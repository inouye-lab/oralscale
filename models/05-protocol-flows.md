# 05 — Protocol Flows (service-flow model)

The exact wire sequences. This is the implementation contract for the Signer, web app,
and autograder. Token payloads are canonical here.

## Signed token payloads (all HMAC-SHA256 over UTF-8 JSON; see protocol.js)
```
CourseToken (public CourseLink fragment — identical for the whole class):
  { v:3, kind:"course", courseId, assignmentId, pseudonymSalt,
    requireKey, allowPrivateCode, exp }        // requireKey drives the app's identity screen
QuizToken (legacy per-student link; accommodations only):
  { v:2, kind:"quiz", courseId, assignmentId, studentRef, timeMultiplier, exp }
RevealToken (Signer -> app; carries the question IDs but NOT the questions):
  { v:6, kind:"reveal", courseId, assignmentId, studentRef, attemptId, attemptSalt,
    questionIds[], questionCount, qIndex, questionId,   // questionId = questionIds[qIndex]
    tStart, tReveal, segments[],                        // segments = the ones already answered
    keyChecked, codeLeadSec, limitSec, bufferSec, codeDigits, tailLimitSec }
QuestionToken (Signer -> app, once codeLeadSec has elapsed; the clock starts here):
  { v:6, kind:"question", ...RevealToken fields, tQuestion, deadline }
ClosingToken (Signer -> app; the QuestionToken plus the commit moment and this segment):
  { v:6, kind:"closing", ...QuestionToken fields, tClosing, segments[+1] }
Certificate (Signer -> app -> Gradescope):
  { v:6, kind:"certificate", courseId, assignmentId, studentRef, attemptId,
    accessKeyVerified, keyChecked,
    questionCount, questionIds[], boundaryCount,
    segments:[ { index, questionId, limitSec, bufferSec, tReveal, tQuestion, tClosing,
                 revealOffsetSec, questionOffsetSec, closingOffsetSec, answerSec } ],
    tStart, tFinish, elapsedSec, deadline, codeLeadSec, codeDigits,
    limitSecPerQuestion, bufferSec, tailLimitSec,
    audioSHA256, clientDurationSec,
    // v5 mirrors, so a one-question attempt is byte-compatible with the old shape:
    questionId, tReveal, tQuestion, tClosing, questionOffsetSec, closingOffsetSec,
    answerSec, limitSec }
```
`segments` accumulates INSIDE the signed token, so the Signer still remembers nothing between
requests — an N-question attempt is as stateless as a one-question one.

**Boundary codes.** Codes are NOT stored:
`code_k = digits( HMAC(secret, attemptId‖":"‖phase(k)) )`, `codeDigits` digits (default four), where
`phase(0) = "open"`, `phase(N) = "close"`, and `phase(k) = "b"+k` in between. An attempt of N
questions has **N+1** codes, and each interior one closes the answer just given *and* opens the
next question — one reading, two jobs. At N = 1 this is byte-identical to the v4 bookend.

**One code per boundary, never a rolling stream** (decision C2). Digits rather than NATO words
because every ASR engine transcribes digits reliably. Verification allows a **Damerau-Levenshtein
distance of 1** — one dropped, added, substituted, or transposed digit. Note this is a *tolerance*,
not an error-correcting code: the verifier re-derives the expected value, so there is nothing to
recover; the only thing that needs surviving is a transcription slip.

**AccessKey** (INV-SEC-8) — not a token but a **self-authenticating** credential, handed out
through Brightspace and typed by the Student as the only thing they enter:
```
key = sid ‖ tag                                          rendered XXXX-XXXX-XXXX-XXXX
sid = base32Crockford( HMAC(secret, "sid:v1:"‖courseId‖":"‖epoch‖":"‖email) )[0..5]
tag = base32Crockford( HMAC(secret, "ktag:v1:"‖courseId‖":"‖sid) )[0..9]
studentRef = "k:" ‖ sid                                  derived BY THE SIGNER from the key
```
`/reveal` splits the key, recomputes `tag` from `sid`, and compares constant-time **before**
touching the Bank. Verification is therefore a pure computation: **no roster at the edge, no
database, no sync step.** `tools/gen-access-keys.js` (or the autograder's no-recording branch)
reissues at will, because nothing was ever stored.

## Flow 1 — Identity (key only; bound at submission)
The link is public and carries no identity, so there is nothing to mint before a student can
start. The Student presents a quiz key, which both proves enrolment and *names* them; the claim
is *verified* at upload, where Gradescope has actually authenticated them.
```mermaid
sequenceDiagram
    participant I as Instructor
    participant S as Student
    participant GS as Gradescope
    participant A as Web app (Z0)
    participant K as Signer (Z1, Secret)
    participant AG as Autograder (holds Secret)
    Note over I: once per term — gen-access-keys.js --roster
    I-->>S: Brightspace post: "your quiz key is ABCD-EFGH-JKMN-PQRS"
    Note over I,K: nothing is uploaded to the Signer — keys verify themselves
    GS-->>S: assignment description contains the PUBLIC CourseLink
    S->>A: open CourseLink
    alt default — key only
      S->>A: types their quiz key (no email, no login)
      A->>K: POST /reveal {courseToken, accessKey}
      K->>K: recompute tag from sid; mismatch -> 403, Bank untouched
      K->>K: studentRef = "k:"+sid          %% identity DERIVED, not supplied
    else open mode (requireAccessKey:false)
      S->>A: types email -> A hashes it in-browser -> studentRef "e:<hex>"
      S->>A: or pastes p:XXXX-XXXX-XXXX (the opt-out)
    end
    Note over A,K: nothing derived from an email is ever sent in key mode (INV-PRIV-2)
    S->>GS: upload the .zip
    GS->>AG: submission_metadata.json (authenticated email)
    AG->>AG: re-derive "k:"+sid (and the e:/p: forms) from that email
    AG->>AG: cert.studentRef matches one? else score 0 (INV-SEC-2)
```
Security: the link is not a credential, so sharing it is meaningless — a recording is graded for
whoever it was certified under, and that must equal the authenticated submitter. Reselling a
`.zip` therefore fails unless the seller ran a separate attempt under the buyer's identity, which
is ordinary collusion (T7, accepted). Sharing a *key* is likewise self-harm: the sharer's
classmate can open questions as them and burn their cooldown, but the resulting Certificate names
the key's owner and so earns the classmate nothing.

## Flow 2 — Code first, then question, repeated per question (web app ↔ Signer)
```mermaid
sequenceDiagram
    participant A as Web app (Z0)
    participant K as Signer (Z1, Secret)
    Note over A: user taps Start (gesture)
    A->>A: getUserMedia; MediaRecorder.start()  %% capture BEFORE question
    A->>K: POST /reveal {courseToken, accessKey}      %% no identity in the body
    K->>K: verify token+exp
    K->>K: ACCESS GATE (INV-SEC-8): recompute the key's OWN tag; wrong/absent -> 401/403
    K->>K: studentRef = "k:"+sid, derived from the verified key
    K->>K: log the decision (INV-SEC-9); lock the IDENTITY out after 10 bad keys
    K->>K: retake cooldown? (INV-SEC-7) -> 429 if rerolling
    K->>K: rate-limit per studentRef (the link is class-wide); attemptId,attemptSalt=rand
    K->>K: questionIds = selectN(secret, assignment,studentRef,attemptSalt)  %% ALL of them, now
    K->>K: tStart=tReveal=now  %% questions chosen but WITHHELD
    K-->>A: {revealToken, code b0, codeLeadSec, questionCount}   %% no question yet
    loop for each question k = 0 … N-1
      A->>A: SHOW code b_k alone; no countdown yet
      Note over A: student reads the four digits aloud
      A->>K: POST /question {revealToken}    %% polls until the lead elapses
      K->>K: refuse until now >= tReveal_k + codeLeadSec (server clock)
      K->>K: tQuestion=now; deadline=tQuestion+limit*mult+buffer*mult+skew
      K-->>A: {questionToken, question, deadline, qNumber, questionCount}
      A->>A: SHOW question k+1 of N; START the visible countdown (limitSec)
      Note over A: at 0:00 the app says "finish your sentence" and runs bufferSec
      Note over A: student answers (NO interruptions)
      Note over A: "I'm done with this question" OR deadline — recorder KEEPS RUNNING
      A->>K: POST /closing {questionToken}
      K->>K: require tClosing <= deadline; append this segment; code b(k+1)=HMAC(...)
      alt more questions remain
        K-->>A: {closingToken, code b(k+1), more:true, nextRevealToken, nextQNumber}
        A->>A: HIDE question; show code b(k+1) — it CLOSES this answer and OPENS the next
      else last question
        K-->>A: {closingToken, code bN, more:false, tClosing, tailLimitSec}
        A->>A: HIDE question; show the final code full-screen
      end
    end
    Note over A: student reads the final digits aloud, then taps Finish
    A->>A: audioSHA256 = SHA256(blob); durationSec
    A->>K: POST /finish {closingToken, audioSHA256, durationSec}
    K->>K: require kind=="closing" AND segments.length == questionCount
    K->>K: require tFinish <= tClosing + tailLimitSec, and <= deadline + tail
    K-->>A: {certificate (all segments), certificateToken}
    A->>A: zip(audio, certificate.json) -> download
```
Enforces INV-INTEGRITY-2/4/5/6 and INV-SEC-7/8/9. The access check and both code endpoints are
pure compute; only the cooldown and the access log touch the DB.

**Why `/finish` refuses a mid-attempt ClosingToken.** Without that guard a student could answer
one question of three and certify — banking a partial attempt *and* walking away having seen two
questions they never had to answer, which is exactly the shopping INV-SEC-7 exists to stop.

## Flow 3 — Validation + grading (autograder)
```mermaid
sequenceDiagram
    participant AG as Autograder (Secret)
    participant W as Local Whisper
    participant L as Local grading model (bundled)
    participant G as Purdue GenAI (opt-in)
    AG->>AG: find answer.* + certificate.json in submission
    alt audio present but certificate absent (UNCERTIFIED BACKUP)
      AG-->>AG: score 0, student-visible backup warning, instructor REVIEW flag
      Note over AG: audio is retained in Gradescope for manual review;<br/>it is never automatically content-graded (INV-INTEGRITY-7)
    else certificate present
    AG->>AG: verify certificateToken signature (INV-SEC-1)
    AG->>AG: SHA256(audio) == cert.audioSHA256 ? (INV-INTEGRITY-1)
    AG->>W: transcribe(audio) -> text + word timestamps
    AG->>AG: trueDuration D; check D<=limit+grace and D~elapsed (INV-INTEGRITY-3)
    AG->>AG: cert.accessKeyVerified? else 0 (INV-SEC-8)
    AG->>AG: code b0 near start, edit-distance<=1 (INV-INTEGRITY-4)
    AG->>AG: every code b_k at/after segment k-1's closingOffsetSec (INV-INTEGRITY-5)
    opt any code not found in the transcript
      AG->>W: re-transcribe THAT boundary window in short overlapping chunks
      W-->>AG: per-chunk text, digit-tuned decode settings (INV-INTEGRITY-9)
      AG->>AG: test each chunk separately; a code found here counts as spoken
    end
    AG->>AG: tFinish<=deadline recorded in cert (INV-INTEGRITY-2)
    AG->>AG: injection.scan(transcript): high severity => integrity failure (INV-SEC-10)
    alt any integrity check fails
      AG-->>AG: score 0, flag for review (INV-INTEGRITY-7)
    else all pass
      AG->>AG: slice the transcript per segment [questionOffsetSec_k, closingOffsetSec_k]
      AG->>AG: pii.redact() each slice -> the OUTBOUND copy only (INV-PRIV-4)
      AG->>W: release() the speech model — grading is next and they never coexist
      alt gradingBackend = local  (DEFAULT)
        loop for each segment k
          AG->>L: grade(question_k, slice_k) — one question, ~2k context
          L-->>AG: {score, feedback}
        end
        Note over AG,L: nothing leaves the container. Context is flat in the<br/>question count, so 20 questions cost time, not memory.
      else gradingBackend = genai
        AG->>G: ONE request carrying every segment, random transcript fence
        Note over AG,G: pre-call jitter; on rate limit (which arrives as HTTP 400 here)<br/>back off with full jitter and retry until the deadline
        G-->>AG: {answers:[{score, feedback, covered, missed, injectionSuspected}]}
        opt GenAI unreachable
          AG-->>AG: no grade; REGRADE REQUIRED with the named backend (INV-GRADE-1)
        end
      end
      AG->>AG: apply calibration — monotone, so it can move a mark, never reorder (INV-GRADE-2)
      AG-->>AG: results.json { score = aggregate over segments, tests[] (one per question), output }
    end
    end
```

**Why the two backends batch differently.** The local grader takes **one Question per call**; the
remote one takes the whole Submission in a single request. That is not an inconsistency — the
binding constraint is different on each side. Remotely it is the *request count*, because a rate
limit counts requests. Locally there is no rate limit, and the constraint is *context length*, and
therefore KV-cache memory: a batched prompt would grow with `questionsPerAttempt`, so a course
asking twenty Questions would need a container a course asking three does not. One at a time keeps
the context near 2k whatever the Question count is.

**Why one request rather than one per Question, on the GenAI path.** Each Gradescope submission is its own container,
so a 200-student regrade is 200 containers calling Purdue GenAI at once, and the request *count* is
what a rate limit counts. Batching an Attempt's Questions into one request divides that by the
question count for the same tokens. Measured against the live service: 25 concurrent submissions,
6 of them throttled, **25 of 25 still graded by GenAI** — none silently fell back to the keyword
heuristic, which is the failure that would matter (two students with the same answer getting
different grades because one was unlucky).

**Purdue GenAI reports a rate limit as `HTTP 400` with a `detail` string, not as `429`.** The retry
policy therefore decides from the response *body*, not the status code. Treating 400 as fatal —
the obvious reading — silently dropped roughly a quarter of a concurrent batch to heuristic
grading.

## Timing constants (defaults; instructor-tunable)
- `limitSec = 120` **per question** (decision A2, revised), warn at 60s/15s.
- `bufferSec = 20` per question — grace after 0:00 to finish a sentence. Separate knob: the
  countdown must mean what it says, and the slack must be tunable without changing it.
- `questionsPerAttempt = 5`. The budget is `N·(codeDigits + limitSec + bufferSec) + 2·codeDigits`
  = 728 s ≈ 12.1 minutes of audio at the four-digit defaults; that is a ceiling. In the pilot
  classroom trial, students finished in about six minutes. Five samples reduce question-draw
  variance, and `dropLowest` prevents one unlucky draw from deciding the grade (decision A1).
- `requireAccessKey = true` (INV-SEC-8). Before a key verifies there is no identity, so a loose
  `KEY_FAIL_LIMIT = 10` invalid-key limit applies per source address per 15-minute rolling window;
  all authenticated limits key on identity. The ordinary request ceiling remains high for campus NAT.
- Codes: 4 digits, one per segment boundary (N+1 of them). Match tolerance = 1 edit. Timestamp slack
  `w = 15s` either side of the expected position.
- `codeLeadSec` — **derived, not configured**: `codeDigits` seconds, so 4 s at four digits. The
  question is withheld this long so the code is read first. One second per digit is what reading
  digits aloud at a natural pace actually costs, and
  deriving it means the number stays right when an instructor changes `codeDigits`. It is not a
  setup question because every second of it is time the student is *not* thinking about the
  question — there is nothing for a teacher to optimise, only a fact about speech.
- `tailLimitSec` — **derived**: `2 × codeDigits`, so 8 s at four digits. Double, because the final
  code is the only boundary with nothing after it to absorb a fumble: every other code is followed
  by a question and two minutes of answer, so a slow start there costs the student their own
  thinking time, whereas at the end there is only the Finish tap plus hashing and one round trip.
  Bounding it still stops the closing step becoming extra unpinned recording time (the live-demo
  attempt used 6 s of the 12).
  Both remain overridable per assignment for a deployment that needs it (FR-7, "advanced").
- `retakeCooldownSec = 300` (INV-SEC-7) — cleared immediately by finishing an attempt.
- `grace = 20s` clock skew. `durationTol = 15s`.
- `exp` (CourseToken) = one term (default 120 days); (legacy QuizToken) = 20 min from mint.
