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

**E1. Multi-course support.** Must be portable to other courses; start with the pilot course.
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

### The curve, and credit for points nobody listed (2026-09-15, INV-GRADE-9/10)

- **Decision (instructor):** 🔵 From Quiz 3 on the bands no longer price the mark. Points are summed
  (core 2, supporting 1, half for `partly`) and read off a curve:
  `0 / 0.70 / 0.85 / 0.90 / 0.92 / 0.95 / 0.97 / 1.00` for 0…7+ points, a total between two entries
  taking the lower. **One core point alone is 0.85**, both are 0.92, and the rest of the scale is
  depth. Why: a student who answers correctly, even simply, should be at a good mark, and the top
  of the scale should measure how strong the answer was rather than how much of our list they said.
- **Decision (instructor):** 🔵 The listed points are **validated, not exhaustive**. The grader is
  asked separately for substantive, correct points the student made that are on neither list — an
  example of their own, or a correct route the bank did not anticipate — worth 1 each (half if
  half-developed), capped at **3 per answer**. A `wrong` one is a false claim. Unquoted novel points
  count neither way. Why: a key-point scheme otherwise rewards reciting our sentences, and the cap
  exists because a grader that can invent credit can be talked into inventing it.
- **Decision (instructor):** 🔵 An uncorrected false claim caps the answer at **0.85** — on a curve
  this flat, the −1 alone would make a confident misconception cost a tenth of a mark.
- **Decision (instructor):** 🔵 An answer conveying **no core point** is capped at **0.70**, so
  supporting and novel credit can never substitute for answering the question.
- **Decision (instructor):** 🔵 Students are **not** told which listed ideas they did not mention.
  This reverses the 2026-09-09 rule: the list read as a tally of what they lost, and several points
  are not derivable from the prompt, so it taught recitation. The record stays instructor-only.
- **Decision (instructor):** 🔵 **Quiz 2 is to be regraded** under the new scheme with a
  **never-lower** guarantee (each student keeps the better of their recorded mark and the new one).
  Quiz 0 and 1 stay on bands. Open: the regrade is a rerun of a non-deterministic grader, so the
  never-lower comparison has to be applied from the recorded marks, not assumed.
- **Best guess:** bank authoring adds one rule — write `keyPoints` so that any one of them, said
  correctly, is already a sound if simplified answer. Points that are meaningless apart are one
  point. `validate-bank.js` still warns above four.

### A `partly` is half but rounds up, and the Quiz 2 regrade is frozen (2026-09-16)

- **Decision (instructor), superseded within the day:** 🔵 `partlyFactor: 1`, pricing a `partly` as
  a whole point. Reverted because it made an answer that gestures at every point score exactly what
  a crisp one does — more thumb on the scale than intended.
- **Decision (instructor):** 🔵 **`partlyFactor` stays 0.5 and `curveRounding` is `"up"`.** A total
  between two rungs takes the higher one. This makes a half-made point *optimistic* rather than
  pessimistic without making it free: two partly-made core points still total 2 and buy what one
  whole core point buys, so vagueness still costs, but 3.5 → 0.92 and a lone `partly` can never
  round away to nothing. Rounding down was the real problem — a 0.5 total was indistinguishable
  from silence, while the feedback told the student the grader had seen something.
- **Decision (instructor):** 🔵 The Quiz 2 `curve-v2` regrade zip is **frozen**
  (sha256 `f7c6f243b89a10ae…`): every submission is being re-marked against it, so `--regrade`
  now refuses to rebuild it without `--repackage-frozen`. It predates `partlyFactor` and therefore
  prices a `partly` at half. That divergence from Quiz 3 is deliberate — a regrade in flight must
  not be re-cut to pick up a later change, because half the cohort would be marked by other code.
- **Open:** the never-lower comparison for Quiz 2 is still manual. The zip cannot know the marks
  students already hold.

### Quiz 3 was ungraded, and how much context a small grader is given (2026-09-17)

- **Observed.** The released `quiz-03` zip (backend `genai`) graded **nothing**. Of the first four
  submissions: two failed with repeated read timeouts and HTTP 400 rate limits from
  `genai.rcac.purdue.edu` (one logged 4 throttled replies and 4.9 min of backoff before its
  deadline passed), one crashed the container outright, and one failed integrity on a boundary code
  that was never transcribed. INV-GRADE-1 turned all of that into `REGRADE REQUIRED` and a 0 in
  Gradescope rather than a quiet fallback, which is correct and is also why four students currently
  hold a zero they did not earn.
- **Decision (best guess, proceeding):** 🟢 Build a **regrade variant** —
  `regrade: {id: "local-qwen", gradingBackend: "local"}` — rather than flipping the course over.
  A second zip under its own name grades the whole cohort with one grader and leaves the released
  artifact alone. `--regrade` was scoring-only until now; it accepts `gradingBackend` as of this
  change (INV-DEPLOY-6), and the override is applied *before* the build environment is derived so
  the zip that asks for the local model is the zip that carries it.
- **Decision (instructor, 2026-09-17):** 🔵 The variant zip is **built but not uploaded**. Decide
  once the marks it produces can be compared against what GenAI would have given. The local model
  marks more harshly, so regrading Quiz 3 this way puts it on a different scale from Quiz 1 and
  Quiz 2 — the same commensurability problem the Quiz 2 regrade raised.
- **And it is not ready anyway.** 🔴 Measured over 24 answers, the local grader marked **every
  optional point `absent`** — 72 of 72 — including on answers that state all three `bonusPoints`
  nearly verbatim. On this bank it therefore caps every student at 0.92 and cannot reach the
  curve's 0.95/0.97/1.00 rungs at all. It also returns the bank's own `keyPoints` wording as
  `evidence` rather than the student's words, which defeats the checkability INV-GRADE-10's
  quote requirement exists for. Fix both before this zip grades anyone.

**G. How much context does the grader get per question?** The bank is far richer than either
grading prompt reads. Every `quiz-03` item carries `rubric`, `keyPoints`, `bonusPoints`,
`referenceAnswer`, `scoringBands`, `commonErrors` and an `evidence` array of verbatim lecture and
slide quotes — and **points mode sends only the prompt, the rubric, the point list and
`commonErrors`**. `referenceAnswer`, `scoringBands` and `evidence` reach the model on the *band*
path and not on the curve, which is the path Quiz 3 onward actually uses.
- This matters most to the small local model, and `localmodel.py` already has the measurement:
  removing the rubric, `commonErrors` or the bank's band text made it *worse* (MAE 0.327 and 0.297
  against 0.117). The bank's richness earns its keep, and points mode is currently not spending it.
- **Decision (instructor, 2026-09-17):** 🔵 Add **`referenceAnswer` and `evidence`** to the points
  prompt, and measure `referenceAnswer` alone before `referenceAnswer` + `evidence` so each field's
  contribution is separable. Implemented as `localmodel.bank_context()`, a single hook the
  benchmark substitutes, so the comparison is the only thing that differs between runs.
- **Decision (instructor, 2026-09-17), superseding the commensurability worry:** 🔵 **The two
  prompts MAY diverge, and the local one may be significantly richer.** The fairness property
  INV-GRADE-1 protects is that every submission for an assignment is graded by the **same**
  backend — so no student is ever measured against another by a different grader, and two backends
  worded differently is not unfairness but two graders, only one of which runs on a given quiz.
  The remote 27B can be trusted to know what a good answer looks like; a 3B cannot, and should be
  told more.
- **Measured, 2026-09-17: it helps, and the win is in RELIABILITY rather than in accuracy.** 🔵
  `tools/eval/points-bench.py`, 102 constructed answers per arm, same fixtures, same model, the
  only difference being the two fields:

  | | bare | + `referenceAnswer` + `evidence` |
  |---|---|---|
  | `readable` | 91.2% | **96.1%** |
  | false claims caught | 4/6 | **6/6** |
  | `scoreErr` (signed) | +0.049 | **+0.013** |
  | `messyCost` | +0.000 | **−0.016** |
  | `under` / `over` | 0.0% / 47.7% | 0.2% / 48.0% |
  | `optCredit` | 100% | 100% |

  Verdict accuracy is unchanged (`exact` 52.3% against 51.8%, `over` within half a point). What
  moves is everything around it: **half the unreadable replies disappear** — which under
  INV-GRADE-1 is half the lost submissions — every planted misconception is caught instead of two
  thirds, the marks land closer to what the answers earn, and the messy twins stop costing anything
  at all. For 219 tokens and no memory (K), that is a clear buy.
- **Why reliability rather than accuracy is the plausible mechanism:** the extra text does not teach
  the model to discriminate between points — nothing did, see the capability limit below — but it
  does give it a worked example of what a good answer to THIS question looks like, and something to
  check a suspected falsehood against. Both are jobs a 3B has no background knowledge for.
**H. The optional-point framing.** 🔵 **Decision (instructor, 2026-09-17): take the scoring out
and still ask for the judgement.** `points_block` labelled optional points "validated depth beyond
what was asked — judge them the same way; an absent one is never a fault". Every clause is about
what the points are WORTH, addressed to a model rule 5 has just told it does not choose the grade,
and it read as permission to skip them. Now: "validated exactly like the core points, and judged by
exactly the same test — did the student convey this idea?"
- **The INV-GRADE-9 guarantee is not weakened**, because the prompt was never what enforced it:
  `optionalWeight` is added and never subtracted, so an absent optional point cannot lower a mark
  whatever the model is told. The guarantee lives in the arithmetic. INV-GRADE-9's "both graders are
  told" clause applies to BAND mode, where the grader picks the band and the statement is
  meaningful; in points mode it is noise at best.

**I/J. A points-mode evaluation, with fixtures.** 🔵 **Decision (instructor, 2026-09-17): build it,
and build it properly.** Every harness in `tools/eval/` measured BAND mode and ORDERING, by
degrading a `referenceAnswer` into full/partial/weak/none. That does not transfer: there is no way
to degrade an answer into a known *vector* of per-point verdicts. New:
- `tools/eval/points_fixtures.py` builds answers UP from a chosen subset of a question's own
  points, so the correct verdict for every id is known by construction. Points are rewritten into
  student voice (bank framing stripped, contractions, spoken lead-ins, clauses reordered) rather
  than pasted, because pasting would measure string matching and flatter any grader.
- **Clean and messy twins.** Every case is generated twice with identical content: once fluent,
  once as a real transcript — fillers, false starts, a corrected slip, and the errors Whisper
  actually makes on this material (spoken maths, split and merged words, homophones). The pair is
  the measurement: any gap between their marks is the grader penalising *speech*, which INV-GRADE-3
  forbids and nothing previously measured.
- **`contradicted` is not synthesised by negation.** Mechanical negation produces ambiguity as
  often as contradiction, and a fixture whose own label is doubtful measures nothing. False-claim
  cases assert one of the bank's `commonErrors` instead — a wrong belief the course author has
  already certified.
- `tools/eval/points-bench.py` reports **`under` and `over` separately** (INV-GRADE-11), plus
  `optCredit`, `messyCost`, false-claim catch rate, and signed score error against the mark the
  constructed vector earns under the course's own curve.

**K. Does the enriched prompt fit, and what does it cost in memory?** 🔵 **It fits, and it costs
no memory at all.**

- **Memory does not depend on prompt length.** llama.cpp allocates the KV cache for `n_ctx` when
  the model loads, so filling 2,205 tokens of a 4,096-token window costs exactly what filling 1,986
  does. Adding `referenceAnswer` and `evidence` therefore changes **time**, not **memory**, and
  E8's measured 2.07 GB peak — taken at `n_ctx=4096` in a Gradescope-shaped container — is
  unaffected. Nothing needs re-measuring, and the 4 CPU / 6 GB container setting stands.
- **What the window itself costs, if it ever needs to grow.** Measured here by loading the same
  GGUF with one slot and with four: 2.155 GB against 2.69 GB, so a 4,096-token KV cache is about
  **180 MB**, or ~45 MB per 1,024 tokens. Going to `n_ctx: 6144` would cost ~90 MB against 66%
  headroom. Cheap — but not needed, which is the better answer.
- **On a Gradescope container**, nothing changes: one slot, in-process `llama_cpp`, `n_ctx=4096`,
  one question per call (E8), so the footprint is flat in `questionsPerAttempt` as before. If the
  window is ever raised, re-measure with `tools/eval/model-study.py`, which reads the kernel's own
  `VmHWM` rather than estimating.

**K (context budget).** 🔵 **Fits, with room.** Measured against the real tokenizer
rather than estimated: the bare points prompt is **1,986** tokens and its reply **302**; adding
`referenceAnswer` + `evidence` costs **+219** tokens of prompt (2,205) and the reply gets slightly
*shorter* (269). Against `n_ctx: 4096` that is ~1.6k of headroom, and even the bank's longest
question with a long answer and the full 1,200-token reply cap stays under. **No `n_ctx` change, so
E8's 2.07 GB peak and the 4 CPU / 6 GB container sizing stand.** An earlier estimate in this file
said the opposite; it divided characters by 3.6, and the real ratio on this structured text is ~4.6.
- **Caching the context at build time — asked, and it is the right instinct aimed at the wrong
  resource.** A KV prefix *can* be reused, and the ~1,470-token system prompt is identical on every
  call, so llama.cpp re-prefills it 5 times per submission for nothing. But that is **time**, and
  memory was the thing under pressure — and a cached prefix would *add* memory, not save it, since
  it has to be held. Worth doing as a speed optimisation if grading ever runs close to the
  Gradescope timeout; not worth doing for the reason it was asked. The per-question text differs
  every call and grading is one question per call by design (E8), so nothing beyond the system
  prompt is shareable.
- **A pre-compressed context field in the bank — considered and rejected.** It would put a
  *paraphrase* of the course's words in front of the grader, and the entire value of `evidence` is
  that it is **verbatim and verified against the source**; a summary of it is just a worse `rubric`,
  which the bank already has. It would also add a bank field that can silently drift from the
  lecture it claims to compress, with nothing to check it against — `evidence` can be re-verified
  against the transcript, and a summary cannot. The measured cost of the real thing is 219 tokens
  and no memory, so there is nothing to compress away.

**L. May the two prompts diverge?** 🔵 **Yes** — see the decision recorded under G.

**M. Per-backend calibration.** 🔵 **Allowed, and probably unnecessary.** The instructor's
position: with points mode the code does the arithmetic, so a grader that judges each point
correctly needs no calibration at all. Calibration is a patch for a model whose *numbers* are
skewed, and this design took the numbers away from the model on purpose. Reach for
`calibrate-grader.py` only if a measured, persistent skew survives the prompt work.

### Positive mistakes beat negative mistakes (2026-09-17, INV-GRADE-11)

- **Decision (instructor):** 🔵 **A grading mistake must fall the student's way.** Credit for
  something not quite earned is an acceptable error; a mark taken off work that *was* earned is
  not. Where a choice is genuinely uncertain — a verdict, a threshold, a rounding rule, an
  unparseable reply, a penalty on thin evidence — it resolves in the student's favour. The
  instructor's framing: *"aim to have negative mistakes low while positive mistakes are okay"*, and
  *"I'd rather give a better grade than penalize students for mistakes in grading."*
- **Scope: the whole project, not one knob.** Written up as INV-GRADE-11 in
  [models/02](../../models/02-requirements-and-invariants.md) and as a rule in
  [AGENTS.md](../../AGENTS.md), so it steers future design rather than being rediscovered.
- **It is descriptive before it is aspirational.** Eight existing choices already point this way and
  were each made separately: `curveRounding: "up"`; a missing verdict is a gap, not an `absent`;
  penalties need a quote; an uncorrected false claim caps rather than zeroes; self-correction is
  never an error; `dropLowest`; optional points may only raise a mark; and a grader that cannot run
  produces no mark rather than a low one. Naming the pattern is what makes the ninth choice easy.
- **What it forbids, concretely.** Tuning a grader or a prompt to minimise *total* error, which buys
  accuracy on positive mistakes with exactly the negative ones this rule exists to prevent. Every
  grader evaluation must report the two directions separately — `under` and `over` in
  `tools/eval/points-bench.py` — and a change that lowers total error while raising `under` is a
  regression whatever its headline number says.
- **The instructor's overall aim, recorded because it ranks the work:** *"a reliable grading backend
  that doesn't have surprises or random failures even if it is not as good as GenAI."* Reliability
  before sharpness. A grader that is a little blunt and never surprises is the target; one that is
  sharper on average and occasionally returns nothing is not.

### Purdue retires `qwen3.6:27b` on 2026-09-23 — what to switch to (2026-09-21, INV-DEPLOY-8)

Purdue announced that `qwen3.6:27b` is replaced in place by `qwen3.8:27b` on 2026-09-23. Both of the
pilot's GenAI courses pin `GENAI_STUDIO_MODEL=qwen3.6:27b` in their own
`.env`, so every zip they have in Gradescope fails from that day. It fails with no mark, not a low
one.

- **What the new ID is.** Unknown until it is live. GenAI Studio was down for the MATH datacenter
  outage (2026-09-19..21) and still answered 503 on the 21st. **Best guess:** `qwen3.8:27b`. Read it
  from `node tools/genai-models.js --course courses/<id>/course.json`, do not type it from the email.
- **Does 3.8 grade like 3.6?** The 2026-08-31 comparison that chose 3.6 (see `DEFAULT_GENAI_MODEL`
  in `grade.py`) does not transfer. **Best guess:** switch, then re-run the eval on 3.8 before
  releasing marks. Report `under` and `over` **separately** (INV-GRADE-11). If 3.8 raises `under`,
  that is a regression, and the answer is `local` or a different offered model, not "close enough".
- **Submissions in flight on the 23rd.** Anything graded by an old zip after the switch has no
  mark, which is the safe way to fail. **Best guess:** rebuild, upload and regrade the affected
  assignment once. A regrade under a new model is a new grader, so regrade **everyone** on that
  assignment together, not only the failures (INV-GRADE-1 fairness).
- **Unreachable at build time: warn or refuse?** Proceeding with **warn** (see INV-DEPLOY-8 for why
  this differs from INV-DEPLOY-5). Revisit if a zip ever ships against a dead model because the
  warning was missed.

### The reply FORMAT decided this grader, not the context (2026-09-17)

Working through G and H produced a result neither question anticipated, so it is recorded as its
own entry. **On qwen2.5-3b in points mode, how the reply is asked for matters more than anything
else in the prompt** — more than the rubric, the reference answer, the evidence quotes, the
optional-point framing, or the order the points are listed in. Measured on the same 6 quiz-03
questions with the same fixtures throughout:

| reply format | required points credited | optional points credited | unreadable |
|---|---|---|---|
| `"verdict":"stated\|partly\|absent\|contradicted"` | — | — | every reply; the alternation was copied verbatim |
| a filled JSON example, real ids | 24/24 | **0/18** | ~0 |
| …example with mixed optional verdicts | 24/24 | 4/18 | ~0 |
| …example with all-`stated` verdicts | — | 6/18 | ~0 |
| one flat point list, no CORE/SUPPORTING split | 24/24 | 4/18 | ~0 |
| optional points listed FIRST | 23/24 | 2/18 | ~0 |
| **one line per point**, verdict first | 26/26 | 12/12 | 2–4 in 18 |
| **one line per point, QUOTE first** | — | 18/18 | **0 in 12** |

- **A 3B shown a filled structure copies it.** The JSON example came back with its own verdict
  pattern *and* its placeholder evidence strings ("what they said about this point") sitting in the
  reply. Because that example showed the optional slots as `absent`, every answer got `absent` —
  while the model's own `feedback`, in the same reply, described the optional points correctly. It
  was never misreading the answers; it was reproducing an example.
- **Order the fields so the model must look before it commits.** Verdict-first, it decides and then
  writes an evidence field to match — optional points the answer did not contain were credited 97%
  of the time. Quote-first it has to find the student's words before it can choose, and false credit
  fell to 67% with not one reply in twelve unreadable. Both field orders are still ACCEPTED on the
  way back in (INV-GRADE-11): a model that answers the other way round has still judged the point.
- **Per-point calls are worse, not better** — tried because they looked like the reliable option.
  60 calls instead of 12, required points 16/24, optional false-credit 11/18. A point judged with
  no sight of the rest of the answer loses the thing that decides it.
- **The rules have to agree with the format.** `pointscore.RULES` ends "Reply with ONLY the JSON";
  handing that to a model asked for lines is a contradiction, and it measured as one (4-in-18
  unreadable against 2-in-18). The local system prompt now re-points only the FORMAT sentences; the
  judgement rules are pointscore's own words, and the shared rules are untouched for GenAI.

**What is left, and it is a capability limit rather than a prompt bug.** Ruled out: framing,
context, the core/supporting split, point order, the example, the rules contradiction, and field
order. What remains: given an answer that is on topic, this model does not reliably tell WHICH
listed points it made. The control that shows it cleanly — an answer conveying nothing gets 0/20
points credited, while an answer conveying one required point gets 20/20 of the rest credited too.
It discriminates between an answer and no answer, then judges the answer holistically and applies
that judgement to every line.
- Under INV-GRADE-11 this errs UPWARD, which is the acceptable direction and matches the
  instructor's stated preference. `under` measures at 0.0%.
- **What it means in practice, on a real submission:** with every fix in place, the first of the
  four Quiz 3 recordings scores **10.0/10, every question 1.000**. It was 8.8 before this session's
  work and 8.5 after the format fixes; the whole move came from removing penalties that should
  never have applied, not from better judgement. The bottom of the scale still works — an answer
  conveying nothing gets 0 of 20 points credited — so it is not rubber-stamping. Between "said
  something relevant" and "said everything" it does not separate. On this bank the local grader is
  closer to a **completion check** than to a mark.
- But that makes the curve's middle rungs uninformative, and it is a trade to choose deliberately
  rather than a defect to be prompted away. **Open for the instructor**, with no best guess offered
  because it is a policy call, not an engineering one. It may be perfectly acceptable as a one-off
  remedy for a quiz GenAI never graded — everyone treated the same, erring generous — and quite
  unacceptable as the standing grader for the course.
- **The one lever left that is not "a bigger model", and it is measurable rather than hopeful:**
  check the grader's own EVIDENCE against the transcript. A `stated` verdict whose quote contains
  words the student never said is a fabricated award, and unlike everything else tried here it can
  be checked in code, deterministically, with no second model call. `points-bench.py` now records
  the evidence and reports a `grounded` rate for exactly this reason.
  - **Reported, never applied**, and that restraint is the point. Turning a failed grounding check
    into a DOWNGRADE would manufacture the negative mistakes INV-GRADE-11 forbids — a model that
    paraphrases the student rather than quoting them would cost marks for the grader's habits.
    There is precedent either way (an unquoted novel point is already dropped, which is an award
    refused for want of evidence), so this is a real option — but it needs the measurement first.
  - **Measured, and they predict it almost perfectly.** Over 449 credited verdicts on 102
    constructed answers:

    | the grader's quote | credits | of which FALSE |
    |---|---|---|
    | NOT found in the transcript | 94 | **91 (97%)** |
    | found in the transcript | 355 | 125 (35%) |

    Refusing credit on an ungrounded quote removes **91 of 216 false credits** and costs **3
    correct ones** — about thirty to one, and by a distance the largest lever measured on the
    over-crediting. It is also the only one that is deterministic code rather than a prompt.
  - **Confirmed end to end**, the whole benchmark run with it on and off rather than extrapolated
    from the correlation:

    | | off | on |
    |---|---|---|
    | `over` | 50.9% | **32.5%** |
    | `under` | 0.0% | **0.6%** |
    | `optCredit` | 100% | 96.9% |
    | `readable` | 97.1% | 99.0% |
    | `grounded` | 79.1% | 100% |

    A 36% relative cut in over-crediting for 0.6% under-crediting. (`falseClaim` reads 4/6 against
    2/6 across the two runs, which is six cases and well inside run-to-run noise — not a finding.)
  - **Built as `scoring.requireGroundedEvidence`, and OFF by default.** 🔴 **Instructor's call.**
    Those 3 withdrawn credits are NEGATIVE mistakes, which INV-GRADE-11 says to design against — a
    grader that paraphrases the student rather than quoting them would cost marks for its own
    habits. Whether 42% less false credit is worth 0.7% of credits wrongly withdrawn is a
    grading-policy decision and not an engineering one. Set it to `true` in `defaults.scoring` (or
    per assignment) to take the trade; `tools/eval/points-bench.py` reports the `grounded` rate
    either way, so the number can be re-checked on any bank.


## Local profile integration (2026-09-21)
Proceed with Qwen3.5 4B Q4_K_M context/no-thinking as the default local model, versioned `qwen35-context-off-v1`. Preserve explicit legacy Qwen2.5 and existing GenAI choices; pin prior course assignments before changing future defaults. Keep the evaluated prompt unchanged: the known admission-of-ignorance false credit is reported, not hidden by an unmeasured heuristic. Grounding remains opt-in because removing ungrounded credit also removed earned credit. New banks should use disjoint criteria and optional authored context; authoring context needs instructor/reference review. Band-mode compatibility is supported but points evidence does not certify band quality. Regrade alternatives may enhance keys while proving identical student-facing questions and selection metadata. Use only the authorized accommodation synthetic self-test in automated gates.

## Instructor identity-debug package (2026-09-21)
The instructor explicitly requested uploading student recordings under their own email
for testing. Implement a build-only `--debug-identity` option, scoped to one pinned
assignment. Keep identity comparison active and report mismatch, while allowing the
rest of the grading pipeline to run. Label filename and every result DEBUG; retain all
other validation and normal production identity behavior. Do not modify deployed
course settings or reuse the public demo bypass. Pair a new normal Quiz 3 enhanced-v2
package with a DEBUG sibling, preserving previous artifacts and the same question bank.

## Grading timing and display order (2026-09-21)
Instructor requested student-visible start/finish/total and instructor-only stage
breakdown at the end, with questions first. Use America/Indiana/Indianapolis (DST-aware),
monotonic elapsed time, sequential main stages and separately labeled nested Qwen spans.
Report result-preparation completion, not queue/image-build time or a fabricated timestamp
for the future file write. Preserve previous artifacts and build a v3 pair. Make Whisper's
four-thread default explicit; Qwen already pins four prompt/generation threads.

## Gradescope cap accounting (2026-09-22)
The instructor's first provided native report took 535.320 seconds but recorded only
0.962 GiB cgroup-v1 charge against 6 GiB. This is 16.033%, not 96.2%; eight samples
occurred during inference. The v3 report lacks live-model RSS/PSS and scope provenance,
so shared file-page charging is plausible but not proven. Instructor requested whole
container cap usage. Make cap charge/percent/headroom primary, verify scope/model
membership, expose component and event counters, and retain live RSS/PSS only as a
separate non-additive footprint diagnostic. Preserve v3 and build a v4 pair. Never
lower the memory recommendation from this single ambiguous memory observation.

## Oversized-model memory experiment (2026-09-22)

Instructor explicitly requested a DEBUG-only model with weights larger than the
6 GiB cap. Selected Qwen3.5 9B Q8_0 (8.873 GiB weights), preserving memory mapping
and all grading settings for comparison. Keep the test cap at 6 GiB. File size
does not guarantee simultaneous residency or failure: paging and external cache
charges remain possible. Course-local derivative only; no production default change.

## Quiz 4 completion diagnostics (2026-09-22)

Instructor requests verbose failure diagnostics for the next quiz. Add shared,
flushed lifecycle events and heartbeat to instructor stdout, and append the
pre-write event history to the final hidden diagnostic item. Post-write shutdown
and launcher status necessarily appear only in stdout. Do not infer platform
fault from absent events. Quiz 4 is still a draft: prepare a separately labeled
test package with Quiz 3 settings; do not register/deploy a live assignment.

## Missed spoken codes no longer zero an attempt (2026-10-05, INV-CODE-4)

Instructor decision: a Quiz 4 attempt lost its opening code in transcription although
the student read it. Revised the same day: an attempt with at least half its codes
heard is graded, flagged, and the student warned that review may affect the grade.
Fewer than half, or any other integrity failure, scores 0 but is still graded, with
the result kept instructor-only for override. Accepted cost: a padded pre-recording
needs to hit only half the boundaries to be graded; it is always flagged for review.
Open: whether the flag alone is enough. Best guess: yes, for formative quizzes.

## Shared workstation model storage (2026-10-10)
Instructor requested removal of stock comparison downloads and reuse across
Codex/Claude sessions. Retain the manifest-pinned Qwen3.5 4B GGUF in the standard
Hugging Face cache with Whisper, rather than switching the qualified llama.cpp
grader to Ollama. Lookup is offline, exact-revision, and explicit overrides fail
closed. Historical course pins and released images remain unchanged; reproducing
old Qwen2.5/comparison runs requires an explicit shared-cache download.
