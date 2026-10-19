# 07 — Test Model (requirement → test traceability)

Every invariant in [02](02-requirements-and-invariants.md) maps to at least one automated
test. Test IDs cite invariant IDs so traceability is greppable. **Gate:** an invariant with
no passing test is a release blocker.

## Levels
Public documentation: **INV-DOC-1** → `t_public_guides` (`npm run test:guides:release` blocks on a
release tag; `npm run test:guides` is advisory between releases, and its self-test asserts that
release mode still fails on each drift): source and output
fingerprints, generated HTML parity, FAQ source coverage, screenshot provenance, and negative
tests for source/content/image/PDF drift. `npm run guides:render` verifies two Letter pages per
guide, verifies print-only headers/page numbers and paper framing are absent on screen, and
checks the faculty starter-prompt copy action and question-design link, and captures desktop/mobile review evidence; maintainers visually review all PDF pages.

- **Unit** — pure functions: crypto/token, question selection, nonce derivation, timing math,
  duration/nonce-timestamp checks, MIME negotiation. (`tests/unit/*`)
- **Integration** — Signer HTTP endpoints against a real Worker/Node instance; autograder over
  crafted submissions. (`tests/integration/*`)
- **System (E2E)** — full loop: issue URL → reveal → pulses → finish → package → autograde;
  plus an **attack suite** that must FAIL to grade. (`tests/e2e/*`, `tools/demo-e2e.js`)
- **Manual/device** — real mic on iOS Safari, Android Chrome, desktop (checklist in [08]).

## Traceability matrix
| Invariant | Test(s) | Level | Must-show |
|-----------|---------|-------|-----------|
| INV-INTEGRITY-1 | `t_hash_binding` | unit+e2e | tampered audio → reject |
| INV-INTEGRITY-2 | `t_window_deadline` | integration | finish after deadline → no cert |
| INV-INTEGRITY-3 | `t_duration_window` | unit+e2e | audio longer than window → reject |
| INV-INTEGRITY-4 | `t_opening_code`, `t_boundary_codes`, e2e E | unit+e2e | first boundary code absent from the start of the transcript → not heard (graded and flagged unless fewer than half the codes are heard, INV-CODE-4); N=1 codes are byte-identical to the v4 bookend |
| INV-INTEGRITY-5 | `t_closing_code`, `t_boundary_codes`, e2e E2/E3/S5/S6 | unit+e2e | any boundary code absent → reported NOT HEARD, including an INTERIOR one on a multi-question attempt (consequence per INV-CODE-4); `/finish` refuses a RevealToken *and* a mid-attempt ClosingToken, so neither the closing step nor a remaining question can be skipped |
| INV-INTEGRITY-4/5 tolerance | `t_code_fuzzy`, e2e L/M | unit+e2e | one mis-transcribed digit still accepted; three wrong digits rejected |
| INV-INTEGRITY-6 | `t_capture_order` | integration | reveal only issued after recording asserted |
| INV-INTEGRITY-7 | `t_no_cert_zero`, `t_uncertified_backup_zero` | e2e+package+unit | submission w/o cert → score 0 + instructor-review flag; captured audio remains downloadable in a visibly labelled UNCERTIFIED BACKUP; student is told to prefer a fresh certified attempt and that staff may manually override only after review; the backup is never content-graded |
| INV-INTEGRITY-8 | e2e Q/Q2 | e2e | student-supplied transcript ignored in production; same submission grades only when the test flag is explicitly set |
| INV-INTEGRITY-9 | `t_transcribe_reliable`, live-recording replay | unit + manual | VAD on, language pinned, `small`+ model, word timestamps on, rescue thresholds relaxed, rescue chunks overlap; a code missing from the transcript IS re-sought in the audio and the rescue's verdict is honoured; two chunks that together spell a code do NOT pass; **and** the real 2026-08-21 failing submission now validates end to end at these settings |
| INV-SEC-1 | `t_signature` (JS+Py) | unit | forged/edited token → reject; JS↔Py interop |
| INV-SEC-2 | `t_identity_parity`, e2e H/I/J | unit+e2e | ref re-derived from metadata email (JS↔Py); resold cert for another submitter → 0 |
| INV-SEC-3 | `t_attempt_salt` | unit | two attempts → different Q distribution + codes |
| INV-SEC-4 | `t_secret_absent`, `t_secret_hygiene` | unit/lint | grep: no secret in web/ bundle or repo; deploy derives course-scoped Worker/Pages names and resolves the matching per-course Secret rather than the legacy shared Secret |
| INV-SEC-5 | `t_rate_limit` | integration | N rapid calls → 429; oversized body → reject |
| INV-SEC-6 | `t_no_html_inject`, `t_studentref_opaque`, e2e K | unit+e2e | question with `<script>` renders inert; malformed/plaintext studentRef rejected before crypto |
| INV-SEC-8 | `t_access_key_parity`, `t_key_identity`, worker gate test, e2e R–R10 | unit+integration+e2e | no key / forged key / tampered tag / another course's key → no question and no bank access; a guessed tag never verifies; sloppy typing still works; JS↔Py parity for mint, verify and identity; `accessKeyEpoch` re-mints; a certificate without `accessKeyVerified` does not grade on a keyed assignment; the gate holds with no D1 bound |
| INV-SEC-9 | e2e R6/R7/R7b | e2e | invented keys mine nothing; a burst of invalid keys refuses that source; the limit expires on its own |
| INV-SEC-10 | `t_prompt_injection` | unit | 22 grader-directed attempts all rated `high`; 16 honest answers about LLMs and about grading all rated below `high`; a detected attempt is refused in Python with backend `refused:prompt-injection` and never reaches a model; the transcript fence is random per request and a guessed closing tag does not end the real one |
| INV-SEC-6 (rich text) | `t_richtext_safe` | unit | 13 hostile prompts yield only whitelisted tags; `<script>`/`onerror`/`javascript:` survive as literal text; no `innerHTML` on the render path; every attribute is a renderer-chosen literal; unknown LaTeX macros are shown, not dropped; plain prose is byte-identical |
| FR-7 (timings) | `t_timing_defaults` | unit | the code lead is one second per digit and the tail is double, derived not configured; JS and Python agree; four digits gives 4 s / 8 s; a 5 × 120 s attempt budgets exactly 728 s of audio; neither Signer still hard-codes a lead or tail default |
| FR-7 (knobs) | e2e S3/S4, `no dead config knobs`, course smoke | unit+e2e | every knob named in a course.json is read by code and vice versa; `bufferSec` extends the window without changing the visible limit; `scoreAggregation` and `difficultyMix` take effect |
| FR-1 (feedback) | e2e S3a/S3b/S3c, S4a/S4b/S4c/S4d | e2e | every question a student is shown carries FOUR labelled parts in a fixed order — the question as asked, the transcript of what they said, the points, and the feedback — and the words quoted back are their own; the `Overall Score` heading NAMES the aggregation rule (`(drop lowest)` / `(average of all N)`); under `dropLowest` the student is told which questions counted and which was dropped, the dropped one says it did not count and still shows its feedback, and the visible per-question marks sum to the total |
| FR-1 (multi) | e2e S/S2/S3/S4, worker multi test | e2e+integration | N questions in one recording, distinct, each graded on its own transcript slice — answering only question 1 of 3 scores about a third |
| INV-SEC-7 | e2e N/O/O2/O3/P | e2e | reroll without finishing → 429; retake after a *real* attempt → allowed; an instant reveal→closing→finish loop does NOT clear it; an attempt that dies after `/closing` does; per-student, not global |
| INV-PRIV-1 | `t_no_audio_upstream` | integration | /reveal,/finish payloads contain no audio bytes |
| INV-PRIV-2 | `t_minimal_pii`, `t_studentref_opaque` | unit | Signer payloads carry only an opaque `studentRef`; plaintext email rejected; app hashes in-browser; no cookies/analytics in `web/` |
| INV-PRIV-3 | `t_transcribe_local` | unit | grader transcribes locally; only text to GenAI |
| INV-PRIV-4 | `t_pii_redaction` | unit | 7 transcripts with personal details are redacted; 12 transcripts of spoken mathematics (eponyms, long digit runs, learning rates) are byte-identical; findings carry the KIND and count, never the text; the original transcript is untouched and only the outbound copy is redacted |
| INV-PRIV-5 | `t_edge_tags_keyed` | unit | no raw address is a database key (F-1); Worker and Node both derive row tags with HMAC rather than a bare digest (F-2); the cooldown table is swept (F-3); a tag under one Secret differs from the same input under another, and from the plain hash it replaced |
| INV-GRADE-1 | `t_grading_backend`, `t_setup_llm` | unit + package | `local` is the default; the named backend either grades or produces `REGRADE REQUIRED`, with no fallback; a local image installs its Python/pip/compiler toolchain, explicitly downloads the selected GGUF to `source/models`, verifies import + model response, exposes the prebuilt-wheel error, and its source fallback compiles only `llama-cpp-python` with a pinned backend rather than recursively source-building every dependency |
| INV-GRADE-2 | `t_calibration_monotone` | unit | a fitted calibration is affine with `scale > 0`; a non-positive slope is refused, not applied; applying it to any set of scores preserves their order exactly; the raw score is retained alongside |
| INV-GRADE-3 | `tools/calibrate-grader.py` | manual + unit | reports consistency, within-question ranking and band separation, in that order; refuses to write a calibration file on a consistency or ranking failure unless `--write` overrides |
| INV-DEPLOY-4 | `t_no_weights_in_zip` | package | the extracted zip contains no `.gguf`/`.bin`/`.safetensors`/`.pt` and no `models/` directory; the artifact is under 100 MB; `setup.sh` is what calls `hf_hub_download`, at image build time |
| INV-GRADE-5 | `t_local_grader_bands`, `t_genai_grader_bands`, `t_grade_all_custom_ladder` | unit | the local grader's prompt asks for a named BAND, never a number; the band→score map is a table in code rather than something the model emits; the parser reads the band first and only then falls back to the legacy numeric forms; `none` inside prose ("none of the key points") is not read as the `none` band; the REMOTE grader asks for the same five names, maps them with the same table, and treats a reply with no readable band as an ungraded answer rather than a zero; a course's `bandScores` re-prices the default rungs and `bands` replaces the ladder entirely (names, count, meanings), both resolved in one shared module so the backends cannot drift; a ladder that climbs, has one rung, or carries an unsafe name is rejected whole; a custom ladder's prompt is generated from its own meanings while the default keeps the measured wording verbatim; the name alternation is longest-first so `part` cannot be booked out of `partial`; bank `scoringBands` outside the ladder are dropped (`t_bands_ladder`); and `grade_all` itself is CALLED on all three ladder shapes — default, re-priced, wholly replaced — because every other assertion here probes `bands.py`/`_normalise`/`_parse_batch` directly and none of them would notice the entry point failing on the non-default branch |
| INV-PLAT-1 | `t_mime_negotiation` | unit + manual | picks a supported type per UA; manual device check |
| INV-PLAT-2 | `t_responsive` | manual | 360px + desktop screenshots, no h-scroll |
| INV-PLAT-3 | `t_degradation` | unit + manual | denied mic / lost net → retake offered |
| INV-PLAT-4 | `t_a11y_flow` | unit + manual | live region carries each state; focus moves on transition; nonce + 60s/15s warnings announced; decorative glyphs `aria-hidden` |
| INV-DEPLOY-1 | `t_active_submission` | unit | the mint branch claims no "highest score" setting (Gradescope has none); it states that the ACTIVE submission is graded, and tells the Student their newest upload counts and how to re-activate an older one; and NO Student- or instructor-readable file (autograder, web app, guides, README, setup/deploy output) promises that the best attempt counts or names the setting — a line that quotes the false claim in order to correct it is exempt |
| INV-DEPLOY-2 | `t_course_bound_autograder` | unit+package | one zip PER ASSIGNMENT, named `<courseId>-<assignmentId>-oralscale-v<version>.zip` under that course's ignored `autograders/`; each carries only its own bank; an unpackageable assignment is skipped, not fatal; ambiguous generic zip is removed; and the shell packager's closing note neither claims one zip serves every assignment nor infers the week from a Gradescope title (both removed by R15), says an unpinned zip WILL NOT GRADE, and reads the pin BEFORE deleting the ephemeral secret.env |
| INV-INTEGRITY-5 | `t_boundary_code_readable` | unit | the "expected but not heard" line separates the boundary INDEX from the spoken CODE with more than a space, so a 4-digit code beside its index cannot be read as one 5-digit code |
| INV-GRADE-6 | `t_rate_limit_visible` | unit | against a urlopen throttled forever, the SHARED budget (not the 25-min per-request deadline) ends the retries; giving up names both the budget and the throttling with counts; an HTTP 400 whose BODY says "rate limit" is counted as throttling; retry lines are streamed to stderr as they happen, so a killed container still leaves a trail |
| INV-GRADE-7 | `t_dropped_question_mark`, `S4c`/`S4c2` | unit + e2e | the dropped question shows the mark it would have earned on the counted questions' scale, says it is NOT part of the total, and carries no `score`/`max_score` so Gradescope cannot sum it back in |
| INV-DEPLOY-8 | `t_genai_model_offered` | unit | against a stub `/api/models`: `genai-models.js` exits 0 for a listed model, 3 for an absent one with the same-family same-size successor ranked first, 2 when unreachable; the build REFUSES an absent model and writes no zip, but only warns when the service cannot be asked; the grader turns `{"detail":"Model not found"}` into a message naming the model, `genai-models.js` and the regrade, in ONE request rather than a retry loop |
| INV-DEPLOY-7 | `t_link_needs_live_worker` | unit | `/health` publishes each bank's `revision` and a KEYED tag of its file digest; `gen-url.js` mints when the tag matches the bank on disk and REFUSES when it does not, naming both revisions — the case every other preflight check passes, because a bank revised in place keeps its bankId, assignment id and question ids; the tag is shown to be keyed, not a bare digest, so a public /health cannot confirm a leaked bank |
| INV-DEPLOY-5 | `t_link_needs_live_worker` | unit | with a `signerUrl` present, `gen-url.js` calls `/health` BEFORE signing and prints no link when the deployed Worker names a different course, does not list the assignment, disagrees on `questionsPerAttempt` or `requireAccessKey`, is unreachable, or still carries the `_template` placeholder URL; it mints normally when `/health` matches; no flag re-enables minting past a refusal |
| FR-6 | `t_retake_fresh_q` | e2e | consecutive attempts get different questions |
| FR-8 | `t_portability` | unit | swap courseId → no code change needed |
| INV-USE-1 | `t_which_quiz_shown`, `t_wrong_link_named` | unit | the app names the course and assignment of the link it was opened with, BEFORE the mic is touched, deriving the quiz number from `assignmentId` alone so a link minted before this existed is not invalidated (a title-less id is shown raw, never guessed at); new links additionally carry `courseTitle`/`assignmentTitle`; a certificate for another assignment or another course is the ONE failure named to the student, and exactly two call sites may name a reason — every other failure still gets `VALIDATION_FAILED_MSG` |
| INV-COURSE-5 | `t_bundle_has_no_answer_key` | unit | `topic`/`principle` are absent from a freshly built bundle by default and present only where `showQuestionMeta: true`; both Signers rebuild the served payload by allow-list, so an older bundle cannot put them on the wire either |
| INV-PRIV-7 | `t_bundle_has_no_answer_key` | unit | a real `build-worker.js` run over a fixture bank yields questions whose keys are exactly `id`/`difficulty`/`prompt`; the reference answer, the scoring bands, the common errors and the evidence quotes appear NOWHERE in the file, not merely under no key |
| INV-GRADE-8 | `t_client_split_marks` | unit | a well-formed set normalises intact and yields per-question audio-clock windows; nine malformed shapes — unknown event, an extra field, NaN, Infinity, negative, absurd, fractional index, non-array, empty — are each refused WHOLE; JS and Python derive identical windows; the marks are read by `instructor_answer_dump` and by nothing else, so `check_boundary_codes` and the graded `segment_transcript` never consult them; both Signers sign them and both fail soft; the app measures every mark from `recorder.startedAt` |
| INV-DEPLOY-3, INV-PRIV-6 | `t_zip_env_matches_backend`, `t_genai_key_scope`, `t_setup_llm` | unit | on a MIXED-backend course, the locally-graded assignment's zip carries no `GENAI_STUDIO_*` at all and declares `ORALSCALE_LOCAL_REQUIRED=1`; the genai assignment's zip carries all three credentials and `ORALSCALE_SKIP_LOCAL_LLM=1` with `ORALSCALE_LOCAL_REQUIRED=0`; each zip embeds only its own assignment; the build log names which zip got the key and sizes the container per assignment — decided inside the build loop from the config actually written into that zip, and cleared from the base environment so an exported key cannot ride in |
| INV-DEPLOY-6 | `t_regrade_variant` | unit | a declared `regrade` variant builds a SECOND zip for a frozen assignment without `--repackage-frozen`, named `…-regrade-<id>.zip`, leaving the released artifact byte-identical; it is pinned to the same assignment id, ships the same bank, and differs only in `scoring`; `--regrade` without `--assignment`, an undeclared variant id, and a variant with no `scoring` are each refused; a variant marked `frozen` is refused without `--repackage-frozen`, the refusal names its recorded sha256, and the override re-cuts it |
| INV-DEPLOY-6 | `t_regrade_backend_variant` | unit | a `regrade` variant declaring `gradingBackend` and no `scoring` builds; it is pinned to the same assignment id, ships the same bank and the same `scoring`, and carries the new backend; a genai-only course does NOT bundle the local model while the variant that flips one assignment to `local` DOES — proving the override lands before the build environment is derived; the released zip still grades with genai; a variant declaring neither `scoring` nor `gradingBackend` is refused |
| INV-GRADE-9 | `t_required_vs_bonus` | unit | an omitted optional point can never push a band DOWN and never appears in "missed", in both graders; how many RAISE it is deferred to the ladder, and a course ladder's own top-band meaning is not overridden by a generic one; the unmade optional points are carried end to end as `strongerIf` and shown to the student in their own section, never merged into "missed"; both graders' prompts separate REQUIRED from OPTIONAL and say an absent optional point may not lower the band or appear under "missed"; the `full` band is defined as answering the question as asked, and `strong`/`partial` name REQUIRED pieces; a bonus point cannot dilute the heuristic score; `validate-bank.js` warns above four required points and names the fix, does not warn at four, refuses a point listed as both, refuses non-string bonus points, and still validates a bank written before the split existed |
| INV-GRADE-10 | `t_points_scoring` | unit | the arithmetic lands each canonical verdict set on the intended band (required-only → partial, +1 → strong, +2 → full, 1 required + 2 optional → partial, no required point → weak at most, nothing → none, a contradicted point subtracts its weight); thresholds are relative on a 3-required question; an uncorrected false claim caps at partial; an unquoted penalty is not applied; a missing verdict is unparseable; malformed policies and a ladder lacking a band are refused; absent `scoring` is band mode; both graders' prompts carry the self-correction rule and never a threshold; the heuristic and GenAI paths return the breakdown; the student sees only narrative feedback (the prompt forbids scoring vocabulary, the fallback narrative contains none, no breakdown or stronger-if list is printed) while the instructor detail carries the evidence; CURVE MODE (`scoring.table`): one core point alone scores 0.85 and both 0.92, depth climbs 0.95/0.97/1.00, a total between two entries takes the lower one, nothing conveyed is still 0, supporting points may stand in for a second core point, a curve needs no band ladder, and an unusable curve (too short, non-monotone, out of range, non-numeric, negative `novelCap`, out-of-range cap score) is refused whole; NOVEL POINTS: a correct unlisted point earns credit and lifts a simplified answer, credit is capped per answer with a note, an unquoted novel point counts neither way, a `wrong` one is a false claim that both costs and caps, the two ceilings (`falseClaimCapScore`, `noCoreCapScore`) apply on the curve, the prompt asks for novel points strictly and forbids listing what the student did not say, and the fallback narrative names neither; `partlyFactor` prices a `partly` (half by default, in full when the course says so, pricing a novel `partial` by the same knob), and a factor above 1 or below 0 is refused; `curveRounding: "up"` lifts a between-rungs total to the higher rung (3.5 → 0.92, a lone half point → a rung rather than nothing) while two half-made points still buy only one whole one and whole totals are unmoved, and any value but "up"/"down" is refused |
| INV-GRADE-10 | `t_local_points_prompt_shape` | unit | the LOCAL grader's points prompt shows a filled example rather than a schema: the verdict slot is a single word and never the `stated|partly|absent|contradicted` alternation, `points` is a LIST of objects carrying the real point ids, and the example carries every key the shared rules ask for (`novelPoints`, `falseClaims`, `feedback`); the four verdicts are named once as a choice to make, and the point ids are enumerated. Each assertion pins one shape qwen2.5-3b returned INSTEAD of a gradeable answer on a real Quiz 3 submission (2026-09-17), every one of which cost the whole submission |
| INV-GRADE-11 | `t_error_asymmetry` | unit | where the arithmetic is UNCERTAIN it resolves the student's way, asserted as one property because the invariant IS the pattern: a half-made point rounds UP to the next rung (3.5 -> 0.92, a lone `partly` -> a rung rather than nothing); an unevidenced penalty is dropped rather than applied (an unquoted false claim leaves a full answer at 1.0, an unquoted `contradicted` scores `absent`), and so is a false claim whose `why` merely restates the quote — it carries no reason, so it cannot support a cap; a gap in the judgement is unparseable rather than a silent zero; an uncorrected false claim CAPS rather than zeroes; and crediting any optional point can only ever raise the mark. A change that points any one of them the other way fails here |
| INV-GRADE-10 | `t_grounded_evidence` | unit | `requireGroundedEvidence` is OFF by default and a verdict quoting words the student never said still earns its credit; ON, such a verdict is scored `absent` while a grounded one is untouched, and only the ungrounded credit is withdrawn rather than the whole answer; the match is loose enough that a quote the model reformatted still counts; with no transcript to check against nothing is withdrawn. Measured before it was built: an ungrounded quote accompanied a FALSE credit 97% of the time against 35% for a grounded one, so the knob removes 42% of the false credit for 3 correct credits in 449 — and it stays off by default because those 3 are the error direction INV-GRADE-11 designs against |
| INV-GRADE-4 | `t_local_retry` | unit | the LOCAL grading path retries an unusable reply rather than abandoning the question: a stub model that fails once and then succeeds is graded, the log names the attempt count, and a model that never returns a readable reply still FAILS after the cap (a ladder that always finds a way to produce a score is the fallback chain INV-GRADE-1 forbids); the rung-2 prompt differs from rung 1 — it has to, at temperature 0 — and the text it adds mentions only the output format, never the rubric, the points or the score |
| INV-GRADE-4 | `t_local_fills_missing_lines` | unit | a reply missing SOME verdicts is topped up by re-asking for those ids alone, with the question and transcript still in view, and the lines already given are kept byte-for-byte; a complete reply costs no extra call; a reply with NO readable line is left to the retry ladder rather than half-invented. The narrow rung exists because re-asking for the whole answer at temperature 0 mostly reproduces the same omission — nothing about the request changed |
| INV-GRADE-9 | `t_optional_points_framing` | unit | the optional points are described to the model with NO scoring language (no "never a fault", no "beyond what was asked", no raise/lower/worth) and are still asked for by the same test as the core ones; the guarantee itself is asserted on the ARITHMETIC instead — upgrading any optional verdict is monotone non-decreasing in the score — which is what makes dropping the wording safe. NOT asserted as "equal to a question with no optional points": thresholds are relative and clamp to the optional weight on offer, so a question offering depth puts its top band higher, which is the instructor's policy and not a penalty |
| INV-GRADE-10 | `t_points_prompt_context` | unit | the points prompt spends the bank fields that previously reached the model on the BAND path only: `referenceAnswer` and the verbatim `evidence` quotes both appear, via `localmodel.bank_context`, and a bank carrying neither adds nothing. The two graders' prompts MAY diverge here (instructor decision 2026-09-17): the fairness INV-GRADE-1 protects is that one assignment is graded by one backend, not that two backends are worded alike |
| INV-GRADE-3 | `t_points_fixtures` | unit | the points-mode eval's ground truth, asserted because a fixture bug would otherwise be chased as a grader defect: a synthesised answer conveys exactly the points its vector claims and nothing about the absent ones; it is in student voice and never the bank text pasted (an early version only lowercased the first letter, so points written without contractions came through verbatim and would have measured string matching); the messy twin carries identical content with different delivery and is recognisably speech; a false-claim case ASSERTS the misconception rather than naming it; and generation is seeded so two graders see byte-identical inputs |
| INV-CODE-3 | `t_codes_ledger` | unit | the student-visible message lists EVERY boundary, not only the missed ones, each with where it was shown, the digits as spoken, and heard / NOT HEARD; it points at the transcript on the same page and tells the student what to do when the grader is the one that is wrong; boundary labels read in the student's terms ("before question 1", "at the very end") |
| INV-CODE-4 | e2e E/E2/S5/S5b, E2b/S5c, A2/C2/F2 | e2e | one code missing (opening, closing or interior) or exactly half heard → score > 0, a visible failed "Validation checks" warning that review may affect the final grade, and an instructor REVIEW block saying it was graded despite missing codes; fewer than half heard, or a tampered-audio / over-long / wrong-identity attempt → score 0, graded items hidden as NOT COUNTED with no score, a hidden "Would-have-been score" test, and no visible test carrying a score |
| INV-DEPLOY-6 | `t_frozen_not_repackaged` | unit | a whole-course `--zip` build skips a `frozen` assignment and builds the others; naming it explicitly EXITS NON-ZERO rather than obeying; the refusal explains the late-vs-punctual grading divergence and names `--repackage-frozen`; the override rebuilds and warns what it costs; an unfrozen assignment is unaffected |
| FR-10 | `t_roster_import` | unit | noisy CSV and namespace-prefixed inline-string XLSX rosters both mint the same deterministic per-student keys; a file without an Email column is refused |

## Attack suite (all must NOT produce a passing grade)
`t_attack_prerecord`, `t_attack_swap_audio`, `t_attack_splice_after_nonce`,
`t_attack_forge_cert`, `t_attack_late_submit`, `t_attack_replay`, `t_attack_oversize_dos`,
`t_attack_resell_cert` (e2e I — a valid `.zip` submitted by a different student earns 0).

## Course-content separation (INV-COURSE-1, INV-COURSE-2, INV-COURSE-3)

`t_course_locality` (unit, four assertions). Course content is a **separate private repository**
cloned into `courses/`; a Bank holds the questions *and* the reference answers, so publishing one
ends the assessment. All three failure modes here are silent, which is why they are asserted rather
than left to convention:

1. **A bank resolves beside its `course.json`** (INV-COURSE-1) — checked against a course folder
   built in a temp directory entirely outside the repo, since that is the case a root-relative path
   would break.
2. **A legacy root-relative bank path still resolves** — a pre-split `course.json` must not fail on
   the first deploy after the split.
3. **Nothing outside the allow-list is tracked under `courses/`** (INV-COURSE-2) — the check that
   actually stops a Bank being published. Asserted in the unit suite *and* in CI, deliberately
   twice.
4. **Every course named in an npm script is one that ships** (INV-COURSE-3) — a gate that needs
   private content is a gate that cannot run on a clean checkout.

## Extended-time accommodations (INV-ACCOM-1, INV-ACCOM-2, INV-ACCOM-3)

`t_accommodation` (unit, 13 assertions) plus coverage in the E2E suite.

The ladder has to mean the same thing in three places — the browser's countdown, the Signer's
deadline, and the autograder's arithmetic — so JS/Python agreement is asserted on the allowed
values **and on the rejections**, including `1.75`, which is not exactly representable in binary.

The fairness rule (INV-ACCOM-2) is asserted in both languages and from both directions: claiming
more than granted while staying inside the granted time is **not** a fault; claiming more and using
more is. The granted allowance includes the granted buffer, so the "finish your sentence" slack is
never held against a student.

Also asserted: off-ladder claims are refused rather than clamped, both Signer implementations stamp
the claim into the certificate, and an instructor-minted multiplier is not overridable by the
client.

**INV-ACCOM-4 (an unverified claim is assumed correct)** is covered by `t_accommodation_grading`
(unit) and exercised end to end in the three-roster-state walkthrough: no roster, granted ≥ claim,
and granted < claim all produce the **same score**. The student-visible wording is asserted to
promise notification only when the email actually sent — a system that tells a student their
instructor was told, when nothing was sent, has failed in a way they cannot detect.

`t_accommodation_not_persisted` (INV-ACCOM-3, 4 assertions) enforces that the multiplier reaches no
Signer table, no persistence call, and no key derivation — and, positively, that it *is* in the
certificate, so the property stays "exactly one place" rather than decaying to "nowhere". Verified
to actually fail by adding a `time_multiplier` column to the D1 schema and watching it go red.

## Boundary-code windows (INV-INTEGRITY-5)

`t_code_windows` (unit) checks the property the timing slack is supposed to have: a code is found
in its own window and nowhere else. Four assertions across 3 s, 10 s and 120 s question spacing —
an honest attempt passes at all three; a skipped interior code is caught at all three; skipping one
does not hide the others; and, the one that pins the fix, **a code planted at a different boundary
does not satisfy the one that was skipped**.

That last case is the bug: before the windows were clamped it was accepted at 3 s spacing and
rejected at 10 s and 120 s, so the guarantee held for a normal course and quietly did not for one
with short questions. It surfaced as a **flaky e2e** — S5 failing about one run in four, because
whether two derived codes happen to look alike within one edit depends on the attempt id. A test
that fails a quarter of the time is a test people learn to re-run; this one fails always, on the
attack rather than on the coincidence.

## Nothing personal in the zip (INV-PRIV-6, INV-ACCOM-1)

`t_no_personal_data_in_zip` (package) asserts on the **extracted** zip of the course under test,
twice over: by NAME, that no file matching accommodation / roster / extension / student / email /
enroll / drc ships; and by CONTENT, that nothing shipped contains an address-shaped string or a
`"k:REF": number` map. The second check is the one that matters — a roster renamed to something
innocuous is how this comes back. `build-autograder.js` also **refuses the build** if such a file
sits beside `course.json`, rather than warning.

`t_accommodation_note` (unit) asserts the absence that replaced the old verification: no roster
loader survives anywhere in `run_autograder.py`, no grant lookup, no notification about an
accommodation, no branch that touches the score, and the note is **instructor-only** — a visible
"extended time claimed" line is itself a disclosure, and on a shared screen it is one the student
did not choose to make.

`t_audit_offline` (unit) covers the replacement. The audit must refuse to run for an automation:
TTY required on both stdin and stdout, assistant and CI markers refused, and **no override flag** —
asserted by looking for a bypass being READ from argv or the environment, not merely mentioned,
since the file legitimately explains why there is none. The test then RUNS it and requires exit 2,
because the test harness is exactly the environment the guard exists to stop. `--self-test` covers
the join and the timing arithmetic on synthetic data and refuses a real roster, which is what keeps
the logic tested without anyone handling a student's accommodation to do it.

## Late-submission policy (INV-LATE-1, INV-LATE-2, INV-LATE-3)

`t_late_policy` (unit, 8 assertions), plus a four-state walkthrough of a real submission
(on time / inside grace / 6h late / 2 days late) through the full autograder.

The assertion that matters most is the failure direction: four separately malformed policies —
unknown mode, `steps` mode with no steps, an unreadable step, and a null policy — must every one
grade the submission in full. A typo must never be why a student gets a zero.

Also asserted: the deduction is a percentage of the maximum rather than of the earned score
(9→7 and 4→2 on the same policy); Gradescope's real timestamp format including UTC offset parses;
an unknown submission time counts as on time; and **no course that ships penalises late work by
default**.

`t_late_due` (unit, 13 assertions) covers **whose** due date. Penalising a student who was *granted*
an extension is the worst outcome this policy can produce — it punishes exactly the person the
instructor went out of their way to help — so the resolution order is asserted end to end: an entry
in `extensions.json` outranks everything and is trusted without a review flag; a per-student date in
the submission metadata is trusted too, being student-specific by construction; the assignment-wide
date is used but **flagged**, because nothing can tell it apart from a student-specific one from a
single submission. Also asserted: an unparseable extension is ignored rather than obeyed, no due
date at all yields no lateness rather than a penalty, and every date field the metadata carried is
reported to the instructor.

**Settled by measurement, 2026-09-02** (three live submissions, `tools/metadata-probe`): Gradescope
sends the dates twice, and a per-student **due-date** extension moves the per-user block
(`users[0].assignment.*`) while leaving the shared one alone. So the per-user date is the student's
own deadline, and a mark taken from it needs no review flag. A per-student **time-limit** extension
appears nowhere in the payload, which is why extended time remains claimed-and-verified
(INV-ACCOM-1/2) rather than read. The captured extended payload is pinned verbatim as a fixture —
the first resolver read `users[].due_date` and would have missed every extension, so the assertion
that catches that regression is worth more than the ones around it.

## Boundary-code length (INV-CODE-1, INV-CODE-2)

`t_opening_code` asserts the **property** rather than the number: codes are all digits and exactly
`CODE_DIGITS` long, JS and Python agree on the value, the value stays within [4, 8], and both
Signers clamp a misconfigured `course.json` up to the floor rather than honouring it.

The floor itself rests on measurement, recorded in `CODE_DIGITS`' comment in `server/lib/protocol.js`:
false-accept by code length against noise digits, and the compounding of the flooding attack across
N+1 boundaries. Re-run those measurements before ever changing the default.

## One grader or none (INV-GRADE-1)

`t_no_grader_fallback` (unit). The property is a **negative** one — that a thing does *not* happen
— which is exactly the kind that rots quietly, because nothing fails when a fallback creeps back
in. So it is asserted directly on the dispatch: no chain from one backend to another, an
unavailable grader raises `GraderUnavailable`, and the caller turns that into an ungraded
submission rather than a score.

Also asserted: the student-facing message does not blame the student and names where to ask; the
instructor gets a `REGRADE REQUIRED` flag naming backend and reason; and a `genai`-only course does
not bundle the local model, since with no fallback it could never be used.

## Which attempt counts (INV-DEPLOY-1)

`t_active_submission` (unit, 4 assertions).

**This test previously asserted the opposite, and that is the point of recording it.** It required
the autograder's output to name the Gradescope setting *"submission to be graded → highest score"* —
so it faithfully guarded a sentence sending instructors to look for a control that **does not exist**
on a Programming Assignment. A green test is not evidence that the world is as the test assumes;
this one had been green since the setting was first written down, never checked.

Corrected against the Gradescope UI and its published guides: Gradescope grades the **active**
submission, which is the newest unless the Student activates an earlier one from Submission History.

Asserted now: the mint branch no longer names a setting that does not exist, it explains what
actually decides the grade, and — because the fix belongs to the Student, not the Instructor — the
**Student-visible** text says their newest upload counts and how to re-activate a better one. A
fourth assertion pins the same statement in `STUDENT-GUIDE.md`, since that is where most Students
will meet it.

## Assignment routing (INV-DEPLOY-3)

`t_assignment_routing` (unit, 7 assertions) and `t_cert_belongs_here` (unit, 6).

Routing is now one rule — the Assignment pinned into the zip — so the interesting assertions are
**negative**: that nothing about the Gradescope assignment influences it. The fixture is built to be
catnip for the rules that used to exist (a matching `gradescopeId`, a `"Quiz 4"` title alias, an
Assignment id sitting inside the title) and asserts that a pin pointing elsewhere still wins and a
contradicting title changes nothing.

Three refusals are pinned because each has a different cause and a different fix: an **unpinned**
zip refuses *even when the Course has exactly one Assignment* — the old "only one" fallback is gone
too, so the unambiguous case cannot quietly re-teach the system to infer; a pin naming an Assignment
the bundled `course.json` lacks refuses as **drift**; and the refusal text names the rebuild command
rather than a setting, because rebuilding is the only real fix.

Two assertions guard against resurrection rather than behaviour: that no inference machinery
(`AssignmentConflict`, `_explicit_rules`, `gradescopeTitleContains`, "week number in title") survives
in the autograder source, and that **no `course.json` still carries a dead routing field**. Dead code
that still resolves Assignments is one edit from running, and a stale knob is a promise the code no
longer keeps.

`t_cert_belongs_here` covers the mistake that per-Assignment zips make realistic: uploading the wrong
one, or a Student uploading last week's `.zip`. `courseId`, `assignmentId` and every `questionId`
must match the zip, each mismatch must clear `integrity_ok` rather than merely annotate, and the
Assignment mismatch must tell the Instructor to check *which zip they uploaded*. The `courseId`
assertion carries its own justification in the source, because it looks redundant with the signature
and is not: two Courses on the legacy shared Secret verify each other's Certificates, and Assignment
ids collide readily across Courses.

## The zip's environment matches the assignment inside it (INV-DEPLOY-3, INV-PRIV-6)

`t_zip_env_matches_backend` (unit, 8 assertions) over a real `--zip` build of a two-assignment
fixture: one `genai`, one `local`.

The property is not "the course ships the key it needs" but "each zip ships what **its** assignment
needs". Those read the same on a single-backend course and come apart on a mixed one, which is why
the fixture is mixed and why the assertion that matters is a **negative** one: no `GENAI_STUDIO_*`
anywhere in the locally-graded zip's `secret.env`. Decided course-wide, that key was written into
every zip as soon as any one week used GenAI — in plaintext, in an artifact readable by anyone with
staff access to the Gradescope course, to be used by nothing in it.

Both directions are pinned, because the mirror case is a build-time cost rather than a secrecy one
and so has no symptom at all: a `genai` zip must carry `ORALSCALE_SKIP_LOCAL_LLM=1`, not bake in a
~2 GB GGUF that INV-GRADE-1 forbids it ever falling back to.

The decision is read from the `course.json` written into **that** zip, not from the course on disk,
so a per-build override (a regrade variant's, say) cannot leave the config and the environment
disagreeing. Two further assertions are on the build log — which zip got the key, and the container
size per assignment — because the alternative to being told is unzipping the artifact to find out.

`t_genai_key_scope` and `t_setup_llm` hold the same property against the source: that the choice is
made inside the per-assignment loop, and that the credentials are cleared from the base environment
so an exported `GENAI_STUDIO_*` cannot ride into a local zip through `{ ...process.env }`.

## Built-in courses are not re-keyable (INV-SEC-4)

`t_builtin_courses_immutable` (unit, 6 assertions).

The property is about which *lever* a person reaches for under pressure. A Secret clash names two
courses, and the tempting fix is to rotate whichever the message mentions — which, when a course was
started by copying a built-in, is the shipped one. That clears the error and keeps the fault.

Asserted: built-ins are recognised **by path, not courseId** (a copied folder keeps its id, so an
id-based rule would protect the copy too); rotating one is refused outright with no override flag;
the refusal names the *user's* course as the thing to change; and `clashAdvice()` points away from
the built-in **in both directions** — asked about the copy it says "fix yours", asked about the
built-in it says "change the other one".

Two more cover the rewrite: a rotation drops every other key in `.env` (a copied file carried a
copied GenAI key too, and keeping it would leave one course using another's credentials), and says
exactly what it removed so the instructor can restore what is genuinely theirs.

## Stale links say so (INV-DEPLOY-3)

`t_stale_link` (unit, 6 assertions — three against each Signer implementation).

Found in production: after `try` became `demo-quiz`, the old public link returned *"studentRef must
be an opaque emailRef or private code"* — true of nothing the student did and pointing at nothing
they could fix. A missing assignment made `requireKeyFor()` read a knob off `undefined`, so a
request carrying a perfectly good quiz key fell through to the open-mode branch and failed there.

The assertions pin the ordering as much as the message: the unknown-assignment check must come
**before** the identity branch, or the wrong error wins again. Both the Node signer and the Worker
are checked, because they are separate implementations of the same contract and this is exactly the
kind of fix that lands in one.

## A link cannot outrun its deployment (INV-DEPLOY-5)

`t_link_needs_live_worker` (unit, 7 assertions, against a stub `/health` on 127.0.0.1 — no network).

Found in production (pilot course, 2026-09-02): Quiz 1 was authored, frozen, packaged and pasted into
Gradescope while the deployed Worker still served only Quiz 0. Every student got `ASSIGNMENT_GONE`.

The assertions pin **refusal**, not a warning, and pin that *no link is printed* — a link that
scrolls into a terminal is a link that gets pasted, so "warned and minted" would fail the same way.
Unreachable is asserted to refuse too: the invariant is that the Worker was *shown* to serve this
assignment, and silence is not evidence. Knob drift (`questionsPerAttempt`, `requireAccessKey`) is
covered alongside absence, because a stale bundle that still knows the id delivers a different quiz
than the one the instructor just reviewed.

The stub also covers the two shapes that are not failures: a matching `/health` mints normally, and
a course with no `signerUrl` skips the check entirely (there is no deployment to interrogate, and
that link is already labelled local-dev).

## One folder is the whole course (INV-COURSE-4)
## One folder is the whole course (INV-COURSE-4)

`t_secret_hygiene` (extended) and `t_course_locality`.

Asserted against the **real courses on disk**, not a fixture, because the failure being prevented is
"the Secret stayed behind in the engine repo" — which a fixture, constructed correctly by
definition, cannot exhibit. Every course must have a Secret; every Secret's source must be a path
under `courses/` (or a course-scoped environment variable); no two may share a value; and
`_template` must ship **without** one, since a skeleton carrying a Secret is a Secret shared by
every course copied from it.

## Per-course signing secrets (INV-SEC-4)
## Per-course signing secrets (INV-SEC-4)

`t_per_course_secret` (unit) plus the commit gate itself, `tools/check-course-safety.js`.

Two layers, because either alone is insufficient. **On the source**, that no minting tool reads
`server/config.json` directly — a wrong Secret produces a *well-formed* link, so there is no runtime
moment at which to catch it. **End to end**, that a link minted for a probe Course verifies under
that Course's Secret and **not** under the legacy one; that half is what would have caught the
production bug, since the source check passes trivially for a tool that resolves correctly and then
signs with something else.

The gate adds the property no single build can observe: **every Course has a Secret, and no two hold
the same value.** Two Courses can each have a file and still share a string, which is
indistinguishable from borrowing until someone forges across the boundary. Verified to actually fail
by copying one Course's Secret into another's file and watching the commit blocked.

There is **no fallback left to test around**: `resolve()` reads `secrets/<courseId>.json` or the
course-scoped `ORALSCALE_SECRET_<COURSEID>`, and nothing else. Removing the bare `ORALSCALE_SECRET`
override cost the suites their ambient Secret and was worth it — `demo-e2e` now resolves the fixture
Course's own Secret and passes it to the Signer it spawns, which is what the suite was always
pretending to do.

Also asserted: the output names which Secret signed it.

## Evaluating a points-mode grader (INV-GRADE-3/10/11)

`tools/eval/points-bench.py`, on fixtures from `tools/eval/points_fixtures.py`. Not part of the
commit gate — it needs a model — but it is the measurement any change to a grading prompt has to
justify itself against, and the numbers belong in STATUS with the change.

**Why a new harness rather than an argument to `bench.py`.** Every other harness here measures BAND
mode and measures ORDERING: degrade a `referenceAnswer` into full/partial/weak/none and ask whether
the grader ranks them. That is the right ground truth for a grader that returns one label, and it
does not transfer — there is no way to degrade an answer into a known *vector* of per-point
verdicts. Points mode needs the opposite construction: build the answer UP from a chosen subset of
the question's own points, so every id's correct verdict is known by construction.

**What it reports, and why these and not an accuracy score.**

| | |
|---|---|
| `readable` | the fraction of answers that came back with a verdict for every point. First, because INV-GRADE-1 has no fallback: one unreadable question costs the whole submission. This is the number that decided Quiz 3. |
| `under` / `over` | **reported separately, never summed** (INV-GRADE-11). `under` is credit withheld from a point the student made; `over` is credit not quite earned. A single accuracy figure would let a change buy `over` accuracy with `under` errors, which is exactly the trade the invariant forbids. |
| `optCredit` | of the optional points an answer genuinely conveyed, how many were credited. Broken out because a grader can look fine overall while being structurally blind to the O points — which caps every student below the top of the curve, and is what was happening on 2026-09-17 (72 of 72 `absent`). |
| `messyCost` | mean score of a clean answer minus its messy twin. The two carry identical content, so anything above zero is the grader marking down *speech* — which INV-GRADE-3 forbids and nothing previously measured. |
| `falseClaim` | catch rate on answers asserting one of the bank's own certified misconceptions. |
| `scoreErr` | mean SIGNED difference from the mark the constructed vector earns under the course's own curve, plus the fraction marked BELOW it. Signed, for the same reason `under` and `over` are separate. |

**Two axes, both switchable, so a claim can be re-run.** `--variant` selects what the local grader
is told about each question (`bare` / `ref` / `evidence` / `ref+evidence`), substituted into
`localmodel.bank_context`. `--opt-framing old` restores the pre-2026-09-17 optional-point wording,
kept in the harness rather than in `pointscore.py` for the reason `variants.py` keeps its own
copies: a measurement you cannot re-run is one the reader has to take on trust.

**The fixtures are themselves tested** (`t_points_fixtures`), because a fixture bug shows up as a
grader defect and gets chased in the wrong file.

## Retrying an unusable grader reply (INV-GRADE-4)

`t_genai_parse_retry` (unit, 7 assertions), driven against `tools/fixtures/fake-genai.py` — a stub
OpenAI-compatible endpoint that replies badly on purpose.

**Behavioural, not grepped**, and that distinction is the point: the property is that the ladder
*recovers*, which source-matching cannot show. The stub reproduces the three shapes that matter —
a batch reply truncated mid-JSON (`finish_reason=length`), a batch reply that is prose, and a
grader that returns nothing usable at any batch size.

Asserted: truncation recovers **and is named as truncation** with the knob to change; a prose reply
falls through to the single-question rung and still grades all five; the genuinely unusable grader
**still fails** — a ladder that always finds a way to produce a score has become the fallback chain
INV-GRADE-1 forbids, so this assertion is the one that keeps the other three honest; the failure
carries structured `[diag]`/`[req]`/`[result]` evidence including the successful requests;
`GraderUnavailable` transports the log so it survives a total failure; and the reminder appended on
rung 2 mentions only output format, never the rubric or the score.

Three further assertions cover `_redact_shape` directly, because the Instructor log is exactly where
student text leaks in by accident and the rule is worth pinning rather than trusting: JSON **keys**
survive and string **values** do not, a truncated tail is reported as `UNTERMINATED` rather than left
dangling, and a non-JSON reply is withheld entirely rather than merely trimmed. Each is checked
against a fixture containing a distinctive phrase that must not appear in the output.

`t_points_reply_trailing_text` (unit, 4 assertions) covers the rung *below* that ladder: a reply
that is not unusable at all, only surrounded by other text. `pointscore.parse_reply` used to fall
back to a greedy `{.*}` slice from the first brace to the last, which is correct for a model that
answers once and stops and wrong for one that answers and then keeps talking. A real Quiz 3
submission (2026-09-17) lost **all five questions** to it: qwen2.5-3b emitted a complete, valid,
gradeable object on every question and then appended a truncated pretty-printed copy, the greedy
slice glued the two together, and the autograder reported `REGRADE REQUIRED` over a judgement it
had already been given. The parser now decodes the first *balanced* object that is actually an
answer, using the JSON decoder's own bracket matching. Asserted: a complete object survives
trailing chatter, leading prose and a wrapping `answers` array; a non-answer JSON object before it
is skipped rather than accepted; a reply with no usable object is still `None` (the ladder must
still be able to fail, per INV-GRADE-1); and the recovered object reaches the same mark as one
handed over clean. Shared by both backends deliberately — a parser lenient for one grader and
strict for the other would make the two produce different marks from the same judgement.

One fixture detail worth keeping: **each mode gets its own port**. Sharing one meant a stub that
outlived its run answered the next one, and every mode silently tested whichever stub was still
listening — the same failure as a stale Signer making an E2E run pass against the previous run's
server. It surfaced here as three green tests reporting the wrong mode's output.

## Asking for a band, not a number (INV-GRADE-5)

`t_local_grader_bands` (unit, 7 assertions).

Asserted on the prompt and the parser rather than on a live model, because a unit run cannot host a
3B GGUF. What the assertions pin is the shape the measurement showed matters: the outgoing prompt
asks for one of the four band names and contains no request for a number; the band→score table is
in Python; and the parser reads a band before it tries any legacy numeric path.

The seventh assertion is the interesting one. `none` is both a band name and an ordinary English
word, and the model's feedback sentence says things like "the student covered none of the key
points" on answers it graded `partial`. A naive substring search turns those into zeros — the exact
class-wide failure the band change was made to remove, reintroduced by the parser instead of the
prompt. So the band regex is word-bounded and refuses `none` when followed by `of`, and the test
feeds it that sentence.

`t_genai_grader_bands` (unit, 6 assertions) makes the same three claims about the remote grader,
plus two the local one does not need. **Both backends map the bands with the same table** — asserted
by reading the literal from each file, because two graders drifting apart on what `partial` is worth
would give two students who said the same thing different marks for a reason invisible to both. And
**a reply with no readable band is a gap, not a zero**: well-formed JSON carrying prose where a band
name belongs used to normalise straight to `0.0`, which is the class-wide zero rebuilt one layer
down, in the parser, where no prompt change could reach it. It is dropped in `_parse_batch` instead,
so the INV-GRADE-4 ladder re-asks it.

The measurement that justifies the remote change is in `tools/eval/bench.py`, which drops GenAI as
the reference. That mattered: once the local grader agreed with the bank author **more often than
GenAI did**, "agreement with GenAI" was measuring the wrong thing, and a grader could only get worse
by improving. `bench.py` uses two references that exist without a model — an ORDERING fixed by
construction (a question's own `referenceAnswer`, that answer truncated, its first sentence, and a
neighbouring question's answer as the hard negative), and the hand-authored calibration bands. It
reports **ties and inversions separately**, because bands trade the first for the second and adding
them together hides a grader getting fairer.

The behavioural claim behind this invariant is not unit-testable and lives in `tools/eval/`:
`qwen-vs-genai.py` scores a variant against a cached Purdue GenAI reference on 35 answers, and
`holdout.py` checks ordering on eight questions that were never used for tuning. Both need a local
server (`ORALSCALE_LOCAL_URL`) and are run by hand when the prompt changes, not in the gate.

## Surviving the phone (INV-PLAT-5, INV-PLAT-6)

`t_attempt_survives_the_phone` (unit, 6 assertions).

Asserted on the source rather than at runtime, and deliberately so: neither failure can be provoked
headlessly. A screen lock needs a real phone left alone for thirty seconds, and an accidental
back-swipe needs a real navigation. Both are also **invisible in every desktop test**, which is
exactly why they survived to be found by reading rather than by failing.

What is pinned: the lock is taken only once recording is live (asking earlier races the mic
permission prompt), re-taken on `visibilitychange` (the browser drops it whenever the page hides, so
one notification would otherwise end the protection for the rest of the attempt), released on both
exits, and **never load-bearing** — an absent or refused API must not interrupt an attempt, because
iOS before 16.4 has no wake lock at all.

For INV-PLAT-6 the assertion that matters is the second condition: leaving is confirmed not only
while recording but while a **certified** recording has not been downloaded. That is the state where
the student did everything right and submitted nothing, and it is the only one where the loss is
both total and silent.

## Demo identity bypass (INV-DEMO-1)

`U1`–`U5` (e2e) plus `t_demo_identity_bypass` (unit).

The e2e cases are deliberately the **same scenario as `R9`** — a certificate uploaded by someone it
was not issued to — run once against the assignment that opts out and once against one that does
not. `R9` must stay 0 and `U1` must not; if the two ever agree, one of them is broken and the pair
says which.

Because the danger here is not that the bypass fails to work but that it works *quietly*, the
warning is asserted as carefully as the behaviour: `U2` that the student actually sees it and that
it is emitted as a **failed** test (Gradescope renders those in red — a passing test named "warning"
reads as reassurance), `U3` that the text both states identity was not checked and forbids real use,
`U4` that the instructor gets a review flag and a record of what the identity check *would* have
said, and `U5` that another assignment in the same course is unaffected.

`t_demo_identity_bypass` covers the two containment properties that have no runtime moment to fail
at: that `tools/check-course-safety.js` fails a course outside `courses/demo/` which sets it, that
it fails any course that sets it in `defaults`, and that the autograder reads it per-assignment
only.

## Current status — green
- `npm run test:unit` — 130/130 (INV-SEC-1 both directions, INV-INTEGRITY-5 derivation parity, INV-SEC-3, identity parity + opaque-ref validation, the v7 additions: timing defaults, prompt-injection detection, PII redaction, keyed edge tags, transcription reliability, and `t_course_locality` for INV-COURSE-1/2/3).
- `npm run test:e2e` — 44/44 honest-pass + attack suite + v3 identity (public link, resale, private code, plaintext-ref rejection).
- `npm run test:worker` — 16/16.
- `npm run test:package` — 19/19.
- `npm run test:banks` — 1/1 on the **demo** course that ships. A real course's banks validate in that course's own private repository: `node tools/validate-all-banks.js courses/<id>`.
- `npm run test:course` — the demo course's `starter` assignment passes end to end. It is keyed, multi-question and heuristic-graded, so it exercises the full path with no private content and no model download.
- Browser-verified (manual): capture-before-question, question+rolling-nonce, countdown, Certified→download, 375px.
- Remaining: real-device mic matrix (iOS/Android/desktop) — instructor checklist in the teacher guide.

## Versioned local grader
- `tools/test-local-profile.py`: INV-LOCAL-1/2, INV-GRADE-1/4/10/11. Generic enhanced and legacy-key prompts, exact criterion set, uncertainty still numeric, context reservation, thinking/truncation rejection, shared false-claim guards, pinned hashes, explicit profile selection, runtime release.
- `tools/test-local-package.js`: INV-LOCAL-2 / INV-DEPLOY-3/6. Synthetic alternate bank preserves student questions, rejects edits/reordering/selection changes, pins selected assignment only and records build provenance.
- Private course regression audit compares the integrated requests and scorer with frozen synthetic evaluation results; aggregate findings in docs/reference/LOCAL-GRADING.md.
- The automated accommodation audit test invokes only its authorized synthetic `--self-test`; source inspection and attempts with input paths are instructor-only under AGENTS.md.

- `tools/test-debug-identity.py` and `tools/test-local-package.js`: INV-DEBUG-1 /
  INV-SEC-1/2/8. Signed synthetic identity match/mismatch, absent submitter, DEBUG
  labels and numeric grading, signature/audio/assignment/access-code failures still
  block, and normal/debug archives stay distinct with identical bank/model configuration.

- INV-USE-6: `tools/test-runtime-timing.py` tests Indianapolis winter/summer offsets,
  monotonic durations, stage accounting and failure spans; `tools/test-debug-identity.py`
  checks feedback-first ordering, visible summary and final hidden breakdown on both
  successful and refused runs. `tools/test-local-profile.py` checks nested Qwen timings
  and CPU thread defaults. Extracted standard/DEBUG package checks preserve scores.
  Resource diagnostics test synthetic cgroup v1/v2 samples, peak/limit labels, minute
  sampling, unavailable-cgroup fallback and continued grading if a read fails.
  Cap diagnostics also cover cgroup mount-root/namespace resolution, finite ancestor
  limits, v1 hierarchy off, group membership, live process RSS/PSS, counter/percentage
  arithmetic, cap-scaled chart and missing/inaccessible scope. A Linux parent plus live
  child allocation smoke verifies the whole-group measurement includes the child.

Course-local oversized-model experiments under INV-DEBUG-1 / INV-LOCAL-2 additionally
verify the frozen base checksum, changed-file allowlist, pinned model metadata,
unchanged bank/prompt/scoring, and refusal to start without DEBUG metadata. Their
build/test scripts and results live with the private course experiment.

INV-USE-6 lifecycle tests in tools/test-runtime-timing.py verify flushed run IDs,
stage/failure/heartbeat events without exception contents, and launcher exit
markers preserving both successful and failing child status.

- INV-USE-7: `tools/test-feedback-footer.py` runs the autograder end to end on the
  synthetic submission and checks that `feedbackFooter` (assignment or course default)
  is the last text of every visible question's feedback, after FEEDBACK; that absent,
  blank or non-string values add nothing; and that the score is unchanged.

Workstation-cache coverage for INV-LOCAL-1: `test_shared_cache_exact_revision_and_overrides` in `tools/test-local-profile.py` checks exact revision, image precedence, missing explicit paths, and standard shared-cache environment overrides without network access.
