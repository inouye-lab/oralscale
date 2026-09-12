## What this changes

<!-- One paragraph. What behaviour is different afterwards? -->

## Why

<!-- The problem. Link the issue or discussion if there is one. -->

---

### 🚨 Content safety

- [ ] No student data, secrets, quiz keys, or question-bank content in the diff, the commits, the
      tests, or this description.
- [ ] No private course content added under `courses/` (course folders belong in their own private
      repositories).

### Model-first

The models in `models/` are the source of truth — a behaviour change without a model change gets
sent back.

- [ ] Relevant model in `models/` read and updated in this change, **or** no behaviour changed.
- [ ] Any new hard property has an `INV-` ID in `models/02-requirements-and-invariants.md` and a
      test in `models/07-test-model.md`.
- [ ] Any open decision is recorded in `docs/project/DESIGN-QUESTIONS.md` with a best guess.
- [ ] `docs/project/STATUS.md` updated as a handoff.

### Tests

- [ ] `npm run test` green (unit + Worker + E2E).
- [ ] Suites for what this touches: `test:package` / `test:banks` / `test:course`.
- [ ] Every touched invariant still passes its test.
- [ ] New tests depend only on `courses/demo/` or `courses/_shell-for-testsuite/` — never private content.

Paste the result line(s):

```
```

### Privacy and security

- [ ] No Secret, API key, or PII reaches the repository, the web bundle, logs, or a URL.
- [ ] No new outbound data flow. **If there is one, describe it here and update `PRIVACY.md`.**
- [ ] Signed-token verification stays constant-time; input validated before crypto or database work.
- [ ] JS signer and Python autograder remain byte-compatible on tokens (`t_signature`).

<!-- If any box above is unchecked, explain here. -->

### Dependencies

- [ ] No new runtime dependency, **or** it is noted in `docs/project/STATUS.md` with a justification.
- [ ] Still runs locally with no cloud account.

### Migration and deployment

- [ ] Backward compatible for a course mid-semester, **or** a migration note is included below.
- [ ] `CHANGELOG.md` updated under `[Unreleased]`.

**Should existing deployments upgrade?** <!-- yes / no / only if affected by … -->

**Migration note and rollback path:** <!-- or "none needed" -->
