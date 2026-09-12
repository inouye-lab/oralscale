# Question design — <YOUR COURSE>

_Copy this file to `courses/<your-course-id>/question-design.md` and fill it in. It is the input
to every question bank you generate. Walkthrough and reasoning:
[docs/guides/QUESTION-DESIGN-GUIDE.md](../../docs/guides/QUESTION-DESIGN-GUIDE.md)._

_Keep it short. One page is the right length. You will reread this in week 9._

---

## Course and audience

- **Course:** <e.g. CHEM 101 — General Chemistry>
- **Level:** <senior undergraduate / mixed undergrad+grad / …>
- **Assumed background:** <linear algebra, probability, some Python>
- **Cohort notes:** <e.g. "roughly half are international students; English is not their first
  language" — this matters, because it is why the grader is told to grade ideas rather than
  fluency, and why a hesitant answer is not a wrong one>

## What I am trying to measure

**In one sentence:**
> <e.g. "Whether they understand why each method is built the way it is, and can tell when one is
> the wrong choice — not whether they can execute it.">

**Primary goal:** <conceptual understanding | judgement | diagnosis | formalisation | procedural
fluency | synthesis>

**Secondary goals:** <at most two>

## What a score will mean

- **Near full marks** — the student has demonstrated that they can: <…>
- **Around half** — the student has probably: <…>
- **Near zero** — the student most likely: <…>

## Explicitly out of scope

<The things you will NOT ask about. Just as useful to a bank generator as what you will.
e.g. "No coding. No library APIs. No derivations longer than two steps. Nothing that needs a
number computed. Nothing from the optional reading.">

## Difficulty, in this course's terms

- **`intro`** (~25%): <what counts as intro *here*>
- **`core`** (~50%): <…>
- **`stretch`** (~25%): <…>

**Calibration check:** a student who has attended lectures but not studied should pass most
`intro`, get roughly half of `core`, and fail `stretch`. Revisit after week 1 against the real
score distribution — and fix it by moving items between pools, not by rewriting the bank.

## Per-attempt shape

- **Questions per attempt:** <3>
- **Time per question:** <120> seconds
- **Difficulty mix across the slots:** <e.g. `["intro","core","stretch"]` — warm-up, spine,
  discriminator>

## Weekly topics and their principles

_One line per week. Name the **principles**, not the vocabulary — a topic list produces questions
about words, a principle list produces questions about ideas._

| Week | Topic | The 2–3 principles this week is really about |
|------|-------|----------------------------------------------|
| 01 | <…> | <…> |
| 02 | <…> | <…> |
| 03 | <…> | <…> |

## Sources

_What the bank is generated from. Files live in `sources/` and are kept, not consumed — they are
how you regenerate a week in November after deciding it drifted._

- [ ] **From topics only** — the table above is the whole input
- [ ] **From my materials** — files in `sources/`, listed below

| File in `sources/` | What it is | Weeks it covers |
|---|---|---|
| `week-01/lecture-01.pdf` | Lecture slides | 01 |
| `syllabus.pdf` | Syllabus | all |

**Before adding anything to `sources/`:** it is a normal folder in your repository. Nothing with a
student's name in it, no unreleased solution sets, no exam you intend to reuse.

## Notes to my future self

<Anything you want to remember when regenerating: phrasings students misread, a week that came out
too hard, a principle you keep forgetting to test.>
