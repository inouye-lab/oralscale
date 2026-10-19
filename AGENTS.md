# AGENTS.md — OralScale house rules

The single source of truth for any AI assistant working in this repo (Claude Code, Codex, Cursor,
…). `CLAUDE.md` is a one-line pointer to this file, so there is one set of rules and no drift.

> **New session / no context?** Read [`docs/project/ONBOARDING.md`](docs/project/ONBOARDING.md) first — it is a
> self-contained cold-start briefing. This file is the house rules it points you to.

OralScale = scalable, privacy-preserving **oral assessment** delivered via a static web app +
a stateless edge Signer, with **Gradescope** as the system of record and **Purdue GenAI** for
grading. Built with [MAGE](docs/project/MAGE.md): the models in [`models/`](models/README.md) are the
source of truth.

## Work model-first
1. Before changing behavior, read the relevant model in `models/` and update it in the same change.
2. Every hard property is an **invariant** with an ID (`INV-…`) in [models/02](models/02-requirements-and-invariants.md)
   and a test in [models/07](models/07-test-model.md). New property → new INV + new test.
3. Log open decisions in [docs/project/DESIGN-QUESTIONS.md](docs/project/DESIGN-QUESTIONS.md) with a best-guess and
   **proceed** — never block on the instructor.
4. Keep [docs/project/STATUS.md](docs/project/STATUS.md) current as a handoff (what's done, what's next, test board).

## 🚫 Never run or read the accommodation audit

`tools/audit-accommodations.js`, any roster CSV passed to it, and anything it prints are
**off limits to you**. Do not execute it, do not read its inputs, do not read, summarise or quote
its output, and do not write a wrapper, a variant, or a "just this once" reimplementation of it.

If the instructor asks for an accommodation audit: tell them the command to type, and stop.

    node tools/audit-accommodations.js --submissions <export.zip> \
      --course courses/<id>/course.json --roster <email,multiplier.csv>

**Why.** Its inputs and outputs name students who hold disability accommodations. That is the most
sensitive data this project touches, and it must never enter a model's context, a session
transcript, a tool log, or a CI record — none of which the instructor can inspect or erase
afterwards. The script enforces this itself: it requires a terminal on stdin **and** stdout,
refuses when an assistant or CI marker is in the environment, and has **no override flag**. Do not
attempt to work around that check. Treating the guard as an obstacle to route around is the failure
mode it exists for.

`--self-test` is the one thing you may run: it exercises the arithmetic on synthetic data and
refuses to accept a real roster.

The same rule covers any file matching `*accommodation*`, `*roster*`, `*.keys.csv`, or
`accommodations.json` — do not open them to "check the format".

## Positive mistakes beat negative mistakes (INV-GRADE-11)

When a design choice here is genuinely uncertain, **resolve it in the student's favour**. Giving a
mark that was not quite earned is an acceptable error; taking one off work that *was* earned is
not, and the two are never to be traded off against each other.

This is a project-wide rule, not a grading knob. It already decides `curveRounding: "up"`, "a
missing verdict is a gap, not an `absent`", "penalties need a quote", `dropLowest`, "optional
points may only raise a mark", and "a grader that cannot run produces no mark rather than a low
one". When you add a threshold, a parser fallback, a rounding rule or a penalty, point it the same
way — and when you evaluate a grader, report the two error directions **separately**. A change that
lowers total error while raising the student-cost direction is a regression. Full statement in
[models/02](models/02-requirements-and-invariants.md) (INV-GRADE-11).

## Non-negotiables (map to invariants)
- **Never** put a signing Secret, any API key, or PII in the repo, the web bundle, logs, or URLs.
  (INV-SEC-4, INV-PRIV-2)
- **The autograder zip contains no personal information** — a Secret and a bank are course secrets;
  a roster is not. No accommodation record, no email, no per-student data. The build refuses rather
  than warns, and `t_no_personal_data_in_zip` asserts it on the extracted zip. (INV-PRIV-6)
- **Never** send audio anywhere but Gradescope. The Signer sees only hashes + timings. (INV-PRIV-1)
- All cross-request trust travels in **HMAC-signed tokens**; verify constant-time; validate input
  before any crypto/DB work. (INV-SEC-1, INV-SEC-5)
- The JS signer and Python autograder must stay **byte-compatible** on tokens (test `t_signature`).
- Question text is rendered as **text, never HTML**. (INV-SEC-6)

## One folder is the whole course (INV-COURSE-4)
Everything belonging to a course lives under `courses/<courseId>/` and **nothing a course needs
lives anywhere else**. The test: copy that one directory to another machine and it still works.
Full statement in [courses/GOVERNANCE.md](courses/GOVERNANCE.md).

- **Secret**: `courses/<id>/.env` (`ORALSCALE_SECRET`), or the course-scoped
  `ORALSCALE_SECRET_<COURSEID>` for CI. **No fallback** — a bare `ORALSCALE_SECRET` is ignored, and
  a course without one cannot be built. **No two courses may share a value**; a clash refuses the
  build. `_template` ships without one, and built-in courses are never re-keyed to clear a clash —
  fix the *user's* course.
- **Generated, never committed**: `.env`, `<id>.keys.csv`, `<id>.brightspace-import.csv`,
  `accommodations.json`, `autograders/`. `.gitignore` and the pre-commit hook are installed
  **before** anything secret is generated.
- Real courses are separate **private** repos cloned into `courses/`; the engine ships only
  `demo/`, `_template/`, `_testsuite/` and `_shell-for-testsuite/`. Never add course content here.

## One autograder per assignment (INV-DEPLOY-3)
`npm run package -- <course.json> --zip` writes one zip **per assignment** into
`courses/<id>/autograders/`, named for the assignment it grades. The assignment is pinned into the
zip and is the **only** thing consulted — nothing is inferred from the Gradescope title, and a zip
that does not say what it grades does not grade.

## Deploy the Worker before you mint the link (INV-DEPLOY-5)
The course config is **bundled into the Worker at deploy time**, so an assignment added to
`course.json` does not exist for students until the Worker is redeployed. A link minted first is
signed, unexpired and perfect, and still fails at `/reveal` with `ASSIGNMENT_GONE` — which the
student reads as "your link is broken" when nothing about their link is wrong.

`tools/gen-url.js` **enforces this** rather than trusting the order. Whenever the course declares a
`signerUrl` it calls `<signerUrl>/health` before signing and refuses to mint unless the live Worker
reports the same `courseId`, lists this `assignmentId`, and agrees on `questionsPerAttempt` and
`requireAccessKey`. Unreachable is also a refusal — "not shown to work" is not "works" — and there
is **no override flag**. Test: `t_link_needs_live_worker`.

So the order is simply:

```bash
npm run deploy -- courses/<id>/course.json
node tools/gen-url.js --course courses/<id>/course.json --assignment <id>
```

If the second command refuses, do not go looking for a way around it; the first one is the fix.
(Observed in the pilot course, 2026-09-02, before the check existed: Quiz 1 was authored, frozen and
packaged, the link was posted, and the Worker still carried the Quiz-0-only bundle.)

## Conventions
- **All future autograders include timing and memory diagnostics by default**
  (standing instructor requirement, 2026-09-22; INV-USE-6). This applies to every
  quiz/course, backend, standard build and DEBUG build—not just Quiz 3 or Qwen.
  Keep questions/feedback first. Students see Purdue-local start/finish and total
  elapsed time; instructors get the detailed stage timings and container memory
  usage/peak, actual cap, percentage and headroom at the end. Report unavailable
  measurements honestly. Keep this in the shared runner and packaging path so new
  assignments inherit it without an opt-in or course-specific patch.
- Vocabulary is the House Lexicon in [models/01](models/01-domain-model.md). Use those exact terms.
- No new runtime dependencies without a note in STATUS — prefer standard library (Node/Web Crypto, Python stdlib).
- Keep the whole system **runnable locally with no cloud account** (Node signer + local autograder).

## Public guide governance

The public Student and Faculty guides are governed by [docs/public/GOVERNANCE.md](docs/public/GOVERNANCE.md)
(INV-DOC-1). **The review blocks only an official release.** On ordinary work,
`npm run test:guides` is advisory. When it lists drift, check whether the mapped FAQs are still
true and *suggest* updates to the instructor; do not block on it or acknowledge it. At release,
`npm run test:guides:release` must pass: review the mapped FAQs and screenshots, regenerate the
HTML/PDFs, and acknowledge. Never acknowledge stale artifacts without editorial and visual review.
Public assets contain synthetic demonstrations only.

## Test gate before calling anything done
- `npm run test:guides` (advisory: suggest guide updates if it lists any). At an official
  release, `npm run test:guides:release` instead, which must pass.
- `npm run test` (unit + worker + E2E honest-pass/attack-fail) green, plus `npm run test:package`
  and `npm run test:course`.
- Any touched invariant's test still passes; drift check: every `INV-` ID in `models/` is referenced
  in `models/07`.
- `node tools/check-course-safety.js` and `node tools/check-secrets.js --all` clean.

## Prove your environment works
```bash
npm test
```

## Layout
```
models/      MAGE models (source of truth)
docs/        guides/ (read) · reference/ (look up) · project/ (the record) — see docs/README.md
server/      Signer: signer.js (dev) + worker/ (prod) + lib/protocol.js
web/         static student app (mobile-first)
autograder/  Gradescope: source/ (validate, transcribe, grade)
courses/     per-course config, banks, secrets and built autograders (see GOVERNANCE.md)
tools/       config, token/URL gen, bank tooling, demo-e2e, test harnesses
```

## Workstation model storage
Use the shared Hugging Face cache for local model weights; do not download GGUF
files into this repo or course scratch folders. See
[LOCAL-GRADING.md](docs/reference/LOCAL-GRADING.md#shared-models-on-a-developer-workstation).
The retained local grader is the exact pinned Qwen3.5 4B Q4_K_M; Whisper models
share the same cache with other local projects. Keep the qualified llama.cpp inference
engine and grading configuration. Historical comparison models were removed on
2026-10-10; an absent model is not permission to substitute another one.
