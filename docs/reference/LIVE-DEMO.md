# First live deployment — start to finish

Cloudflare account → deployed Signer + web app → Gradescope → a test submission you make yourself.
**~25 minutes** the first time, **~5 minutes** for each later week. All free tier.

You need: a Cloudflare account (step 1), a Gradescope course with an assignment you can break,
Node 18+, and this repo.

> Do the **dry run in step 6** before showing anyone. Submitting to your own assignment is the only
> way to confirm the two copies of the signing secret match.

---

## 1. Cloudflare account (5 min)

1. **dash.cloudflare.com/sign-up** — email + password, confirm the email.
2. That's it. No domain, no credit card, no paid plan. Skip every prompt about adding a site;
   Workers and Pages run on `*.workers.dev` / `*.pages.dev`.

```bash
cd server/worker && npx wrangler login && cd ../..
```

A browser window opens — approve it. `npx` fetches wrangler on demand; nothing to install globally.

---

## 2. Signing secret (30 seconds)

One secret ties the Signer to the autograder. If they disagree, **every submission scores 0**.

```bash
node tools/make-config.js          # creates server/config.json (gitignored)
```

Already have one from local testing? Keep it — `--force` makes a new one and invalidates every
certificate issued under the old one.

---

## 3. Deploy everything (one command, ~5 min)

```bash
npm run deploy -- courses/<id>/course.json
```

That bundles the banks, creates the D1 database and writes its binding into `wrangler.toml`,
applies the schema, uploads the secret, deploys the Worker **and** the web app, checks `/health`,
and records both URLs back into `course.json`.

It must print:

```
✅ cooldown enforced (D1 bound)
```

If it prints the ⚠️ line instead, the database binding didn't take — students could reroll
questions freely (INV-SEC-7). Re-run before continuing.

### If the schema step reports an authentication error

```
✘ [ERROR] A request to the Cloudflare API (…/d1/database/…/import) failed.
  Authentication error [code: 10000]
```

`wrangler d1 execute --file` uses D1's **import** API, which has been seen to reject a
correctly-scoped OAuth login (`wrangler whoami` will show `d1 (write)` and Super Administrator).
It is not a permissions problem you can fix.

The deploy script now checks whether the `attempt` and `rl` tables already exist and skips the step
if so, then falls back to running the statements individually through a different endpoint. If you
hit this on an older checkout, confirm the tables directly:

```bash
cd server/worker && npx wrangler d1 execute oralscale --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table';"
```

If `attempt` and `rl` are listed, the schema is complete and the error was a no-op.

### On a brand-new account: register a workers.dev subdomain first

A fresh Cloudflare account has no `*.workers.dev` subdomain, so there is nowhere to serve the
Worker and the deploy stops with:

```
✘ [ERROR] You need to register a workers.dev subdomain before publishing
```

**This is one-time account setup, not a problem with the project** — the Worker itself uploads
successfully before the error, and will show in the dashboard with "No active routes".

Go to **dash.cloudflare.com → Workers & Pages** and check **Account details → Subdomain** on the
right. Set one if it's blank; if it already has a value, nothing is wrong — the deploy simply ran
before the route could attach. Then re-run `npm run deploy`; the database, schema and secret are
all skipped.

*(Wrangler prints a `…/workers/onboarding` link that currently 404s. Ignore it — the dashboard
moved that page.)*

> ⚠️ **Settle your subdomain before handing out links.** It becomes part of the Signer URL, which
> is signed into every student link. Changing it later breaks every link already distributed, and
> they last 120 days by default. A freshly changed subdomain also takes a few minutes to start
> accepting requests.

Re-running the command later is safe; it skips anything already set up.

<details>
<summary>Prefer to run the steps by hand?</summary>

```bash
node tools/build-worker.js courses/<id>/course.json
cd server/worker
npx wrangler d1 create oralscale          # paste the id into wrangler.toml, uncomment the block
npx wrangler d1 execute oralscale --remote --file schema.sql
npx wrangler secret put ORALSCALE_SECRET  # paste `node tools/make-config.js --print`
npx wrangler deploy
cd ../.. && npx wrangler pages deploy web/ --project-name oralscale
```
Then set `signerUrl` and `webappUrl` in `course.json` to the two printed URLs.
</details>

---

## 4. Build the autograder (2 min)

```bash
npm run package -- courses/<id>/course.json
```

That bundles the banks, pulls the signing secret from `server/config.json` (the same one
`npm run deploy` gave the Worker) and the web app URL from `course.json`, packages
`courses/<id>/autograders/<courseId>-<assignmentId>-oralscale-v<version>.zip`, and prints the Gradescope checklist. Nothing to type, nothing to
mistype — and the secrets go straight into the zip and are then deleted, never left on disk.

**Purdue GenAI is picked up from `.env` automatically.** Put all three in the repo-root `.env`
(gitignored):

```
GENAI_STUDIO_API_KEY=sk-…
GENAI_STUDIO_BASE_URL=https://genai.rcac.purdue.edu
GENAI_STUDIO_MODEL=…
```

The packaging step confirms the model when all are present. For a course configured with `genai`,
packaging refuses to proceed if any are missing — INV-GRADE-1 forbids silently substituting a
different grader. Exported environment variables override `.env`; blank entries in `.env` are
ignored, so the shipped `.env.example` placeholders can't clobber anything.

A course explicitly configured with `local` or `heuristic` does not need GenAI credentials. See
**Secrets** below before using a real key.

Every graded submission now states which grader ran, e.g. `[graded by: genai:gemma4:26b-a4b]` or
`[graded by: heuristic]`, so a GenAI outage is visible rather than silently degrading scores.

It warns you about the two mistakes that actually bite: a `webappUrl` that is a per-deployment
Pages hostname (no valid certificate — browsers reject it), and a missing `signerUrl`.

**Don't pass `--assignment`.** Left unpinned, the autograder reads the week from the Gradescope
assignment's title, so this **one zip works for every week** — build once, upload the same file
everywhere.

---

## 5. Gradescope (5 min)

Create a **Programming Assignment** titled naturally — **`Quiz 4`** is enough. The autograder reads
the quiz number from the title and maps it to `week-04-…`, so no topic name has to appear in the
title and there is nothing to configure. Then:

1. **Configure Autograder** → upload the zip named for that assignment from `courses/<id>/autograders/`. The image build takes several
   minutes (ffmpeg + caching the Whisper model). **Read the log**: it must end with
   `whisper model 'small' cached OK`. A failed build is deliberate — an autograder without Whisper
   can't transcribe anything and would score your whole class 0.
2. **Autograder Settings → container `2.0 CPU, 3.0 GB RAM`.** Not optional, and the failure is
   silent: the `small` speech model needs about **1.7 GB just to load**, so on the 0.5 CPU /
   0.75 GB default *every* submission comes back with no transcript, and it looks like a student
   problem. (For `ORALSCALE_WHISPER_MODEL=medium` or `large-v3` — worth it for a cohort with many
   non-native English speakers — use `4.0 CPU / 6.0 GB`.)
3. **Autograder Settings → timeout `40 minutes`.** Not because one submission takes forty minutes;
   it takes a few. The headroom is for AI grading hitting Purdue GenAI's rate limit: the grader
   waits and retries rather than silently dropping to keyword matching, so a throttled submission
   is *slow* instead of being graded differently from its neighbours. A container killed
   mid-retry gives the student nothing. This matters most on a whole-class regrade, where every
   submission is its own container and they all start at once.
4. **Nothing to set for scoring.** Gradescope grades the most recent (active) submission; there is
   no "highest score" option on a Programming Assignment. Students re-activate a better attempt from
   Submission History, and the student guide tells them so. Worth knowing: a "get a link"
   submission with no recording scores 0, and that 0 stands if it is their newest upload.
5. Point value **10**, matching `ORALSCALE_MAX_POINTS`.
6. Paste the student link into the **assignment description**:

```bash
node tools/gen-url.js --assignment week-04-methods-core
```

One public link for the whole class — it carries no identity and is safe to publish (decision B1).
The Signer URL travels inside it, signed, so the web app needs no configuring.

The course is inferred from the assignment id, and the tool **refuses** to mint a link whose
`pseudonymSalt` belongs to a different course than the assignment does — that combination would
pass `/reveal` but fail every identity check at grading time, i.e. a silent class-wide zero. If the
banner says `LOCAL DEV link — NOT for students`, you have not deployed yet; run `npm run deploy`
first, which records `signerUrl` and `webappUrl` into `course.json`.

---

## 6. Dry run — before anyone else sees it

1. Open the assignment in Gradescope, click the link.
2. Paste your quiz key → **Continue**. That is the only field; you never type an email. Get your
   own key with
   `node tools/gen-access-keys.js --course courses/<id>/course.json --student you@purdue.edu`
   (use the address your Gradescope account uses, or the identity check will fail at upload).
3. **Allow mic & start** — recording begins *before* the question appears.
4. Read the four opening digits aloud, one at a time.
5. Answer for ~30 seconds. You're testing plumbing, not knowledge. At 0:00 the screen says
   "finish your sentence" and gives you `bufferSec` more before it moves on by itself.
6. Tap **I'm done with this question** → the question disappears and new digits appear. **Keep
   recording**, read them aloud. Leave a beat of silence first — don't talk over them. If the
   assignment has more questions, the next appears right after; repeat 4–6 until the last, then
   **Finish & submit**.
7. Download the `.zip` and upload it to the assignment.
8. Expect **Integrity: PASSED** and a score out of 10.

| If it fails on… | Cause |
|---|---|
| Certificate signature | the two secrets differ (step 2 vs 4) |
| Identity | the key was minted for a different address than the Gradescope account you submitted from — the hidden test names both |
| Spoken codes | a code wasn't heard; don't talk over the digits at any boundary |
| Reveal refused, "needs your personal quiz key" | no key, a key from another course, or a mistyped character |
| Transcription — AUTOGRADER MISCONFIGURED | Whisper missing from the image; re-read the step 5 build log |
| Configuration — could not tell which week | the title has no quiz number ("Oral Quiz"), an unknown one ("Quiz 10" in a course with no week 10), or two ("Quiz 4 and 5"). The message lists the fixes |

---

## Each additional week (~5 min)

1. Create the Gradescope assignment, titled `Quiz N` for week N.
2. Upload the zip named for that assignment from `courses/<id>/autograders/`, 10 points. Nothing to
   set for scoring (see above).
3. Paste a fresh link: `node tools/gen-url.js --assignment week-05-…`

Only re-run `npm run deploy` if you changed a bank or `course.json`.

---

## Secrets — what lives where

| Secret | Where it lives | Who can read it |
|---|---|---|
| `ORALSCALE_SECRET` | `server/config.json` (gitignored); Worker secret; inside `autograder.zip` | you; Cloudflare; anyone with Gradescope staff access to the course |
| `GENAI_STUDIO_API_KEY` | inside `autograder.zip` only | same |
| `pseudonymSalt` | `course.json`, and inside the public link | **public by design** — not a secret |

**Gradescope has no secrets manager.** Whatever the container needs must be inside the image, so
The course-named autograder zip contains both secrets in plaintext. That's unavoidable; what you can control:

- **Never commit it.** `courses/**/autograders/` and `source/secret.env` are both gitignored, and `build.sh`
  writes the zip `chmod 600`.
- **Pass secrets via environment** (step 4) so nothing lingers on your disk between builds.
- **Use a dedicated, revocable GenAI key** for this — not your personal all-purpose key — and
  rotate it at the end of term.
- **Course staff can read it.** Any TA with Gradescope access to the assignment can download the
  autograder and recover both secrets. The GenAI key is a billing/abuse concern; the signing secret
  is worse — with it, someone could forge certificates. Scope TA access accordingly.
- **Rotating** means: `node tools/make-config.js --force`, `npm run deploy`, rebuild and re-upload
  the zip. Certificates issued under the old secret stop verifying, so rotate between weeks.

Students never see any of this — Gradescope shows them only `results.json`.

---

## Before a live audience

- **Never set `ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR`.** It tells the grader to trust a transcript from
  inside the student's own `.zip` (INV-INTEGRITY-8). `build.sh` refuses to package it.
- **Abandoning a question costs a 5-minute wait** (INV-SEC-7); finishing an attempt clears it
  instantly. Demoing retakes back-to-back? Finish each attempt, or set `retakeCooldownSec: 0` on the
  demo assignment.
- **Mic requires HTTPS** — Pages gives you that. It will not work over plain `http://` on a phone.
- **Untested on real hardware.** iOS Safari and Android Chrome capture paths are verified in code
  and in a desktop browser with a simulated mic, never on a physical device. Use your own phone in
  the dry run.
