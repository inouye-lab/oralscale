# Question-Bank Generation Spec (frozen banks for OralScale)

Every bank is authored **once** to this spec, then frozen. Follow it exactly so all weeks are
consistent and gradeable.

**This file is deliberately instructor-neutral.** It covers the parts that are the same for every
course: the JSON shape, the constraints the spoken format imposes, and the failure modes that make
any bank measure the wrong thing. It carries no opinion about what your course should test.

**What to test, what a score should mean, and what you refuse to ask are YOURS**, and they live in
`courses/<courseId>/question-design.md`. Read that first; where it and this file disagree about
anything other than the schema, yours wins. Everything below that says "default" is a starting
point your `question-design.md` may override.

## Output
A single JSON file `banks/<courseId>/<week-slug>.json`:
```json
{
  "version": 1,
  "bankId": "<courseId>-<week-slug>",
  "title": "Week NN — <topic>",
  "course": "<course number and title, as students see it>",
  "createdWith": "LLM-authored to bank-generation-spec, frozen 2026",
  "questions": [ /* ~100 items */ ]
}
```
Each question:
```json
{
  "id": "<week>-<nnn>",                 // e.g. "w04-017", unique within the bank
  "topic": "<short module topic>",
  "principle": "<the durable principle this tests>",   // REQUIRED — anchor to a principle
  "difficulty": "intro | core | stretch",
  "kind": "explain | why | compare | spot-the-flaw | formalize | when-would-you",
  "prompt": "<the spoken question>",
  "rubric": "<1-2 sentences: what earns credit>",

  // REQUIRED vs OPTIONAL. `keyPoints` lists ONLY what the question ASKS FOR:
  // points without which the answer is wrong or has not answered the question as
  // stated. At most four, and usually two or three. Everything that merely makes
  // an answer stronger, richer or easier to mark goes in `bonusPoints`, which the
  // grader is told may never lower a band and may never be reported as "missed".
  // See "Required is what the question asks" below.
  "keyPoints": ["2-4 points WITHOUT WHICH the question has not been answered"],
  "bonusPoints": ["<optional: what makes an answer stronger and can never cost a mark>"],

  // OPTIONAL, but see "Why the optional fields earn their keep" below.
  "referenceAnswer": "<a model full-credit SPOKEN answer, 60-100 words>",
  // Keys are your course's BAND NAMES. These five are the engine default
  // (1.0 / 0.9 / 0.8 / 0.7 / 0.0); a course may re-price them with
  // `defaults.bandScores`, or define a different ladder entirely — other names,
  // more rungs or fewer — with `defaults.bands`. Match whichever is in force:
  // a band the ladder does not contain is ignored, and one you omit is one the
  // grader has to judge unaided.
  "scoringBands": {
    "full":    "<what a full-credit answer contains>",
    "strong":  "<the whole reasoning minus one substantive piece - the commonest good answer>",
    "partial": "<the main idea without the mechanism>",
    "weak":    "<on topic, but the vocabulary and nothing behind it>",
    "none":    "<what earns nothing, including the specific wrong answer you expect>"
  },
  "commonErrors": ["<the misconception they arrive with>", "<the plausible-but-wrong thing>"]
}
```

### Required is what the question asks; everything else is a bonus (INV-GRADE-9)

**The test for every point you write down: would an answer WITHOUT it be *wrong*, or merely
*weaker*?** Wrong is `keyPoints`. Weaker is `bonusPoints`. There is no third category, and getting
this wrong is the commonest and most expensive fault a bank has.

It is expensive because a grader believes you. Handed a list of five things a full answer "hits",
it withholds marks for each one the student did not say — including the ones the prompt never
asked for. A student can then answer exactly what was asked, correctly and completely, and land
two bands below a student who padded. That is not a grading bug; it is the bank telling the grader
something untrue about what the question required.

The first draft of a pilot course's Quiz 1 bank averaged **5.7 required points per question**, and every
one of its hundred items was over the limit. That is the normal failure mode, not an unusual one:
listing everything a complete treatment of a topic would mention is what an author naturally does.

Three rules follow.

1. **Anything genuinely required must be explicit in the prompt.** A student cannot be marked down
   for not answering something they were not asked. If a point belongs in `keyPoints` and the
   prompt does not ask for it, fix the prompt or move the point.
2. **Four required points is the ceiling, and `validate-bank.js` warns above it.** It follows from
   a rule you already have (at most two things per question): two things with two required points
   each is a full question. A fifth means either the question grew a third part or something
   optional got filed as required.
3. **`bonusPoints` is not a dumping ground.** It is what a grader reads to recognise a genuinely
   strong answer and to write useful feedback about one. Points that are simply out of scope
   belong in neither list.

**How the two lists map onto bands is the COURSE's decision, not the bank's.** The engine default
puts *answered the question as asked and said nothing false* at `full`. A course may instead price a
complete required-only answer lower and make the optional points the way to climb — the pilot course does
exactly that (`partial` 0.80 for answering the question, `strong` 0.92 for one or two optional
points, `full` 1.00 for two or three), because it wants students to explain what they mean rather
than stop at the minimum. Either way the rule for you as an author is identical: `keyPoints` is what
the question asks, `bonusPoints` is depth beyond it, and nothing a student is *required* to say may
be absent from the prompt.

In BAND mode the optional points a student did **not** make are reported back to them as *what
would have made this answer stronger* — so write them as things worth saying, not as filler. In
POINTS mode they are not shown to the student at all (INV-GRADE-9), but they still decide how a
strong answer climbs, and the grader still reads them to recognise one.

**A course on a CURVE asks one more thing of you** (`scoring.table`, INV-GRADE-10): write
`keyPoints` so that **any one of them, said correctly, is already a sound if simplified answer**.
The curve prices a single core point as a good mark and both as a complete one, which only makes
sense if each genuinely answers the question. If one point is meaningless without another, they are
one point, not two. Such a course also credits substantive correct points the student made that are
on **neither** list, so a bank does not have to anticipate every good answer — which is the
pressure that makes authors overfill `keyPoints` in the first place.

### Why the optional fields earn their keep
They exist because of a measured result, not a hunch (`tools/eval/`, and the report in
[STATUS.md](../project/STATUS.md)). A **small** grading model — the kind that could run entirely inside the
Gradescope autograder, with no external service and no API key — has far less background knowledge
to fall back on than a large one, so it grades much closer to a large model when the Bank tells it
what a good answer looks like rather than expecting it to already know.

They also help a large model: they anchor it to *your* standard instead of its own, which makes
scores comparable across weeks and across sections.

Write them at least for `core` and `stretch` items. `commonErrors` is the highest value for the
least effort, because you already know them — they are the things you correct every year, and
writing them down stops a grader awarding credit for the confident wrong answer.

## Hard requirements
0. **Formatting in `prompt`** — plain prose is fine and usual, but a small, safe subset is
   rendered: `**bold**`, `*italic*`, `` `code` ``, bullet/numbered lists, blank-line paragraphs,
   and LaTeX (`$inline$`, `$$display$$`) which becomes MathML. Use notation where the subject
   needs it — `$\nabla_\theta J(\theta)$` reads better than "the gradient of J with respect to
   theta". Do **not** use links, images, tables, headings or raw HTML: they are not rendered as
   markup (HTML shows as literal characters) and none of them survives being read aloud.
   Remember the question is *spoken*: a wall of display math usually belongs on a written
   assignment instead. `validate-bank.js` warns about all of these.
   The renderer supports a subset of LaTeX. Sizing and spacing macros such as `\big`, `\bigl`
   and `\bigr`, as well as `\mid` and the starred `\operatorname*`, are printed to the
   student as raw source. Use plain `/`, `(`, `|` and `\operatorname` instead.
   `tools/bank-worksheet.js` renders every prompt through the student app's own parser, so
   check the worksheet: an unsupported macro shows up there exactly as a student would see it.
1. **~100 questions** (90–110 acceptable). Unique `id`s. No near-duplicate prompts.
2. **Answerable aloud in 2–3 minutes** by a student who understands the material (5 min absolute
   max). No question that needs writing or deriving on paper, or running code — not because
   computation is unworthy, but because the format cannot carry it: there is no paper, no editor,
   and a two-minute clock.
2a. **Never require a remembered list, and never ask for more than two things.** The two failure
   modes a first draft reliably has; both make a comprehension instrument measure memory instead.
   - *If the answer is "the four X", it is a recall question.* A student who understands the idea
     and cannot recall that there were **four** of them loses marks for a memory failure. Ask for
     the SHAPE, not the inventory: not "name the four mechanisms and the role of each" but "one of
     them *produces* evidence and another *judges* it — why are those separate jobs?" The tell is a
     count in the prompt, or a rubric crediting "all four".
   - *The same goes for terminology.* Require what a term DOES, not what it is called, unless the
     word itself is the thing being taught.
   - *At most two things to explain per question.* A three-part prompt is three questions sharing
     one two-minute budget, and it fails the student who knows two of them perfectly. Warning
     signs: more than two clauses in the prompt, more than two credited elements in the rubric,
     more than six `keyPoints`. Where a third element genuinely helps, make it a **bonus** and say
     so in the rubric — "an example strengthens the answer but is not required" — so the grader
     does not withhold full credit for its absence.
2d. **Notation may appear in the PROMPT; it may not be required in the ANSWER.** Mathematical
   notation is fine to read and terrible to speak: "the sum over i of x i minus mu quantity squared"
   is a sentence nobody says and nobody should be asked to. So the rule is asymmetric.
   - *In the prompt:* use notation where it genuinely reads better than words, inline and short.
     A student can look at `$W^\top x$` while they talk about it.
   - *In the answer:* never require a formula to be spoken. What is being tested is whether the
     student can INTERPRET notation, map it to a concept or an algorithm, and say what it does and
     when it breaks — not whether they can dictate it.
   - *The shape that makes this work:* **offer two or three candidate expressions and ask which one
     is right and why the others fail.** The student answers by naming one and reasoning about it,
     which is a spoken answer; the notation does the work of being precise. This is how to ask a
     notational question without asking anyone to read a formula aloud.

2b. **The prompt must be SELF-CONTAINED.** No retrieval step before the reasoning step.

   **Separate the setup from the ask, and make clear what the student should explain.**
   Audit every prompt for first-read clarity, including stretch questions. Introduce the objects
   and needed assumptions before the question; break up dense clauses and abstract noun chains.
   Keep necessary technical meaning without supplying the answer. After a rewrite, check that
   the required criteria, reference answer and grading context still answer the revised ask.
   See the [readability guidance](../guides/QUESTION-DESIGN-GUIDE.md#make-the-task-clear-on-the-first-reading).
   - *Name the referents.* "The two approaches we contrasted", "the four questions to ask of a new
     method" — each makes the student first remember WHICH things are meant, and only then reason.
     Someone who has the understanding and blanks on the label scores zero on a question that was
     never about the label. Naming them inline costs one clause and removes the problem.
   - *Put the setup in the prompt.* "Give the example from lecture" and "state the rule the
     instructor gave" are recall questions however conceptual the rest of the prompt is. Supply the
     situation and ask for the reasoning. Attribution is fine as long as the prompt still states
     the claim: "we argued that X; what was the argument?" gives the student everything they need
     to begin.
   - *Prefer the positive ask.* "…and what is it NOT responsible for?" is a second question in
     disguise, testing a boundary that may never have been drawn explicitly. Ask what the thing IS
     for; put the negative in `commonErrors`, where it blocks a wrong answer without being
     something the student must produce.
   - *A scenario beats a definition.* Two candidates and which one counts, two approaches and which
     scales — a scenario is self-contained by construction, has a checkable answer, and cannot be
     answered by reciting anything.
2c. **Credit the principle, not the instructor's exact position.** A rubric requires a sound
   argument that reaches the principle, not the particular stance taken in class or the words used.
   Say so in the rubric ("any sound argument for that earns full credit") — a grader reading a
   rubric full of specific required elements will withhold marks for their absence.
3. **Probe behaviour and reasoning, not execution.** Trade-offs, assumptions, consequences, "what
   would go wrong if" — never "compute X" or "write the code for X". This follows from (2): a
   spoken answer can carry an argument and cannot carry a derivation. *Which* reasoning is worth
   probing is your `question-design.md`'s call, not this file's.
4. **Fill `principle` on every item.** It is a required field, and writing it is the cheapest
   quality check there is: an item whose `principle` line reads as a restatement of the prompt is
   usually a definition question in disguise. What counts as a principle in your course is yours
   to define.
5. **Difficulty mix — default ~25% intro, ~50% core, ~25% stretch.** What `intro`, `core` and
   `stretch` MEAN is course-specific; define them in `question-design.md`. The assignment's
   `difficultyMix` draws against these labels, so the bank must actually contain enough of each.
6. **Kind mix — default explain 25%, why 25%, compare 15%, when-would-you 12%, formalize 12%,
   spot-the-flaw 11%.** The spread matters more than the exact split: a bank that is all `explain`
   becomes predictable within a week or two, and predictable is rehearsable. **Spot-the-flaw items
   must state the flawed claim in the prompt** and put the correct fix in `keyPoints`/`rubric`, or
   the grader has nothing to mark against.
7. **Tone: match the register you use in class,** and keep it consistent across the bank — a
   student should not be able to tell which items were written on which day. No emoji, no
   decorative framing, one idea per question.
8. **Coverage:** spread across the week's sub-topics; several distinct angles on one emphasised
   idea (a rephrase, a "why", a "when would you choose", a spot-the-flaw, a formalization) is the
   intended way to reach ~100 without filler. Weight the angles toward what you actually spent
   time on — a bank that samples uniformly over a syllabus tests something the week did not teach.

## Example — the shape, not the subject
```json
{
  "id": "w04-023",
  "topic": "Curse of dimensionality",
  "principle": "In high dimensions, distance concentrates, so neighbor-based reasoning degrades.",
  "difficulty": "core",
  "kind": "why",
  "prompt": "Explain in plain words why nearest-neighbor distances become nearly meaningless as the number of dimensions grows, and what that implies for KNN.",
  "rubric": "Credit for the concentration-of-distances intuition (nearest and farthest points become similarly far) and the consequence that KNN's notion of 'close' stops being informative.",
  "keyPoints": [
    "As dimension grows, pairwise distances concentrate toward a similar value",
    "The ratio of nearest to farthest distance approaches 1",
    "'Nearness' stops carrying information about similarity",
    "KNN degrades because neighbors are no longer meaningfully closer",
    "Needs exponentially more data to keep the space populated"
  ]
}
```

## Where the content comes from
A Bank is generated from the instructor's **`question-design.md`** (what they are trying to
measure, what a score should mean, what `intro`/`core`/`stretch` mean in *their* course) and
optionally from their own materials in **`courses/<courseId>/sources/`** — slides, notes, past
exams, in whatever format they have. Materials in `sources/` are kept, not consumed: they are how
a week gets regenerated later. See [QUESTION-DESIGN-GUIDE.md](../guides/QUESTION-DESIGN-GUIDE.md).

**Hand the author ideas, not a topic list.** This is a practical point about input, not a claim
about what your course should teach: a list of topic names produces questions about vocabulary,
because a name is all the author was given. "Week 4: KNN, train/test split, cross-validation"
yields definitions; "Week 4 is about generalisation being the goal, and about error measured on
the data you fitted being optimistically biased" yields questions about ideas. Whatever your
course's version of an idea-per-week looks like, write that down and the bank follows it.

## Validate before freezing
`node tools/validate-bank.js banks/<courseId>/<week-slug>.json` must pass (unique ids, prompts
present, keyPoints present, `bonusPoints` well-formed and never duplicating a required point). Aim
for every item to also have `principle` + `kind`.

**Read the warnings, especially the required-points one.** It prints the mean number of required
points per question; if that number is much above two, the bank is about to mark a cohort down for
things it never asked them.

## Context for the standard local grader
See [LOCAL-GRADING.md](LOCAL-GRADING.md) for optional `gradingContext` metadata and
the exact `pointDecisions`/`systemGuidance` contract. Draft context from course sources,
verify mathematical claims and partial-credit boundaries, and make new listed criteria
semantically disjoint. Existing overlapping criteria may share supporting evidence; a
concrete example cannot earn both listed and novel credit. Qualify clean/messy pairs
and the full raw-point scale before release. Enhancing a deployed key belongs in a
versioned alternative bank with unchanged student-facing questions.
