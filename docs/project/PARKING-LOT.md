# OralScale — Parking Lot

Ideas worth preserving that are not yet decisions, requirements, or committed work. Promote an
item to the models, invariants/tests, or `DESIGN-QUESTIONS.md` only when it is taken up.

Captured 2026-08-20. Last worked 2026-08-21.

## Resolved and promoted out of here (2026-08-21)
Kept as a one-line index so the history is findable; the reasoning lives where the work does.

| Was | Now |
|---|---|
| PII warning and transcript sanitization | **INV-PRIV-4** (models/02). Students are told before recording; the outbound grading copy is redacted; the disclosure names each data flow exactly. Test `t_pii_redaction`. |
| Audit the edge databases | **models/06 "Edge-database audit, 2026-08-21"** — three findings (raw addresses as row keys, unsalted hashes over tiny domains, unbounded retention), all fixed, now **INV-PRIV-5**. Test `t_edge_tags_keyed`. |
| Investigate a possibly truncated live-demo attempt | **INV-INTEGRITY-9**. Root cause found and reproduced: Whisper drops digit runs at decode-window edges. Fixed by VAD + a `small` model + a pinned language, with a chunked re-transcription rescue as backstop. The real failing submission now validates. Test `t_transcribe_reliable`. |
| Preserve the oral construct | **[QUESTION-DESIGN-GUIDE.md](../guides/QUESTION-DESIGN-GUIDE.md)**, "the one thing that makes these questions different" — a written-easy question can be a good oral question, and the test is whether *speaking* it distinguishes understanding. It is guidance for the author, not a validator rule, because no checker can judge it. |
| Simple-model gradability | Partly promoted: the Bank schema now carries optional `referenceAnswer`, `scoringBands` and `commonErrors`, measured in `tools/eval/`. See the open item below for what remains. |

## Security and privacy

*(nothing open)*

## Alternatives to GenAI grading

- **Question-specific deterministic graders.** It may be possible to attach a Python grader to
  each question in the Bank and score with fuzzy term/concept matching. This is not preferred, but
  could be a fallback when GenAI grading is unavailable. Before pursuing it, evaluate brittleness,
  false positives, paraphrase handling, maintenance cost, and how instructors would author and
  validate the rules.
  - **Less pressing than it was.** The 2026-08-21 rate-limit work (25 concurrent submissions, 6 of
    them throttled, **25 of 25 still graded by GenAI**) removed the failure this was insurance
    against. The remaining case is GenAI being unavailable outright, which the small-model item
    below covers better.

- **Small open-weights model inside the autograder.** **Measured 2026-08-21** — full report and
  table in [STATUS.md](STATUS.md) §9, raw data kept with the private course record. Summary of
  where it stands:
  - **`llama3.2:3b` ranks answers nearly as well as Purdue GenAI's `gemma4:26b-a4b`** (0.85 vs
    0.92 within-question pair accuracy; 0.91 vs 0.96 correlation with intended quality) and is
    **clearly better than the keyword heuristic it would replace** (0.71). As a fallback for when
    GenAI is unreachable, it is a straightforward improvement.
  - **It compresses the score scale**, though — band separation 0.55 against GenAI's 1.00, so the
    *ordering* is right while the *numbers* are not usable as marks. The optional bank fields fix
    most of that (0.55 → 0.79) without costing ranking, which is the clearest evidence that
    telling a small model more is what makes it work.
  - **Below ~3B is not a candidate.** `qwen2.5:1.5b` is erratic and `gemma3:1b` is close to random.
  - **Still open, and this is what "pursue it" would mean:** packaging a 3B GGUF via
    `llama-cpp-python` into the image, sized against 4 CPU / 6 GB *beside* Whisper's ~1.7 GB;
    measuring latency in a real container (~45–60 s per 3-question attempt extrapolated, which
    fits the timeout); deciding on score recalibration; and deciding whether it is a *fallback* or
    a first-class option for an instructor with **no GenAI account at all** — the second is a much
    stronger reason to do it, because it would make the whole system self-contained.

## Recording and transcription reliability

- **Languages other than English.** Transcription is pinned to English (`language="en"`, decision
  **E2**) and there is no plan to change that. Recording what is known, since the question will
  come up again — probably about Mandarin:
  - **The transcription half is not the obstacle.** The `small`/`medium`/`large-v3` models are
    multilingual and Mandarin is among Whisper's better-supported languages. The change is roughly
    one config knob per assignment plus a per-language decision about *which* model, since the
    quality gap between sizes is wider for non-English.
  - **The spoken boundary codes need thought, not much work.** They are digits, which every
    language transcribes well, but `digits_only()` maps only English number words
    (`"four"` → `4`). A Mandarin speaker reading 六五零 would produce characters the matcher drops.
    A per-language digit-word table is small and self-contained.
  - **Grading is the real question.** A rubric and key points written in English, a transcript in
    Mandarin, and a model asked to judge whether the ideas match is a genuinely harder task than
    either monolingual case, and it is the part that decides a grade. It would need its own
    calibration set before anyone could claim it works — the same exercise as `tools/eval/`, run
    per language.
  - **And a policy question underneath the technical one:** whether an answer in another language
    is *permitted* is a course decision, not a configuration one, with implications for fairness
    across a cohort and for who can review a flagged recording.

## Question-bank validation

- **Enforce the optional gradability fields?** The Bank schema now supports `referenceAnswer`,
  `scoringBands` and `commonErrors`, and the authoring spec asks for them on `core` and `stretch`
  items. The 2026-08-21 study says they are worth having even on the **large** model in production
  (pair accuracy 0.83 → 0.92, band separation 0.975 → 1.000), so this is no longer a question of
  *whether* they help.
  - What is left is a migration question: 1,414 existing pilot-course questions do not have them, and
    backfilling is an LLM pass plus a read-through per week. A `validate-bank.js` warning would be
    honest but would fire on every existing bank until that is done, so the sequence is
    **backfill → warn → maybe require**, not the other way round.

## Accommodations — a supported alternative format

Deferred deliberately at the `0.1.0-alpha.1` pilot (decision **R8**). Extended time is supported;
anything further is currently worked out case by case between the instructor, the student, and a
disability services office, and instructors are invited to propose what they did.

What would move this from "handled case by case" to "supported":

- **Two or three real cases from the pilot.** Prescribing a format before seeing one would be
  guessing, and the whole point of the alpha is to produce those cases.
- **The Purdue DRC conversation**, which gives at least one institution's actual position rather
  than an inference about it.
- **A decision on option 2** (D2c): a typed real-time variant — same frozen bank, same server-timed
  window, rolling challenge codes typed rather than spoken, keystroke timing in place of word
  timestamps. It preserves "unassisted and real-time", which options 1 and 3 do and do not
  respectively, but it is a genuine build: a new capture path plus a new validator, and it is
  weaker against a second person typing.
  - The honest counter-argument is that option 1 (live oral over video) preserves the construct
    exactly, needs no code, and does not scale past a handful of students — which is fine, because
    this accommodation is rare. Option 2 is only worth building if the pilot shows it is *not* rare,
    or shows that option 1 fails for a reason we have not thought of.

## Oral Quiz 0 — read the questions

100 prerequisite questions authored 2026-08-22 for the pilot course. Validated against the schema
and smoke-tested end to end, but **no human has read them yet**.

Low risk and deliberately not urgent: the quiz is ungraded, the content is prerequisite-level
rather than course material, and a bad question costs a student nothing. Worth a read-through of a
sample before students see it, and a fuller pass if it gets reused for a graded assignment.

- Bank: `courses/<id>/banks/quiz-00-prerequisites.json` (own private repo).
- Distribution: intro 22 / core 53 / stretch 25; all five question kinds; every item carries
  `referenceAnswer` + `scoringBands` + `commonErrors`.
- Coverage: linear algebra, probability and statistics, calculus and optimisation, programming and
  computational reasoning, and general quantitative reasoning.
