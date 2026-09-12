# `courses/` — course configuration and question banks

A **course folder** is everything specific to one course in one term: its configuration, its
question banks, and the design notes behind them. Code stays generic and lives outside this
directory (FR-8).

```
courses/<courseId>/
  course.json          configuration: assignments, defaults, salt, signer URL
  banks/               frozen question banks, one per assignment
  question-design.md   what you are measuring and what you refuse to ask
  sources/             lecture material the banks were authored from
  calibration.json     OPTIONAL, produced by tools/calibrate-grader.py
  dist/                GENERATED, gitignored autograder zip for this course
```

## A course folder should be its own private git repository

**Two reasons, and both of them bite.**

*Losing it.* A semester of banks is many hours of authoring. It lives on one laptop until you
put it somewhere else.

*Leaking it.* A bank contains the questions **and** the reference answers. A student who reads it
has the assessment. Public repository, public gist, shared drive with a link — any of those ends
the integrity property the rest of this system exists to protect.

So: private repository, own remote, not a subdirectory of the engine repo.

```bash
git -C courses/<courseId> init
git -C courses/<courseId> add -A
git -C courses/<courseId> commit -m "Initial course content"
git -C courses/<courseId> remote add origin git@github.com:<you>/oralscale-<courseId>.git
git -C courses/<courseId> push -u origin main
```

The tools warn on every run while a course folder is not a git repository with a remote. The
warning is a nag by design. Silence it permanently only when you have made a deliberate choice:

```bash
export ORALSCALE_ACK_COURSE_UNBACKED=1
```

## What ships with the engine, and what does not

| Folder | In the engine repo? | Why |
|---|---|---|
| `demo/` | Yes | Works out of the box with no authoring. General STEM questions. |
| `_template/` | Yes | Skeleton to copy for a new course. |
| everything else | **No** | Private course content. `.gitignore` excludes it by default. |

The `.gitignore` allow-lists rather than blocks: a course folder you create is private unless you
deliberately make it otherwise. Check before you assume — `git check-ignore -v courses/<courseId>`.

`dist/` is also ignored inside each course repository. Its autograder zip contains the signing
secret and may contain a GenAI key in plaintext; co-location prevents course mix-ups, but the
artifact must never be committed, emailed, or placed in a broadly shared drive (INV-DEPLOY-2).

## Naming

`<coursenumber><term>` — lowercase, no spaces: `chem101-fall2026`, `phys211-spring2026`. The
repository is then `oralscale-<courseId>`.

> ⚠️ **`courseId` is cryptographic input.** It is hashed into student identifiers and quiz keys
> (`server/lib/protocol.js`). Renaming it invalidates every key already issued for that course.
> Pick it once, before you mint keys, and leave it alone. The repository name is free to differ.

## Starting a new course

1. `cp -r courses/_template courses/<courseId>` and fill in `course.json`.
2. Generate a **fresh** `pseudonymSalt` — never copy one from another course.
3. Drop lecture material into `sources/`.
4. Follow [`AGENTS.md`](AGENTS.md) to author and validate the banks.
5. Put the folder in its own private repository (above).

## Bank paths

Paths in `course.json` are resolved **relative to the `course.json` itself**, so a course folder
never needs to know where it was cloned. Write `banks/week-04.json`, not
`courses/<id>/banks/week-04.json`. Repo-root-relative paths from before the split still resolve,
but new courses should not use them.
