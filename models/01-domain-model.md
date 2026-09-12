# 01 — Domain Model (knowledge graph)

The nouns of OralScale and how they relate. This vocabulary is canonical; code,
docs, and UI use these exact terms (see the House Lexicon at the bottom).

## Entities

- **Course** — a portable unit (e.g. `chem101-fall2026`). Has many Weeks. Config in
  `courses/<courseId>/course.json`. Nothing course-specific lives in code.
- **Week / Module** — an assessment unit within a course (e.g. `week-04-knn-eval`).
  Owns exactly one **Bank**.
- **Bank** — a *frozen* set of ~100 **Questions** for a Week. `banks/<courseId>/<week>.json`.
  Authored once with an LLM, then frozen; content-hashed. No AI at quiz time.
- **Question** — `{id, topic, principle, difficulty, kind, prompt, rubric, keyPoints[]}`, plus the
  optional gradability fields `{referenceAnswer, scoringBands, commonErrors}`. Tests one
  principle, answerable aloud in 2–3 min (≤5). The `principle` field ties it to the course's
  redesign philosophy; the optional fields exist so a grader anchors to the Instructor's standard
  rather than its own, which matters most for a small, self-contained grader (`tools/eval/`).
- **Question-design brief** — `courses/<courseId>/question-design.md`: what the Instructor is
  trying to measure, what a score should mean, and what `intro`/`core`/`stretch` mean in *this*
  course. Together with **Sources** it is the input every Bank is generated from. It is
  course-specific data, so it lives under `courses/` (FR-8), never in `docs/`.
- **Sources** — `courses/<courseId>/sources/`: the Instructor's own materials (slides, notes, past
  exams) in whatever format they exist. **Kept, not consumed** — they are how a Week is
  regenerated later.
- **Assignment** — an instance of a Week offered to Students, with policy knobs
  (`limitSec`, `questionsPerAttempt`, `requireAccessKey`, `retakeCooldownSec`). Identified by
  `assignmentId`. Realized as one Gradescope Programming Assignment. The code-reading times
  (`codeLeadSec`, `tailLimitSec`) are **derived from `codeDigits`**, not configured — see FR-7.
- **Student** — identified by **studentRef**, an *opaque* ref the Signer cannot read as an
  identity. Three forms, all re-derivable by the autograder from the Gradescope-authenticated
  email at submission time:
  - `k:<sid>` — **the default.** Derived by the *Signer* from the Student's AccessKey. The
    browser sends no email and nothing computed from one, and `sid` is keyed by the Secret, so
    nobody without the Secret can walk it back to an address.
  - `e:<hex>` — HMAC of the email under the course's **public** salt, computed in the browser.
    Only for Assignments running with `requireAccessKey:false`. Pseudonymous, not anonymous:
    a holder of the salt can brute-force a known roster.
  - `p:XXXX-XXXX-XXXX` — HMAC under the Secret, minted by the autograder; the opt-out for the
    `e:` form.

  No OralScale account; no password.
- **CourseLink / CourseToken** — a signed, **public** capability naming one Assignment and
  carrying the course's public pseudonym salt. Published in the Gradescope assignment
  description; identical for every Student, so it is not a credential.
- **UniqueURL / QuizToken** *(legacy, accommodations only)* — a signed per-Student capability
  carrying a plaintext studentRef and a `timeMultiplier`. Issued by hand for DRC extended-time
  students; the ordinary path uses the CourseLink.
- **AccessKey** (UI: *quiz key*) — a per-Student, per-Course credential the Instructor hands out
  through Brightspace. Sixteen Crockford characters, `XXXX-XXXX-XXXX-XXXX`, and **self-authenticating**:
  ```
  key = sid ‖ tag
  sid = base32( HMAC(Secret, "sid:v1:"‖courseId‖":"‖epoch‖":"‖email) )[0..5]   30-bit id
  tag = base32( HMAC(Secret, "ktag:v1:"‖courseId‖":"‖sid) )[0..9]              50-bit MAC
  ```
  The Signer verifies enrolment by **recomputing `tag` from `sid`** — so there is no roster at the
  edge and nothing to keep in sync (INV-SEC-8). `sid` is also the Student's identity: the Signer
  derives `studentRef = "k:"+sid` from the key, which is why the Student types **no email at all**.
  A key is a *bank-access credential, not proof of identity* — identity is bound at submission
  (INV-SEC-2). One key per Student per Course, for the whole term.
- **Attempt** — one recording session, holding `questionsPerAttempt` **Segments** in a single
  continuous recording. All its Questions are chosen at reveal from a fresh `attemptSalt` and
  are distinct. Retakes create new Attempts with new Questions, subject to the retake cooldown.
- **Segment** — one Question inside an Attempt: `{index, questionId, tReveal, tQuestion,
  tClosing}` plus the offsets from `tStart`. The transcript is sliced by these offsets, so each
  Question is graded only on what was said while it was on screen.
- **RevealToken** — signed server record of an Attempt's question and time window
  (`tReveal`, `deadline`). The server's tamper-proof memory (statelessness).
- **ClosingToken** — the RevealToken plus `tClosing`, the server-clock moment the Student
  committed ("I'm done"). Required by `/finish`, so the closing step cannot be skipped.
- **Boundary code** — a six-digit spoken challenge at a Segment boundary:
  `digits( HMAC(secret, attemptId‖":"‖phase) )`. An Attempt of N Questions has **N+1** of them —
  `b0 ─ Q1 ─ b1 ─ Q2 ─ … ─ Q(N) ─ bN` — and every interior code does double duty: it closes the
  answer just given and opens the next Question, so the Student reads digits once per boundary,
  not twice. Each is issued only at its moment, which is what makes it evidence of liveness.
  Phases are `open` (b0), `b1…b(N-1)`, `close` (bN); for N = 1 this is exactly the v4
  **opening code / closing code** bookend. There is no mid-answer code (decision C2).
- **Certificate** — signed proof binding an Attempt to its audio (`audioSHA256`), its Segments,
  and validated time window (`tStart`, `tFinish`), and recording that the Attempt passed the
  access gate (`accessKeyVerified`). The only thing the autograder trusts.
- **SubmissionPackage** — `answer.<ext>` + `certificate.json`, zipped, uploaded to Gradescope.
- **Grade** — score + rubric feedback from the autograder (integrity checks + GenAI content grade).
- **Rescue pass** — a second, targeted re-transcription of one Segment boundary's window of the
  audio, run only when a boundary code was not found in the main transcript. It reads audio the
  grader already holds and searches for a code the grader already derives, so it can only turn a
  false "code not heard" into a true one (INV-INTEGRITY-9).
- **Injection scan** — the deterministic check that a transcript contains no instruction addressed
  to the grading model. Runs *before* any model call and is enforced in Python (INV-SEC-10).
- **Instructor** — authors Banks, sets Assignment policy, holds the signing **Secret**, deploys.

## Relationships
```
Course 1──* Week 1──1 Bank 1──* Question
Week   1──* Assignment 1──* Student   (via UniqueURL)
Student 1──* Attempt *──1 Question
Attempt 1──* Segment 1──1 Question          (Attempt 1──N+1 boundary codes)
Attempt 1──* RevealToken 1──1 ClosingToken  (one pair per Segment; the last one certifies)
Student 1──1 AccessKey per Course           (derived, never stored; carries its own MAC)
AccessKey ──derives──> studentRef "k:<sid>"  (by the Signer, from the key alone)
Attempt 1──1 Certificate 1──1 SubmissionPackage ──> Gradescope ──> Grade
Instructor ──holds──> Secret ──signs──> {CourseLink, RevealToken, ClosingToken, Certificate,
                                         boundary codes, AccessKeys}
```

## Trust facts (see [06 threat model])
- **Secret** is known only to the Signer and the autograder. Everything signed with it is
  trustworthy; everything else (client clock, studentRef entry, audio bytes) is untrusted
  until bound by a signature.
- **Audio** exists only in the browser and in Gradescope. The Signer sees only `audioSHA256`.

## House Lexicon (canonical terms — do not synonymize in code/UI)
| Use | Not |
|-----|-----|
| Attempt | try, session, take |
| Bank | pool, set, database (of questions) |
| RevealToken | start token, session token |
| Certificate | receipt, proof, signature (alone) |
| studentRef | username, userid, email (in code — it is opaque, never an address) |
| CourseLink | quiz link, class link |
| boundary code (opening / closing for the ends) | nonce, challenge, passphrase (UI says "code") |
| Segment | part, section, sub-question |
| AccessKey (UI: "quiz key") | password, token, licence, login, private code (that is the pseudonym) |
| buffer (bufferSec) | grace (that is clock skew), extra time, overtime |
| Signer | backend, API (be specific) |
| rescue pass | retry, second transcription, fallback |
| injection scan | filter, moderation, content check |
| question-design brief | spec, blueprint, plan (of questions) |
| Sources | uploads, materials folder, corpus |
