# `courses/` — authoring workflow for coding agents

You are helping an instructor turn lecture material into a **frozen question bank**. This file is
the procedure. The reasoning behind it is [`docs/guides/QUESTION-DESIGN-GUIDE.md`](../docs/guides/QUESTION-DESIGN-GUIDE.md);
the schema contract is [`docs/reference/bank-generation-spec.md`](../docs/reference/bank-generation-spec.md).

## 🚫 Never run or read the accommodation audit

`tools/audit-accommodations.js`, its roster CSV, and its output are off limits. Do not run it, do
not read its inputs or outputs, do not reimplement it. Tell the instructor the command and stop.
Its data names students who hold disability accommodations and must never reach a model's context,
a transcript, or a log. Full statement in the root [AGENTS.md](../AGENTS.md).

## Ground rules

1. **The instructor owns the questions.** Draft, then have them read. Never freeze a bank the
   instructor has not reviewed.
2. **Never invent course content.** Every question traces to something in `sources/`. If the
   material does not cover a topic, say so rather than filling the gap from general knowledge.
3. **Course content stays private.** Never copy bank content into the engine repo, a public gist,
   an issue, a pull request, or anywhere outside the course folder.
4. **Frozen means frozen.** Once students have sat an assignment, editing its bank changes what
   different students were assessed on. Make a new bank instead.
5. **Text, never HTML.** Question prompts render as plain text (INV-SEC-6). Markup will show up
   literally.

## Step 1 — Ingest

Ask for lecture slides, notes, a syllabus, or a reading list, and put them in `sources/`. Read
them before writing anything. Report what you actually found: weeks covered, topics per week, and
any gap where a week has no usable source material.

## Step 2 — Design guidelines

Fill in `question-design.md` **with** the instructor, from the sources. It is the input to every
bank, and it is one page. The parts that do the work:

- **What you are measuring** — the durable principles, not the procedures.
- **What you refuse to ask** — definitions, recall, anything answerable by naming a term.
- **Cohort notes** — e.g. many students are not native English speakers, which is why the grader
  is told to grade ideas rather than fluency.

If the instructor is unsure, propose a draft from the sources and let them correct it. That is
faster than an interview.

## Step 3 — Generate

Author to `docs/reference/bank-generation-spec.md`. Target **~100 questions per assignment** so that a bank
survives students comparing notes.

Required per question: `id`, `prompt`, `keyPoints`. Also fill `topic`, `principle`, `difficulty`,
`kind`, and `rubric`.

**`keyPoints` is REQUIRED-ONLY (INV-GRADE-9): one core point per explicit ask in the prompt**, so
one or two per question — `validate-bank.js` warns above four. Each must be a substantive answer
that, said correctly on its own, is already a sound if simplified answer. Everything that merely
makes an answer stronger goes in `bonusPoints`, which both graders are told may never cost a mark.
The test for each point: would an answer without it be **wrong**, or merely **weaker**? And
anything you make required must be explicitly asked for in the prompt — a student cannot be marked
down for not answering something they were not asked. The recommended rules (points curve, hard
limits on prompts, style) are Part B of the course's `question-design.md`; a new course copies it
from `courses/_template/question-design.md`.

**Fill `referenceAnswer`, `commonErrors`, `evidence` and `gradingContext` too.** They are optional
in the schema and near-mandatory in practice: they are the measured difference between a small
local grader and a large one (`docs/reference/LOCAL-GRADING.md`, `tools/eval/`). `gradingContext`
gives the local grader a checked explanation and one sufficient example per point, with IDs `R1…`
matching `keyPoints` and `O1…` matching `bonusPoints` in order. A points-mode bank may omit
per-item `scoringBands`. `courses/demo/banks/general-stem.json` is a worked example.

Aim for a spread of `difficulty` (roughly 25 / 50 / 25 intro / core / stretch) and a mix of `kind`.
A bank that is all `explain` gets predictable fast.

Write prompts a student can answer **aloud in two to three minutes**. Read one out loud. If it
needs notation, a diagram, or a calculation, rewrite it.

### Naming an assignment

**Keep the assignment id generic: `quiz-03`, not `quiz-03-attention-and-transformers`.**

The id is not private. It is printed in the student app when nothing better is available, it is
carried inside every student link (where anyone can base64-decode it), and it is the autograder
zip's filename. An id that names the week's subject is therefore a topic hint attached to the quiz
before a single question has been served.

It also has to stay true. A quiz gets re-scoped, or becomes a review drawing on several weeks, and
an id chosen from the first draft's topics is then actively misleading — and renaming it means
renaming the bank, the Gradescope assignment and the zip.

Every assignment must also set **`shortTitle`** — the short, topic-free label students actually see
("Oral Quiz 3"). It is required: `gen-url.js` refuses to mint a link without it and
`check-course-safety.js` refuses the commit. It is display only, so adding one to an existing course
changes nothing anybody is graded on. Matching the Gradescope assignment name is useful, not
required.

*(Two pilot quizzes predate this and are left
alone — renaming a released assignment costs more than the hint is worth. From `quiz-03` on, plain
numbers.)*

## Step 4 — Validate

```bash
node tools/validate-bank.js courses/<courseId>/banks/<bank>.json
```

Fix and repeat until clean. Build the instructor review worksheet with
`node tools/bank-worksheet.js <bank.json>`. Then check the whole course:

```bash
node tools/validate-all-banks.js courses/<courseId>/banks
node tools/test-course-smoke.js --course courses/<courseId>/course.json --assignment <assignmentId>
```

The smoke test is the one that catches a bank that validates but does not actually serve.

**If your questions carry `evidence` quotes, check them.** Add a `sources` array to the bank
listing the files the quotes come from (paths relative to the source repository), then:

```bash
node tools/check-bank-evidence.js courses/<courseId>/banks/<bank>.json --root <source-repo-dir>
```

This exists because of a real failure mode, and it is not fabrication — it is **drift**. Reading a
speech-to-text transcript, an author naturally tidies: drops the stumble, joins two sentences the
ASR split, quietly repairs a garbled word. Every one of those edits makes the quote read better
and makes it a worse record of what was said, and none of them look wrong on the page. The first
pass over a real week-1 bank had 15 such fragments out of 182. Quote verbatim, mark elisions
with `...`, and leave the garbles in — the `source` field already says it is a transcript.

## Step 5 — Freeze

Commit to the course's **own private repository**, with a message naming the source material and
the date. Record the bank `sha256` that `validate-bank.js` prints — that is what makes "the bank
students actually saw" a checkable claim later.

## What to escalate rather than decide

- A question that depends on material the sources do not cover.
- Anything touching accommodations or a student's individual circumstances.
- A request to change a bank after students have sat it.
- Any prompt where you are unsure whether it asks for a principle or a procedure — that judgement
  is the instructor's whole point.
