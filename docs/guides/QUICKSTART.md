# Quickstart — a running oral quiz in about an hour

> **For instructors planning a rollout:** start with the [illustrated Faculty guide](../public/site/faculty.html)
> and [two-page PDF](../public/site/faculty-guide.pdf). This document is the technical setup reference
> for you and the AI agent handling your first launch.

The shortest path from `git clone` to a student taking a quiz. Four commands, and **two things only
you can do** because they need an account in your name.

If you want to understand the system first, read [`PILOT-PACKET.md`](PILOT-PACKET.md). If you want
to see it working first, start here.

> **Want to see it working before building your own course?** Deploy the demo first — steps 3 and 4
> below work against `courses/demo/course.json` with no authoring at all, and you can take a real
> quiz on your phone in fifteen minutes. Otherwise skip it; nothing later depends on it.
>
> **Prefer to have an AI agent drive this?** See [Let an agent do it](#let-an-agent-do-it) at the
> bottom. Same steps; it runs the commands and stops at the two that need you.

---

## Before you start

**Three prerequisites, and only one of them is a signup.**

| | How | When you need it |
|---|---|---|
| **Node 18+** | `node --version` | Everything. Install from [nodejs.org](https://nodejs.org) if missing. |
| **Python 3.9+** | `python3 --version` | Only to run the autograder locally (`npm test`). Gradescope brings its own. |
| **A Cloudflare account** | [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) | **Before step 2.** Email + password, ~2 minutes. |

**You do not install wrangler.** Every command that needs it runs `npx wrangler`, which fetches it
on demand. Nothing to install globally, nothing to keep updated.

**You do not need a domain, a credit card, a paid plan, a server, or an AI API key.** Cloudflare's
free tier covers this, and the default grader runs inside the Gradescope container.

### The one thing that will stop you

`npm run launch` **does not log you in, and does not ask.** It assumes an authorised Cloudflare
session and fails if there is not one. Authorise once, before you launch:

```bash
npx wrangler login          # opens a browser; approve it, then close the tab
```

Skip the account signup and that command has nothing to log into — so create the account first. The
login is per machine and lasts; you will not do it again on this computer.

Everything else in step 1 is local: no account, no network, nothing to approve.

### What each step actually needs

| Step | Network | Account |
|---|---|---|
| 1. Create your course | no | none |
| 2. `npm run launch` | yes | **Cloudflare** (already authorised) |
| 3. Gradescope assignment | yes | **Gradescope** |
| 4. Take it yourself | yes | your own quiz key, minted locally |
| 5. Roll out | yes | your LMS |

---

## 1. Create your course


```bash
npm install
npx wrangler login          # opens a browser; approve it
node tools/setup.js --title "SCI 101 — Example Course" --term fall2026 --assignments "Quiz 1"
```

One command, or drop the flags (`npm run setup`) to be asked instead — same result either way.

It creates `courses/<your-id>/` with a working `course.json`, a starter question bank, its signing
secret, a `.gitignore`, a commit guard, and **its own git repository**. Add a *private* remote and
push: a bank holds your questions *and* their reference answers, so it must never be public.

**Everything about your course lives in that one folder.** Copy it or clone it and the whole course
travels with it — see [`../../courses/GOVERNANCE.md`](../../courses/GOVERNANCE.md).

You get two assignments: **`demo-quiz`** (generic questions, for testing — keep it) and the quiz you
named.

## 2. Launch it

```bash
npm run launch -- courses/<your-id>/course.json
```

Deploys the Signer and the student page to Cloudflare, then builds **one autograder zip per
assignment** into `courses/<your-id>/autograders/`. Roughly five minutes the first time.

This is `npm run deploy` followed by `npm run package`; both still work on their own. They are
wrapped because the order matters and getting it wrong is silent — package before deploy and the zip
carries no `webappUrl`, so a student who submits with no recording is never told where the quiz is.

Look for `✅ cooldown enforced (D1 bound)`. If it says the binding did not take, re-run before
letting students near it.

## 3. Create the `demo-quiz` assignment in Gradescope

A *Programming Assignment*. Upload the zip whose **filename names it** — nothing is inferred from
the Gradescope title, so name the assignment whatever you like. Three settings are not optional:

| Setting | Value | If you get it wrong |
|---|---|---|
| Container | as printed by `npm run launch` | Too small and the speech model cannot load — no transcripts, for anyone |
| Timeout | **40 minutes** | A throttled submission is killed mid-retry and the student gets nothing |

**Nothing to set for scoring.** Gradescope grades the *active* submission — the most recent one
unless a student activates an earlier one from Submission History. There is no "highest score"
option on a Programming Assignment; the student guide tells students how to re-activate a better
attempt, which is where that control actually lives.

## 4. Take it yourself, end to end

```bash
node tools/gen-access-keys.js --course courses/<your-id>/course.json --student you@your.edu
node tools/gen-url.js        --course courses/<your-id>/course.json --assignment demo-quiz
```

Open the link on your phone, enter your key, answer a question out loud, download the `.zip`, and
**submit it to Gradescope**.

**Do not skip the upload.** Everything up to the download can succeed while the Signer and the
autograder hold different secrets, and you would not know: that mismatch surfaces only at grading,
as an entire cohort scoring zero. This single run is the check.

It is also the fastest way to understand what you are asking students to do — including how it feels
to read digits aloud on a phone.

## Next — your own questions

The starter bank proves the machinery; it does not assess your course. Read
[`QUESTION-DESIGN-GUIDE.md`](QUESTION-DESIGN-GUIDE.md) first, then draft a bank with an LLM — the
chat prompt is in the [README](../../README.md#optional--your-own-questions). Validate and redeploy:

```bash
node tools/validate-bank.js courses/<your-id>/banks/quiz-1.json
npm run launch -- courses/<your-id>/course.json
```

Re-test on `demo-quiz` after any change. That is what it is for.

## Then — roll out to students

```bash
node tools/gen-access-keys.js --course courses/<your-id>/course.json --roster <lms-export.csv>
```

Paste the `gen-url.js` link into the assignment description, upload the keys to your LMS, then
**delete the local file** — it pairs student emails with credentials. A pre-commit guard refuses to
commit it, but it is dangerous while it exists; keys are derived rather than stored, so you can
regenerate them whenever you need them.

Give students [`STUDENT-GUIDE.md`](STUDENT-GUIDE.md), and tell them to turn off auto-lock. Make the
first real quiz **ungraded** — every remaining setup mistake surfaces there instead of in a graded
week.

---

## And — the settings worth knowing

`questionsPerAttempt` (default 3), `limitSec` (default 120 s **per question**), and
`gradingBackend` (default `local`). Every key in `course.json` has a `…Note` beside it explaining
itself.

```bash
node tools/set-grading.js --course courses/<your-id> --show
```

`local` bundles a small open-weights model into the image, so transcripts never leave the container.
`genai` grades better but sends de-identified transcripts to a service with **no FERPA
certification** — your institution's call, not a default. There are no fallbacks between graders.
See [`../reference/GRADER-BACKENDS.md`](../reference/GRADER-BACKENDS.md).

---

## Let an agent do it

Steps 1–4 are mechanical, and an agent with a terminal (Claude Code, Codex, Cursor) can run them.
Clone the repo, open it in the agent, and paste this:

```text
Set up OralScale for my course, following docs/guides/QUICKSTART.md.

Course: <e.g. CHEM 101, Fall 2026>
Questions per attempt: <e.g. 3>   Time per question: <e.g. 120 seconds>

Read AGENTS.md and docs/guides/QUICKSTART.md first, then work through steps 1 to 4.

Rules:
- Run the commands; do not rewrite the tools to work around a failure. If something
  fails, explain the error, diagnose it, and fix and retest without bypassing safeguards.
- STOP and hand back to me for anything needing my account: `npx wrangler login`,
  creating the Gradescope assignment, and uploading keys to my LMS.
- Never commit a .env, a *.keys.csv, a *.brightspace-import.csv, or anything under
  autograders/. A pre-commit guard blocks these; do not disable it.
- Do not invent quiz questions. Use the starter bank; I will author real ones later.
- After each step, tell me in one line what it did and what I should check.

Finish by printing: the student link, where the autograder zip is, the exact
Gradescope settings I must set by hand, and anything you could not do.
```

**What the agent cannot do for you**: log into Cloudflare, create the Gradescope assignment, upload
the keys, or decide your questions. Those need your account or your judgement, and the prompt tells
it to stop there rather than guess.

**Check its work before students see it.** Take the quiz yourself through the real deployed link and
submit to the real Gradescope assignment. That single end-to-end run is what proves the two copies
of your signing secret match, and it is the failure that otherwise shows up as every student
scoring zero.
