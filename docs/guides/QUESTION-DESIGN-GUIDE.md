# Designing your questions

**Who this is for:** an instructor who has never used OralScale, is about to write their first
question bank, and would like to spend the thinking time on *what to ask* rather than on JSON.

**What you end up with:** a short `question-design.md` in your course folder that says what you
are trying to measure and how hard you want it to be, a `sources/` folder holding whatever you
based it on, and — from those two — a bank of ~100 questions per week.

**How to use it:** read it yourself, or hand it to an AI assistant and work through it as an
interview. Both work. The section headings are the interview.

> Do the setup walkthrough first if you have not:
> [SETUP-GUIDE.md](../reference/SETUP-GUIDE.md) gets you a working quiz with example questions in about
> twenty minutes, so you can hear one before you design one. It is much easier to write good
> questions once you have answered one out loud yourself.

---

## Before anything: the one thing that makes these questions different

Your students will **speak** the answer, alone, into a phone, with a two-minute clock and no
notes, no editor, no AI, and no second draft.

That single constraint should drive every design decision below. It has two consequences that
surprise most people:

**A question can be intellectually easy in writing and still be a good question here.** "Why does
normalising by the norms make cosine similarity ignore length?" is nearly trivial to look up and
takes ten seconds to write down. Saying it out loud, correctly, in one pass, without hedging,
requires that you actually hold the idea. That is the measurement. Do not throw an item out
because its written answer looks simple — throw it out if *speaking* it would not distinguish a
student who understands from one who does not.

**A question can be intellectually excellent and still be a bad question here.** Anything that
needs scratch paper, a derivation of more than two steps, a diagram, or a number computed to
three places is not answerable aloud. It is a fine homework problem. It is not this.

The test to apply to every candidate item: *could I answer this well, out loud, in two minutes,
without writing anything down — and would a student who half-understands it visibly fail to?*

---

## Recommended workflow: let AI build the bank with you

Start with an AI interview, not a blank list of questions. Give the assistant the slides,
lecture transcripts, notes or readings you want to assess, this guide, and the
[bank-generation specification](../reference/bank-generation-spec.md). Ask it to help write
`question-design.md` before generating the bank. You supply teaching goals and review the result;
the agent drafts the questions, reference answers and grading criteria, then validates the bank.

Tell it which skills matter: information recall, concept application, theoretical reasoning,
applying principles across diverse domains, or translating word problems into concrete models.
State what to exclude: untaught content, rote definitions, lengthy calculations, trick wording,
or tasks needing diagrams or scratch paper. Recall can be an explicit course goal; distinguish
it from reasoning rather than allowing the agent to assume what "understanding" means.

Have it propose a small sample for alignment first, then expand to roughly 100 varied questions
per quiz directly grounded in the supplied content. Review samples across goals and difficulty,
answer several aloud, revise, validate and freeze. A larger bank should add meaningful variations,
not filler. Keep the course sources, questions and reference answers private.

## Step 1 — What are you actually trying to measure?

Most instructors say "understanding". That is not specific enough to write a rubric against, and
it is not specific enough for an AI grader either. Pick from the goals below — one primary, and
at most one or two secondary.

| Goal | The question sounds like | You are measuring | Watch out for |
|---|---|---|---|
| **Procedural fluency** | "Walk me through what happens to the weights on one gradient step." | Can they run the machinery in their head, in order, without notes | Easy to fake by memorising a script; keep these to a minority |
| **Conceptual understanding** | "Why does regularisation reduce variance but raise bias?" | Do they know *why* the machinery is built the way it is | The default and usually the right primary goal |
| **Discrimination / judgement** | "When would you choose absolute error over squared error? Ground it in a real situation." | Can they choose between methods and defend it | Vague answers score well unless the rubric demands a concrete case |
| **Diagnosis** | "Here is a claim that sounds right but isn't. Find the flaw and fix it." | Can they detect an error rather than recite a correct thing | The single hardest kind to fake, and the most work to write |
| **Formalisation** | "Put 'the decoder focuses on relevant states' into a precise statement." | Can they move from intuition to a precise statement | Do not let it become "recite the formula" |
| **Synthesis / transfer** | "You have seen PCA and autoencoders. What is the same idea underneath?" | Can they connect two things you never connected for them | Genuinely hard aloud; use sparingly and as `stretch` |
| **Raw calculation** | "Compute the eigenvalues of this 2×2 matrix." | Arithmetic | **Almost never appropriate here.** Put it on a written assignment |

**Write down the answer to this, in one sentence, before you write a single question.** Something
like: *"I want to know whether they understand why each method is built the way it is, and whether
they can tell when one is the wrong choice — not whether they can execute it."*

That sentence is the first line of your `question-design.md`, and everything else follows from it.

### The outcome you are hoping to measure

Say what a result would *mean*, not just what you will ask. This is the part most people skip, and
it is what makes the scores interpretable in week 6 when you look at them.

Fill in these three:

- **A student scoring near full marks has demonstrated that they can …**
- **A student scoring around half has probably …**
- **A student scoring near zero most likely …**

Concretely, for a conceptual-understanding goal:
> *Full marks: can state the mechanism and why it has the effect it does, unprompted, in their own
> words. Half: knows the fact and can state it, but reaches for a definition rather than a reason —
> "regularisation reduces overfitting" with nothing behind it. Near zero: recognises the words and
> nothing more.*

If you cannot fill those in, the goal is not yet specific enough. Go back up the table.

### Mixing goals

You do not need one goal per week. A good default for a weekly check with three questions per
attempt is a **mix**, arranged so that a student who has done the reading but not the thinking
gets partial credit and no more:

- one **conceptual** (the spine — most of your bank)
- one **judgement** or **diagnosis** (the discriminator)
- one **formalisation** or **procedural** (the floor — catches nothing-at-all)

If you set `difficultyMix` in your course config (see below), the three slots are drawn from
different difficulty pools automatically, which produces this shape without you curating it.

---

## Step 2 — How hard, and hard in what way?

**Difficulty is not the same axis as goal.** A conceptual question can be gentle or brutal; so can
a formalisation. Deciding them separately is what stops a bank from being accidentally uniform.

OralScale has three difficulty levels. They are drawn as separate pools, so what you put in each
matters:

| Level | Share of bank | What it means here | A student who has *attended* but not *studied* |
|---|---|---|---|
| `intro` | ~25% | One idea, stated plainly, no chaining. The warm-up: it exists so a nervous student starts by succeeding. | Should mostly pass |
| `core` | ~50% | The main claim of the week, with a reason attached. Two ideas connected, at most. | Should get roughly half |
| `stretch` | ~25% | Requires connecting the week to something else, or noticing something not said explicitly in lecture. | Should not pass |

Calibrate with that right-hand column. It is far more reliable than asking yourself "is this
hard?", because it is a prediction you can check against real scores after week one.

### Four dials, and what each costs

When you want a question harder, you are choosing one of these. Knowing which one you turned
matters, because they fail differently:

1. **Number of steps to chain.** Cheap to add, but each extra step makes the answer longer, and
   two minutes runs out. Two links is usually the ceiling for a spoken answer.
2. **How far from what was said in lecture.** The honest way to make something a `stretch`. Costs
   nothing in answer length.
3. **How much precision the answer needs.** "Roughly why" versus "state it exactly". Raises
   difficulty without raising length — the most efficient dial for spoken questions.
4. **How much the question tells them.** A question that names the concepts is easier than one
   that makes them find the concept. Also free in length. Be careful at the top end: a question
   that does not say what it is about becomes a guessing game rather than a hard question.

**Do not** make questions harder by making them longer, more obscure, or more numerically fiddly.
Those raise the failure rate without raising the information you get.

### The calibration you should actually do

After your first live week, look at the distribution. If nearly everyone is at 80%+, your `core`
pool is really `intro`. If the median is under 40%, you have written `stretch` questions and
labelled them `core`. Move items between pools; do not rewrite the bank.

---

## Step 3 — Write it down: `question-design.md`

Put this in `courses/<your-course-id>/question-design.md`. It is short by design, it is the input
to every bank you generate afterwards, and it is the thing you will actually reread in week 9.

A template is at [`courses/_template/question-design.md`](../../courses/_template/question-design.md);
copy it. It asks for:

- **Course and audience** — level, prerequisites, whether English is most students' first
  language. *(That last one is not a throwaway: it changes how much of a spoken answer's
  hesitancy you should read as not knowing, and it is why the rubric wording below says "grade
  ideas, not fluency".)*
- **Primary goal**, plus secondary goals — from Step 1.
- **The three outcome sentences** — from Step 1.
- **What is out of scope** — the things you will *not* ask about, which is as useful to an AI bank
  generator as what you will.
- **Difficulty calibration** — your own words for what `intro`/`core`/`stretch` mean in *this*
  course.
- **Weekly topics** — one line per week, with the two or three principles each week is really
  about.
- **Sources** — see Step 4.

---

## Step 4 — Where the questions come from

Two ways, and you can mix them freely.

### (a) From topics
You list the week's topics and principles and the bank is generated from those. Fastest. Works
well when the course follows a standard treatment and you mainly care that the ideas are covered.

The catch: questions come out phrased the way the *field* phrases things, not the way *you* phrase
them. Students notice, and it costs you a little on the "did I teach this" front.

### (b) From your own materials
Drop your slides, lecture notes, reading list, past exams, homework solutions — whatever you have
— into `courses/<your-course-id>/sources/`. Anything readable is fine: PDF, PowerPoint, Markdown,
plain text, scanned notes.

This is strictly better if you have the materials, because the generated questions use your
notation, your emphasis, and your examples, and they skip what you skipped. The cost is one
drag-and-drop.

```
courses/<your-course-id>/
  course.json            settings
  question-design.md     Steps 1-3, above
  sources/               <- your raw materials, kept as they are
    week-01/
      lecture-01.pdf
      notes.md
    week-02/
      slides.pptx
    syllabus.pdf
    README.md            what each file is, and which week it belongs to
```

**`sources/` is kept, not consumed.** It is not deleted after generation, and it is the reason you
can regenerate a week in November after realising the questions drifted. Treat it as the archive
of what the bank was built from.

Two cautions:

- **Check what you drop in.** If a slide deck contains a solution set you have not released, or a
  student's name, or an exam you still intend to reuse, it does not belong here. `sources/` is a
  normal folder in your repository.
- **Sources are input, not authority.** A generator reading your slides will happily turn a typo
  on slide 14 into a question. You still read the bank before freezing it.

### What to say about a week
Whichever route you take, the useful unit is not "the topic" but **the principle**. Compare:

> ✗ "Week 4: KNN, train/test split, cross-validation, the curse of dimensionality"
>
> ✓ "Week 4 is really about three things: (1) the point of learning is generalisation, not fitting;
> (2) any error estimate computed on data you fitted is optimistically biased, and the size of that
> bias is what we call overfitting; (3) distance-based reasoning degrades in high dimensions
> because distances concentrate. Everything else this week is machinery for those three."

The second version produces a much better bank, because it tells the generator what the questions
are *for*. A topic list produces questions about vocabulary.

---

## Step 5 — What a good item looks like

Every question is one JSON object. The fields that matter, and why:

```json
{
  "id": "w04-023",
  "topic": "Curse of dimensionality",
  "principle": "In high dimensions, distance concentrates, so neighbour-based reasoning degrades.",
  "difficulty": "core",
  "kind": "why",
  "prompt": "Explain in plain words why nearest-neighbour distances become nearly meaningless as the number of dimensions grows, and what that implies for KNN.",
  "rubric": "Credit for the concentration-of-distances intuition (nearest and farthest points become similarly far) and the consequence that KNN's notion of 'close' stops being informative.",
  "keyPoints": [
    "As dimension grows, pairwise distances concentrate toward a similar value",
    "The ratio of nearest to farthest distance approaches 1",
    "'Nearness' stops carrying information about similarity",
    "KNN degrades because neighbours are no longer meaningfully closer",
    "Needs exponentially more data to keep the space populated"
  ]
}
```

- **`principle`** is the durable idea. If your question would be obsolete when the *method* is,
  you asked about the method. Rewrite it around the principle.
- **`prompt`** is spoken to a student on a phone. Plain prose; `**bold**`, `*italic*`,
  `` `code` `` and LaTeX (`$\nabla_\theta J(\theta)$`) render, and nothing else does. A wall of
  display maths belongs on a written assignment.
- **`rubric`** is one or two sentences telling the grader what earns credit. It is not a model
  answer.
- **`keyPoints`** are 4–6 concrete things a full-credit answer hits. **These do most of the
  grading work**, so make them things a student would actually *say*, not chapter headings.

### The six kinds, and the mix

`explain` 25%, `why` 25%, `compare` 15%, `when-would-you` 12%, `formalize` 12%,
**`spot-the-flaw` 11%**.

`spot-the-flaw` is worth the extra effort it takes to write: you state a plausible but wrong claim
in the prompt and ask the student to find and fix it. It is the hardest kind to answer from a
memorised script, because a script has nothing to say about a claim it has never seen. Put the
correct fix in `keyPoints`.

### Four fields that make a small grader work much better

These are **optional**, and they exist because of a measured result: a small model has far less
world knowledge to fall back on, so it grades much closer to a large one when the bank tells it
what a good answer looks like instead of expecting it to know. They also make a *large* model more
consistent, and they make your own later reading of the bank much easier.

Add them at least to your `core` and `stretch` items:

```json
{
  "referenceAnswer": "A model full-credit spoken answer, 60-100 words, in the register a student would actually use. Not a textbook paragraph.",
  "scoringBands": {
    "full":    "What a full-credit answer contains.",
    "strong":  "The whole reasoning minus one substantive piece - the commonest good answer.",
    "partial": "The main idea without the mechanism.",
    "weak":    "On topic, but the vocabulary and nothing behind it.",
    "none":    "What earns nothing, including the specific wrong answer you expect."
  },
  // Those five names and their 1.0 / 0.9 / 0.8 / 0.7 / 0.0 shares are the engine
  // default. Re-price them with `defaults.bandScores` in course.json, or replace
  // the ladder outright - your own names, more rungs or fewer - with
  // `defaults.bands`. Keep these keys matching whichever ladder you chose.
  "commonErrors": [
    "The misconception you know they arrive with",
    "The plausible-but-wrong thing that should NOT earn credit"
  ]
}
```

`commonErrors` is the highest-value of the three and the cheapest to write, because you already
know them — they are the things you correct every year. Writing them down stops a grader giving
credit for the confident wrong answer.

---

## Step 6 — Generate, read, freeze

1. **Generate** — hand your `question-design.md`, your `sources/`, and
   [bank-generation-spec.md](../reference/bank-generation-spec.md) to an AI assistant and ask for one week's
   bank. ~100 questions per week. This is the only place AI touches question content; **no AI is
   called at quiz time.**
2. **Validate** — `node tools/validate-bank.js banks/<course>/<week>.json`. It checks ids,
   prompts, key points, and warns about HTML, unbalanced `$`, and code fences in something meant
   to be spoken.
3. **Read it.** Not all hundred — sample twenty, spread across the difficulty levels. You are
   looking for: factually wrong items, items that need paper, near-duplicates, and items whose
   `keyPoints` are chapter headings rather than things a person would say.
4. **Answer three of them out loud, on your phone, against the clock.** This takes six minutes
   and catches more problems than reading fifty. If *you* run out of time, your students will.
5. **Freeze it.** Do not regenerate mid-term: question selection is deterministic in the bank's
   contents, and changing the bank changes which questions students draw.

### Why the bank is large

A hundred questions a week is not padding. It is the assumption the whole design rests on
(assumption **A-4** in the models): a bank big enough that memorising all the answers is more work
than learning the material. It is also what makes unlimited retakes safe — each retake draws a
genuinely different question rather than recycling a small pool.

Reaching a hundred without filler is easier than it sounds, because you are not writing a hundred
*ideas*. You are writing five or six angles on each of fifteen or twenty principles: a plain
"explain", a "why", a "when would you choose", a "spot the flaw", a formalisation, a comparison.
Each is a genuinely different demand on the student.

**Keep the bank unpublished.** It sits in your private repository and is served only to students
holding a valid quiz key. A published bank is a study sheet, and A-4 stops holding.

---

## A short checklist before you freeze a week

- [ ] Every item answerable aloud in two minutes with nothing to write on
- [ ] Every item anchored to a `principle`, not to a method that will date
- [ ] Roughly 25 / 50 / 25 across `intro` / `core` / `stretch`
- [ ] At least one in ten is `spot-the-flaw`
- [ ] `keyPoints` contain only essential required ideas (usually 2–4); optional depth belongs in `bonusPoints`
- [ ] `commonErrors` filled in wherever you know the misconception
- [ ] No links, images, tables or headings in any prompt
- [ ] You answered three of them out loud yourself, against the clock
- [ ] Nothing in `sources/` that should not be in a repository
