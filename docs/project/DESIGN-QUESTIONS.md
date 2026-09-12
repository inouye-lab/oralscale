# OralScale — Running Design Questions

Questions for the instructor (David) to answer later. **Each has a "current best guess"
that the build proceeds with**, so nothing is blocked. Edit the "Decision" line to steer.

Uncommitted ideas that are not ready for a best guess live in [PARKING-LOT.md](PARKING-LOT.md).

Status legend: 🟢 proceeding on best guess · 🔵 answered · 🔴 needs attention soon

---

## A. Assessment policy

**A1. Questions per attempt.** How many questions does a student answer in one recording/attempt?
- **Decision (2026-08-20, REOPENED and implemented): `questionsPerAttempt` is a real knob,
  default 1.** 🔵
- Superseded the 2026-08-18 decision ("1, fixed — not a knob"), which had removed the key from
  `course.json` as dead config. The instructor asked for multi-question attempts, so the work the
  old note said would be needed across the Signer, web UI and autograder has now been done.
- **Shape:** N questions in ONE continuous recording, each with its own `limitSec`, its own
  countdown, and its own "I'm done with this question" commit. Between questions the student reads
  a single four-digit boundary code that closes the answer just given and opens the next
  (models/01 "Boundary code"). Each question is graded only on the transcript slice while it was
  on screen, and the score is the mean.
- **Why one code per boundary rather than a closing code then an opening code:** two sets of
  digits back to back is a worse student experience for identical evidence — the code is issued at
  the boundary either way, so it postdates the answer it closes and predates the question it opens.
- **The pilot course runs 5 questions × 120 s** (instructor decision reaffirmed 2026-08-25), with a 20 s
  buffer each. The hard ceiling is about 12 minutes, but the instructor's classroom attempt took
  about six. Five questions sample more principles and reduce question-draw variance; `dropLowest`
  prevents one unlucky draw or bad moment from deciding the grade.
- Guarded by the reverse drift check in `tools/test-unit.js`: a knob named in `course.json` that
  no code reads is now a test failure in *both* directions.

**A2. Time limit.** Per-question/attempt limit.
- **Decision (2026-08-20, revised): 2 minutes per QUESTION (`limitSec: 120`) plus a separate
  20 s `bufferSec`**, instructor-configurable per assignment; soft warnings at 60s and 15s (also
  announced to screen readers, INV-PLAT-4). Supersedes the 2026-08-18 decision of a single
  3-minute limit, which predates multi-question attempts. 🔵
- **Why `bufferSec` is its own knob and not a bigger `limitSec`.** The countdown is a promise to
  the student; if "2 minutes" silently means "2 minutes and a bit", the number on screen is a lie
  and students learn to ignore it. If instead the recording cuts off at exactly 0:00, it cuts off
  mid-word, which makes the assessment worse for no gain. So the limit is honest and the grace is
  explicit: at 0:00 the screen says *"finish your sentence"* and the question closes itself
  `bufferSec` later. Clock skew is a **third** thing (`GRACE_SEC`, deployment-wide) and is folded
  into neither — conflating the three is how a "3 minute" quiz becomes an unpredictable one.
- Rationale: matches the "2–3 minute answer" framing used everywhere in the docs, which the old
  5-minute default contradicted. Less student burden and less audio to transcribe/spot-check.
- ⚠️ **Note the window includes reading + thinking, not just talking.** At 180s a student has
  roughly 2:25 of actual speaking time. Student guide now says "aim for about 2 minutes." If you
  want a full 3 minutes of *speech*, set `limitSec: 210–240` in `course.json` — one-line change,
  no code.

**A3. Retake policy & scoring.** Unlimited retakes with a fresh question each time — how do multiple attempts combine into a grade?
- **Decision (2026-08-18): unlimited retakes; Gradescope keeps the HIGHEST-SCORING submission.** 🔵
- **This is a hard prerequisite, not a preference** — promoted to **INV-DEPLOY-1**. The
  single-assignment flow scores a "no recording" submission 0 while handing back the quiz link;
  under "most recent" or "average" that 0 would overwrite an earned score. The autograder now
  prints the requirement on every mint run (test `t_best_of_required`), and TEACHER-GUIDE has it as
  a bolded setup step. `retakePolicy` has been removed from `course.json` — it was dead config;
  the real control lives in Gradescope's assignment settings.
- **⚠️ CORRECTED (2026-08-29): the premise was false.** There is no "highest score" setting on a
  Gradescope Programming Assignment — it grades the **active** submission, newest by default. The
  decision's *intent* (a retake never costs a student their earned score) survives; its *mechanism*
  does not. It is now delivered by telling the Student to re-activate the attempt they want, which
  is two clicks in Submission History. `t_best_of_required` became `t_active_submission` and asserts
  the opposite of what it used to. See INV-DEPLOY-1.
- **Follow-up (2026-09-02):** the correction had not reached every message. Three student-facing
  autograder strings, the web app's post-download steps, the student guide, the README and several
  instructor setup outputs still promised "your best attempt counts" or told instructors to set a
  control that does not exist. All corrected, and `t_active_submission` now asserts the absence of
  the claim across the autograder, the web app and the guides so it cannot creep back.

**A4. Pass threshold / points.** What score is "full credit"?
- **Decision (2026-08-18): 10 points per week (`ORALSCALE_MAX_POINTS=10`), no hard pass/fail.** 🔵
- The GenAI rubric score (0–1) is scaled onto the 10 points and is **advisory**; integrity failures
  score 0 and are flagged for review. Still open for the instructor and *not* a code question:
  what fraction of the course grade the weekly orals carry.

**A6. What a band is worth.** The grader names a band; what fraction of the question does each band earn?
- **Decision (2026-08-31, instructor): a FIVE-rung scale, and the prices are a per-course knob.** 🔵
- The instructor asked for `1.0 / 0.92 / 0.80 / 0.70 / 0.0` and the engine had four bands, so a
  fifth rung — **`strong`** — was inserted between `full` and `partial` rather than dropping one of
  the five numbers. **Engine default (revised 2026-09-01): `full 1.0 · strong 0.9 · partial 0.8 ·
  weak 0.7 · none 0.0`** — an even tenth per rung, with the single cliff between `weak` and
  `none`. **The pilot course sets `defaults.bandScores` to `1.0 / 0.92 / 0.80 / 0.70 / 0.0`**, which is the
  same shape with a slightly gentler step at the top.
- **Why a fifth rung and not a re-pricing of four.** The commonest good spoken answer has the
  reasoning and leaves out one substantive piece. On four rungs a grader must round it to `full`
  (which ties it with a complete answer) or to `partial` (a 35-point drop for one omission). Both
  are wrong, and the tie is the one that shows up in the measurements as the grade failing to say
  anything. The rung is the instructor's invention; the model picks it, so it is named in both
  prompts and both parsers.
- **The instructor owns the prices, not the names.** `grade.resolve_bands` accepts a course table
  only if it is complete over the five names, numeric, within `[0,1]` and non-increasing; anything
  else is rejected **whole** and the default is used. A half-applied curve would draw part of a
  student's mark from each scale, which is the one outcome nobody could defend. Adding or removing
  a band is not offered, because the names are compiled into two prompts and two parsers.
- **Where the pilot course's curve comes from:** the only cliff that belongs there is wrongness. An answer
  that is on topic and says nothing false has demonstrated something and keeps 0.7; `0.0` is
  reserved for being wrong about the central idea or not answering. Combined with `dropLowest` over
  five questions this targets ~85% for a student who attends and studies and well under 40% for
  someone who has not engaged with the material.

**A5. Bank size & overlap.** Target ~100 questions/week for low overlap.
- Best guess: **100 per week**, deterministic no-repeat within a student's attempts until the pool is exhausted.
- Decision: _pending_ 🟢

---

## B. Security / identity

**B1. Quiz-link distribution.** How do quiz links reach students via Gradescope?
- **Decision (2026-08-18): ONE PUBLIC course link in the assignment description; identity is
  bound at SUBMISSION time, not at link time.** 🔵
- The old flow minted a per-student link from `submission_metadata.json`, which forced every
  student through a placeholder submission *before every quiz* just to obtain a URL. Identity is
  authenticated by Gradescope at **upload** anyway, so binding it at mint time bought nothing and
  cost a whole round-trip. The link is now public, carries no identity, and is not a credential.
- The student self-identifies in the app (see **B5**); the autograder re-derives that ref from the
  Gradescope-authenticated email and refuses to grade a certificate it cannot match (**INV-SEC-2**).
- **What this costs:** a `.zip` is now portable until it is submitted, so "certificate resale" is
  worth naming explicitly. It fails: the recording is graded only for the identity it was certified
  under, so a seller must run a separate attempt per buyer — ordinary collusion (T7, already
  accepted). Covered by e2e test I.
- Legacy per-student QuizTokens still work and are retained **only** for DRC extended-time links,
  which need a `timeMultiplier` (see D2b). `node tools/gen-url.js --student ... --time-mult 1.5`.

**B5. Does the typed email create a FERPA/privacy exposure?** The student types their address into a
page that talks to a Cloudflare Worker outside Purdue's contracted boundary.
- **Decision (2026-08-18): the Signer never receives a plaintext email. Two opaque forms, student
  chooses.** 🔵 (mechanism) / 🔴 (whether the default satisfies Purdue's privacy office)
- **Worth noting first:** the *previous* design already sent the plaintext email to the Signer — it
  sat in the QuizToken payload and was signed into every Certificate. This change removes an
  existing exposure rather than creating a new one.
- **Default — `e:<hex>` emailRef.** The student types their address; the browser computes
  `HMAC(pseudonymSalt, normalized_email)` via Web Crypto and sends only that. Nothing to remember,
  nothing to distribute, and no address on the wire or in edge logs.
- **Opt-out — `p:XXXX-XXXX-XXXX` private code.** `HMAC(Secret, email)`, minted by the autograder
  inside the FERPA boundary and handed to the student in Gradescope feedback. Stable all term.
- **The honest limitation.** `pseudonymSalt` is public (it rides in the course link), and a class
  roster is a small, guessable population — `firstname.lastname@purdue.edu` for ~200 people. Anyone
  holding the salt can brute-force an emailRef back to an address in seconds. A slow KDF does not
  fix this; the keyspace is too small. So the default is **pseudonymization, not anonymization**: it
  removes plaintext PII from the wire and from logs, and it defeats casual inspection and
  cross-service correlation. It does not make re-identification infeasible. The `p:` form does — its
  salt is the Secret, which the browser never holds.
- **Still for the instructor + Purdue privacy office:** whether the `e:` default is acceptable as
  the norm, or whether `p:` should be the default (costing every student one code to keep) — and
  whether students with a FERPA directory-information opt-out should be steered to `p:` explicitly.
  The build proceeds with `e:` as default because it is the only option that needs no distribution
  step, which is the entire point of B1.
- **Superseded for the default configuration (2026-08-20, B7):** students no longer type an
  email at all. The `e:` form and this trade-off survive only for courses running with
  `requireAccessKey: false`.

**B2. Impersonation and off-mic help (T6/T7).** No login means someone else could take the quiz, or
sit off-microphone and feed answers.
- **Decision (2026-08-18): ACCEPTED, with a post-hoc review policy rather than a technical control.** 🔵
- No lightweight cryptographic scheme distinguishes "this student explained it" from "someone next
  to them did and they repeated it," and OralScale should not pretend otherwise. What it does give
  is durable evidence: a signed timeline plus a voice recording, retained in Gradescope.
- **The policy** (now written into models/06 as "Impersonation policy"):
  1. Post-hoc review of recordings across a student's own weeks — a **flag for a human**, never an
     automated penalty. This keeps faith with the non-goal "not a biometric identity system."
  2. Escalate a flag to a **real conversation** — office hours or Zoom, explaining the same
     material. That is the only reliable verification, and it scales because it is rare.
  3. **Tell students** the recordings are retained and may be reviewed. A deterrent nobody knows
     about deters nobody, and disclosure is the honest thing regardless.
  4. Keep stakes proportionate: these are formative weekly checks. The same content is assessed on
     **proctored exams**, which remain the gold standard for identity-critical verification.
- Note the link itself is no longer worth sharing (B1) — the identity claim is.

**B6. Question shopping / bank cataloguing.** A student rerolls `/reveal` until an easy question
appears, or harvests the bank by rerolling repeatedly.
- **Decision (2026-08-18): per-student retake cooldown — INV-SEC-7.** 🔵
- One question per student per assignment per `retakeCooldownSec` (default **300 s**), **unless the
  previous attempt was actually finished**, which clears the cooldown at once.
- That exception is what keeps it from punishing the honest case. Answering takes ~3 minutes anyway,
  so a student who does the work is never blocked; only someone who bails on a question they just
  saw has to wait. Unlimited retakes stay policy (FR-6) — the cooldown targets *rerolling*, not
  retaking.
- A mic failure costs nothing either: capture starts *before* `/reveal` (INV-INTEGRITY-6), so a
  denied or broken mic never consumes an attempt.
- **Cost:** this is the first genuinely correctness-relevant Signer state (one row per
  student+assignment: attempt id, reveal time, finished flag). It stays a hardening layer — losing
  the DB degrades shopping resistance, not integrity. No email, no audio; the key is a salted hash.
- **Residual:** a patient student can still reroll every 5 minutes and catalogue the bank slowly.
  That is T13, and the cooldown at least makes it cost real time. Tune `retakeCooldownSec` per
  assignment in `course.json` if a week needs it tighter.

**B3. Database.** "Stateless/sessionless but may have a small DB." What may it store?
- Best guess: a **small KV/DB for anti-replay + rate-limiting only** (attempt IDs, nonce issuance, per-URL counters). **Never audio, never transcripts.** Server remains logically stateless (all trust in signed tokens); DB is a hardening layer.
- Decision: _pending_ 🟢

**B4. Rate limiting / DoS.** Lightweight abuse protection.
- Best guess: per-URL and per-IP token-bucket limits on `/start` and `/finish`; small proof-of-work or signed nonce to make `/start` non-trivial to spam; Cloudflare's edge already absorbs volumetric DoS.
- Decision: _pending_ 🟢

---

**B7. Per-student quiz keys — and no email at all.** How do students prove enrolment, and how
little can we learn about them while they do it? 🔵
- **Decision (2026-08-20): a per-student, per-course AccessKey is the ONLY thing a student enters.
  No email, no login (INV-SEC-8).**
- **Why it was needed:** the CourseLink is public by design and `studentRef` used to be
  client-supplied, so a script could invent identities and mine the entire week's Bank. Assumption
  A-4 — the whole basis for a question bank being reusable — depends on that not happening.
- **Self-authenticating, so there is nothing to sync.** `key = sid ‖ tag`, where
  `sid = base32(HMAC(Secret, courseId‖epoch‖email))[0..5]` and
  `tag = base32(HMAC(Secret, courseId‖sid))[0..9]`. The Signer recomputes `tag` from `sid`: a
  valid tag *is* proof of enrolment, because only the Secret can produce one.
  - **Rejected alternative (considered 2026-08-20):** precompute every valid key hash and upload
    them to the edge DB. It buys revocation, and costs a second deployment step that silently goes
    stale exactly when a new student joins mid-term. Self-authenticating keys give the same gate
    with one manual step instead of two — and the one step (post keys to Brightspace) had to
    happen anyway.
- **The key is also the identity.** `studentRef = "k:"+sid`, derived *by the Signer* from the key.
  So the browser sends nothing derived from an email, and `sid` is keyed by the Secret rather than
  a public salt — strictly more private than the `e:` form it replaces (B5), which was
  brute-forceable against a known roster. The autograder re-derives `k:<sid>` from the
  Gradescope-authenticated email, so identity binding (INV-SEC-2) is unchanged.
- **Recovery, three ways**, since "student can't find their key" is the new failure mode: the
  Brightspace post; submitting to Gradescope with no recording, whose feedback prints their own
  key; or the instructor re-running the tool. None of them requires anyone to store a key.
- **Bit budget:** 16 typed characters = 30-bit id + 50-bit MAC. Forging a tag is 2^50 guesses
  against a rate-limited edge. A 30-bit id can collide across a large roster (≈1e-4 at 500
  students), which the mint tool **detects** — it holds the whole roster — and fixes with an
  `accessKeyEpoch` bump.
- **Not an identity proof.** A shared key lets someone open questions as that student; it never
  lets them earn that student's grade. Revocation is therefore not urgent; if it ever is, the
  answer is an epoch bump (re-mints the course), not a per-key list.

**B8. Should the failed-key limit apply per address, given campus NAT?** 🔵
- **Decision (2026-08-20): yes, but only for INVALID KEYS, and loosely.** Ten invalid keys from one
  source in 15 minutes, self-clearing. Every other limit keys on identity, and the per-IP *request*
  limit was raised 60→600/min because a 200-student lecture hall shares one campus address.
- The asymmetry is forced: a forged key **names nobody**, so until a key verifies there is no
  identity to attach a limit to. Leaving forgery entirely unbounded was the alternative, and a
  50-bit tag deserves *some* backstop. The threshold is set where a whole class fumbling their own
  keys stays clear of it — honest students paste a key from Brightspace and never accumulate
  failures — and the window rolls off by itself, so nothing needs an instructor to unblock it.
- Regression tests: e2e R7 (a burst is refused) and R7b (it expires on its own).

**B9. How much formatting should question prompts support?** 🔵
- **Decision (2026-08-20): a small Markdown subset + LaTeX → MathML, rendered through a whitelist
  DOM builder. No links, images, tables, headings or raw HTML.**
- **Why any:** banks are LLM-authored for technical courses. A question about gradient descent
  that cannot write `∇θ J(θ)` is a worse question, and asking an LLM to avoid notation produces
  stilted prompts.
- **Why so little:** every construct has to earn its risk. Links in a spoken quiz are a
  distraction or a phishing vector; images cannot be read aloud; tables do not survive being
  spoken. What is left is what an LLM writes anyway without being asked.
- **Why it is safe by construction, not by sanitizing:** the parser emits plain objects with
  whitelisted tags and author text only in text nodes; the renderer builds DOM with
  `createElement`/`textContent`. There is **no `innerHTML` on the path**, so there is no parser for
  injected markup to survive — raw HTML in a prompt displays as characters. Attribute values are
  literals chosen by the renderer. Unknown LaTeX macros are *shown*, not dropped, so a broken
  question is visible to its author rather than quietly becoming a different question.
- **Why MathML and not KaTeX/MathJax:** no runtime dependency, no font payload, no CDN — it is a
  static app a student opens on a phone on campus wifi. Browsers render MathML natively now; where
  they do not, the page falls back to showing the LaTeX source.
- Regression test: `t_richtext_safe` (13 hostile prompts, no innerHTML, literal-text survival).

## C. Real-time integrity (capture-before-question)

**C1. Capture-before-reveal enforcement.** Requirement: recording must start *before* the question is shown, and the audio must be sent only within the validated window after reveal.
- Best guess protocol: mic starts → `/reveal` returns question + server timestamp `t_reveal` (signed) → answer → `/finish` with audio hash; server enforces `t_finish − t_reveal ≤ limit` and the autograder enforces **audio duration ≈ elapsed window** and **rolling nonce timestamps** so a pre-recorded or late file is rejected. (Detailed in the threat/protocol models.)
- Decision: _pending_ 🟢

**C2. Rolling vs bookend challenge codes.**
- **Decision (2026-08-18): BOOKEND — one code at the start, one at the end. No mid-answer codes.** 🔵
- **Why the change.** Rolling codes interrupted a three-minute explanation four times. That is not
  merely annoying: fluent unassisted reasoning is *the thing being measured*, and breaking it to
  perform a compliance task degrades the measurement. Against that cost, rolling codes stopped
  strictly less than they appeared to — they never prevented reading a prepped script (T3) or
  playing a prepared recording while saying the codes live over it. The attacks they uniquely
  blocked all reduce to T7, which is accepted.
- **What it costs, stated plainly.** INV-INTEGRITY-5 drops from "whole-timeline liveness" to
  "endpoint liveness." The middle of the recording is no longer pinned to the clock, so a
  technically capable attacker could assemble it post-hoc with a custom client. That attacker
  already wins under T7 with far less work. The middle is not unconstrained: duration must fit the
  live window (INV-INTEGRITY-3), the tail after the closing code is bounded (`tailLimitSec`), and
  the stream is continuous with no pause/resume.
- **The closing code earns its keep independently.** The old scheme left up to 45 s of *unpinned
  audio at the end* — the gap between the last rolling code and Stop. Nothing bound the tail of the
  recording to the moment of stopping. The closing code closes exactly that hole.
- Implementation: the question is **hidden** when the student taps "I'm done", which makes it a
  real commitment rather than a soft pause; `/finish` refuses a RevealToken so the closing step
  cannot be skipped.

**C5. Code format and matching tolerance.**
- **Decision (2026-08-18): six digits, read one at a time; accept Damerau-Levenshtein distance ≤ 1.** 🔵
- **Digits, not NATO words.** ASR mangles `xray` and `juliet`, and the old scheme already needed a
  digit-word mapping to paper over inconsistent rendering. Every engine transcribes digits.
- **A tolerance, not an error-correcting code.** ECC recovers an *unknown* message over a noisy
  channel. Here the verifier re-derives the expected digits, so there is nothing to recover — the
  only requirement is surviving one transcription slip. Distance ≤ 1 covers exactly the four cases
  worth covering: a dropped, added, substituted, or transposed digit. A Verhoeff or Damm check
  digit would be the right tool if we needed *detection over an unknown value*; we do not.
- Six digits leaves ample room: an unrelated 6-digit string lands within distance 1 of the expected
  one roughly 6 times in 100,000, and the search is confined to the two time windows. Guessing is
  not the threat anyway — the code is HMAC-derived and revealed only at its moment.

**C3. Transcription location.** Local Whisper (private) vs Purdue GenAI STT.
- Best guess: **local `faster-whisper` in the autograder container** (keeps audio in Gradescope's boundary). GenAI used only for text grading.
- Decision: _pending_ 🟢

---

## D. Platform / UX

**D1. iOS/Android/browser matrix.** Must work on all iPhones/Androids + major browsers with mic capture.
- RESEARCHED: iOS Safari records `audio/mp4` (AAC) on 14.5+ and adds `audio/webm;opus` on 18.4+ (Mar 2025). Chrome/Firefox use `audio/webm;opus`. Use `MediaRecorder.isTypeSupported()` negotiation; **omit the `start(timeslice)` arg on Safari** (older Safari only fires `dataavailable` on stop); require HTTPS + a user gesture for `getUserMedia`.
- Best guess: negotiate MIME in order `[webm;opus, ogg;opus, mp4]`; ffmpeg/Whisper in the autograder decode AAC/mp4 fine.
- Decision: _pending_ 🟢

**D2. Accessibility / accommodations.** Extended-time students, screen readers, captions.
- Best guess: instructor can mint URLs with a per-student time multiplier; UI is keyboard- and screen-reader-friendly; nonce shown large and also as text.
- Decision: _pending_ 🟢

---

## E. Portability

**E1. Multi-course support.** Must be portable to other courses; do ai-curriculum first.
- Best guess: all course specifics live in `banks/<courseId>/<week>.json` + a `course.json` config; nothing course-specific in code.
- Decision: _pending_ 🟢

**E2. Transcription language — English only, for now.** 🔵 *(ratified by the instructor 2026-08-21)*
- **Decision (2026-08-21, instructor): pin transcription to English** (`language="en"`), and say
  so to students.
- **Why pin at all.** Whisper guesses the language per decode window, and the windows this system
  cares about most are bare runs of digits with silence either side — the worst possible evidence
  for a language guess. Leaving it free was one of three contributors to the 2026-08-21 live
  failure (INV-INTEGRITY-9).
- **This is not a claim that accented English is a problem.** Most of the class are international
  students, and the two changes that most improve their transcripts are already in: a `small`
  (or larger) multilingual model rather than `base` or an English-only distil model, and a grading
  prompt that explicitly says to be fair to hesitant, informal and non-native phrasing and to grade
  ideas rather than fluency. Pinning the *language* to English does not narrow the *accents*.
- **Could other languages work?** See PARKING-LOT — the short answer is that the transcription half
  is straightforward and the grading half is the real question. Not being pursued.

**E3. Where does the question-design brief live?** 🟢
- **Decision (2026-08-21): a per-course `question-design.md` plus a `sources/` folder**, both
  inside `courses/<courseId>/`, with a template in `courses/_template/`.
- **Why in the course folder and not in `docs/`:** it is course-specific data, and FR-8 says
  course-specific data lives only under `courses/` and `banks/`. It is also the thing an instructor
  hands to an assistant along with their slides, so it wants to sit next to them.
- **`sources/` is kept, not consumed** — it is how a week gets regenerated in November after the
  instructor decides the questions drifted. Instructors are told twice (guide and folder README)
  that it is a normal repository folder, so nothing with a student's name in it and no unreleased
  solution sets.

**E4. Questions per attempt, and how they combine.** 🔵 *(instructor decision 2026-08-21)*
- **Decision: 5 questions, `limitSec` unchanged at 120 s, and `scoreAggregation: dropLowest`.**
  Applied to the setup wizard's default **and** to the pilot course. This overrides my recommendation of 3;
  the instructor's reasoning is better than mine was, and it is recorded here because the
  arithmetic is not obvious.
- **Why 5 is not the 12½-minute recording it looks like.** `limitSec` is a *ceiling*, not an
  expectation. Students commit with "I'm done with this question" as soon as they have finished,
  and a good answer to one of these runs about a minute — so five questions typically produces six
  or seven minutes of audio, not twelve. The ceiling only binds on a student who actually needs it.
- **Why `limitSec` stays at 120 rather than dropping to 60.** Lowering it would not shorten a
  typical attempt (students already finish early); it would only make the limit start biting on
  slower and non-native speakers — precisely the students it should not cut off. The ceiling is
  free for everyone it does not bind.
- **`dropLowest` is what makes 5 worth having.** The score becomes the best 4 of 5, so one unlucky
  draw, one skipped topic, or one moment of going blank does not decide the grade. That is a real
  reduction in a real anxiety, and it is only affordable because more than one question was asked.
  The dropped question's feedback is still shown in full, marked as not counting — it is usually
  the most useful feedback on the attempt.
- **Implementation note:** the drop is tracked by *index*, not by value, so the per-question marks
  a student sees add up to the total they were given. "Best 4 of 5" only reassures if the
  arithmetic on screen matches it.

**E5. Two severities for prompt injection, rather than one.** 🔵 *(ratified 2026-08-21: never falsely accuse)*
- **Decision (2026-08-21): a `high` detection is an integrity failure (not graded, generic message
  to the student, evidence + Dean of Students note to the instructor); a `possible` detection is
  graded normally and merely flagged.**
- The instructor asked for a validation error on detection. The two-tier split is how that request
  is implemented *without* the failure mode it would otherwise create: this is an AI course whose
  first week is `intro-llm-use`, so "you can tell the model to ignore its previous instructions" is
  a **correct answer**, not an attack. A single tier would zero that student with a message that by
  design does not say why — a false misconduct accusation produced by a regular expression.
- `high` requires an imperative addressed to the grader together with a grading outcome, a bare
  command about the grade, or the grader's own output format spoken aloud. 22 attack phrasings and
  16 honest ones are in `t_prompt_injection`; the benign half is half the specification.
- The detector is tuned to miss a borderline attempt rather than accuse an honest one. **Worth
  confirming that is the trade you want.**

**E6. Backfill the gradability fields into the 14 existing pilot-course banks?** 🔵 *(instructor
decision 2026-08-21: yes, all 14 weeks)*
- **Decision: backfill all 14 weeks** with `referenceAnswer`, `scoringBands` and `commonErrors`.
  Done by `tools/backfill-gradability.py`.
- **Why it is safe on a frozen bank.** The fields are purely *additive*: no `id`, `prompt`,
  `rubric` or `keyPoints` is touched, and question selection keys on the bank's contents in `id`
  order — so **which question a student draws does not change**. Existing questions keep any field
  they already have, so the job is resumable and re-running it is a no-op.
- **Why it is worth doing mid-term.** Measured payoff on the grader actually in use, and a much
  larger payoff on a small local model, which has far less background knowledge to fall back on:
  telling it what a good answer looks like is most of the difference between ranking answers
  correctly and guessing.
- **The real risk is content, not mechanics.** This is generated material that students are graded
  *against* — a wrong `commonErrors` entry actively costs marks. The tool validates shape and
  refuses malformed entries, and prints a sample, but **a human still has to read a sample of it**
  before the banks are trusted. Recorded here as an open obligation, not a completed one.

**E7. Which grader by default, and what may be said about FERPA.** 🔵 *(instructor decision
2026-08-21)*
- **Decision: `gradingBackend` defaults to `local`** — a small open-weights model bundled inside
  the autograder image, so the transcript never leaves the Gradescope container. `genai` remains
  available and is what the pilot course uses.
- **The disclosure is the point of the decision, not a footnote.** The setup wizard and the teacher
  guide both say, in these terms: Purdue GenAI Studio is on-premises and receives only the
  de-identified, PII-redacted transcript — **and it carries no FERPA certification, and OralScale
  makes no FERPA claim on its behalf.** Sending student work there is the instructor's decision and
  the instructor's risk. That is why the default is the conservative option rather than the better
  one: choosing `genai` should be an act, not an omission.
- **Each backend is the other's fallback**, and reaching the keyword heuristic is flagged loudly
  (INV-GRADE-1). The unfairness worth preventing is not a mark that is slightly off; it is two
  students who said the same thing being graded by different methods because one of them submitted
  during an outage.
- **There is no `localModel` knob any more.** `qwen2.5-3b` is the only bundled local grader: twelve
  candidates from 1.5B to 9B were measured and eleven lost, so a menu would have implied a choice
  that does not exist. The live choice is the BACKEND — Purdue GenAI `qwen3.6:27b` marks noticeably
  better, at the cost of the transcript leaving the container. See E8.

**E8. Which local model, and why not the biggest that fits?** 🔵 *(instructor decision 2026-08-21)*
- **Decision: default `qwen2.5-3b`** — originally because it was the only local model whose quality
  was measured. **Re-opened and re-decided 2026-08-31** against eleven other candidates, and the
  answer got stronger: it wins on both evaluation sets and nothing larger beats it. The old note that
  `qwen3-4b` was an "untested upgrade" was a wrong guess — measured, it is markedly blunter (32% ties
  against 15%). `genai` remains the best grader and must still be **actively selected**; on GenAI,
  `qwen3.6:27b` beats `gemma4:26b-a4b` on every metric.
- **Note on naming:** the measured model is **Qwen2.5-3B-Instruct**. There is no Qwen3-3B — the
  Qwen3 line goes 0.6B / 1.7B / 4B / 8B, which is why the upgrade candidate is a 4B.
- **The instructor asked for the largest model with 10–20% headroom.** Measured resident memory at
  a 4096-token context: 3B ≈ 2.0 GB, 4B ≈ 2.6 GB, gemma-3-4B ≈ 3.1 GB, 7B ≈ 4.2 GB; add ~0.4 GB of
  Python and runtime for the grading-phase peak. On that criterion alone the answer is a 4B (50%
  headroom) or even the 7B (23%).
- **It defaults to the 3B anyway, because measured beats bigger.** The 3B has 0 rank inversions,
  perfect consistency, correctly zeroed wrong answers, and band separation 0.94 after calibration.
  The 4B has none of those numbers — only a memory figure. Shipping an unmeasured default and
  *calling* it better would be an assertion dressed as a decision. `calibrate-grader.py` upgrades
  it in one command once someone has run it.
- **Two design decisions create the headroom**, and both are what a future change could accidentally
  undo:
  1. `transcribe.release()` frees the speech model before the grader loads, so the container's peak
     is `max(whisper, grader)` rather than their sum.
  2. Local grading is **one question per call**, so context — and therefore the KV cache — does not
     grow with `questionsPerAttempt`. Moving from 5 questions to 20 changes grading *time*, not
     memory. (Batching exists on the GenAI path for the opposite reason: a remote rate limit counts
     requests.)

**E9. Switching backends mid-term, and adjusting a whole assignment.** 🔵 *(instructor request,
implemented 2026-08-21)*
- **Decision: per-ASSIGNMENT overrides in `course.json`, driven by `tools/set-grading.js`.** Not
  per-assignment zips.
- **Why not separate zips.** The week is resolved from the Gradescope assignment title, so one zip
  already serves the whole term. A second artifact for one week is two things to keep in step, and
  the one you forget is the one that grades wrong. `gradingBackend`, `localModel` and `scoreBonus`
  all already resolve assignment → defaults, so "GenAI for weeks 1–5, local afterwards" is a
  per-assignment key plus one rebuild.
- **`scoreBonus` is the remedy knob**: points added to every submission for one assignment, applied
  *after* aggregation, capped at `maxPoints`. Uniform on purpose (a remedy that lands differently
  on different students re-creates the unfairness it repairs) and **disclosed to the student** on
  purpose (a mark they cannot account for is worse than a lower one they can). `set-grading.js`
  **refuses** a non-zero bonus with no `--reason` — enforced, not warned, because a blanket
  adjustment nobody recorded a reason for is indefensible when a student asks in week 12.
- **The GenAI key now ships only where it is needed.** `autograder.zip` holds the signing secret in
  plaintext and is readable by anyone with staff access to the course, so a credential that no
  assignment uses is pure downside — and switching the backend is exactly when one would otherwise
  be left behind. The build checks **per assignment**, so a mixed-mode course keeps the key.

## F. Surfaced by use-case / UX review

**B1b. Single- vs two-assignment Gradescope flow.**
- **Decision (2026-08-18): moot — resolved by B1.** 🔵 With a public link there is no "get link"
  step to house, so one assignment with one submission is the whole flow. The no-recording branch
  survives only to explain the mistake and hand over the B5 private code.

**C4. Offline-tolerant recording fallback.** If wifi drops mid-record, the attempt is lost.
- Best guess: **stay online; free retake on failure** (keeps strong liveness). A client-derived
  nonce schedule would tolerate offline but weakens the guarantee — not default.
- Decision: _pending_ 🟢

**T3. Auto-derive `ORALSCALE_ASSIGNMENT`.**
- **Decision (2026-08-18): DONE — the week is read from the Gradescope assignment title, with the
  env var as an override.** 🔵
- This was the single biggest source of per-week busywork: previously each week needed a
  `secret.env` edit, a rebuild, and a fresh upload. Now one `autograder.zip` serves the whole term —
  build once, upload the same file to every assignment, name the assignment after the week.
- Resolution order, most explicit first: `ORALSCALE_ASSIGNMENT` (pins a zip) → `gradescopeId` in
  course.json (numeric, survives renaming) → `gradescopeTitle` alias → the full week id in the title
  → **the quiz NUMBER in the title** → the only assignment, for single-week courses.
- The number rule is the one that matters in practice: **`Quiz 4` resolves to `week-04-…` with zero
  configuration**, so the natural Gradescope title works and no course topic has to leak into an
  assignment name. `Quiz 4 (Spring 2026)` still resolves — 2026 is not a week.
- Anything genuinely ambiguous (`Quiz 4 and 5`), absent (`Oral Quiz`) or unknown (`Quiz 10` in a
  course with no week 10) is an explicit *configuration* failure with instructor-facing text listing
  the four ways to fix it — never a guess, because guessing would grade a student against the wrong
  bank, and never a student-facing zero.
- Cross-week protection is unaffected: the certificate carries a signed `assignmentId`, so a
  week-05 recording submitted to the Quiz 4 assignment is still rejected (verified).
- `ORALSCALE_ASSIGNMENT` still wins when set, for anyone who prefers pinning one zip per week.

**T4. Class-wide flags dashboard.** Aggregate integrity-flagged submissions.
- Best guess: **use Gradescope's score/filter view** for v1; a small report tool later.
- Decision: _pending_ 🟢

**D2b. Per-student accommodation roster.** Autograder-minted links currently use multiplier 1.
- Best guess: issue accommodation links manually with `gen-url.js --time-mult`; add a roster map
  the autograder reads if demand warrants.
- Decision: _pending_ 🟢

**D2c. Full accessibility pass.** (Original text was stale: `aria-live` on banner and nonce already
shipped before this entry was written.)
- **Decision (2026-08-18): technical pass DONE; format-accommodation policy still with the
  instructor.** 🔵 (technical) / 🔴 (policy)
- **Technical pass shipped** as **INV-PLAT-4**, test `t_a11y_flow`: focus moves to the newly
  relevant element on every transition (question → review → error); the ticking timer is
  `aria-hidden` (it would flood a live region) with the 60s/15s warnings announced instead; the
  challenge code is announced assertively, atomically, and spelled out digit-by-digit; the error
  card is a `role="alert"`; decorative glyphs are `aria-hidden`; visible `:focus-visible` ring;
  `prefers-reduced-motion` disables the pulse/flash animations. Still needs a real screen-reader
  run on device (VoiceOver/TalkBack) — automated checks are static assertions on markup + logic.
- **Policy question — needs David + Purdue DRC.** For a student who cannot use a spoken format at
  all, three options, in order of how well they preserve what the assessment measures:
  1. **Live oral with the instructor/TA over Zoom or office hours.** Same construct (unassisted
     real-time explanation), no code needed, doesn't scale past a handful of students — which is
     fine, since this accommodation is rare. *Recommended default.*
  2. **Typed real-time explanation with the same liveness structure.** Same frozen bank, same
     server-timed window, rolling challenge codes typed rather than spoken, keystroke timing in
     place of word timestamps. Preserves "unassisted and real-time" but is a genuine build
     (new capture path + new validator) and is weaker against a second person typing.
  3. **Written response with an oral-free rubric.** Cheapest, but it's the exact proxy the whole
     course redesign argues AI has broken — it does not measure the same thing. Use only if 1 and 2
     are both unavailable.
- Note options 2 and 3 change *what is measured*; option 1 doesn't. That's the argument for
  defaulting to 1 and treating the rest as fallbacks.

---

## R — Pilot release (decided 2026-08-22)

**R1. Course content separated from the engine. DECIDED — three repositories.**
The 14 banks were in all 41 commits of the engine repo, so deleting files would not have hidden
them from anyone who clones. Course content now lives in its own private repository per course:

| Repository | Contents |
|---|---|
| `inouye-lab/oralscale` | Engine. Private for the pilot, MIT-licensed to invited faculty. |
| `<private-org>/oralscale-<archive-course>` | The backfilled historical banks. |
| `<private-org>/oralscale-<pilot-course>` | Live course + Oral Quiz 0. |

Formalised as INV-COURSE-1/2/3 with `t_course_locality`.

**R1b. `courseId` was NOT renamed.** `example-fall2026` stays. It is an HMAC input for student
identifiers and access keys (`server/lib/protocol.js:433-449`), so renaming it would silently
invalidate every quiz key already minted. Repository names may differ from `courseId`; only
`courseId` is load-bearing. **Anyone tempted to tidy this later: don't.**

**R2. Bank provenance relabelled. DECIDED.** The banks were generated from **an earlier course's**
lecture content (`docs/curriculum-analysis.md:21`) but every header claimed the pilot course. They
are now labelled as historical archive content, with a `provenance` block. Question text
unchanged. The pilot course starts fresh, from Fall 2026 material.

**R3. Un-backed-up course folders warn, and keep warning. DECIDED.**
`tools/lib/course.js:warnIfUnbacked()` warns when a course folder is not a git repository with a
remote — including when it is merely tracked inside the engine repo, which is the case the split
exists to prevent. Permanent opt-out via `ORALSCALE_ACK_COURSE_UNBACKED=1`, and nothing else.
- *Why a repeating nag rather than a one-time notice:* the two failures it guards against are
  losing a semester of authoring to a dead laptop, and leaking a bank. Both are unrecoverable and
  neither announces itself. A notice you can dismiss by pressing enter is a notice that gets
  dismissed by pressing enter.

**R4. Licence: MIT, © 2026 David I. Inouye. DECIDED by the instructor.**
With a non-binding acknowledgement request in the README, which is ordinary academic practice and
deliberately not a licence condition — adding conditions is exactly what raises adoption friction.
- **Open, parallel, non-blocking:** Purdue's IP policy may govern ownership of software developed
  with university resources. Worth putting to OTC or the Copyright Office before any *public*
  release. It does not block a private pilot shared with named colleagues.

**R5. Private repository, MIT-licensed. DECIDED — not a contradiction.**
The licence governs what recipients may do; publication timing is a separate decision. Students
should not be able to read the integrity mechanism while it is grading them.

**R6. Public version starts at `0.1.0-alpha.1`. DECIDED.**
`package.json` said an unpublished `0.2.0`, so this is formally a downgrade. Accepted deliberately:
nothing was ever published under `0.2.0`, and "this is version 0.1" is the honest story. Internal
`v7.x` labels retire into `CHANGELOG.md` as history.

**R7. Student-app footer carries no repo link and no version. DECIDED.**
`Open source under the MIT License. Created by David I. Inouye.` — muted, linking to
davidinouye.com. No source link, because the page is student-facing; no version string, because
students do not file bug reports. Version belongs in instructor-facing output.

**R8. Accommodations are handled case by case during the alpha. DECIDED — not a release blocker.**
The pilot is a small pretest with specific, named faculty, all of whom already handle accommodations
for their own assessments through their own institutional process. Prescribing one alternative
format before seeing a single real case would be guessing.

So: extended time is supported today; anything further is worked out by the instructor, the
student, and a disability services office, as it arises. D2c above sets out the three options and
their trade-offs, with the live-oral-over-video option recommended as the default because it is the
only one that preserves what the assessment measures.

- **Instructors are explicitly invited to propose solutions**, in `DISCLAIMER.md`, `README.md` and
  `docs/guides/PILOT-PACKET.md`. This is the productive framing: the general answer should be derived from
  real cases, and a solution that works two or three times is what earns its way into being a
  supported feature.
- **Still on the list, just not blocking:** the Purdue DRC conversation, and a decision on whether
  option 2 (typed real-time variant) is worth building. Revisit once the pilot has produced actual
  cases — see `docs/project/PARKING-LOT.md`.

**R9. CI runs against the demo course only. DECIDED.**
`test:banks` and `test:course` pointed at `courses/example-fall2026`, which no longer ships, so the
gate could not have run on a clean checkout. Both now target `courses/demo`, and
`courses/_shell-for-testsuite/` supplies the fourteen-week structure the assignment-resolution tests need.
Formalised as INV-COURSE-3.

---

## R10 — Extended-time accommodations (decided 2026-08-24)

**Can the autograder read DRC accommodations from Gradescope? NO — verified, not assumed.**

- `submission_metadata.json` documents exactly: `id`, `created_at`, `assignment`
  (`due_date`, `group_size`, `group_submission`, `id`, `course_id`, `late_due_date`, `release_date`,
  `title`, `total_points`), `submission_method`, `users` (`email`, `id`, `name`), and
  `previous_submissions`. **No accommodation, extension, time-limit or multiplier field**, and the
  dates are assignment-level rather than per-student.
- **There is no official public Gradescope REST API.** Integration is LTI 1.3 (roster and grade
  sync) plus the autograder framework. A public API is a published feature request, not a product.
- Unofficial scraper libraries exist. **Rejected**: they need instructor credentials, and the
  autograder zip carries the signing Secret in plaintext and is readable by anyone with staff
  access to the course. Putting Gradescope credentials in there would be handing out an
  account, not reading a field.

**So: the Student claims, and we audit afterwards.** Gradescope stays the single source of truth.
The alternative — a second place to maintain accommodations — would drift, and drift lands on the
student as a flag for something they did not do.

**REVISED 2026-09-02 (instructor decision): the audit moved OUT of the autograder.** Verifying in
the container required bundling a roster of who holds an accommodation into the zip, which is
uploaded, cached and replicated — for a check needed at most once per quiz. The autograder now only
NOTES a claim and assumes it correct (INV-PRIV-6); `tools/audit-accommodations.js` does the same
join on the instructor's own machine, and refuses to run for an AI assistant or in CI.

**The fairness rules, which are the whole design (INV-ACCOM-2):**

| Situation | Outcome |
|---|---|
| No selection | Nothing. Never looked up. |
| Selected ≤ granted | Silent. |
| Selected > granted, answered within the real grant | **Note, not a flag.** Nothing was taken. |
| Selected > granted **and** used more | Reported for review. **Score unchanged.** |
| No roster bundled | Unverified — a statement about our records, not the student. |

Every path fails safe towards the student, and no path changes a score.

**Deliberate choices worth not re-litigating:**
- **Off-ladder claims are refused, not clamped.** Silently granting less time than asked for
  surfaces as a countdown dying mid-sentence — the worst moment to learn the claim was ignored.
- **The selection is not remembered between attempts.** A stored "2x" reapplying months later
  would be a claim the student did not make that day.
- **Grants above 2x are recorded at the 2x cap, never dropped.** Whatever such a student selects is
  within their grant, so the cap can never flag them; dropping the row would do the opposite. The
  delivery gap is real and is surfaced at build time instead.
- **The grant's own buffer counts towards the allowance**, so a student is never faulted for the
  "finish your sentence" slack they were legitimately given.

**R10b. An unverified claim is ASSUMED CORRECT (instructor decision, 2026-08-24).** It grades
normally, the score is untouched, the student is told plainly that it could not be confirmed, that
the instructor has been told, and that their score is unaffected. The instructor gets a review flag
and an email.
- **Why the default falls towards the student.** Our copy of the roster is the thing most likely to
  be wrong — a grant added after export, or recorded at course level. Wrongly withholding an
  accommodation lands on the person least able to absorb it. Verification prompts a human; it does
  not adjudicate.
- **The student is never told a promise the system did not keep.** The wording tracks whether the
  email actually sent; unsent degrades to "flagged for your instructor", true either way.

**R10c. The multiplier is NEVER stored on the server (instructor requirement, 2026-08-24).** Not in
a table, not in a key, not in a log. The Signer is told it, computes a deadline, and drops it. It
exists at rest only in the signed Certificate, inside the student's own submission to Gradescope.
- **Stricter than the "no PII" rule that governs the rest of the system, on purpose.** The
  multiplier names nobody and would have passed that bar. Disability status is simply the wrong
  thing to keep in an edge database at any linkability.
- Enforced by `t_accommodation_not_persisted`, verified to fail by adding a `time_multiplier`
  column and watching it go red. Notification email is a pointer, never a copy.

**R10d. 2x remains the maximum (instructor decision, 2026-08-24).** No student has been seen with
more. The roster tool records a larger grant at the 2x cap so such a student can never be flagged,
and tells the instructor at build time to arrange the remainder directly.

---

## R11 — Boundary codes shortened to four digits (decided 2026-08-24)

**Six → four.** The design principle is that every digit is one more thing a nervous person has to
read correctly on a recording, so the pressure is downward: as short as it can be while the
property still holds.

**Three was measured and rejected.** The instinct was that the one-error tolerance would cover a
short code. It does the opposite — the tolerance is what breaks it. `code_spoken_in` allows one
Damerau-Levenshtein edit over windows of length `L-1 … L+1`, so a 3-digit code is accepted by **any
two of its three digits appearing in order**. Against digits that merely occur in a student's
answer (20,000 trials):

| noise digits in window | 5 | 10 | 20 | 40 | 80 |
|---|---|---|---|---|---|
| 3 digits | 12.8% | 26.2% | 48.3% | 74.6% | 93.4% |
| 4 digits | 1.4% | 4.0% | 9.1% | 17.9% | 33.5% |
| 5 digits | 0.1% | 0.5% | 1.2% | 2.6% | 5.7% |
| 6 digits | 0.0% | 0.0% | 0.1% | 0.4% | 0.7% |

**Tightening the matcher instead was also measured, and is worse.** Disallowing the shortened
window rejects 100% of honest students whose transcript drops a digit; tolerance 0 rejects 90% of
substitutions and 100% of drops. A dropped digit is exactly what the rescue pass (INV-INTEGRITY-9)
exists to catch, so the tolerance has to stay and length is the only lever.

**Four holds because all N+1 boundaries must match.** A pre-recorded answer reciting random digits
at every boundary of a 5-question attempt:

| digits recited per boundary | 30 | 60 | 120 |
|---|---|---|---|
| 4 digits | 5e-06 | 5e-04 | 1e-02 |
| 6 digits | 6e-18 | 4e-16 | 2e-11 |

120 digits inside a 15-second window is eight a second. Not a thing a mouth does, and audibly
absurd to an instructor playing the recording.

**Open:** if a course turns out to have students who habitually recite long digit strings while
explaining (a numerical-methods course reading off matrices, say), 5 is the next rung and costs one
digit. The measurement script is worth re-running per course before assuming 4 fits.

---

## R12 — No grader fallbacks (decided 2026-08-24)

**The course names a grader; that grader runs, or the submission is not graded.**

The previous design fell `genai → local → keyword`, flagging each step. Its stated justification
was: *"the unfairness worth preventing is not a mark that is slightly off; it is two students who
said the same thing being graded by different methods because one submitted during an outage."*
The chain then did exactly that. A weaker grader is not a smaller version of the same measurement —
it is a different measurement, and which one a student received came down to timing. Flagging
recorded the unfairness rather than preventing it.

**What happens instead:** nothing is graded, no score is produced, the instructor gets
`REGRADE REQUIRED` naming backend and reason, and the student is told plainly that their recording
passed every check, that they need not resubmit, that they will not be marked down, and where to
ask (`supportChannel`, default Piazza).

**Failing hard is the recoverable option.** An ungraded submission is visible and the instructor
regrades everyone affected together, with one grader. A submission silently scored by keyword
matching is neither visible nor recoverable — nobody knows to look.

**Consequences worth keeping:**
- A `genai` course no longer bundles the local model: with no fallback it could never be used.
  That removes 2 GB, a `llama-cpp-python` build that fails outright on Gradescope's base image, and
  several minutes from every image build.
- A grader is only required when there is something to grade. An attempt whose answers were all
  refused for prompt injection needs no backend, and demanding one would fail a submission over a
  grader that was never going to be asked to do anything.

**Open:** `heuristic` remains a *choosable* backend for testing and for an instructor with neither
a key nor room for a model. It is never reached automatically.

---

## R13 — Alpha Release Pre-Flight Decisions (decided 2026-08-25) 🔵

**1. Default Grader Backend:**
- **Decision:** Default grader is **local Whisper (`small`) + local Qwen (`qwen2.5-3b`)**.
- **Rationale:** 100% zero-network evaluation inside the Gradescope container, strictly preserving student FERPA boundaries without requiring external API keys. Purdue GenAI Studio remains an opt-in alternative per course.

**2. Instructor Notifications:**
- **Decision:** Disabled by default (`ORALSCALE_NOTIFY_ENABLED=0`).
- **Rationale:** Sending outbound email regarding accommodation reviews via third-party mail relays presents potential FERPA record disclosure concerns. Unverified accommodation claims remain surfaced within Gradescope submission test output for instructor inspection.

**3. Repository Separation:**
- **Decision:** Main public repository (`oralscale`) holds the open-source engine, web app, tools, and starter demo bank. Live course banks and production secrets reside in separate private course repositories (e.g. `oralscale-courses/<course>`).

---

## R14 — Final instructor release decisions (decided 2026-08-25) 🔵

**1. The pilot course stays at five questions and deliberately uses Purdue GenAI.** The engine and setup
default remains the local grader. The pilot course explicitly opts into `genai` even though GenAI Studio
carries no FERPA certification; that is the instructor's course-specific decision under E7.

**2. Preserve an uncertified recording after `/finish` fails.** A complete non-empty recording is
downloadable as an unmistakable UNCERTIFIED BACKUP. It has no Certificate, scores 0 automatically,
is never content-graded, and is flagged for instructor review. The student is strongly encouraged
to make a fresh certified attempt; if that is impossible, staff may manually override after
listening and reviewing the circumstances. This is evidence preservation during rollout, not a
weaker authentication path (INV-INTEGRITY-7).

**3. Autograder artifacts live beside their courses, but never in git.** Packaging writes
`courses/<courseId>/dist/oralscale-autograder-<courseId>-v<version>.zip`. The course-bound name
prevents uploading the wrong course's artifact; the ignored `dist/` matters because each zip
contains the signing Secret and may contain a GenAI key in plaintext (INV-DEPLOY-2).

## R15 — One autograder per assignment; nothing is inferred (decided 2026-08-28) 🔵

**Decided and implemented: a zip grades exactly the assignment it was built for. All six inference
rules are removed** (INV-DEPLOY-3).

The chain that existed — `ORALSCALE_ASSIGNMENT`, `gradescopeId`, `gradescopeTitle`,
`gradescopeTitleContains`, the id inside the title, a week number in the title, "there is only one"
— began as convenience and became the defect:

- **It made a superficial property load-bearing.** A Gradescope title is presentation to everyone
  who has not read the source. Renaming an assignment could silently change which bank a submission
  was graded against.
- **A wrong guess produces a score, not an error.** Nothing to notice, nothing to go looking at.
- **It was week-shaped** (`week-04-…`, "Quiz 4"), and plenty of courses number nothing.
- Rules could disagree, so it needed conflict detection — machinery whose whole purpose was to
  notice the guessing going wrong. Deleting the guessing deleted that too.

**Pinning is not less flexible, only more honest.** Changing which assignment a Gradescope
assignment grades has *always* required rebuilding and re-uploading, because the bank lives inside
the zip. The title only looked like a control.

### What replaced it

`npm run package -- <course.json> --zip` writes **one zip per assignment** into
`courses/<courseId>/autograders/`, named `<courseId>-<assignmentId>-oralscale-v<version>.zip`.
Upload the one whose filename matches; title the Gradescope assignment anything.

- **The filename is the safety mechanism.** With nothing inferred at grading time, the file states
  what it grades — so uploading the wrong one is a visible mistake when you make it, not a
  plausible score weeks later.
- **Each zip carries only its own bank**, so a quiz-1 autograder cannot leak quiz-14's questions and
  reference answers. This repository once shipped fourteen banks from another course; one assignment
  per zip makes that structurally impossible instead of something a build step must remember.
- **An assignment that cannot be packaged is skipped with a warning** — no bank, an empty or missing
  bank, no `limitSec` — so a half-written week 12 does not stop weeks 1–11 shipping.
- **A zip that does not say what it grades does not grade.** Including the case where the course has
  exactly one assignment: the "only one" fallback is gone too, so the unambiguous case cannot
  quietly re-teach the system to infer.

### Why this does not cost flexibility (the Gradescope check that settled it)

Checked rather than assumed: **Gradescope duplicates assignments including the autograder
configuration**, at assignment and at course level. So "one zip per assignment" does not mean
configuring each from scratch — duplicate, then swap the zip.

That same finding is why *inference* was the wrong answer. Duplication is the path of least
resistance, so many assignments sharing one zip is where instructors land **by default**, including
across terms when a duplicated course carries last term's zip forward. Under the old scheme a
duplicated assignment inherited `ORALSCALE_ASSIGNMENT` from inside the zip and silently graded week
5 against week 4's bank. Now the filename makes the swap obvious, and the certificate check catches
it if the swap is forgotten.

### The bad path is closed at grading time too

The certificate names the course and assignment it was issued for. Both are checked against the zip,
and every question id must exist in the bundled bank. A mismatch scores 0 with an instructor flag
naming both sides — so uploading the wrong zip, or a student uploading last week's `.zip`, cannot
produce a grade against the wrong bank.

The `courseId` check was added here and is not redundant with the signature: two courses still on
the legacy shared secret verify each other's certificates perfectly well, and assignment ids collide
readily across courses.

---

---

_Append new questions below as they arise during the build._


## Public guide release (2026-09-11)

- **Best guess, proceeding:** an overview at `/oralscale/` and separate Student/Faculty pages,
  with two-page Letter downloads (Quickstart, then FAQ). Single shared content and CSS produce
  HTML and PDF. Portable static files integrate with the existing website without theme changes.
- **Public GitHub URL:** leave the public link unset until release is approved; say it is planned.
- **Faculty audience:** teaching workflow first; acknowledge that initial setup needs a technical
  partner. Do not invent a faculty dashboard or a no-code installation process.
- **Governance:** INV-DOC-1 requires mapped FAQ/source review, synthetic app screenshots,
  regeneration receipts, and explicit editorial acknowledgement. Hashes request review, not
  automatic rewriting. External Gradescope claims also have a six-month review limit.
- **Publication:** local preparation only. No push or deployment is authorized in this task.

### Public guide revision 1.1 (2026-09-11)

User decision: continuous HTML with print-specific page framing only in PDF; general private key
distribution; prioritize approved extended time; describe de-identified model assessment separately
from local Gradescope identity validation and grade assignment. Privacy wording names the quiz
server specifically, since Gradescope itself receives the uploaded audio. Accommodation approval
remains instructor-verified against Gradescope records, not automatically verified by the grader.

### Public guide revision 1.2 (2026-09-11)

- **Decision:** 🔵 Faculty use an AI coding agent to launch their own demo course, Cloudflare
  website and Gradescope autograder before building a real quiz. No technical partner or
  prewritten questions are prerequisites. Account authorization and teaching judgments remain
  with the instructor. Plain chat can guide but needs execution tools to perform setup.
- **Question design:** start from faculty materials; have AI interview for learning goals and
  exclusions, draft representative samples, then generate a large grounded bank for review.
- **Public URL:** use https://github.com/inouye-lab/oralscale now at the user's request, even
  while private; verify anonymous access before publishing. This supersedes the original
  unset-link decision and does not authorize changing repository visibility or pushing the site.

### Public guide revision 1.3 (2026-09-11)

- **Decision:** 🔵 Lead faculty setup with the starter prompt immediately after prerequisites.
- Explain manual or instructor-run local accommodation auditing, with no approval-list upload
  into the autograder. Preserve INV-ACCOM-2: unsupported claims flag only if excess time was
  used; human review, no automatic grade change. No restricted audit material accessed.
- Instructor privacy reminder covers FERPA and institutional rules. Delete local audit copies
  after review subject to retention obligations; this is not a claim that deletion itself
  guarantees compliance or that the guide can waive anyone’s legal obligations.

### Public guide palette (2026-09-12)

- **Decision:** 🔵 Plum/apricot on white, charcoal body copy and deep-plum headings. Student
  accents plum; Faculty accents dark burnt apricot. Mix secondary panels but preserve the
  shared typography, layout and labels. Apply equally to HTML and PDF.
- Website main menu: OralScale immediately after Teaching.

### Points scoring and the false-claim penalty (2026-09-12, INV-GRADE-10)

- **Decision (instructor):** 🔵 Judge each point (`stated` / `partly` / `absent` /
  `contradicted`) and compute the band in code. Required points are worth 2, optional 1. Thresholds
  sit relative to the required total: +0 partial, +1 strong, +2 full.
- **Decision (instructor):** 🔵 An uncorrected wrong statement is a *penalty*. A contradicted
  point subtracts its weight **and** caps the answer at `partial`. Both apply, so contradicting a
  point counts twice. That is intended. It is the first knob to soften (`falseClaimCap: "full"`)
  if Quiz 3 data shows over-flagging.
- **Decision (instructor):** 🔵 Self-correction within the answer is never penalised; only the
  final position is judged.
- **Best guess:** penalties require a quoted span of the student's words, or they are not applied.
- **Decision (instructor):** 🔵 Students get narrative feedback, not a breakdown. It covers what
  was right, any uncorrected false claim and the correct idea, and what the question was getting
  at. Optional ideas are framed as things that would have strengthened the answer, even at full
  marks. The feedback never shows points, a rubric or "required"/"optional". Verdicts stay in the
  instructor detail.
- **Decision (instructor):** 🔵 The pilot course defaults to points from Quiz 3 on. Quiz 0–2 are pinned to
  bands.

### Public-guide review blocks releases, not commits (2026-09-12, INV-DOC-1)

- **Decision (instructor):** 🔵 The guide review gates only an official release.
  `npm run test:guides` is advisory on commits and pushes to main: it lists drift as suggested
  updates. `npm run test:guides:release` is blocking, and CI runs it on `v*` tags. Structural
  errors still fail in both modes. The FAQs are kept high-level, so spec changes rarely falsify
  them; a per-commit sign-off was friction without protection.
