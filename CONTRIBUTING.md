# Contributing to OralScale

Thanks for trying this. During the invited alpha the most valuable contributions are **reports of
what broke in a real course**, not code.

Read [`docs/project/ONBOARDING.md`](docs/project/ONBOARDING.md) first — it is a self-contained cold-start briefing.
[`AGENTS.md`](AGENTS.md) is the house rules it points to (`CLAUDE.md` is a pointer to it).

## Before anything else

- **Never** put student data, secrets, quiz keys, or question-bank content in an issue, a pull
  request, a commit, or a test fixture. See [`SECURITY.md`](SECURITY.md).
- **Security problems go through private reporting**, never a public issue.
- Course content belongs in your own private course repository, not here. See
  [`courses/README.md`](courses/README.md).

## This project is model-first

The models in [`models/`](models/README.md) are the source of truth. Code is written to satisfy
them, not the other way round.

1. **Read the relevant model before changing behaviour, and update it in the same change.** A pull
   request that changes behaviour without touching a model will be sent back.
2. **Every hard property is an invariant.** It gets an ID (`INV-…`) in
   [`models/02-requirements-and-invariants.md`](models/02-requirements-and-invariants.md) and a
   test in [`models/07-test-model.md`](models/07-test-model.md). New property → new INV → new test.
   No exceptions for security, privacy, or grading paths.
3. **Open decisions go in [`docs/project/DESIGN-QUESTIONS.md`](docs/project/DESIGN-QUESTIONS.md)** with a best guess,
   and then you proceed. Do not block waiting on an instructor.
4. **Keep [`docs/project/STATUS.md`](docs/project/STATUS.md) current** — it is the handoff to the next person, human
   or agent.

## Non-negotiables

These map to invariants and are not stylistic preferences:

- No Secret, API key, or PII in the repository, the web bundle, logs, or URLs (INV-SEC-4, INV-PRIV-2).
- Audio goes nowhere but Gradescope. The Signer sees hashes and timings only (INV-PRIV-1).
- All cross-request trust travels in HMAC-signed tokens. Verify constant-time. Validate input
  **before** any crypto or database work (INV-SEC-1, INV-SEC-5).
- The JS signer and the Python autograder must stay **byte-compatible** on tokens (`t_signature`).
- Question text renders as text, never HTML (INV-SEC-6).
- No new runtime dependencies without a note in STATUS. Prefer the standard library — Node/Web
  Crypto, Python stdlib.
- The whole system must stay runnable locally with no cloud account.

## The test gate

Everything green before you call anything done:

```bash
npm run test
```

That is unit + Worker + E2E. Also run what your change touches:

```bash
npm run test:package   # autograder packaging
npm run test:banks     # bank validation (demo course)
npm run test:course    # full course path, end to end
```

Any invariant your change touches must still pass its test, and every `INV-` ID in the models must
still be referenced in `models/07-test-model.md`.

Tests must not depend on private course content. Use `courses/demo/` or `courses/_shell-for-testsuite/`.

## Pull requests

Fork and open a pull request; nobody needs push access to `main`. Keep them small and reviewable —
one behaviour change per pull request, with the model change in the same commit series.

The pull-request template asks about testing, privacy, models, and migration. Answer it honestly;
"not applicable" with a reason is a fine answer, a blank checkbox is not.

Changes to security, privacy, grading-correctness, or deployment paths get extra review and may sit
longer. That is deliberate.

### During a semester

Deployed release lines accept only privacy, security, grading-correctness, data-loss,
accessibility, or submission-blocking fixes. Feature work targets the next minor version. If your
change alters behaviour a running course depends on, say so explicitly and propose a migration note.

## Reporting a bug well

Use the issue form. What actually helps:

- The **exact version** (`package.json`, or the release tag you deployed).
- Environment: browser and version, device, operating system.
- What you expected, what happened, and how to reproduce it.
- **Redacted** diagnostics. Reproduce with `courses/demo/` where you can — a demo-course
  reproduction is worth far more than a description of a private course.

## Attribution

Contributors are credited in [`AUTHORS.md`](AUTHORS.md). Contributions are accepted under the terms
in [`LICENSE`](LICENSE).
