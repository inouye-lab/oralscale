# Question design — <YOUR COURSE>

_Copy this file to `courses/<your-course-id>/question-design.md` and fill in the `<…>` parts. It is
the input to every question bank you or a coding agent generate, and it **overrides** the engine
documents wherever the two disagree about anything other than the schema. Walkthrough and
reasoning: [docs/guides/QUESTION-DESIGN-GUIDE.md](../../docs/guides/QUESTION-DESIGN-GUIDE.md).
Schema: [docs/reference/bank-generation-spec.md](../../docs/reference/bank-generation-spec.md)._

_Part A is yours to fill in, and one page is the right length for it. Part B is the **recommended
house style**: what the pilot course converged on over its first six quizzes. Keep it unless you
have decided otherwise, and strike or amend a rule when you do. Part C is where each review's
lessons go, so the next bank inherits them._

---

# Part A — this course

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

A good question elicits one of:

- **Understanding** — can they state the principle in their own words and say why it holds?
- **Application** — given a scenario, can they apply the principle and reach the answer it forces?
- **Discrimination** — can they tell the principle from the plausible thing next to it?

<Strike any that do not apply; add your own.>

## What a score will mean

The calibration target: **who should get what.** Check every draft bank against it. The defaults
below fit the recommended curve (Part B §1); change the numbers if your course differs.

| Student | Target |
|---|---|
| Best students | 95–100% |
| Good students who studied | 90–94% |
| Average student who attends and studies | ~85% |
| Attends lecture, does not study | 75–80% |
| Has neither attended nor studied | < 40% |

## Explicitly out of scope

<The things you will NOT ask about. Just as useful to a bank generator as what you will.
e.g. "No coding. No library APIs. No derivations longer than two steps. Nothing that needs a
number computed. Nothing from the optional reading. Nothing mentioned only in passing.">

## Difficulty, in this course's terms

| | |
|---|---|
| `intro` | <A student who attended and paid attention can answer it; saying the idea back in their own words is enough.> |
| `core` | <Requires having thought about it — the mechanism, the reason or the consequence. Most of the bank.> |
| `stretch` | <Applies a principle to a situation not seen in class, or reconciles two ideas. Must still be fair to someone who studied.> |

**Calibration check:** a student who attended but did not study should pass most `intro`, get
roughly half of `core`, and struggle on `stretch`. Revisit after the first quiz against the real
score distribution — and fix it by moving items between pools, not by rewriting the bank.

## Per-attempt shape

Recommended (and what `courses/_template/course.json` ships):

- **Questions per attempt:** 5, combined with `dropLowest` — the weakest answer is shown but not counted
- **Time per question:** 120 seconds
- **Difficulty mix:** `["intro","core","core","core","stretch"]`
- **Bank size:** ~100 questions per quiz, so a bank survives students comparing notes

## Weekly topics and their principles

_Name the **principles**, not the vocabulary — a topic list produces questions about words, a
principle list produces questions about ideas._

| Quiz | Lectures it covers | The 2–3 principles these lectures are really about |
|------|-------|----------------------------------------------|
| 01 | <…> | <…> |
| 02 | <…> | <…> |

## Sources

_What the bank is generated from. Files live in `sources/` and are kept, not consumed — they are
how you regenerate a quiz later, and every question's `evidence` quotes them._

| File in `sources/` | What it is | Quizzes it covers |
|---|---|---|
| `quiz-01/lecture-01-slides.pdf` | Lecture slides | 01 |
| `quiz-01/lecture-01-transcript.txt` | Lecture transcript | 01 |

**Coverage follows what was actually taught, not the slide deck.** Use the transcript or your notes
to exclude slides prepared but never shown. **Before adding anything to `sources/`:** nothing with a
student's name in it, no unreleased solution sets, no exam you intend to reuse.

---

# Part B — recommended house style

## 1. How a mark is computed (the points curve)

Recommended course setting (already in `courses/_template/course.json`): local grading with
Qwen3.5 4B and `scoring.mode: "points"` with a `table`. Every question carries two lists of
criteria:

| | |
|---|---|
| `keyPoints` — **core** (`R1`, `R2`) | The explicit answer to each explicit ask in the prompt: **one core point per ask**, so one or two per question. Each must be a substantive, specific answer, and **any one of them, said correctly, is already a sound if simplified answer.** |
| `bonusPoints` — **supporting** (`O1`, `O2`, …) | Everything else worth saying: the mechanism, a consequence, a limit or caveat, a connection, a concrete example, the concept's name. They show depth and **may never cost a mark**. No fixed count; no filler; never a restatement of a core point. |

The grader judges each point as `stated`, `partly`, `absent` or `contradicted`, quoting the student.
Code does the arithmetic: core = 2 points, supporting = 1, `partly` = half, and a substantive correct
point **not on either list** ("novel") = 1, up to 3 per answer. The total is read off the curve:

| Points | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7+ |
|---|---|---|---|---|---|---|---|---|
| Mark | 0 | 0.70 | **0.85** | 0.90 | **0.92** | 0.95 | 0.97 | 1.00 |

- One core point, said correctly: **0.85**. Both core points: **0.92**. Depth climbs to 1.00.
- A total between rungs rounds **up** (`curveRounding: "up"`), so a half-made point never rounds away.
- **What costs marks is being wrong, not being brief.** An uncorrected false claim caps the answer
  at 0.85. An answer with no core point at all caps at 0.70, so depth cannot stand in for
  answering. A slip the student corrects during the answer is never penalised.
- Students see a short narrative — what they got right, what to revisit — and the
  `feedbackFooter` telling them a good, correct answer earns about 90%. They never see the rubric
  or the arithmetic.

**The test for every point you write: would an answer without it be WRONG, or merely WEAKER?**
Wrong is core. Weaker is supporting. Nothing else is core.

## 2. Core criteria answer the prompt's explicit asks

**A student should never have to guess what the question wants.**

- **Every core criterion maps to a clause of the prompt** ("which one, and why", "what goes wrong,
  and how would you fix it"). If you cannot point to the clause, the criterion is supporting — or
  the ask belongs in the prompt.
- **Every explicit ask has exactly one core criterion.** A single-ask question has one core
  point, not two manufactured halves of one idea.
- **Core criteria are stated substantively.** "Because it rounds" is not a criterion; "finite
  precision rounds the large intermediate values, so their small difference is lost" is.
- **An open "Why?" with several valid reasons:** scope the question so one reason is *the* answer,
  or accept any one sound reason as core and list the others as supporting.
- **A criterion that names three or more items** lists them as examples ("for example …"), or the
  grader will demand all of them.
- **Test:** cover the key, read the prompt, and write the answer a careful student would give.
  Every core criterion should appear in it as the direct response to some clause.

## 3. Hard limits on the prompt

- **Never require a remembered list.** "Name the four X" is recall wearing comprehension's clothes.
  Ask for the *shape*: "What would you have to pin down before that claim can be analysed?"
- **At most two asks per question.** A three-part prompt is three questions sharing two minutes,
  and it fails the student who knows two parts perfectly.
- **Self-contained.** No retrieval step before the reasoning: not "the two methods from lecture",
  not "the example the instructor used". Name the things in the prompt; ask for the reasoning.
- **The setup names the objects; it never states a core point.** Check every sentence of the stem
  against R1 and R2.
- **A later ask must not answer an earlier one.** "Which is right, (A) or (B), and why does (B)
  fail?" answers its own first question. Phrase the second ask neutrally ("why does the other one
  fail?", "why or why not?"). *Check:* answer only the last ask; if that settles an earlier core
  point, rewrite.
- **A spot-the-flaw prompt asks for the fix if a core point is the fix.**
- **Exactly one defensible answer.** If two well-prepared students could reasonably diverge, cut the
  question rather than soften it.
- **No unverified premise.** A claim the lecture made in passing does not go into a stem as fact.

## 4. Style

- **A scenario beats a definition.** A concrete situation with a decision to make is
  self-contained, has a checkable answer, and cannot be answered by recitation.
- **Ask for the principle, not your exact position.** Any sound argument that reaches the principle
  earns full credit; say so in the `rubric`.
- **Prefer the positive ask.** "What is X *not* for?" tests a boundary that may never have been
  drawn. Put the negative in `commonErrors` instead.
- **Do not teach the workaround.** Ask why a policy serves the student, not what abuse it stops.
- **Anchor every item to a `principle` that outlives the method.** If the method were replaced
  next year, would the question still be worth asking?
- **Notation is for reading, not for speaking.** A prompt may use short inline notation, defining
  every symbol before the ask. An answer may never require notation to be spoken. To examine a
  notational point, offer two or three candidate expressions and ask which is right and why. Use only
  the LaTeX the student app renders (see the bank spec).
- **First-read clarity.** A prepared student should understand the task on the first reading; the
  difficulty comes from the idea, not from unpacking the sentence. Short concrete setup, then a
  direct ask. Name objects before using them. Prefer two clear sentences over one compressed one.
- **Length.** Answerable aloud in two minutes; aim for prompts of roughly 150–250 characters. When a
  draft runs long, cut setup the ask does not use before cutting an ask.
- **Coverage follows emphasis.** Several angles (explain, why, when-would-you, compare,
  spot-the-flaw) on an idea that took ten minutes of class; one item or none on a passing mention.

## 5. What every question carries

```json
{
  "id": "q-001",
  "topic": "Rates of change",
  "principle": "A derivative is an instantaneous rate, obtained as a limit of average rates.",
  "difficulty": "core",
  "kind": "explain",
  "prompt": "Explain what the derivative of a function at a point measures, and how it relates to the average rate of change.",
  "rubric": "Credit the instantaneous rate (tangent slope) and its relation to average rates as a limit. Any sound explanation of the limit earns full credit.",
  "keyPoints": [
    "The derivative measures the instantaneous rate of change at that point (the slope of the tangent line there).",
    "It is the limit of average rates of change as the interval shrinks toward zero."
  ],
  "bonusPoints": [
    "Geometrically the secant line through two points becomes the tangent line.",
    "Practical reading: how much the output moves for a small nudge in the input."
  ],
  "referenceAnswer": "The average rate is rise over run across an interval. Shrink the interval toward zero and the limit of that ratio is the instantaneous rate, the slope of the tangent line …",
  "commonErrors": ["Describing an average rate over an interval with no limiting process"],
  "evidence": [{"source": "quiz-01/lecture-01-transcript.txt", "quote": "verbatim, garbles and all ..."}],
  "gradingContext": {
    "courseExplanation": "A concise, teacher-checked explanation of the reasoning.",
    "pointDecisions": [
      {"id": "R1", "meaning": "The complete meaning of core point 1.", "sufficientExample": "One sufficient student phrasing."},
      {"id": "R2", "meaning": "…", "sufficientExample": "…"},
      {"id": "O1", "meaning": "…", "sufficientExample": "…"},
      {"id": "O2", "meaning": "…", "sufficientExample": "…"}
    ]
  }
}
```

- **`evidence`** quotes the slide or transcript each question rests on, verbatim, including
  speech-to-text garbles, with elisions marked `...`. Check it with `tools/check-bank-evidence.js`.
  "Anything explained in lecture is fair game" is only defensible if every question can produce the
  moment it was taught.
- **`gradingContext.pointDecisions`** IDs match `keyPoints` (`R1…`) and `bonusPoints` (`O1…`) in
  order. This is what the local grader reads to decide each point; see
  [LOCAL-GRADING.md](../../docs/reference/LOCAL-GRADING.md#authoring-future-banks).
- Points-mode banks may omit per-item `scoringBands`; the curve, not a band, decides the mark.
- The reference answer, every criterion and the context **require your review**. A bank that
  validates is not a bank that grades well; spot-check a few answers before students see it.

## 6. Review before freezing

1. `node tools/validate-bank.js <bank>` clean, and the course smoke test passes.
2. Build the review worksheet (`node tools/bank-worksheet.js <bank>`) and mark each question
   Keep / Revise / Remove.
3. Red-team the draft against §2–§4: one reviewer pass that answers only from the prompt, and one
   that hunts for stems giving the answer away.
4. Record what the review taught you in Part C.

---

# Part C — lessons from each review

_After every quiz review, add the defects that survived the draft as checks you can run, with the
date. The next bank is written against them._

- <YYYY-MM-DD, Quiz N:> <…>
