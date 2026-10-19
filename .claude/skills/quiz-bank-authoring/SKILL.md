---
name: quiz-bank-authoring
description: Draft, red-team and hand off a ~100-question OralScale bank for a new quiz from recent lectures. Use when the instructor asks to create or revise a quiz bank ("make the Quiz N bank from last week's lectures"), to audit a draft bank against the question-design guidelines, or to build the review worksheet for a bank.
---

# Quiz-bank authoring

This skill does not hold the rules for good questions. The guideline documents do, and they
change as the instructor reviews each quiz. The skill does two things: it loads those documents
into context, and it runs the workflow that previous quizzes established. When the skill and a
guideline document disagree, the document wins.

## 0. Hard limits (read before anything else)

- Never run, read or reimplement `tools/audit-accommodations.js`. Never open any file matching
  `*accommodation*`, `*roster*`, `*.keys.csv` or `accommodations.json`. See the root `AGENTS.md`.
- Course content stays in the course's private folder, `courses/<id>/`. Nothing about the course
  goes into engine files, commits, issues or public text: no question text, answer keys,
  evidence, topics or course names.
- Draft only. Do not freeze the bank, add it to `course.json`, package it, deploy it or mint
  links unless the instructor explicitly asks. Do not commit unless asked.

## 1. Load the guidelines (every time, in this order)

Read these files in full. Do not skim; each one holds rules the others lack.

1. `courses/<id>/question-design.md` holds **this course's** rules: what is measured, what is
   refused, how scores are priced, cohort notes, and the "Lessons from …" sections added after
   each review. It overrides the engine documents.
2. `docs/guides/QUESTION-DESIGN-GUIDE.md` holds the engine-wide rules. Step 6 covers first-read
   clarity and Step 7 gives nine principles for prompts and keys.
3. `docs/reference/bank-generation-spec.md` holds the JSON schema, the hard requirements, and
   the LaTeX the student app can render.
4. `docs/reference/LOCAL-GRADING.md`, section "Authoring future banks", specifies the
   `gradingContext` contract: `R1…`/`O1…` meanings and sufficient examples.
5. `courses/AGENTS.md` is the authoring workflow and the list of things to escalate.

Then study the most recent previous quiz as the working template:

- its draft folder, `courses/<id>/drafts/quiz-NN/`: the authoring files, `build.py`, and
  `red-team-audit.md`
- its review notes, `drafts/quiz-NN-review-notes.md`
- its frozen bank, `banks/quiz-NN.json`
- its assignment entry in `course.json`, which fixes the point scheme to match

Also read any instructor feedback recorded since then: worksheet notes pasted into a session,
commit messages, and new "Lessons" sections.

## 2. Establish scope from the sources

- Find the lectures. Frozen decks, transcripts and delivery summaries usually live in the
  curriculum repository. Ask for the path if it is not in the course README or memory.
- "Last week" means the meetings of the previous calendar week. Use each delivery summary to
  learn what was **actually shown**, and exclude slides that were prepared but never shown.
  Material the previous quiz already covered or excluded needs a deliberate decision.
- Copy the slide sources, transcripts and summaries verbatim into
  `courses/<id>/sources/quiz-NN/`, and write a `source-manifest.json` with their SHA-256 hashes.
- Read every source completely: slides, speaker notes and transcript. Note where the lecture
  spent its time. Coverage follows emphasis, not the slide count.

## 3. Draft

- Copy the previous quiz's authoring layout, which is `common.py` + `items_*.py` + `build.py`.
  Each topic group is `G(topic, day, principle, courseExplanation)`, and each question is
  `Q(difficulty, kind, prompt, R=[(meaning, sufficientExample), …], O=[…], ref, err, ev)`.
  Follow the course's current rule for how many criteria to write; in the pilot course that is
  one core criterion per explicit ask in the prompt, and as many supporting criteria as are
  natural. For each core criterion, name the clause of the prompt it answers.
- Plan the topic groups by lecture emphasis. Then target the mixes in `question-design.md`: the
  difficulty split (usually 25/50/25) and the kind mix, including at least 11 spot-the-flaw
  items, each quoting its claim.
- Every question needs **verbatim** evidence: two or three quotes from the source files that
  show the principle was taught. Copy them character for character, keeping speech-to-text
  errors.
- Write the reference answer as a spoken answer, not as the criteria joined together. Write
  each misconception for the question it belongs to.

## 4. Build and red-team (iterate until clean)

Run the quiz's `build.py`. It must refuse a bank that breaks a hard rule, and it writes the
bank, `audit-metrics.json` and the worksheet. At minimum it checks:

- criteria counts, reference-answer length, the difficulty split and duplicate prompts
- evidence found verbatim in the named source file
- criteria that start with a pronoun
- prompts that do not render through `web/js/richtext.mjs`
- spot-the-flaw items without a quoted claim
- core criteria whose wording overlaps the prompt, flagged for manual review

Then run three passes and fix everything they find. Where a fix touches a prompt, recheck the
key against the revised ask.

1. **Prompt against key, question by question.** For each item, check that:
   - every core criterion is asked for, and neither is stated in the stem
   - the two core points can be lost independently, and either alone is a sound but
     simplified answer
   - the student needs no retrieval step before starting to reason
   - it asks at most two things
   - every symbol is bound before it is used
   - it is answerable aloud in two minutes
   - the facts are correct
   - it uses the same vocabulary as its key
2. **The student's eye.** Read all prompts without their keys. Could a prepared student
   restate each task after one reading?
3. **Scans.** Check for:
   - words in the prompts that never appear in the sources (untaught terminology)
   - sentences over about 30 words
   - near-duplicate prompts
   - criteria that read like a list the student must recite
   - supporting points that restate their own core point
   - unverified premises in stems

Finally, run the engine checks:

```bash
node tools/validate-bank.js courses/<id>/drafts/quiz-NN.json
node tools/check-bank-evidence.js courses/<id>/drafts/quiz-NN.json --root courses/<id>
node tools/check-course-safety.js && node tools/check-secrets.js --all
```

Also build a local-grader request for every item through `autograder/source/localcontext.py`,
and compare its size with the previous quiz's.

Record every finding and fix in `drafts/quiz-NN/red-team-audit.md`. Include the decisions you
are leaving to the instructor and the honest limits of the audit, for example that no Qwen
evaluation was run and that the bank was self-reviewed.

## 5. Worksheet and handoff

```bash
node tools/bank-worksheet.js courses/<id>/drafts/quiz-NN.json -o courses/<id>/quiz-NN-review.html --title "Quiz N"
```

The worksheet is shuffled in an order fixed by the bank hash and shows every question ID. Each
question gets Keep / Revise / Remove and a note, and **Copy feedback** turns the notes into
`qN-0XX [status] note` lines. It is gitignored because it contains the answer keys.

Open it in the browser pane and confirm three things: math renders, a note survives a reload,
and nothing overflows at phone width. Then clear any test notes.

Write `drafts/quiz-NN-review-notes.md`, covering scope and exclusions, the topic table,
grading, how to rebuild, and how to give feedback. Add a short section to the course README.

## 6. After the instructor's feedback

- Apply the edits to the authoring files and rebuild. The new hash reshuffles the worksheet.
- **Turn every correction that generalizes into a guideline.** Add it to `question-design.md`
  if it is specific to this course, or to Step 7 of `QUESTION-DESIGN-GUIDE.md` if it holds for
  any course, which also means updating the public-guide review. Write each one as a testable
  check. Add the check to `build.py` where it can be automated. **Do not add question-writing
  rules to this skill**; it only points to them.
