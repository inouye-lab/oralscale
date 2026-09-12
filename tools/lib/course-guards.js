'use strict';
/*
 * The guards that must exist BEFORE a course folder holds anything secret.
 *
 * A course folder accumulates the most sensitive material in the system: the
 * signing Secret, the quiz keys paired with student emails, the accommodation
 * roster, the built autograders. All of it is generated, none of it is ever
 * committed — and "remember not to commit it" is not a control. So the .gitignore
 * and the pre-commit hook are written FIRST, before the thing they protect
 * exists. Installing them afterwards leaves a window, and the window is exactly
 * when a new instructor is most likely to run `git add -A`.
 *
 * Two repositories can be in play and both get a hook:
 *   - the ENGINE repo (this one), which may contain courses/<id>/ directly
 *   - the COURSE repo, when courses/<id>/ is its own git checkout
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/* Everything a course folder generates that must never reach a commit.
 * Patterns, not filenames, because the generators name files after the course. */
const IGNORE_LINES = [
  '# OralScale — generated, secret, and NEVER committed.',
  '# Written by tools/lib/course-guards.js. Safe to extend, not to remove.',
  '.env',
  '.env.*',
  '!.env.example',
  '*.keys.csv',
  '*.brightspace-import.csv',
  'accommodations.json',
  'extensions.json',
  'autograders/',
  'dist/',
];

/* Matched against staged paths by the hook. Kept in sync with IGNORE_LINES:
 * .gitignore stops the accident, the hook stops the accident plus `git add -f`
 * and anything already tracked from before the rules existed. */
const HOOK_PATTERNS = [
  '(^|/)\\.env$',
  '(^|/)\\.env\\.',
  '\\.keys\\.csv$',
  '\\.brightspace-import\\.csv$',
  '(^|/)accommodations\\.json$',
  '(^|/)extensions\\.json$',
  '(^|/)(autograders|dist)/',
];

/* Committed templates that LOOK like the files above but hold no values. */
const ALLOW_PATTERNS = [
  '(^|/)\\.env\\.example$',
];

const HOOK = `#!/bin/sh
# OralScale guard — installed by tools/lib/course-guards.js. Do not edit by hand.
#
# Refuses a commit that stages a course Secret, a quiz-key export, an
# accommodation roster, or a built autograder. These are generated, they pair
# student emails with credentials, and they are not recoverable once published.
# ALLOW is applied after MATCH because this hook runs under grep -E (POSIX ERE),
# which has no lookahead — an inline (?!example$) silently matches nothing and
# blocked .env.example, a committed template with no values in it.
blocked=$(git diff --cached --name-only --diff-filter=ACM \
  | grep -E '${HOOK_PATTERNS.join('|')}' \
  | grep -vE '${ALLOW_PATTERNS.join('|')}' || true)
if [ -n "$blocked" ]; then
  echo ""
  echo "COMMIT BLOCKED — these are secret course artifacts and must never be committed:"
  echo "$blocked" | sed 's/^/    /'
  echo ""
  echo "  Quiz-key exports pair student emails with credentials: upload them to"
  echo "  Brightspace, then DELETE the local file before committing."
  echo ""
  echo "  If a file is already tracked, untrack it and rotate what it exposed:"
  echo "      git rm --cached <file>"
  echo ""
  exit 1
fi
`;

/** Is `dir` the root of a git repository (a .git dir or worktree file)? */
function isGitRepoRoot(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

/** The hooks dir for a repo root, or null if this is not one. */
function hooksDir(repoRoot) {
  const dotGit = path.join(repoRoot, '.git');
  if (!fs.existsSync(dotGit)) return null;
  const st = fs.statSync(dotGit);
  if (st.isDirectory()) return path.join(dotGit, 'hooks');
  // A worktree/submodule: .git is a file pointing at the real gitdir.
  const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotGit, 'utf8'));
  if (!m) return null;
  const real = path.resolve(repoRoot, m[1].trim());
  return fs.existsSync(real) ? path.join(real, 'hooks') : null;
}

/** Write the pre-commit hook into a repo root. Returns the path, or null. */
function installHook(repoRoot) {
  const dir = hooksDir(repoRoot);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'pre-commit');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (existing.includes('OralScale guard')) {
    if (existing !== HOOK && !existing.includes('check-secrets')) {
      fs.writeFileSync(target, HOOK, { mode: 0o755 });   // refresh our own
    }
    return target;
  }
  if (existing.trim()) {
    // Someone else's hook. Append rather than clobber — theirs may be doing
    // something the project needs, and silently replacing it is a worse bug
    // than the one this prevents.
    const merged = `${existing.replace(/\n*$/, '\n')}\n${HOOK.replace(/^#!.*\n/, '')}`;
    fs.writeFileSync(target, merged, { mode: 0o755 });
    return target;
  }
  fs.writeFileSync(target, HOOK, { mode: 0o755 });
  try { fs.chmodSync(target, 0o755); } catch { /* best effort */ }
  return target;
}

/** Ensure the course folder has a .gitignore covering every generated secret. */
function ensureGitignore(courseDir) {
  const file = path.join(courseDir, '.gitignore');
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = IGNORE_LINES.filter((l) => l.startsWith('#') ? false
    : !have.split('\n').some((h) => h.trim() === l));
  if (!missing.length) return { file, added: [] };
  const body = have.trim()
    ? `${have.replace(/\n*$/, '\n')}\n${missing.join('\n')}\n`
    : `${IGNORE_LINES.join('\n')}\n`;
  fs.writeFileSync(file, body);
  return { file, added: missing };
}

/**
 * Install every guard for a course folder, in BOTH repositories that can hold
 * it. Idempotent; safe to call on every build.
 */
function ensure(courseDir, { log = () => {} } = {}) {
  const dir = path.resolve(courseDir);
  const gi = ensureGitignore(dir);
  if (gi.added.length) log(`   ✓ ${path.relative(ROOT, gi.file)} now ignores ${gi.added.join(', ')}`);

  const repos = [];
  const engine = installHook(ROOT);
  if (engine) repos.push({ root: ROOT, hook: engine, kind: 'engine' });
  if (isGitRepoRoot(dir) && path.resolve(dir) !== ROOT) {
    const own = installHook(dir);
    if (own) repos.push({ root: dir, hook: own, kind: 'course' });
  }
  for (const r of repos) log(`   ✓ pre-commit guard installed in the ${r.kind} repo`);
  if (!repos.length) log('   ⚠️  no git repository found — the commit guard could not be installed');
  return { gitignore: gi.file, repos };
}

module.exports = { ensure, ensureGitignore, installHook, isGitRepoRoot, IGNORE_LINES, HOOK_PATTERNS };
