# OralScale — Pilot Release Plan

_Captured 2026-08-21. Reviewed and decided 2026-08-22. Decisions marked **DECIDED** are settled;
the rest is an implementation checklist. Verified claims are marked **VERIFIED 2026-08-22**._

## Goal

Release a clearly experimental version of OralScale to a small group of invited faculty while:

- preserving attribution for David I. Inouye;
- allowing colleagues to use it, report problems, and propose improvements;
- avoiding claims that the software or any deployment is FERPA-compliant;
- keeping students from seeing the internals while the assessment design is still live;
- keeping changes reviewable and semester deployments stable; and
- leaving a practical path toward a broader open-source release or future commercialization.

## Shape of the first pilot — DECIDED

Use the `inouye-lab` GitHub organization. The engine repository stays **private** and is shared
with a small number of invited faculty with Read or Triage access. It is **MIT-licensed to them**,
but not published publicly yet: students should not be able to read the integrity mechanism while
it is grading them. Private-but-MIT is a deliberate position, not a contradiction — the licence
governs what recipients may do; publication timing is separate.

Do not distribute detached copies: they lose version history and fragment bug reports.

Create an immutable GitHub prerelease from a tested commit: **`v0.1.0-alpha.1`**. Pilot deployments
pin that tag rather than following `main`.

Faculty use **Discussions** for open questions, **Issues** for reproducible bugs and accepted work,
**private security reporting** for vulnerabilities, and **forks + pull requests** for changes. No
pilot participant needs push access to `main`.

---

## Repository and course layout — DECIDED

### The split

Course content leaves the engine repository entirely. Three repositories:

| Repository | Visibility | Contents |
|---|---|---|
| `inouye-lab/oralscale` | Private (MIT, shared with invited faculty) | Engine, docs, demo course only |
| `<private-org>/oralscale-<archive-course>` | Private (Inouye only) | Backfilled historical bank |
| `<private-org>/oralscale-<pilot-course>` | Private (Inouye only) | Live Fall 2026 course + Oral Quiz 0 |

The engine keeps its existing `inouye-lab/oralscale` remote.

**Naming convention:** `oralscale-<course><term>` — lowercase course number, no space, term as
`fall2026` / `spring2026`. Short form (`chem101`, not `chem10100`) for one reason that matters: the
directory name should match the `courseId` inside `course.json`, and `<pilot-course>` is already
that value in production.

> ⚠️ **Do not rename `courseId: "<pilot-course>"`.** It is an HMAC input for student IDs and
> access keys (`server/lib/protocol.js:433–449`). Changing it silently invalidates every quiz key
> already minted for Fall 2026. The repository name may differ from the `courseId`; the `courseId`
> is load-bearing and the repository name is not.

### Provenance relabel — DECIDED

**VERIFIED 2026-08-22:** the 14 existing banks were generated from **an earlier course's** lecture
content (the course's own `curriculum-analysis.md`, mapped from the Spring 2026 baseline), but every bank
header reads the current course's title.

Relabel them as what they are: historical questions backfilled from an earlier course's lecture
content, **not** the current pilot-course question set. This is a metadata edit
(`course`, `bankId`, `createdWith` provenance note) across 14 files — no question text changes.

They then move to `oralscale-<archive-course>` as a reusable archive.

### The pilot course starts with Oral Quiz 0 — DECIDED

`oralscale-<pilot-course>` gets one bank to begin with: **Oral Quiz 0**, an ungraded prerequisite
check that doubles as the students' first run through the system. Recommended scope ~40 questions
covering linear algebra, probability, calculus, and Python fluency — enough for a random draw
without the authoring cost of a full 100-question bank, and it is ungraded, so bank-mining is not
a threat. Remaining weeks are authored from Fall 2026 lecture content as the semester proceeds.

### New `courses/` structure

Course configuration and question banks live together, so a course folder is one self-contained
private repository that clones into place:

```
courses/
  README.md            what a course folder is; private-repo guidance
  AGENTS.md            agent-guided authoring workflow (below)
  _template/           skeleton to copy
  demo/                ships with the engine — works out of the box
    course.json
    question-design.md
    banks/
  <your-course>/       a separate PRIVATE repo, cloned or submoduled here
```

The top-level `banks/` directory goes away; `banks/starter/general-stem.json` becomes the demo
course's bank. **The demo bank should be generic high-school math and science** so a new faculty
member can run a real end-to-end quiz within minutes of cloning, without authoring anything.

**Fail-safe `.gitignore`:** ignore `courses/*` and allow-list only `README.md`, `AGENTS.md`,
`_template/`, and `demo/`. A newly created course folder is then private by default — the mistake
that leaks a live bank has to be made deliberately.

### `courses/AGENTS.md` — the authoring workflow

A coding agent reading this file should be able to walk an instructor from lecture material to a
validated bank:

1. **Ingest** — instructor drops lecture slides, notes, or a syllabus into `sources/`.
2. **Guidelines** — agent helps fill in `question-design.md` (what to measure, what not to ask,
   cohort notes) from those sources.
3. **Generate** — author questions against `docs/reference/bank-generation-spec.md`.
4. **Validate** — `npm run validate` against the bank schema; fix and repeat until clean.
5. **Freeze** — commit to the instructor's private course repository.

### Backup warning for un-remoted course folders — DECIDED

A course folder holds hand-authored questions that are expensive to lose and damaging to leak.
Add a check that runs with the course-loading tools: if a course directory is not a git repository,
or is one with no remote, print a visible warning recommending a **private** remote.

Dismissible **permanently** via an environment variable (suggested:
`ORALSCALE_ACK_COURSE_UNBACKED=1`, documented in `.env.example`), and **not** otherwise — it
repeats every run until the instructor either backs the course up or explicitly opts out.

---

## Release gates, in order

### 1. Licence and attribution — DECIDED

- **Licence: MIT**, `Copyright (c) 2026 David I. Inouye`. Add the `LICENSE` file.
- Fix `package.json`: it currently declares `"license": "MIT"` with no `LICENSE` file backing it.
- **README acknowledgement note** — a friendly, non-binding request (MIT does not require it) that
  adopters cite or link back. Standard academic practice; keep it a courtesy, not a condition.
- **Student-app footer**, muted but visible:

  > Open source under the MIT License. Created by [David I. Inouye](https://www.davidinouye.com).

  Deliberately **no** repository link and **no** version string: the student app should not point
  at the internals, and students do not file bug reports. Version belongs in instructor-facing
  output and `CHANGELOG.md`.
- `CITATION.cff` and/or `AUTHORS.md` remain the durable scholarly attribution.

> **Assumption of record:** this proceeds on the instructor's decision to licence under his own
> name. Purdue's IP policy may still govern ownership of software developed with university
> resources. That is a question worth putting to OTC or the Copyright Office in parallel — it does
> not block the private faculty pilot, but it should be answered before any public release.

### 2. Separate reusable software from private course content

- Move the 14 relabelled banks to `oralscale-<archive-course>`.
- Create `oralscale-<pilot-course>` with `course.json` and the Oral Quiz 0 bank.
- Restructure `courses/` and retire top-level `banks/` as described above.
- **Purge course content from engine git history.** The banks are in all 41 commits, so deleting
  the files does not hide them from anyone who clones. Use `git filter-repo --path banks/ --path
  courses/<pilot-course> --invert-paths`, then force-push. Every existing clone must be re-cloned;
  confirm no collaborator holds one before rewriting.
- **VERIFIED 2026-08-22 — history is otherwise clean.** Every file ever added across all branches
  was checked: the only sensitive-looking matches are `.env.example` and
  `autograder/source/secret.env.example`. No `.env`, no roster, no `*.keys.csv`, no built
  autograder archive, no model weights have ever been committed.

### 3. Produce one coherent alpha candidate

- **DONE** — the working tree is clean and the 41-commit history is coherent. (The earlier note
  about a large uncommitted change is stale.)
- Set `package.json` to `0.1.0-alpha.1`. The current `0.2.0` was never published; the public series
  starts at 0.1.0 by decision, and the internal v7.x labels retire into `CHANGELOG.md` as history.
- Make setup and build inputs reproducible: pin tool, Python-package, and model revisions; record
  model-file checksums where practical.
- Third-party notices for Qwen and Whisper. Note the scope is **attribution, not redistribution** —
  `.gitignore` excludes `autograder/source/models/`, and weights download at image-build time.
- Build release artifacts from a clean checkout, not a developer workspace.

### 4. Make documentation match the actual system

- **`docs/project/MOTIVATION.md:30` calls Gradescope "the FERPA-compliant system of record."** Fix this
  specific line — it is exactly the claim this plan forbids.
- Remove stale descriptions of personal links, rolling codes, and GenAI-only grading.
- Make the student privacy disclosure reflect the selected backend. It must not say every
  transcript goes to Purdue GenAI when local grading is in use.
- Replace Purdue-specific compliance implications with an adopter-responsibility statement.
- Document known limitations, supported devices/languages, accessibility status, residual risks,
  required human review, and the experimental nature of automated grading.

### 4b. Accommodations — case by case during the alpha, DECIDED

Extended time is supported (`gen-url.js --time-mult`) and the technical accessibility pass is done.
There is no single prescribed alternative format for a student who cannot use a spoken modality,
and for this pilot that is a decision rather than a gap: the participants are a small number of
named faculty who already handle accommodations through their own institutional process, and
prescribing a format before seeing one real case would be guessing.

`DISCLAIMER.md`, `README.md` and `docs/guides/PILOT-PACKET.md` say so plainly, set out the three options
from D2c with the live-oral-over-video default recommended, and **explicitly invite instructors to
propose what they did and report how it went**. That is the productive framing — the general answer
should come from real cases, and a solution that works two or three times is what earns its way
into being a feature.

Not a release blocker. Still on the list, in `docs/project/PARKING-LOT.md`: the Purdue DRC conversation,
and whether the typed real-time variant is worth building.

### 5. Add the release and contribution surface

`.github/` is currently **empty** — all of this is unbuilt, and it is the bulk of the remaining
work. Create and review:

- `LICENSE` (MIT, David I. Inouye);
- `DISCLAIMER.md` — alpha status, no warranty, no support guarantee, adopter responsibility for
  privacy, security, accessibility, grading, and institutional approval;
- `PRIVACY.md` — deployment-neutral data-flow document;
- `SECURITY.md` — private reporting route; warning not to post student data or secrets;
- `CONTRIBUTING.md` — model-first workflow, tests, pull-request expectations;
- `CHANGELOG.md` — user-facing release history, absorbing the v7.x labels;
- `CITATION.cff` and/or `AUTHORS.md`;
- structured bug and feature-request forms;
- a pull-request template with testing, privacy, model, and migration checks; and
- `CODEOWNERS` for security-, protocol-, grading-, privacy-, and deployment-sensitive paths.

### 6. Automated release evidence

**VERIFIED 2026-08-22 — all five suites green locally:**

| Suite | Result |
|---|---|
| `npm run test:unit` | 126/126 |
| `npm run test:worker` | 16/16 |
| `npm run test:e2e` | 44/44 in 1m50s |
| `npm run test:package` | 19/19 |
| `npm run test:banks` | 14/14, 1,414 questions |

The earlier note that E2E stalled is **stale** — it completes in under two minutes. The remaining
gate is therefore *enforcement in CI*, not diagnosis. Run on every pull request and again on the
release commit: unit, JS/Python interoperability, Worker, full E2E and attack suite, bank
validation, course smoke test, autograder package build and test, documentation/model/invariant
drift checks, secret scanning, and dependency/licence checks. Use explicit timeouts and archive
the result.

Note that bank validation and the course smoke test currently depend on course content that is
moving out of the repository — CI must run them against the **demo** course instead.

### 7. Protect stable code

- Protect `main` and active maintenance branches; require pull requests and passing status checks.
- Deploy courses from a tag, never automatically from the latest branch.
- Maintain a `release/0.1` line if the pilot needs patches while larger work continues.
- During a semester, accept only privacy, security, grading-correctness, data-loss, accessibility,
  or submission-blocking fixes into the deployed line.
- Put feature work and meaningful behaviour changes into the next minor release.
- Require an explicit upgrade decision, migration note, and rollback path for every deployed
  course. Do not auto-deploy dependency updates or agent-generated changes.

| Version | Meaning |
|---|---|
| `0.1.0-alpha.1` | First invited-faculty pilot snapshot |
| `0.1.0-alpha.2` | Additional pilot fixes before the baseline |
| `0.1.0` | First documented alpha baseline |
| `0.1.1` | Backward-compatible bug, security, or privacy fix |
| `0.2.0` | Meaningful new feature or workflow change |
| `1.0.0` | Stable compatibility commitments and broader production confidence |

### 8. Pilot deliberately

- Invite roughly three to five faculty initially.
- Give them a short pilot packet: alpha warning, supported environment, setup guide, known
  limitations (including 4b), privacy responsibilities, bug-report link, security contact, and
  exact version.
- **Reduce adoption friction aggressively.** This is an explicit goal: the demo course must work
  end to end from a fresh clone with no authoring, no cloud account, and no secrets beyond a
  locally generated one.
- Each faculty member needs their own Cloudflare account and signer secret. Document that
  provisioning path explicitly — it is currently assumed rather than written down.
- Ask each to test with themselves or synthetic data before involving students.
- Encourage institutional IT/privacy review before student use.
- Time-box the pilot and define **exit criteria** in advance: what result means expand, what means
  iterate, what means stop. Review setup failures, device failures, grading problems, privacy
  concerns, support burden, and requested changes.
- Define what happens at pilot end: revoking access, tearing down deployments, deleting data.

## Feedback and maintenance workflow

1. **Capture** — a structured report records version, environment, expected/actual behaviour,
   reproduction steps, and redacted diagnostics.
2. **Triage** — label severity and area.
3. **Schedule** — milestone, or defer to the next minor version.
4. **Remediate** — work on a branch; update the relevant model and invariant/test when behaviour or
   a hard property changes.
5. **Review** — require tests and human approval; extra review on privacy/security/grading paths.
6. **Release** — merge, tag, publish notes, state whether deployments should upgrade.
7. **Observe** — convert recurring failures into durable tests, documentation, or setup automation.

Initial labels: `bug`, `security`, `privacy`, `grading-correctness`, `release-blocker`,
`semester-safe`, `breaking-change`, `needs-reproduction`, `enhancement`, `backport-0.1`.

## Email intake and future automation

Do not automatically turn raw support email into public issues. Email may contain a student's name,
grade, transcript, audio, quiz key, deployment secret, or other protected information.

1. Auto-reply with the structured bug-report form and a warning not to include student data, audio,
   transcripts, quiz keys, or secrets.
2. Keep emailed reports in an institutionally appropriate private intake location.
3. Redact and summarise.
4. Require human approval before creating a repository issue.
5. Route vulnerabilities and suspected exposure through the private security process.

Later automation may classify, label, draft reproduction steps, or open remediation pull requests.
It must not autonomously publish sensitive reports, merge code, create releases, or deploy to a
live course. Automate evidence and triage; retain human authority over privacy, grading, releases,
and deployment.

## Still open

- Purdue OTC/Copyright determination on institutional ownership — parallel, not blocking.
- Whether preserving a proprietary dual-licence option justifies a contributor agreement.
- Purdue DRC answer on non-spoken accommodation format (4b).
- Which CI and security services are available for a private organization repository.
- Support expectations and response-time promises, if any.
- The date and criteria for expanding from invited alpha users to a public release.
- Oral Quiz 0 final question count and topic split.

## Next actions

### ✅ Done (2026-08-22)

| # | Action | Where |
|---|---|---|
| 2 | 14 banks relabelled as an earlier course's historical content | `courses/<archive-course>/banks/` |
| 3 | `courses/` restructured; top-level `banks/` retired; `README.md` + `AGENTS.md` written | `courses/` |
| 4 | Oral Quiz 0 authored — 100 questions, validated, smoke-tested | `courses/<pilot-course>/banks/` |
| 6 | Backup warning + `ORALSCALE_ACK_COURSE_UNBACKED` opt-out | `tools/lib/course.js` |
| 7 | `LICENSE`, student-app footer, README acknowledgement note | `LICENSE`, `web/index.html` |
| 8 | Release surface: `DISCLAIMER`, `PRIVACY`, `SECURITY`, `CONTRIBUTING`, `CHANGELOG`, `CITATION.cff`, `AUTHORS`, issue forms, PR template, `CODEOWNERS`, pilot packet | root, `.github/`, `docs/guides/PILOT-PACKET.md` |
| 9 | `docs/project/MOTIVATION.md` FERPA claim fixed; `package.json` → `0.1.0-alpha.1` | — |
| 10 | CI wired against the demo course | `.github/workflows/ci.yml` |
| — | Both course repos initialised locally with correct remotes and an initial commit | `courses/*/.git` |
| — | INV-COURSE-1/2/3 added to the models with `t_course_locality` | `models/02`, `models/07`, `tools/test-unit.js` |
| 1 | Engine committed and pushed; both course repos pushed to their remotes | all three remotes |
| 2 | **History purged and force-pushed.** Backup taken first | `../oral-scale-backup-2026-08-22/` |
| — | `_template/course.json` added, `local` grading default stated at length | `courses/_template/` |

**History purge — done, and it needed a second pass.** `git filter-repo` removed
`banks/<pilot-course>/` and `courses/<pilot-course>/` from all 42 commits, but a scan of every
blob still found the full banks reachable. The cause was two
`refs/codex/turn-diffs/checkpoints/…` refs — snapshots left by a previous Codex session, which
filter-repo does not rewrite because they are outside `refs/heads`, `refs/tags` and `refs/remotes`.
They were local-only and never pushed, but they would have kept the content alive in the local
clone indefinitely. Deleted, reflog expired, `gc --prune=now`, then re-verified from a **fresh
clone of the remote**: 0 occurrences of the private paths and 0 blobs containing a private question
id. *Anyone repeating this on another repository: check `git for-each-ref` for non-standard ref
namespaces before declaring a purge complete.*

The current tree is byte-identical across the rewrite (tree `bbda5f81`), which was the requirement.
39 commits from 42 — three became empty because they only ever touched purged paths.

**Backups, kept outside the repository at `../oral-scale-backup-2026-08-22/`:**
`engine-prepurge.git` (a `--mirror` clone: all 42 commits, all refs, full pre-purge history) and
`worktree-full-2026-08-22.tar.gz` (26 MB — the entire working tree including the untracked and
ignored private course folders and their own git repos).

**Gate status — all green, verified 2026-08-22:** unit 131/131, worker 16/16, e2e 44/44,
package 19/19, banks 1/1 (demo) + 14/14 (archive course in its own repo), course smoke green on
both `demo/starter` and the real `<pilot-course>/quiz-00-prerequisites`. All four CI-only checks
(course-content allow-list, invariant drift, version consistency, secret filenames) verified
locally.

### ⏳ Needs your judgment or your credentials

**1. ~~Rename the engine repository~~ DONE 2026-08-24.** `oral-scale` → `oralscale`. Remote and
all in-repo URLs updated.

**2. Purdue OTC / Copyright Office** on institutional ownership. Not blocking a private pilot;
should be answered before any public release.

**3. Decide the pilot exit criteria** before inviting anyone — what result means expand, what means
iterate, what means stop. `docs/guides/PILOT-PACKET.md` states support expectations but deliberately
leaves the success criteria for you.

**4. ~~Review `docs/curriculum-analysis.md` before inviting faculty.~~ DONE (2026-08-29).** It
shipped in the engine repo and held the week-by-week topic map with "oral-question seeds" — not a
frozen bank and not reference answers, but question-adjacent material derived from lecture content.
**Moved to `courses/<pilot-course>/curriculum-analysis.md`**, inside the private course folder, and
untracked from the engine. The whole point of the split was to stop shipping question material, and
this was the last of it.

**5. Deferred to `docs/project/PARKING-LOT.md`, deliberately:** a supported alternative accommodation format
(R8 — case by case for now, learning from the pilot), and a human read-through of Oral Quiz 0.
