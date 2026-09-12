# Course governance — one folder is the whole course

**A course folder is self-contained. Everything that belongs to a course lives under
`courses/<courseId>/`, and nothing a course needs lives anywhere else.**

Copy that one directory, or clone that one repository, onto another machine and you have a
working course. That is the test. If something has to be fetched from the engine repo, carried
by hand, or remembered, the rule has been broken.

## Why this is a rule and not a preference

Course folders are meant to be **separate private repositories** cloned into `courses/`, because a
Bank holds the questions *and* the reference answers — publishing one ends the assessment. That
separation only works if the folder is complete. A signing Secret parked in the engine repo is a
portability bug wearing a tidiness costume: the course looks fine, travels fine, and then every
certificate fails to verify on someone else's machine, for reasons nothing in the folder explains.

It happened. Secrets used to live in `secrets/<courseId>.json`, beside the engine rather than the
course, and the resolver fell back to a *shared* file when one was missing — so whichever course
wrote that file last decided what every other course signed with. A public demo link went out
signed with a different course's Secret. Nothing in the link looked wrong; it failed only in a
student's hands.

## What lives in the folder

| | |
|---|---|
| `course.json` | Config: assignments, limits, grading backend, policies. **Committed.** |
| `banks/` | The question Banks. **Committed** (to the course's own private repo). |
| `question-design.md`, `sources/` | Authoring notes. **Committed.** |
| `.gitignore` | Written automatically; ignores everything below. **Committed.** |
| `.env` | `ORALSCALE_SECRET`, and optionally this course's `GENAI_STUDIO_*`. **Never committed.** |
| `<courseId>.keys.csv` | Minted quiz keys, paired with student emails. **Never committed.** |
| `<courseId>.brightspace-import.csv` | The same keys in LMS import shape. **Never committed.** |
| `accommodations.json` | Extended-time grants by opaque ref. **Never committed.** |
| `autograders/` | Built Gradescope zips — each contains the Secret in plaintext. **Never committed.** |

Every generator writes into the course folder. None of them writes anywhere else.

## The Secret

- **One per course, no exceptions and no fallback.** It is read from `courses/<id>/.env`, or from
  the course-scoped `ORALSCALE_SECRET_<COURSEID>` for CI. A bare `ORALSCALE_SECRET` is deliberately
  ignored: it is a whole-shell value, so a terminal holding one course's Secret would silently sign
  another course's artifacts.
- **No two courses may hold the same value.** Checked programmatically before minting, before
  building, and at commit time — including against `_template` and the test fixtures, because the
  way a Secret gets shared is by copying a folder that had one. **A clash refuses the build.**
- **A course with no Secret cannot be built.** The tools fail and offer to create one.
- `_template` deliberately ships **without** `.env`. A skeleton carrying a Secret is a Secret shared
  by every course ever copied from it.

## The guards, and when they are installed

`.gitignore` and a `pre-commit` hook are written **before** anything secret is generated — by
`make-config.js` before it mints, by `gen-access-keys.js` before it writes keys, and by
`build-autograder.js` before it packages. Protection that arrives after the artifact leaves a
window, and the window is exactly when a folder full of new files invites `git add -A`.

The hook is installed in **both** repositories that can hold the folder: this engine repo, and the
course's own repo when it is a separate checkout.

**The hook is a backstop, not the plan.** A key export pairs student emails with credentials and is
dangerous while it exists, not only once it is committed. Upload it to Brightspace, then delete it.
Keys are derived rather than stored, so you can regenerate them whenever you need them.

## Built-in courses are not yours to re-key

`_template`, `demo`, `_testsuite` and `_shell-for-testsuite` ship with OralScale and keep the
Secrets they ship with. `make-config.js --force` **refuses** to rotate them.

This matters at exactly one moment: a Secret clash. You started a course by copying a built-in
folder, `.env` came along, and now two courses hold one Secret. The error names *both*, and the
tempting fix is to rotate whichever one is mentioned first. If that is the built-in, the message
goes away and the real problem stays — your course is still signing with a Secret every other copy
of that folder also has, and you have quietly re-keyed the skeleton every future course is copied
from, or a fixture the test suite depends on.

**Change your own course.** The tools say so, and name the command for *your* course, not the
built-in.

## Rotating replaces `.env`, on purpose

`make-config.js --force` rewrites the file to contain the new `ORALSCALE_SECRET` and **nothing
else**, and prints what it removed.

The reason to rotate is almost always that the file was copied from another course — which means
every *other* line in it was copied too: that course's `GENAI_STUDIO_API_KEY`, its settings. Keeping
them would leave this course quietly using another course's credentials, which is the same bug one
layer down. Add back by hand only what genuinely belongs to this course.

## Starting a new course## Starting a new course

```bash
npm run setup                      # scaffolds courses/<id>/, offers to create the Secret
```

Or by hand: copy `courses/_template/`, rename it, then

```bash
node tools/make-config.js --course courses/<id>/course.json
```

which installs the guards, creates `.env`, and refuses any value another course already holds.
