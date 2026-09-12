#!/usr/bin/env bash
# One-command Cloudflare deploy: bundle -> D1 -> secret -> Worker -> Pages -> verify.
#
#   bash tools/deploy.sh courses/<id>/course.json [pages-project-name]
#
# Safe to re-run: it creates the D1 database and sets the secret only if missing,
# and re-applies the schema idempotently (schema.sql is CREATE TABLE IF NOT EXISTS).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COURSE="${1:?usage: bash tools/deploy.sh courses/<id>/course.json [pages-project-name]}"
PROJECT="${2:-}"
WORKER_DIR="$ROOT/server/worker"
TOML="$WORKER_DIR/wrangler.toml"

command -v npx >/dev/null || { echo "npx not found — install Node 18+."; exit 1; }
[ -f "$COURSE" ] || { echo "No such course.json: $COURSE"; exit 1; }
COURSE_ID="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).courseId || ''))" "$COURSE")"
case "$COURSE_ID" in
  ''|*[!a-z0-9-]*) echo "courseId must contain only lowercase letters, digits, and hyphens."; exit 1;;
esac
WORKER_NAME="oralscale-${COURSE_ID}-signer"
[ -n "$PROJECT" ] || PROJECT="oralscale-${COURSE_ID}"

# --- wrangler, on the right CPU architecture -------------------------------
#
# wrangler ships `workerd`, a NATIVE binary, and npm installs only the slice
# matching the architecture it ran as. wrangler's own shim is `#!/usr/bin/env
# node`, and on an Apple Silicon Mac `env` hands back whichever slice of a
# UNIVERSAL node binary matches the calling process -- so a shell running under
# Rosetta launches node as x64, workerd looks for @cloudflare/workerd-darwin-64,
# and finds only the arm64 one npm installed. The error talks about copying
# node_modules into Docker, which is not what happened, and every wrangler
# command fails.
#
# Reproduced on this project: `node -p process.arch` said arm64 while `env node
# -p process.arch` said x64, in the same shell.
#
# So: on Apple Silicon, if `env node` is NOT arm64, re-launch through `arch
# -arm64`. Guarded three ways -- macOS only, arm64 hardware only, and only when
# the mismatch is actually present -- so an Intel Mac, a Linux box, or a
# correctly-aligned shell all take the plain path.
WRANGLER_ARCH=""
if [ "$(uname -s)" = "Darwin" ] \
   && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ] \
   && [ "$(env node -p 'process.arch' 2>/dev/null)" != "arm64" ] \
   && command -v arch >/dev/null 2>&1; then
  WRANGLER_ARCH="arch -arm64"
  printf '\033[2m(running wrangler under arch -arm64: this shell launches node as %s, and wrangler ships a native arm64 binary)\033[0m\n' \
    "$(env node -p 'process.arch' 2>/dev/null || echo unknown)"
fi
wrangler() { $WRANGLER_ARCH npx --yes wrangler "$@"; }

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Run a command with a REAL terminal attached while still capturing its output.
#
# Piping wrangler through `tee` makes it think it is non-interactive, so prompts
# ("register a workers.dev subdomain now?") silently auto-answer "no" and turn a
# one-click question into a hard failure. `script` gives it a pty and still gives
# us the transcript.
run_tty() {
  local out="$1"; shift
  : > "$out"
  # Only reach for `script` when we actually have a terminal to preserve; in CI or
  # a pipe it errors out ("tcgetattr/ioctl"), so fall through to a plain capture.
  if [ -t 1 ] && command -v script >/dev/null 2>&1; then
    if script --version >/dev/null 2>&1; then
      script -q -e -c "$*" "$out" >/dev/null 2>&1 || true    # GNU/util-linux
      cat "$out"
    else
      script -q "$out" "$@" || true                           # BSD / macOS
    fi
    return 0
  fi
  "$@" 2>&1 | tee "$out" || true
}

say "1/6  Bundling course + banks into the Worker"
node "$ROOT/tools/build-worker.js" "$COURSE"

say "2/6  Database (D1) — required for the retake cooldown"
if grep -q '^\[\[d1_databases\]\]' "$TOML"; then
  echo "D1 already configured in wrangler.toml — skipping create."
else
  echo "Creating D1 database 'oralscale'…"
  OUT="$(cd "$WORKER_DIR" && wrangler d1 create oralscale 2>&1 || true)"
  echo "$OUT"
  DBID="$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  if [ -z "$DBID" ]; then
    echo
    echo "Could not read a database_id from wrangler's output (it may already exist)."
    echo "Run 'npx wrangler d1 list', then paste the id into $TOML and re-run."
    exit 1
  fi
  cat >> "$TOML" <<EOF

[[d1_databases]]
binding = "DB"
database_name = "oralscale"
database_id = "$DBID"
EOF
  echo "Appended the D1 binding to wrangler.toml (id $DBID)."
fi

say "3/6  Database schema"
# schema.sql is CREATE TABLE IF NOT EXISTS, so re-applying is harmless — but the
# `--file` path goes through D1's IMPORT API, which has been seen to return
# "Authentication error [code: 10000]" on a perfectly-scoped OAuth login. Check
# what is actually there first, and fall back to plain --command statements
# (a different endpoint) rather than failing a deploy over a no-op.
schema_ok() {
  (cd "$WORKER_DIR" && wrangler d1 execute oralscale --remote --json \
     --command "SELECT name FROM sqlite_master WHERE type='table';" 2>/dev/null) \
    | grep -q '"attempt"' && \
  (cd "$WORKER_DIR" && wrangler d1 execute oralscale --remote --json \
     --command "SELECT name FROM sqlite_master WHERE type='table';" 2>/dev/null) \
    | grep -q '"rl"'
}

if schema_ok; then
  echo "Tables 'attempt' and 'rl' already exist — nothing to apply."
else
  echo "Applying schema.sql…"
  if ! (cd "$WORKER_DIR" && wrangler d1 execute oralscale --remote --file schema.sql); then
    echo "Bulk import failed — retrying statement by statement…"
    # Strip comments, split on ';', run each through the query endpoint.
    python3 - "$WORKER_DIR/schema.sql" <<'PYEOF' > /tmp/oralscale-stmts.txt
import re, sys
sql = open(sys.argv[1]).read()
sql = re.sub(r"--[^\n]*", "", sql)
for stmt in (s.strip().replace("\n", " ") for s in sql.split(";")):
    if stmt:
        print(stmt)
PYEOF
    while IFS= read -r stmt; do
      [ -z "$stmt" ] && continue
      (cd "$WORKER_DIR" && wrangler d1 execute oralscale --remote --command "$stmt" >/dev/null) \
        || echo "  (statement failed, continuing): ${stmt:0:60}…"
    done < /tmp/oralscale-stmts.txt
  fi

  if schema_ok; then
    echo "Schema applied."
  else
    echo
    echo "Could not create the 'attempt' / 'rl' tables. The retake cooldown (INV-SEC-7)"
    echo "will NOT be enforced until they exist. Apply them by hand with:"
    echo "  cd server/worker && npx wrangler d1 execute oralscale --remote --file schema.sql"
    echo "then re-run this script."
    exit 1
  fi
fi

say "4/6  Signing secret"
if (cd "$WORKER_DIR" && wrangler secret list --name "$WORKER_NAME" 2>/dev/null | grep -q ORALSCALE_SECRET); then
  echo "ORALSCALE_SECRET already set on the Worker — leaving it alone."
  echo "(It must equal what the autograder uses: node tools/make-config.js --course '$COURSE' --print)"
else
  echo "Setting ORALSCALE_SECRET from the '$COURSE_ID' course secret…"
  node "$ROOT/tools/make-config.js" --course "$COURSE" --print \
    | (cd "$WORKER_DIR" && wrangler secret put ORALSCALE_SECRET --name "$WORKER_NAME")
fi

say "5/6  Deploying the Worker and the web app"
cd "$WORKER_DIR"
run_tty /tmp/oralscale-deploy.txt $WRANGLER_ARCH npx --yes wrangler deploy --name "$WORKER_NAME"
cd "$ROOT"

if grep -q 'register a workers.dev subdomain' /tmp/oralscale-deploy.txt 2>/dev/null; then
  ACCT="$(grep -oE 'dash\.cloudflare\.com/[0-9a-f]{32}' /tmp/oralscale-deploy.txt | head -1 || true)"
  cat <<EOF

────────────────────────────────────────────────────────────────────────
ONE-TIME ACCOUNT SETUP NEEDED — this is not an error in your project.

Your Worker uploaded fine, but it has no workers.dev URL to serve on yet.
In the Cloudflare dashboard:

  https://dash.cloudflare.com  ->  Workers & Pages

Look at "Account details" on the right for **Subdomain**. If it is blank,
set one; if it already has a value, you are fine — the deploy just ran
before the route could attach.

(Wrangler prints a /workers/onboarding link that currently 404s. Ignore it.)

A changed subdomain can take a few minutes to start accepting requests.
Then re-run this script — everything already done is skipped:

  npm run deploy -- "$COURSE"

NOTE: the subdomain becomes part of the Signer URL, which is baked into every
student link. Settle on it BEFORE handing links out.
────────────────────────────────────────────────────────────────────────
EOF
  exit 1
fi

WORKER_URL="$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' /tmp/oralscale-deploy.txt | head -1 || true)"

run_tty /tmp/oralscale-pages.txt $WRANGLER_ARCH npx --yes wrangler pages deploy web/ --project-name "$PROJECT"

# Pages prints a PER-DEPLOYMENT url (https://<hash>.<project>.pages.dev). That one
# changes on every deploy, so it must never end up in a student link. The stable
# project alias is https://<project>.pages.dev — prefer it, and only fall back to
# the parsed value if the alias is not serving yet.
PAGES_URL="https://$PROJECT.pages.dev"
if ! curl -fsS -o /dev/null --max-time 20 "$PAGES_URL/"; then
  echo "Note: $PAGES_URL is not answering yet (it can take a minute on a new project)."
  ALT="$(grep -oE 'https://[a-z0-9.-]+\.pages\.dev' /tmp/oralscale-pages.txt | tail -1 || true)"
  if [ -n "$ALT" ] && curl -fsS -o /dev/null --max-time 20 "$ALT/"; then
    echo "Falling back to $ALT — re-run once the stable alias is live."
    PAGES_URL="$ALT"
  fi
fi

say "6/6  Verifying"
if [ -n "$WORKER_URL" ]; then
  HEALTH="$(curl -fsS "$WORKER_URL/health" || echo '{}')"
  echo "$HEALTH"
  # Three outcomes, not two. "Not enforced" because the binding failed is an
  # emergency; "not enforced" because this course deliberately set
  # retakeCooldownSec:0 is normal, and printing the emergency for both is how a
  # load-bearing warning becomes background noise.
  case "$HEALTH" in
    *'"cooldownEnforced":true'*)
      echo "✅ cooldown enforced (D1 bound)";;
    *'"cooldownConfigured":false'*)
      echo "ℹ️  no retake cooldown configured for this course (retakeCooldownSec:0) — nothing to enforce."
      echo "    Deliberate for ungraded practice. For a GRADED quiz, set retakeCooldownSec so a"
      echo "    student cannot reroll until they see a question they like (INV-SEC-7).";;
    *)
      echo "⚠️  a retake cooldown IS configured but is NOT enforced — the D1 binding did not take."
      echo "    Students could reroll questions freely (INV-SEC-7). Re-run before students use this.";;
  esac
else
  echo "Could not parse the Worker URL; check the deploy output above."
fi

# Record the URLs so gen-url.js can embed the Signer in the signed link.
if [ -n "$WORKER_URL" ]; then
  python3 - "$COURSE" "$WORKER_URL" "$PAGES_URL" <<'PY'
import json, sys, collections
path, worker, pages = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path), object_pairs_hook=collections.OrderedDict)
d['signerUrl'] = worker
if pages:
    d['webappUrl'] = pages.rstrip('/') + '/'
json.dump(d, open(path, 'w'), indent=2, ensure_ascii=False)
open(path, 'a').write('\n')
print(f"Recorded signerUrl={worker} webappUrl={d.get('webappUrl','')} in {path}")
PY
fi

cat <<EOF

Done.
  Worker : ${WORKER_URL:-?}
  Web app: ${PAGES_URL:-?}

Next:
  1. Build the autograder (secrets stay off disk):
       npm run package -- "$COURSE"
  2. Upload the zip named for the assignment from its autograders/ folder,
     10 points. Nothing to set for scoring: Gradescope grades the ACTIVE
     (newest) submission and has no "highest score" option here — students
     re-activate a better attempt themselves (INV-DEPLOY-1).
  3. Paste the student link into the assignment description:
       node tools/gen-url.js --assignment <week-id>
EOF
