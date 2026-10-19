# Changelog

User-facing release history. Format follows [Keep a Changelog](https://keepachangelog.com/);
versioning is [Semantic Versioning](https://semver.org/), with the caveat that **pre-1.0 alpha
releases may break compatibility between any two versions**.

Internal development used a `v7.x` labelling scheme before the first public release. Those labels
are retained in [`docs/project/STATUS.md`](docs/project/STATUS.md) as project history and are **not** public
versions. The public series starts at `0.1.0-alpha.1`.

## [Unreleased]

## [0.2.0-alpha.1] — 2026-10-19

Second instructor release. **Local grading and the points curve are now the recommended setup**:
new courses (from `courses/_template/` or `npm run setup`) grade inside the Gradescope container
with Qwen3.5 4B and score on the curve, and `courses/_template/question-design.md` carries the
question-design house style the pilot course converged on. Existing courses keep exactly what
their `course.json` says: nothing switches a released assignment's grader or scale (INV-DEPLOY-6).
Rebuild autograder zips for new assignments only.

### Highlights
- **Recommended course defaults.** `courses/_template/course.json`, `tools/setup.js` and the demo
  course now ship `gradingBackend: "local"` with `localModel: "qwen3.5-4b"`, the points curve
  (`0 / 0.70 / 0.85 / 0.90 / 0.92 / 0.95 / 0.97 / 1.00`, `curveRounding: "up"`, novel points up to
  3, false-claim cap 0.85, no-core cap 0.70), `dropLowest`, a five-question
  `intro / core / core / core / stretch` mix, and a `feedbackFooter` telling students a good,
  correct answer earns about 90%. The engine's own default when `scoring` is unset is still the
  band ladder.
- **Question-design template.** `courses/_template/question-design.md` now has three parts: the
  course-specific page to fill in; the recommended house style (one core criterion per explicit
  ask, never a remembered list, at most two asks, self-contained prompts, a later ask must not
  answer an earlier one, notation for reading not speaking, first-read clarity, a fully worked
  question with `evidence` and `gradingContext`); and a running log of lessons from each review.
- **The demo bank is a worked example of the recommended schema.** `general-stem.json` revision
  2.0: one or two core points per question, `bonusPoints` for depth, and `gradingContext` for the
  local grader. Prompts and question ids are unchanged.
- **Standard local grading profile `qwen35-context-off-v1`** (INV-LOCAL-1/2): Qwen3.5 4B Q4_K_M on
  a pinned llama.cpp runtime with SHA256-verified artifacts, thinking disabled, one question at a
  time, constrained JSON. Evidence and limits in `docs/reference/LOCAL-GRADING.md`. Explicit
  `qwen2.5-3b` keeps the historical grader.
- **Points curve scoring** (INV-GRADE-10): `scoring.table` turns the point total into the mark;
  substantive correct points nobody listed earn credit; student feedback never lists what they
  did not say.
- **Positive mistakes beat negative mistakes** (INV-GRADE-11), stated as a project-wide rule:
  uncertain choices resolve in the student's favour, and grader evaluations report over- and
  under-crediting separately.

### Added
- **Timing and memory diagnostics in every autograder** (INV-USE-6). Students see local start,
  finish and elapsed time; instructors get stage timings and container memory use, peak, cap and
  headroom.
- **`feedbackFooter`** (INV-USE-7): an optional fixed note under every question's feedback.
- **The Worker publishes which bank revision it serves**, with a keyed tag, and `gen-url.js`
  refuses to mint a link against a Worker serving a different bank (INV-DEPLOY-7).
- **A GenAI autograder is never built against a model the service no longer offers**
  (INV-DEPLOY-8, `tools/genai-models.js`).
- **Instructor identity-debug builds** (INV-DEBUG-1) with their own filename and flag-only identity.
- **`tools/bank-worksheet.js`** offline Keep / Revise / Remove review worksheet, and a
  quiz-bank authoring skill for coding agents (`.claude/skills/quiz-bank-authoring/`).
- **QUESTION-DESIGN-GUIDE Step 7**: nine rules a prompt and its key owe each other.
- **Shared model cache for developer workstations**: local tooling resolves model weights offline
  from the standard Hugging Face cache instead of per-repository copies.

### Changed
- **Every verified attempt is graded** (INV-CODE-4). An attempt with at least half its boundary
  codes heard and no other integrity failure keeps its score, with a review flag; otherwise it
  scores 0 but is still graded, with a hidden would-have-been score for the instructor to
  override with. Previously one missed code zeroed the attempt.
- **The GenAI key ships only in zips that grade with GenAI**; a local-only zip no longer carries
  it, and a GenAI-only zip no longer carries the local model.

### Fixed
- **Gradescope image builds failed in pip's resolver** on Ubuntu 22.04's pip 22.0.2 when a
  dependency release forced backtracking. Setup now installs pip 24.3.1 first.
- **A braceless `\tfrac12` swallowed the character after it** in the student app's math renderer.
  The renderer also gains `\dagger`, norm bars and `\operatorname`.


### Added
- **`tools/bank-worksheet.js`: an offline instructor feedback worksheet for a draft bank.**
  - Questions appear in a shuffled order, seeded by the bank's SHA-256, so the order stays the
    same across reloads of one revision. Question IDs are always visible. Prompts go through
    the student app's parser.
  - Each question shows its core and supporting criteria with their sufficient examples,
    together with the misconceptions and the verbatim evidence.
  - The reviewer marks each question Keep, Revise or Remove and can add a note. **Copy
    feedback** exports every note as plain text; notes can also be exported and imported as
    JSON tied to the bank hash.
  - `bank-review-sheet.js` remains the read-only view.
- **Quiz-bank authoring skill (`.claude/skills/quiz-bank-authoring/`).** The skill orients a
  coding agent before it writes a bank. It points to the guideline documents, which remain the
  place for question-writing guidance, and to the course's `question-design.md`. It then walks
  through the private-course workflow: sources, draft, red-team audit, worksheet and handoff.
- **Points scoring (`scoring: "points"`, INV-GRADE-10), opt-in per course or assignment.** The
  grader judges every point on its own — `stated`, `partly`, `absent` or `contradicted`, quoting
  the student — and lists any false claims the student left uncorrected. Code then computes the
  mark: required points are worth 2, optional points 1, half for `partly`, and minus the weight for
  an uncorrected contradiction. The thresholds sit relative to the question's required total
  (+0 partial, +1 strong, +2 full). An uncorrected false claim caps the answer at partial. A
  mistake the student corrects during the answer is never penalised. Students get a short narrative
  covering what they got right, what to revisit, and ideas that would have strengthened the answer.
  The narrative never shows the rubric or the arithmetic. Leaving `scoring` unset keeps the band
  ladder unchanged. The pilot course uses points from Quiz 3 on.

### Changed
- **Optional points can now RAISE a band, and courses set where the top sits.** The guarantee is
  unchanged and now stated as such: an omitted optional point may never push a band *down* and never
  appears under "missed". How many are needed to push one *up* is the ladder's business. The pilot course
  prices a complete required-only answer at `partial` (0.80), with one or two optional points for
  `strong` (0.92) and two or three for `full` (1.00). The engine default is unchanged.
- **Students are told what would have made an answer stronger.** The optional points they did not
  make are reported on every answer, including full marks, in their own section after the mark —
  never merged into "missed".
- **`keyPoints` means REQUIRED-ONLY; `bonusPoints` is new** (INV-GRADE-9). A point belongs in
  `keyPoints` only if an answer without it is *wrong* or has not answered the question as stated.
  Anything that merely makes an answer stronger goes in `bonusPoints`, which both graders are told
  may never lower a band and may never be reported as "missed". The `full` band is now defined as
  *answered the question as asked and said nothing false*. **This grades more leniently.** Banks
  with no `bonusPoints` behave exactly as before; `validate-bank.js` warns above four required
  points and prints the per-bank mean.
- **The topic/principle line above each question is off by default** (INV-COURSE-5). Set
  `showQuestionMeta: true` per assignment to restore it. When false the fields are not merely
  hidden — they are not in the deployed bundle and the Signer never sends them.
- **The Worker bundle carries prompts, not the answer key** (INV-PRIV-7). `build-worker.js` now
  builds `bundle.json` by allow-list; `rubric`, `keyPoints`, `bonusPoints`, `referenceAnswer`,
  `scoringBands`, `commonErrors` and `evidence` no longer leave the repository. Previously the
  bundle was the entire bank.

### Fixed
- **The review player looked like it held a truncated recording.** `MediaRecorder` writes a live
  WebM stream with no Duration in its header, so the browser reports `Infinity` until it has decoded
  to the end. The review card now states the true length from the recorder clock and says the player
  is what disagrees. Display only: the certificate's `durationSec` and the autograder's duration
  measurement never used the container header.
- **A lone difficulty label ("CORE") was still shown above every prompt.** Withholding the meta line
  left `difficulty` behind. It stays in the deployed bundle because question selection uses it, but
  neither Signer sends it to the browser unless the assignment opted into the meta line.
- **Running the tests no longer overwrites the deploy bundle.** `server/worker/bundle.json` is what
  `wrangler deploy` uploads; the worker suite rebuilt it for a fixture course, so a deploy run after
  the tests could ship the wrong course. `build-worker.js` takes `--out` and the suite builds to a
  temp file.
- **The which-quiz banner named the week's topics.** It printed the assignment's full title and
  its id (`quiz-02-methods-and-models`), both of which describe the subject, above the
  quiz — and the title was stamped into the link, so the hint travelled inside the URL too. It now
  shows only the quiz number and the course. `gen-url` no longer stamps the title, and the app
  ignores it in links that already carry it. Set `shortTitle` per assignment to control the label;
  minting now **refuses** when no quiz number can be derived from the id and no `shortTitle` is
  set, rather than falling back to displaying a topic-bearing id.
- **The wrong-link hint named Gradescope.** Links may be handed out over Piazza, Brightspace or
  elsewhere; the wording is now generic.
- **A signed token carrying non-ASCII text decoded as mojibake in the browser.** The app read
  token payloads with `atob` alone, which returns one character per byte; every field that had
  ever been in a token was ASCII, so this only surfaced when links began carrying human titles
  (`Oral Quiz 2 â€" …`). Payloads are now decoded as UTF-8. All-ASCII tokens
  decode identically, so links minted before this are unaffected.

### Added
- **`shortTitle` per assignment — REQUIRED** — the short, topic-free label students see above the
  quiz ("Oral Quiz 2") and the only assignment text stamped into a link. `gen-url.js` refuses to
  mint without it and `check-course-safety.js` refuses the commit; every shipped course is
  backfilled. It is display only, so adding one changes nothing anybody is graded on.
- **`validate-bank.js` warns on prompts that need a retrieval step before the reasoning step** — a
  principle referred to by number, or a bare "one of the …" whose set the prompt never lists.
- **The app names the quiz its link is for** (INV-USE-1), above every card including the failure
  cards, and before the microphone is touched, derived from ids already present in every signed link — so links minted
  before this change gain it without being re-minted. `gen-url.js` additionally stamps human
  titles into new links.
- **A wrong-link submission is told so.** A certificate naming a different assignment or course is
  the one validation failure whose cause is given to the student; every other failure keeps the
  generic message.
- **Per-question split times on the audio clock** (INV-GRADE-8). The app reports the moments only
  it can see, measured from the first byte of audio, and the Signer signs them into the certificate
  as `clientMarks`. Signed but never trusted: every integrity check still runs on server
  timestamps. On a validation failure the autograder now prints an instructor-only per-question
  dump of the question, both clocks, and what was said.
- **A missed boundary code names itself** (INV-CODE-3). The student-visible message lists every
  code the attempt required, with where it was shown and whether it was heard.
- **`"frozen": true` on an assignment** (INV-DEPLOY-6). A frozen assignment is skipped by
  `npm run package` and refused when named explicitly, unless `--repackage-frozen`. Prevents the
  command that packages this week from silently rebuilding a released assignment's grader with a
  newer engine.


## [0.1.0-alpha.2] — 2026-09-01

First release offered to instructors outside the project. See the release notes for the two ways in:
try the live demo and a prebuilt Gradescope autograder, or take the repository and stand up your
own course.

### Added
- **The grading ladder is a course knob.** `defaults.bands` in `course.json` replaces the whole
  ladder — your own band names, however many rungs, each with a score and optionally a `meaning` —
  and `defaults.bandScores` re-prices the default five without renaming them. Resolution lives in
  one module (`autograder/source/bands.py`) that both graders import, so they cannot drift.
  A ladder is accepted only with **at least two rungs**, safe names, scores in `[0,1]`, and scores
  that do not climb as the ladder descends; anything else is rejected **whole** and the default is
  used, because a half-applied ladder would take part of a student's mark from each of two scales.
  **A custom ladder gets its prompt boundaries generated from its own `meaning` strings** — the
  shipped wording was tuned on the default names and that tuning does not transfer.
- **A fifth band, `strong`,** between `full` and `partial`. The four-rung scale forced an unfair
  call on the commonest good spoken answer — the reasoning present, one substantive piece missing —
  which had to be rounded up into a tie with a complete answer or down into a 35-point drop.
- **`tools/check-bank-evidence.js`** verifies that every `evidence` quote in a bank appears
  verbatim in the source files the bank names. Its first run on a real bank found **15 fragments
  out of 182** that had drifted — a stumble dropped, two speech-to-text sentences joined, a garbled
  word repaired. None invented, none visibly wrong on the page.
- **`tools/bank-review-sheet.js`** renders a bank as one self-contained, filterable HTML sheet, so
  an instructor can actually read a hundred questions before freezing them.
- **`tools/eval/bench.py --grader local`** measures the SHIPPED local grader in-process rather than
  a prompt variant over HTTP, so both sides of a backend comparison are the code that runs;
  `--bank`, `--course` and `--paired` narrow, price and intersect a comparison, and the remote path
  is checkpointed like the local one.

### Changed
- **Default band prices are now an even tenth per rung: `1.0 / 0.9 / 0.8 / 0.7 / 0.0`** (was
  `1.0 / 0.65 / 0.3 / 0.0` on four rungs). The old curve treated "on topic and says nothing false"
  as most of the way to a zero. The single cliff now sits where the answer changes kind rather than
  degree — between the lowest on-topic band and `none`. **This changes marks** for any course that
  does not set its own prices; ranking is unaffected, and every published ordering, inversion and
  tie figure is a rank statistic and still stands.
- **Student feedback shows the work, not just the mark.** Every question now carries four labelled
  parts in a fixed order — the question as asked, the transcript of what the student said, the
  points, and the feedback — and the **`Overall Score` heading names the aggregation rule**
  (`(drop lowest)`, `(average of all 5)`). Under `dropLowest` the student is told which questions
  counted and which was dropped. An `Overall` label over a number that is not the average of the
  marks above reads as an arithmetic error.
- **The bank-generation spec is now instructor-neutral.** One course's teaching philosophy had
  accumulated in it as if it were engineering. What to test, what a score means and what earns
  credit moved to the per-course `question-design.md`; the spec keeps the schema, what the spoken
  format makes impossible, and the failure modes any bank can have. Two new hard requirements came
  out of reviewing a real bank: **never require a remembered list** ("name the four X" is a recall
  question wearing a comprehension question's clothes) and **the prompt must be self-contained**
  (no retrieval step before the reasoning step).
- The starter bank shipped in `courses/demo/` and `courses/_testsuite/` defines all five bands, and
  `bank/schema.json` documents the current ladder and admits custom band names. It had been
  describing the superseded four-band scale to exactly the people with no other reference.

### Fixed
- **Band prices and `calibration.json` silently composed.** A course setting both got its own curve
  and then an affine transform of that curve. The autograder now raises an instructor flag instead
  of letting it pass.
- The band-name parser matches **longest name first**. Python's `|` is first-match, so a ladder
  carrying both `part` and `partial` would have booked the shorter one out of the middle of the
  longer one's text.

### Changed
- **There is no local model menu any more, and no `localModel` setting.** Twelve open-weights
  candidates from 1.5B to 9B (Qwen2.5, Qwen3, Qwen3.5, Gemma 3, Gemma 4, Phi-4-mini, Llama 3.2,
  Ministral) were measured on peak container memory and on marking quality over the same 512
  constructed and 32 hand-authored answers. **`qwen2.5-3b` wins at every size** — bigger models
  grade *worse* here, because the 3B is the only one that errs harsh and the rest are generous,
  which shows up as ties (`qwen3.5-9b` gives `weak` answers 0.83 against a nominal 0.30 and ties on
  37% of pairs against the 3B's 15%). A menu implied a choice that measurement says does not exist,
  so it is gone rather than annotated. A `course.json` that still names an old model is **not**
  broken: the autograder logs the stale setting and grades with `qwen2.5-3b`.
- **Purdue GenAI now defaults to `qwen3.6:27b`**, which beat the previous `gemma4:26b-a4b` on every
  metric on both evaluation sets and lost on none — inversions 2/768 vs 3/768, ties 7% vs 9%, mean
  error 0.050 vs 0.058, and it is the only one of the two that scores an off-question answer a clean
  zero. **No regrade is owed:** both graders share one band→score table, so nobody's scale moves.
  Pin a different model with `GENAI_STUDIO_MODEL` if you need one.
- **The choice that remains is the backend, and it is stated plainly wherever it is read.**
  `local` + `qwen2.5-3b` stays the default. **Purdue GenAI `qwen3.6:27b` grades noticeably better**
  (92% vs 85% ordering, 7% vs 15% ties, error 0.050 vs 0.097) — the cost is that the de-identified,
  PII-redacted transcript leaves the Gradescope container, to a service holding no FERPA
  certification. `local` is the default despite grading worse on purpose: exporting student work
  should be an act, not an omission. `set-grading.js --model` now refuses and points at
  `--backend genai`.

### Fixed
- **The autograder could not build with several of the models it offered.** `setup.sh` pinned
  `llama-cpp-python==0.3.2`, which predates Qwen3, Qwen3.5, Gemma 3, Gemma 4 and Phi-4 — **7 of the
  12 candidates cannot load under it, including `qwen3-4b` and `gemma3-4b`, which the model table
  listed as instructor choices.** Selecting one produced a failed image build with an opaque
  `ValueError: Failed to load model from file`. Now pinned to `0.3.35`, verified to compile from
  source on x86_64 glibc Ubuntu with the same flags and to load every bundled model.
- **The published memory table was estimated, not measured, and wrong in both directions.** Peak
  usage is now read from the kernel's high-water mark inside a container capped at Gradescope's
  4 CPU / 6 GB while running a real grading call: the 3B is **2.07 GB**, not the 2.4 GB claimed, and
  the 7B is 4.74 GB, not 4.6 GB.
- **The bundled local grader gave every answer a 0.** It was asked for a *number* between 0 and 1,
  which a 3B model cannot produce reliably; it now picks one of four named bands
  (`full`/`partial`/`weak`/`none`) and the autograder does the arithmetic (INV-GRADE-5). Measured
  against Purdue GenAI on 35 answers: mean error 0.460 → **0.117**, within-question rank agreement
  28% → **95%**, and answers wrongly collapsed to zero **21 of 26 → 0**. Nothing else about the
  prompt changed. If you graded with `gradingBackend: "local"` before this release, rebuild and
  re-upload the autograder and regrade — the old marks are not salvageable.
- The mint-branch output no longer tells students Gradescope has a "highest score" setting. It does
  not; it grades the **active** submission. Students are now told their newest upload counts and how
  to re-activate an older one from Submission History.

- **Purdue GenAI was paying for the same mistake, quietly.** It is `gemma4:26b-a4b` — a
  mixture-of-experts with roughly *four billion active parameters per token* — so the gap to a 3B is
  much smaller than "26B vs 3B" suggests, and the defect was never capacity. Across 512 answers
  spanning all 16 banks: asked for a number, 9 inversions at MAE 0.092; asked for a band, 5 at
  0.066; asked for a band derived from the `covered`/`missed` key points it already returns,
  **4 at 0.058**. Both graders now share the same four band names and the same band→score table, so
  their marks are **commensurable** — switching backend mid-term no longer shifts every student's
  scale. Rebuild and re-upload your autograders.
- **A GenAI reply with no readable band is now an ungraded answer, not a zero.** Well-formed JSON
  carrying prose where a band name belongs used to normalise straight to 0.0 — the class-wide zero
  rebuilt in the parser, where no prompt change could reach it. It is dropped so the retry ladder
  re-asks, and failing that you get `REGRADE REQUIRED` rather than a mark.
- **Model weights are no longer packaged into the autograder zip.** `setup.sh` already downloaded
  them at image build time; `build.sh` was also sweeping in whatever a developer had in
  `source/models/`, so uploads went from ~95 KB to **1.9 GB** (25 GB for a 14-week course).
  Gradescope does not reject an oversized upload cleanly — it takes twenty minutes or dies on a weak
  connection — so the build now refuses any zip over 100 MB and names its largest entries.

### Added
- **[docs/reference/GRADER-BACKENDS.md](docs/reference/GRADER-BACKENDS.md) re-measured end to end**,
  and the pre-band numbers removed rather than kept alongside. Short version: the local grader is no
  longer the compromise it was — **3 inversions in 768 pairs against GenAI's 4**, and on
  hand-authored answers it is *more* faithful to the bank author than GenAI is (MAE 0.041 vs 0.066),
  because GenAI is generous: it gives answers the author called `partial` a mean of 0.91.
- `tools/eval/` — the harness behind the numbers above. `qwen-vs-genai.py` scores a prompt variant
  against a cached Purdue GenAI reference; `bench.py` runs either grader over all 16 banks and
  prints a head-to-head; `holdout.py` checks answer ordering on questions never used for tuning;
  `variants.py` and `genai_variants.py` hold the prompts that were tried, including the rejected
  ones and why. Run by hand, not part of `npm run test`.

## [0.1.0-alpha.1] — 2026-08-25

First invited-faculty pilot snapshot. Everything before this was internal.

### Changed
- **The engine `.env` no longer holds anything a course needs.** `ORALSCALE_SECRET` is gone from it
  (nothing reads it any more) and so is `GENAI_STUDIO_API_KEY`. A course that grades with `genai`
  now carries all three `GENAI_STUDIO_*` values in its own `.env`, because a cloned course must keep
  grading — and with no grader fallbacks, a partial set means submissions are simply not graded.
  What remains in the engine `.env` is a **local convenience default** (base URL and model), used
  only when the course being built does not carry its own; the build warns when a `genai` course
  relies on it, since that produces a working zip here and a broken one anywhere else.
  `.env.example` stays committed and documents the split.
- **Stray key exports removed from the repository root.** `demo.keys.csv` and
  `demo.brightspace-import.csv` were left there by the old output paths; a test now fails if any
  key export, Brightspace import or roster reappears at the root.
- **`AGENTS.md` is now the single source of house rules**, with `CLAUDE.md` reduced to a one-line
  `@AGENTS.md` import. Claude Code reads `CLAUDE.md` and *not* `AGENTS.md`, so the two had diverged —
  `AGENTS.md` still described secrets living in `server/config.json`. The import is the documented
  way to keep one file. `courses/CLAUDE.md` does the same for `courses/AGENTS.md`.

### Fixed
- **A stale quiz link now says so** (INV-DEPLOY-3). After an assignment is renamed or retired, old
  links keep circulating. One returned `studentRef must be an opaque emailRef or private code` —
  true of nothing the student did, and pointing at nothing they could fix. A missing assignment made
  `requireKeyFor()` read a knob off `undefined`, so a request carrying a perfectly good quiz key
  fell through to the open-mode branch and failed there. Both Signers now reject an unknown
  assignment **before** the identity branch, with: *"This quiz link is out of date… Your quiz key is
  fine and does not change."*

### Changed
- **Built-in courses cannot be re-keyed** (INV-SEC-4). `_template`, `demo` and the test fixtures keep
  the Secrets they ship with; `make-config.js --force` refuses. This matters at exactly one moment —
  a Secret clash, where the tempting fix is to rotate whichever course the error names, and that is
  the *shipped* one when a course was started by copying a built-in. The tools now name the **user's**
  course as the thing to change, in both directions. Matched by path, never by courseId, because a
  copied folder keeps its id.
- **Rotating a Secret replaces `.env` entirely** and reports what it removed. The reason to rotate is
  almost always that the file was copied — so every other line was copied too, including another
  course's GenAI key. Keeping them would leave one course using another's credentials.
- **`npm run setup` no longer asks where the Secret should go.** There is one right place; asking
  implied the others were reasonable.
- **`secrets/` is gone.** Its README pointed at the new location; that job is done by
  `courses/GOVERNANCE.md`. The path stays gitignored so an old habit cannot re-create it.
- Removed the `· audio is yours` tagline from the student-app footer.

### Changed
- **One folder is the whole course** (INV-COURSE-4). Everything belonging to a course now lives
  under `courses/<courseId>/`, and nothing a course needs lives anywhere else. Copy that directory,
  or clone that repository, and the course works — that is the test.
  - **The signing Secret moved into the course folder**, `courses/<id>/.env`. It used to sit in
    `secrets/<courseId>.json`, beside the engine rather than the course: a portability bug wearing
    a tidiness costume. The folder clones cleanly and then every certificate fails to verify on the
    other machine, for reasons nothing in the folder explains.
  - **Key exports land in the course folder too.** `<courseId>.keys.csv` and the Brightspace import
    used to be written to the repository root — the most sensitive file in the project, outside the
    folder meant to contain the whole course.
  - **A course's `.env` can also carry its own `GENAI_STUDIO_*`**, so a cloned course builds an
    autograder that can actually grade. The engine `.env` remains the shared default.
  - **`.gitignore` and a `pre-commit` hook are installed BEFORE anything secret is generated** — by
    `make-config.js` before it mints, `gen-access-keys.js` before it writes keys, and
    `build-autograder.js` before it packages — into **both** the engine repo and the course's own
    repo when it is a separate checkout. Protection that arrives after the artifact leaves a window,
    and the window is when a folder full of new files invites `git add -A`.
  - **The hook is a backstop, not the plan.** `gen-access-keys.js` now says it plainly: upload to
    Brightspace, delete the local files, *then* commit. Keys are derived rather than stored, so
    deleting costs nothing.
  - **`_template` ships without `.env`**, deliberately — a skeleton carrying a Secret is a Secret
    shared by every course copied from it. `npm run setup` offers to create one (recommended) and,
    if declined, says exactly where to put it.
  - New: [`courses/GOVERNANCE.md`](courses/GOVERNANCE.md).

### Added
- **A course signing Secret is explicit, per course, and has NO fallback** (INV-SEC-4). It is read
  from exactly two places: `secrets/<courseId>.json`, or the **course-scoped** environment variable
  `ORALSCALE_SECRET_<COURSEID>` (for CI and container deploys, where a file is awkward). A course
  without one cannot be built at all — every tool fails loudly and names both ways to supply it.
  - **Two fallbacks removed, neither a convenience.** `server/config.json`, the pre-split shared
    Secret, meant whichever course wrote it last decided what every *other* course signed with —
    that is how a demo link came to be signed with the pilot course's Secret. A bare `ORALSCALE_SECRET` is
    the same failure with a shorter fuse: a whole-shell value silently signing whichever course you
    happen to run next. `ORALSCALE_SECRET_CHEM101_FALL2026` can only ever be that course's.
  - **A clash refuses the build.** Uniqueness is checked before minting, before building, and at
    commit time, against every course on disk **including `_template` and the test fixtures** —
    the way a Secret gets shared is by copying a folder that had one. `tools/check-course-safety.js`
    fails the commit if any course lacks its own Secret, or if **two courses hold the same value** — a property no single build can see, since two courses
    can each have a file and still share a string. Sharing means either can forge the other's
    certificates and mint the other's quiz keys, and a Secret compromised in one ends every grade
    in both.

- **Uncertified backups preserve a completed recording when certification fails**
  (INV-INTEGRITY-7). If `/finish` cannot issue a certificate after the audio is complete, the
  browser offers an unmistakably labelled backup zip rather than destroying the student's work.
  It contains audio but no `certificate.json`, scores 0 automatically, never reaches a content
  grader, and is flagged for careful instructor review and possible manual override. Students are
  told that a fresh certified attempt is strongly preferred and normally required for full credit.

- **Course-bound autograder artifacts** (INV-DEPLOY-2). Packaging now writes
  `courses/<courseId>/dist/oralscale-autograder-<courseId>-v<version>.zip`; separate courses no
  longer overwrite one ambiguous `autograder/autograder.zip`. Every `dist/` is gitignored because
  the artifact contains the signing secret and may contain a GenAI key in plaintext.

- **The screen stays awake for the whole attempt** (INV-PLAT-5). A student answering a
  120-second question is talking, not touching the screen, and the iOS default auto-lock is 30
  seconds — which suspends the page, stopping `MediaRecorder` and freezing the countdown while the
  Signer's deadline keeps running on the server. The app now holds a Screen Wake Lock for the
  duration of a recording and re-acquires it whenever the page becomes visible again. Best-effort:
  devices without the API (iOS before 16.4) record exactly as before, and the student guide now
  says to raise auto-lock before starting.

- **Leaving the page mid-attempt asks for confirmation** (INV-PLAT-6) — including, and especially,
  after a recording is certified but before the `.zip` has been downloaded. The recording lives in
  that browser tab and nowhere else, so a back-swipe at that moment means the student did
  everything right and submitted nothing.

- **A demo autograder that does not check identity** (INV-DEMO-1), so an instructor evaluating
  OralScale can record on the public demo site — which hands out one shared quiz key — and upload
  the result to their own Gradescope course without first minting a key for their own address.
  Enabled per-assignment (`demoSkipIdentityCheck`) on the public `try` assignment only.
  - It is loud by construction: the build prints a banner, every submission graded under it shows
    the student a red DEMO MODE warning, and the instructor gets a review flag recording what the
    identity check *would* have said.
  - It is contained by construction: never read from `defaults`, never inherited by another
    assignment, and `tools/check-course-safety.js` refuses the commit if any course outside
    `courses/demo/` sets it — the same allow-list that guards open mode, for the same reason.

- **The certificate must belong to this course AND this assignment** (INV-DEPLOY-3). `courseId`,
  `assignmentId` and every `questionId` are checked against the zip; a mismatch scores 0 with an
  instructor flag naming both sides. Uploading the wrong zip — or a student uploading last week's
  `.zip` — cannot produce a grade against the wrong bank.
  - The `courseId` check is new and is **not** redundant with the signature: two courses still on
    the legacy shared secret verify each other's certificates, and assignment ids collide readily
    across courses.

### Changed
- **One autograder per assignment; nothing is inferred** (INV-DEPLOY-3). `npm run package` now
  writes one zip **per assignment** into `courses/<courseId>/autograders/`, named
  `<courseId>-<assignmentId>-oralscale-v<version>.zip`. Upload the one whose filename matches, and
  title the Gradescope assignment however you like.
  - **All six routing rules are gone** — `gradescopeId`, `gradescopeTitle`,
    `gradescopeTitleContains`, the id inside the title, a week number in the title, and "there is
    only one". So is the conflict detection they needed, which existed only to notice the guessing
    going wrong. The assignment is written into the zip at build time and is the only thing read.
  - **Why removing it beat tuning it.** Guessing made a *superficial* property load-bearing: a
    Gradescope title is presentation, and renaming an assignment could silently change which bank a
    submission was graded against — producing a score, not an error. Pinning is not less flexible,
    only more honest; changing which assignment a Gradescope assignment grades always required
    rebuilding and re-uploading, because the bank lives inside the zip.
  - **A zip that does not say what it grades does not grade**, including when the course has exactly
    one assignment. The failure names the rebuild command; the student is told it is not their
    fault and to post on the course support channel.
  - **Each zip carries only its own bank**, so a quiz-1 autograder cannot contain quiz-14's
    questions and reference answers.
  - **An assignment that cannot be packaged is skipped with a warning** — no bank, an empty or
    missing bank, no `limitSec` — so a half-written week 12 does not stop weeks 1–11 shipping.
  - `dist/` is now `autograders/`. Stale `gradescopeTitle` / `gradescopeId` fields were removed from
    every `course.json`, and a test fails if one comes back: a stale knob is a promise the code no
    longer keeps.

- **The public demo is now its own single-assignment course.** The seven fixtures the test suites
  drive moved to `courses/_testsuite/`, so `courses/demo/` holds exactly `demo-quiz`. With one
  assignment the autograder cannot mis-route whatever the Gradescope assignment is called — an
  empty title resolves — which is the experience someone evaluating OralScale should have: it works,
  first time, without reading anything.
  - A side effect worth having: the public demo Signer no longer exposes the four **keyless** test
    fixtures it used to serve. Its `/health` warning about open assignments is gone because the open
    assignments are.
- **The demo's public assignment is now `demo-quiz`** (was `try`) and claims **any** Gradescope
  title containing "demo", so an instructor can name the assignment naturally. Instructors are told
  to put "Demo" in the title anyway — assignment naming is how a real course routes submissions, and
  the demo should make that visible once rather than hide it, even though the demo itself no longer
  depends on it.

### Fixed
- **`npm run setup` produced a course that could not be packaged.** The scaffold referenced
  `banks/starter/general-stem.json` and nothing ever created it, so the first thing a new instructor
  does — package the course they just made — failed on a missing bank. The starter bank is now
  copied into the new course, not referenced out of the engine repo, which would break the moment
  the course became its own repository (INV-COURSE-1).

- **Quiz links were signed with the wrong course's secret** (INV-SEC-4). `gen-url.js` had never
  learned about the per-course secret split and read `server/config.json` — the pre-split shared
  secret — whatever `--course` said. Once that file held another course's secret, every link it
  minted was signed by the wrong course and the Signer rejected it with `invalid course token`.
  Found on the public demo. **Nothing in the payload differs** — same course id, assignment, salt
  and expiry — only the signature, so a bad link looks perfect until a student is stuck on it.
  - `gen-accommodations.js` had the same bug and fails more quietly: the roster keys on
    `studentRef`s no certificate in that course can match, so every accommodation claim returns
    UNVERIFIED and a disability accommodation silently becomes unconfirmable.
  - Both now resolve `secrets/<courseId>.json`, and **every minting tool prints which secret it
    used**. `ORALSCALE_SECRET` still wins for CI, but it is a whole-shell override — a shell
    carrying one course's secret will sign another's links with it — so saying which one was used
    is the only defence.

- **A GenAI reply that cannot be parsed is now retried instead of costing the submission**
  (INV-GRADE-4). Seen in the field: `could not parse model reply as JSON`, 5 of 5 questions,
  `REGRADE REQUIRED` — and the same student resubmitting graded normally. The existing retry
  watches for failures to *reach* the service, and this is an HTTP 200 whose body is prose or JSON
  truncated by a token limit, so nothing retried.
  - Three rungs, all within the same grader: the batch as sent, the batch with an output-format
    reminder, then one request per question. At `temperature: 0` an identical re-ask reproduces an
    identical bad reply, so each rung changes exactly one thing — never the rubric, key points,
    model or temperature. A grader that cannot return usable output at any batch size **still**
    fails with no score, because a ladder that always produces something has become the fallback
    chain INV-GRADE-1 forbids.
  - **No completion cap is sent, and that is measured rather than assumed.** Against Purdue GenAI
    Studio, an unset `max_tokens` is *uncapped* (a long generation ran to 1492 characters and
    finished normally), while a set `max_tokens` is enforced as a **character** budget — 500 gives
    exactly 500 characters. Sizing a "generous" token budget would therefore have truncated replies
    that work today. `ORALSCALE_GENAI_MAX_TOKENS` remains for a different gateway that does cap by
    default; an endpoint rejecting the parameter is retried once without it.
  - **The instructor log is now verbose and structured** — one greppable line per request
    (`[diag]`/`[req]`/`[rungN]`/`[result]`), successes included, so "how often does the first ask
    fail" is answerable across a cohort. It contains no student text: model replies are reduced to
    their structure with JSON keys kept and string values replaced by `<str:N>`, and a non-JSON
    reply is described rather than echoed.
  - **Failures now carry their evidence.** `finish_reason` and a redacted picture of the reply
    reach the instructor-only output and travel on the exception, so they survive a total failure —
    previously the one case that most needed the evidence discarded it. Truncation is named as
    truncation, because "ignored the format" and "did not fit" have different fixes.

- **Demo/local autograder images build on Gradescope's glibc base** (INV-GRADE-1). The v0.3.2
  prebuilt `llama-cpp-python` “linux” wheel is musl-linked and cannot load there. Its import error
  is now visible, and the fallback compiles only `llama-cpp-python` with an explicit toolchain and
  pinned build backend; it no longer forces the entire transitive dependency graph to build from
  source and fail in `tomli` before reaching llama.cpp. The selected GGUF is now explicitly
  downloaded into `source/models` before its load-and-response smoke test. Packaging also tells
  local courses to use the required 4 CPU / 6 GB container instead of the smaller GenAI-only
  setting, and the setup declares `python3-pip` and `requests` instead of assuming the base image
  provides dependencies omitted by upstream package metadata. Its native build targets baseline
  x86 instead of emitting host-specific SIMD instructions that can crash under emulation or on a
  different Gradescope CPU.

- **Course deployment is isolated end to end** (INV-SEC-4). `deploy.sh` now derives a distinct
  Worker and Pages project from `courseId` and uploads that course's own signing secret. Deploying
  A real course can no longer overwrite the demo Signer or silently use the legacy shared secret.

- WAV duration is read with Python's standard library before invoking `ffprobe`. This keeps the
  Gradescope-package rehearsal deterministic even when a development machine's ffmpeg linkage is
  broken, without changing the authoritative packet-timeline check used for browser WebM audio.

- **The deploy gate no longer cries wolf about the retake cooldown.** `cooldownEnforced:false`
  meant two unrelated things — "the D1 binding failed, students can reroll freely" and "this
  course set `retakeCooldownSec:0` on purpose" — and `deploy.sh` printed the same alarming warning
  for both. `/health` now also reports `cooldownConfigured`, and the three cases are reported as
  three different things. An ungraded practice quiz tripping a scary warning on every deploy is
  how the one line the guide tells instructors to check becomes noise.

- **Extended-time accommodations, selected by the student and verified afterwards**
  (INV-ACCOM-1/2/3). A student taps "I have DRC accommodations" on the start screen and picks
  1.25x, 1.5x, 1.75x or 2x; the countdown and buffer scale, and the claim is recorded in the signed
  certificate. Gradescope remains the system of record for the grants themselves — it does not
  expose them to an autograder, so `tools/gen-accommodations.js` turns a Gradescope export into a
  roster keyed by opaque `studentRef` (no emails, gitignored) that the autograder verifies against.
  - Selecting less than granted, or nothing, is never recorded as an event. Claiming more is
    reported only if the student also *used* more than their grant allows, and **no outcome ever
    changes a score**.
  - Off-ladder values are refused rather than clamped; an instructor-minted accommodation link
    remains an authorisation that the client cannot override.

- **Autograder builds refuse to ship a bank the course does not reference.** The bank output
  directory is cleared before each build; previously it accumulated every bank ever built, so a
  one-assignment course packaged fourteen banks from a different course, reference answers
  included. Staff-only, so nothing student-readable leaked, but it defeated the content separation
  and quadrupled the artifact (884 KB → 133 KB).
- **Late-submission policy** (`gradingPolicy.late`, INV-LATE-1/2/3). Per course, at the top level
  of `course.json`, overridable per assignment. `mode: "steps"` with
  `steps: [{withinDays: 1, deductPercentOfMax: 20}]` and `afterSteps: "zero"` gives the common
  policy: one day late costs 20% of the maximum, nothing after that. `graceMinutes` covers the
  submit-as-the-clock-turns case.
  - Deductions are a percentage **of the maximum**, not of the earned score, and are applied last —
    after aggregation and after any `scoreBonus`.
  - **Everything that ships defaults to `"none"`**, and every malformed policy grades everything: a
    typo must never be why a student gets a zero.
  - ⚠️ Gradescope exposes only an assignment-level due date, so per-student extensions are
    invisible. Every deduction tells the instructor to check and tells the student it can be
    overridden.

- **Spoken boundary codes reduced from six digits to four** (INV-CODE-1). Every digit is one more
  thing a nervous person has to read correctly, so the pressure is downward. A 5-question attempt
  now asks for 24 spoken digits instead of 36, and because the read windows derive from the length
  (1 s per digit, doubled at the final code) the attempt is also ~14 s shorter.
  - **Four is a floor, not a default.** At three digits the one-edit tolerance accepts any two of
    the three digits in order, and a code the student never said matches innocent numbers in their
    answer 26% of the time (ten digits of noise) rising to 48% (twenty). Both Signers clamp
    `codeDigits` to [4, 8].
  - Certificates are verified with the digit count they were issued under, so work already
    submitted verifies unchanged (INV-CODE-2).

### Changed
- **Instructor email notification is now OFF by default**, pending a records-policy decision.
  Mailing an accommodation review hands an outside mail provider the fact that a particular
  submission needs accommodation review — a disclosure leaving the institutional boundary. It
  requires an explicit `ORALSCALE_NOTIFY_ENABLED=1`; SMTP credentials alone no longer enable it.
  The code is kept, working and tested, for when that decision is made. Unverifiable accommodations
  are still flagged on the submission itself.
- `courses/_fixture-weeks` renamed to `courses/_shell-for-testsuite`, and its `courseId` and note
  with it — the old name did not say loudly enough that it is a test shell rather than a course.
- Repository renamed `oral-scale` → `oralscale`; all in-repo URLs updated.

### Added
- `LICENSE` (MIT, David I. Inouye), `DISCLAIMER.md`, `PRIVACY.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, `CITATION.cff`, `AUTHORS.md`, and GitHub issue/pull-request templates.
- Attribution footer in the student web app. Deliberately no repository link and no version string
  on a student-facing page.
- `courses/README.md` and `courses/AGENTS.md` — what a course folder is, why it belongs in its own
  private repository, and the agent-guided workflow from lecture material to a validated bank.
- **Backup warning** for a course folder that is not a git repository with a remote. Repeats every
  run until the course is backed up or `ORALSCALE_ACK_COURSE_UNBACKED=1` is set. Question banks are
  expensive to author and damaging to leak; a nag is the correct behaviour.
- `courses/demo/` gains a **`starter`** assignment: keyed, three questions, general STEM content,
  working from a fresh clone with no authoring.
- `courses/_shell-for-testsuite/` — a synthetic fourteen-week course so engine tests no longer depend on
  private course content.
- `courses/_template/course.json` — a fully commented skeleton. States at length why
  `gradingBackend` defaults to `local` and what choosing a remote backend actually means, so the
  default is inherited and the alternative has to be chosen.
- **Oral Quiz 0**, a 100-question ungraded prerequisite bank (linear algebra, probability and
  statistics, calculus and optimisation, programming and computational reasoning). Lets students
  run the whole system once before it counts, and surfaces prerequisite gaps early.

### Changed
- **Course content is separated from the engine.** The top-level `banks/` directory is gone; banks
  now live in `courses/<courseId>/banks/`, making a course folder a self-contained private
  repository. `.gitignore` allow-lists `courses/`, so a new course folder is private by default.
- **Bank paths resolve relative to their `course.json`**, not to the engine repository root, so a
  course folder does not need to know where it was cloned. Repo-root-relative paths still resolve
  (`tools/lib/course.js`).
- The 14 existing question banks are relabelled as **historical archive**
  content from an earlier course, which is what they were generated from. They were previously
  mislabelled as the current course. Question text is unchanged; provenance metadata was added.
- `npm run test:banks` and `npm run test:course` run against the **demo** course, so a clean
  checkout with no private content passes the full gate.
- `package.json` version set to `0.1.0-alpha.1` (was an unpublished `0.2.0`) and given author and
  homepage fields.

### Removed
- Private course content purged from the engine's git history (all 42 commits rewritten, 39 remain).
  Two `refs/codex/turn-diffs/checkpoints/…` refs from a previous tool session had to be deleted
  first — `git filter-repo` leaves refs outside `refs/heads`/`refs/tags`/`refs/remotes` alone, and
  they kept every purged object reachable. **Existing clones must be re-cloned.**

### Fixed
- `docs/project/MOTIVATION.md` described Gradescope as "the FERPA-compliant system of record", a compliance
  claim this project does not make on any institution's behalf.
