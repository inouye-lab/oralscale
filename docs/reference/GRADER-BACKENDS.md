# Grading backends — measurement and recommendation

**Current default (2026-09-21): Qwen3.5 4B Q4_K_M, context/no-thinking.** See
[LOCAL-GRADING.md](LOCAL-GRADING.md) for points-mode evidence and the versioned integration.
The study below is preserved as historical band-mode evidence; its “default” and “only model”
statements describe the earlier release, not current configuration.

_Re-measured 2026-08-31. Twelve local candidates and two Purdue GenAI models over the same answers.
Reproduce with `tools/eval/model-study.py` (local) and `tools/eval/bench.py` (GenAI); qualify your
own course with `tools/calibrate-grader.py`._

## Historical band-mode recommendation (superseded for new local packages)

**There is no model menu any more, and that is the finding.** Twelve local candidates were measured;
eleven lost. The choice that remains is a *backend* choice, and it is a real one.

| | What you get | Cost | Set with |
|---|---|---|---|
| **`local` + `qwen2.5-3b`** — the default | The best local grader measured at any size. Grading never leaves the Gradescope container, needs no account, and cannot be taken down by an outage. | It is beaten by GenAI. | nothing — it is the default |
| **`genai` + `qwen3.6:27b`** | **Noticeably better marking.** Fewer inversions, fewer ties, lower error on both evaluation sets — and it is roughly 8× faster per question. | **The transcript leaves the container.** De-identified and PII-redacted, to a service carrying no FERPA certification. | `--backend genai` |

```bash
node tools/set-grading.js --course courses/<id> --backend genai
node tools/set-grading.js --course courses/<id> --show
```

**`local` is the default despite grading worse, on purpose: exporting student work should be an act,
not an omission.** Switching costs nobody a regrade — both graders share one band→score table, so
the marks stay commensurable and nobody's scale shifts.

### Getting a Purdue GenAI key

1. Sign in at **[genai.rcac.purdue.edu](https://genai.rcac.purdue.edu)**.
2. Click the **account icon** (top right) → **Account**.
3. Find **API keys** and click **Show**.

Put all three values in `courses/<id>/.env`, inside the course folder, so the folder stays the whole
course:

```
GENAI_STUDIO_API_KEY=<the key you just revealed>
GENAI_STUDIO_BASE_URL=https://genai.rcac.purdue.edu
GENAI_STUDIO_MODEL=qwen3.6:27b
```

A partial set is worse than none: with no fallbacks (INV-GRADE-1), missing credentials mean the
affected submissions go **ungraded** and are flagged for regrade. The key is read at **build** time
and written into the zip, so rebuild and re-upload after changing any of the three.

**Do not judge oral quizzes on the local grader alone.** If your first run comes back with answers
that should have failed collecting partial credit, the usual cause is the backend rather than the
format or the questions — the two graders agree on strong answers and diverge almost entirely on
weak and wrong ones, with `local` the generous one. On one real 100-question bank (396 answers), a
fluent, confident answer to the *wrong question* scored 2.7/10 under `local` and 0.4/10 under
`genai`.

| on the 512 | `local` qwen2.5-3b | `genai` qwen3.6:27b |
|---|---|---|
| inversions | 2 / 768 | **2 / 768** |
| ordering | 85% | **92%** |
| ties | 15% | **7%** |
| MAE | 0.097 | **0.050** |

**There is no local upgrade path, and no medium or large tier.** Every larger model measured grades
worse — see below. If the 3B is not good enough for your course, the answer is `genai`, not a bigger
GGUF.

---

## Scoring modes: bands, or points (INV-GRADE-10)

The backend decides **who reads the transcript**. The scoring mode decides **what that reader is
asked**. The two choices are independent, and every backend supports both modes.

| `scoring` | The model is asked | The mark comes from |
|---|---|---|
| unset / `"bands"` — engine default | pick one named band (`full` … `none`) against band descriptions | the ladder's price for that band |
| `"points"` | for **each** required (`R1…`) and optional (`O1…`) point: `stated`, `partly`, `absent` or `contradicted`, quoting the student; plus any false claim left uncorrected | `autograder/source/pointscore.py`, then the same ladder |

**Why points.** Band mode leaves the grading policy inside the prompt, where the model has to count
against it. In one pilot quiz's ladder, the `strong` and `full` descriptions overlapped at exactly
two optional points, and no band described an answer with four. Points mode asks the model only
narrow questions it answers reliably. Code applies the thresholds, so they cannot be misread. The
same verdicts give the same mark on every backend, and a policy change means recomputing from the
saved verdicts, not regrading.

**The arithmetic in band-priced points mode** (defaults; each number is a key under `scoring`;
adding `table` replaces the band thresholds below with a curve — see *Curve mode*):
- Required points are worth 2 each and optional points 1 each. `partly` earns half the weight, and
  `contradicted` costs the weight.
- With `base` = 2 × the number of required points: below base is `weak`, base is `partial`,
  base + 1 is `strong`, and base + 2 is `full`. The thresholds are relative to each question
  because Banks mix 2- and 3-required questions.
- An answer that conveys no required point is `weak` at most, and zero or fewer points is `none`.
- An uncorrected false claim caps the answer at `partial`.
- A slip the student corrects during the answer is never penalised.
- A penalty with no quote of the student's words is not applied.
- A reply missing a verdict for any point is re-asked, then marked REGRADE REQUIRED. It is never
  counted as `absent`.

**What students see.** They get narrative feedback: what they got right — including a good example
of their own — and anything to revisit, with what the question was getting at only when the answer
missed it. They are **not** told which listed ideas they did not mention (instructor, 2026-09-15):
a student who answered well and is handed a list of unsaid things reads it as what they lost, and
several of those points are not derivable from the prompt. They never see points, verdicts or the
rubric. The per-point record goes in the instructor-only detail.

### Curve mode: `scoring.table`

Set `table` and the bands stop deciding the mark — the point total is read straight off a curve the
instructor writes, one entry per whole point, with a total between two entries taking the lower:

```json
"scoring": { "mode": "points", "table": [0, 0.7, 0.85, 0.9, 0.92, 0.95, 0.97, 1.0],
             "novelCap": 3, "falseClaimCapScore": 0.85, "noCoreCapScore": 0.7 }
```

- **Novel points.** The model also reports substantive, correct points the student made that are on
  neither list, each `full` (+`novelWeight`), `partial` (half) or `wrong`, with a quote. Credit is
  capped at `novelCap` per answer. `wrong` is a false claim: it costs the weight and trips the
  ceiling. A novel point without a quote counts neither way, exactly like an unquoted penalty.
- **`partlyFactor` prices a half-made point.** 0.5 by default; set it to 1 and a `partly` earns
  what a `stated` does (and so does a novel `partial`). It may not exceed 1. At 1, an answer that
  gestures at every point scores exactly what a crisp one does — usually more than intended.
- **`curveRounding` decides which way a half point goes.** `"down"` (default) or `"up"`. Rounding
  up is the cheaper kindness: `partly` stays worth half, so two of them still buy only what one
  whole point buys, but a lone half-made point can never round away to nothing. That matters
  because the feedback tells the student the grader saw something; a mark of zero for it says
  otherwise.
- **Two ceilings replace the band cap.** `falseClaimCapScore` is the most an answer with an
  uncorrected false claim can score; `noCoreCapScore` the most an answer that conveyed no core
  point can score, so depth and novel credit cannot stand in for answering the question.
- **No ladder is needed.** No band name is ever produced, so a course on a curve is not required to
  keep a five-rung ladder it does not use. An unusable curve — fewer than two entries, non-numeric,
  outside 0–1, or decreasing — is refused whole and grades nobody, like any other bad policy.

**Measurement status.** A simulation of students who hit each point independently put points mode
slightly below the pilot's Quiz 1 scale and well above its Quiz 2 band ladder as shipped (/10, best
4 of 5: 8.79 / 9.31 / 9.72 at p = 0.6 / 0.7 / 0.8). No backend has yet been measured against
labelled answers in points mode, so the tables below all describe band mode. The per-point JSON is
a heavier ask than one band label, and the local 3B model is the backend most likely to struggle
with it. Re-judge a sample of real transcripts before relying on it, and watch the false-claim
rate, since the cap is the harshest rule.

## The result that decides this

**Spending more memory on a bigger local model does not buy better grading. It buys worse
grading.** Twelve candidates from 1.5B to 9B, one quantisation (Q4_K_M), one prompt, the same 512
constructed answers and the same 32 hand-authored ones. The 2.07 GB incumbent wins both.

| model | peak | ordering | **inversions** | ties | MAE (tuned) | levels |
|---|---|---|---|---|---|---|
| **`qwen2.5-3b`** | **2.07 GB** | **85%** | 2/768 | **15%** | **0.097** | **4** |
| `qwen2.5-7b` | 4.74 GB | 80% | **1/768** | 20% | 0.114 | 3 |
| `gemma4-e4b` | 5.13 GB | 77% | 3/768 | 23% | 0.134 | 3 |
| `qwen3-8b` | 5.38 GB | 71% | 3/768 | 29% | 0.151 | 3 |
| `qwen3.5-4b` | 2.89 GB | 68% | 4/768 | 32% | 0.158 | 3 |
| `qwen3-4b` | 3.01 GB | 67% | 4/768 | 32% | 0.152 | 4 |
| `ministral-8b` | 5.28 GB | 64% | **0/768** | 36% | 0.160 | 3 |
| ~~`qwen3.5-9b`~~ | ~~5.64 GB~~ | 62% | 3/768 | 37% | 0.159 | 3 |
| `gemma3-4b` | 2.99 GB | 54% | 8/768 | 45% | 0.184 | 3 |
| `phi4-mini` | 2.95 GB | 51% | 2/768 | 49% | 0.182 | 2 |
| `qwen2.5-1.5b` | 1.15 GB | 74% | 6/768 | 25% | 0.144 | 3 |
| `llama3.2-3b` | 2.44 GB | 29% | 4/768 | 71% | 0.248 | 3 |

Every model produced 0 unparseable replies, so nothing here is a formatting artefact.

**Why the bigger models lose: they are generous, and generosity shows up as ties.** The 3B is the
only model in the table that errs *harsh*. Every other one hands `weak` answers most of a mark —
`qwen3.5-9b` gives them **0.83** against a nominal 0.30 — which collapses the distinction between a
good answer and a thin one. A tie is not unfair, but it is the grade failing to say anything, and at
37% ties the grader has stopped discriminating.

**`levels` is the column to read alongside a flattering MAE.** It counts the distinct scores left
after fitting a per-model table (below). A model that ties everything can be "calibrated" into a
better MAE by collapsing two bands onto one number — Phi-4-mini's fitted table is `0.65/0/0/0`,
which scores well by giving up on three quarters of the scale. Only `qwen2.5-3b` and `qwen3-4b` keep
all four.

### The closest thing to a case for a bigger model, and why it is not offered

`qwen2.5-7b` has the **fewest inversions of any local model, 1 in 768**, against the 3B's 2 — and an
inversion is the failure calibration cannot repair, so that is the one number worth pausing over. It
is not enough. It costs 2.3× the memory, 2× the time per question (58.8 s against 28.5 s, measured
in-container), 5 points of ordering accuracy and a scoring level, to move a count from 2 to 1 on a
768-pair sample where that difference is one answer. `ministral-8b` records 0 inversions, and at 36%
ties that is the trivial kind of correctness: it rarely inverts because it rarely distinguishes.

**A menu of one is honest here.** Offering the 7B would imply the trade is live; measured, it is not.
The trade that IS live is `genai`.

## Per-model tuned mapping tables

Each model was given its own `band → score` table, fitted to minimise absolute error against the
intended band and forced monotone, then scored **out of fold** (4-fold, grouped by question, so a
question's four answers never straddle the split). An in-sample table would flatter every model
equally and rank them by how much room each had to cheat.

This matters for a comparison because a fixed table punishes a model for a bias one number would
fix. It cannot change ordering, inversions or ties — any monotone table preserves those exactly — so
the split is: **judge separation by inversions and ties, judge what is left by calibrated MAE.**

| model | fitted table (full/partial/weak/none) | reading |
|---|---|---|
| **`qwen2.5-3b`** | **1.0 / 0.65 / 0.3 / 0.0** | **identical to the shipped table** |
| `qwen2.5-7b` | 1.0 / 0.3 / 0.3 / 0.0 | `partial` and `weak` merged |
| `qwen3-4b` | 0.65 / 0.3 / 0.15 / 0.0 | every band marked down — systematically generous |
| `gemma4-e4b` | 1.0 / 0.3 / 0.0 / 0.0 | `weak` written off entirely |
| `phi4-mini` | 0.65 / 0.0 / 0.0 / 0.0 | two levels left |
| `llama3.2-3b` | 0.65 / 0.3 / 0.0 / 0.0 | — |

**`qwen2.5-3b` is the only candidate whose fitted table came back equal to the shipped one.** It is
already calibrated; the others need a table to hide a bias, and the table costs resolution to do it.

That is also why the shipped table stays shared between both backends rather than becoming
per-model. One table makes marks **commensurable** — switching backend mid-term, or regrading one
week with the other grader, does not shift every student's scale. A per-model table would buy a
little MAE and give that up. The right move is to pick a model that fits the table, and one does.

## Memory — measured, not estimated

Peak resident set of the real grading path, read from the kernel's `VmHWM` inside a Gradescope-shaped
container (glibc Ubuntu, CPU only, capped at 4 CPU / 6 GB, `n_ctx=4096`, `n_batch=256`) while running
an actual grading call. This is a whole-process figure — Python and the runtime are already in it.

**The old table in this file was estimated from file size plus a 0.4 GB guess, and it was wrong in
both directions**: it listed the 3B at 2.4 GB (it is 2.07) and the 7B at 4.6 GB (it is 4.74).

| model | file | **peak** | headroom in 6 GB | verdict |
|---|---|---|---|---|
| `qwen2.5-1.5b` | 0.92 GB | 1.15 GB | 81% | fits |
| **`qwen2.5-3b`** | 1.80 GB | **2.07 GB** | **66%** | **default** |
| `llama3.2-3b` | 1.88 GB | 2.44 GB | 59% | fits |
| `qwen3.5-4b` | 2.55 GB | 2.89 GB | 52% | fits |
| `phi4-mini` | 2.32 GB | 2.95 GB | 51% | fits |
| `gemma3-4b` | 2.32 GB | 2.99 GB | 50% | fits |
| `qwen3-4b` | 2.33 GB | 3.02 GB | 50% | fits |
| `qwen2.5-7b` | 4.36 GB | 4.74 GB | 21% | fits |
| `gemma4-e4b` | 4.64 GB | 5.13 GB | 15% | tight |
| `ministral-8b` | 4.57 GB | 5.28 GB | 12% | tight |
| `qwen3-8b` | 4.68 GB | 5.38 GB | 10% | **at the line — see below** |
| `qwen3.5-9b` | 5.29 GB | **5.64 GB** | 6% | **ruled out** |

**The working ceiling is 5.5 GB peak, not 6.0.** A container that only just holds today is one that
OOMs after any future change — a longer context, a bigger Whisper model, one more Python import.

`qwen3.5-9b` is the only candidate the ceiling excludes outright. **`qwen3-8b` is a second casualty
in practice**: these figures are arm64, and a cross-check on Gradescope's actual x86_64 measured
1–3% heavier (`qwen2.5-3b` 2.07 → 2.14 GB, `qwen2.5-7b` 4.74 → 4.80 GB). Applying that puts
`qwen3-8b` at roughly 5.5 GB on the architecture that matters. Neither is worth pursuing on quality
anyway — they place 4th and 8th.

**Memory does not grow with `questionsPerAttempt`.** Local grading is one question per call, so the
context stays near 2k whether an attempt has 3 questions or 20. More questions costs *time*, not
memory. (The GenAI path batches for the opposite reason: a remote rate limit counts requests.)

## Purdue GenAI: `qwen3.6:27b`, now the default

Both through the shipped `grade.py` path, byte-identical inputs, same band→score table.

**512 constructed answers**

| | `gemma4:26b-a4b` (was the default) | **`qwen3.6:27b`** |
|---|---|---|
| **inversions** | 3 / 768 | **2 / 768** |
| ordering, strict | 91% | **92%** |
| ties | 69 (9%) | **56 (7%)** |
| MAE | 0.058 | **0.050** |

**32 hand-authored answers**

| | `gemma4:26b-a4b` | **`qwen3.6:27b`** |
|---|---|---|
| inversions | 0 / 48 | 0 / 48 |
| ordering, strict | 88% | **90%** |
| ties | 12% | **10%** |
| MAE | 0.064 | **0.055** |
| off-question answers scored | 0.04 | **0.00** |

**Qwen 3.6 wins on every metric on both sets and loses on none.** It is also the only one of the two
that gives a fluent, confident answer to the *neighbouring* question a clean zero — the hard negative
this benchmark is built around. It is now the default in `grade.py` (`DEFAULT_GENAI_MODEL`); a course
can still pin its own with `GENAI_STUDIO_MODEL`.

Both remain better than any local model, which is the honest framing: **the local grader's case is
privacy and availability, not accuracy.** If marking quality is what you care about most, `genai` is
the answer — and no local model, at any size that fits, changes that.

## Prompting: the shipped prompts are the right ones, and that was not obvious

Every prompt variant in `tools/eval/variants.py` and `tools/eval/genai_variants.py` was re-run
against the leading candidates. **Nothing beat the shipped prompt at full scale, for any model.**

The shipped local prompt (`band_v3`) carries an *anti-harshness* rule written for Qwen2.5-3B, the one
model that errs harsh. Since every other candidate errs generous, the obvious hypothesis was that the
rule pushes them the wrong way — and on a 128-answer screen it looked true:

| | 128-answer screen | **full 512** |
|---|---|---|
| `gemma4-e4b`, shipped `band_v3` | 77%, MAE 0.134 | 77%, 3 inv, MAE 0.134 |
| `gemma4-e4b` + `band_v3_kp` | **81%, MAE 0.107** | 77%, 3 inv, MAE 0.131 |
| `qwen2.5-3b`, shipped `band_v3` | 85%, MAE 0.097 | 85%, 2 inv, MAE 0.097 |
| `qwen2.5-3b` + `band_v3_kp` | **88%, MAE 0.075** | 87%, **3 inv**, MAE 0.079 |

**The gains did not survive.** Gemma's vanished entirely. Qwen's improved MAE on constructed answers
came with an extra inversion, and on the hand-authored answers `band_v3_kp` was clearly *worse* —
88% against 92%, MAE 0.061 against 0.041. That is the same trap that got `band_v5` rejected in v8.4,
and for the same reason: a constructed `weak` is the first sentence of the author's own prose, so a
stricter prompt looks good against it and bad against what a struggling student actually says.

The same happened on GenAI. `band_strict` beat the shipped prompt on the 32 hand-authored answers for
*both* models (92%, MAE 0.044) and then **doubled the inversions on the 512** — 2→4 for Qwen 3.6,
3→7 for Gemma 4. Rejected.

**The lesson is about method, not prompts: a 32-answer set cannot separate two good graders, and a
128-answer screen cannot either.** On the small set several model/prompt combinations produced
byte-identical score vectors. Judge a prompt change on inversions at full scale, and on the
hand-authored set for the weak/none boundary. Both, or neither.

## The runtime pin is a model-compatibility decision

`setup.sh` pinned `llama-cpp-python==0.3.2`, which was never chosen deliberately. That version
predates Qwen3, Qwen3.5, Gemma 3, Gemma 4 and Phi-4, and **7 of the 12 candidates cannot load under
it** — including `qwen3-4b` and `gemma3-4b`, which this file and `localmodel.MODELS` were *offering
as choices*. An instructor selecting one got a failed image build with an opaque
`ValueError: Failed to load model from file`.

| loads under 0.3.2 | fails under 0.3.2 |
|---|---|
| `qwen2.5-1.5b`, `qwen2.5-3b`, `qwen2.5-7b`, `llama3.2-3b`, `ministral-8b` | `phi4-mini`, `gemma3-4b`, `qwen3-4b`, `qwen3.5-4b`, `gemma4-e4b`, `qwen3-8b`, `qwen3.5-9b` |

Now pinned to **0.3.35**, verified to compile from source on x86_64 glibc Ubuntu with the same
`CMAKE_ARGS`, and to load every model in `MODELS`. Raise it whenever a model is added that needs a
newer llama.cpp.

## What was measured

**A. 512 answers across all 16 banks** (`tools/eval/bench.py`, `tools/eval/model-study.py`). 128
questions, 8 per bank, 4 answers each. Sampling is seeded, so every model saw byte-identical inputs.
The relative quality of the four is fixed by **construction**:

| built as | should score |
|---|---|
| the question's own `referenceAnswer` | highest |
| that answer truncated to ~60% of its sentences | below it |
| its first sentence only | below that |
| **a different question's reference answer, from the same bank** | lowest |

**B. The 32 hand-authored calibration answers**, each written for an intended band — the only *true*
absolute labels here, and the set that has now twice caught a change the big one waved through.

**Inversions are the fairness metric; ties are not.** An inversion puts a worse answer *above* a
better one; a tie gives two different answers the same mark. Blunt is survivable and fixable by
calibration; backwards is neither, because a monotone map preserves a wrong order as faithfully as a
right one.

## The FERPA position on `genai`

Purdue GenAI Studio is on-premises at Purdue, and OralScale sends it only the **de-identified,
PII-redacted transcript** — never the audio, never a name, never an email (INV-PRIV-4). Detected
prompt-injection attempts are never sent at all (INV-SEC-10).

**It carries no FERPA certification, and OralScale makes no FERPA claim on its behalf.** Sending
student work there is the instructor's decision and the instructor's risk. That is why `local` is the
default — and now the local default is also the best local grader available, rather than a
compromise.

**The key is never shipped when it is not needed.** `build-autograder.js` checks every assignment; if
none uses `genai`, the credentials are left out of the zip entirely.

## Backend failure behaviour

There are no automatic grader fallbacks. If the configured backend is unavailable, the recording
remains ungraded and is marked `REGRADE REQUIRED`. Once restored, regrade all affected submissions
together so the cohort is measured consistently (INV-GRADE-1).

`heuristic` is selectable *deliberately* — an explicit choice is not a degradation and is not
flagged. That is what the test suites use. It is the only grader here that actively mis-ranks, and it
hands 0.400 to answers that deserve 0.

## Reproducing this

```bash
# download the candidate slate (~40 GB) and serve each with llama.cpp, one at a time
python3 tools/eval/model-study.py --list
python3 tools/eval/model-study.py --model qwen2.5-3b --set calibration
python3 tools/eval/model-study.py --model qwen2.5-3b --set constructed --per-bank 8
python3 tools/eval/study-report.py

# Purdue GenAI, either model
GENAI_STUDIO_MODEL=qwen3.6:27b python3 tools/eval/bench.py --grader genai --per-bank 8 --save q36.json

# qualify and calibrate ONE backend for your course
python3 tools/calibrate-grader.py --course courses/<id> --backend local
```

**Twenty of your own graded answers beat any built-in fixture.** Grading twenty real student answers
yourself and passing them as `--gold` calibrates to *your* standard in *your* course.

## Caveats

- **The 512-answer set is constructed, not human-labelled.** Its *ordering* is exact; the band
  attached to each rung is a reasonable label, not a certainty. Trust the ordering and inversion
  counts; treat its MAE as indicative.
- **A constructed `weak` is not a real `weak`.** It is the first sentence of the author's own prose:
  on topic by construction. **Judge the weak/none boundary on hand-authored answers, because that
  boundary is where a student gets a zero.**
- **32 answers is a small set** — enough to catch a grader that mis-ranks or is wildly miscalibrated,
  not enough to separate two good graders. Twice now it has produced a "win" that failed to
  replicate. Treat any result that rests on it alone as a hypothesis.
- **Memory figures are arm64**, cross-checked against x86_64 on two models (1–3% heavier there). The
  three largest x86_64 probes timed out under emulation rather than being measured.
- **Quality was measured on Apple-silicon llama.cpp with Metal**, at temperature 0; the container
  timings are separate and were measured CPU-only in a Gradescope-shaped container, uncontended.
- **The answers are written, not transcribed.** Real Whisper output is messier.
