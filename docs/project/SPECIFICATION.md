# OralScale — System Specification (v1)

## 1. Actors & systems
- **Instructor** — authors the frozen question bank, holds the signing secret, publishes the
  Gradescope assignment, configures the autograder.
- **Student** — records a spoken answer in the browser and uploads the resulting file to Gradescope.
- **Web app** — static, client-side JavaScript (deployable on GitHub Pages / Brightspace / any
  static host). Renders questions, records audio, runs the timer, hashes audio, packages output.
- **Signer** — a *stateless* HTTPS endpoint (single serverless function). Holds the instructor
  secret; issues signed start/finish tokens. **Stores nothing; never receives audio — only hashes.**
- **Gradescope** — system of record for submissions and grades; runs the autograder container.
- **Purdue GenAI** — LLM used *inside* the autograder to grade transcript content (one call per
  submission, one config per assignment).

## 2. Artifacts & formats
- **Question bank** (`bank/bank.json`): `{ version, bankId, questions:[{id, topic, difficulty,
  prompt, rubric, keyPoints[]}] }`. Frozen; content-hashed; committed to the repo.
- **Assignment token** (pasted by student): a signed, URL-safe blob encoding `{bankId,
  assignmentId, expiresAt}` — class-wide, distributed via Gradescope/Brightspace.
- **Start token** (Signer → app): signed `{studentRef, attemptId, questionId, nonce,
  startTime, deadline}`. `questionId` is derived deterministically (see §4) so no state is stored.
- **Completion certificate** (Signer → app): signed `{studentRef, attemptId, questionId,
  nonce, startTime, endTime, audioSHA256, durationSec}`.
- **Submission package** (student → Gradescope): the audio file (`.webm`/`.ogg`) **plus** a
  `certificate.json`. Delivered as a small `.zip`, or the certificate embedded in a text sidecar.

## 3. Student flow
1. Open web app → paste assignment token → enter Purdue username (career account).
2. App calls `Signer /start` → receives a fresh random question + nonce + server clock window.
3. App shows the question and a **spoken challenge** ("begin by reading aloud: `BRAVO-7-TANGO`").
   A visible countdown (2–5 min, configurable; default 3) starts.
4. Student records via microphone (MediaRecorder API). Audio stays in the browser tab.
5. On stop (or deadline) the app computes `SHA-256(audio)` in-browser (SubtleCrypto) and calls
   `Signer /finish` with the hash + timing. Signer validates the window and returns the certificate.
6. App bundles `audio + certificate.json` into a downloadable `.zip`. Student uploads it to Gradescope.
7. **Retake:** repeat freely; each attempt draws a *new* question. No penalty; encourages practice.

## 4. Real-time integrity protocol (the crux)
Goal: a submission is provably recorded **after** the question was revealed and **within** the limit.

- **Question selection is deterministic & stateless:** `questionId =
  HMAC(secret, bankId‖assignmentId‖studentRef‖attemptSalt) mod N`. `attemptSalt` is random per
  start, so retakes differ; the Signer never has to remember what it served.
- **Freshness via nonce:** `nonce` is unpredictable and revealed only at `/start`. The student
  must *speak* it (verified by transcription in the autograder), so audio content is provably
  post-reveal. Optionally a second nonce is revealed mid-recording to deter splicing.
- **Time-boxing via signed clock:** `startTime`/`deadline` come from the Signer's trusted clock,
  not the client. `/finish` rejects hashes submitted after `deadline`. `endTime − startTime` and
  the audio's own `durationSec` must be consistent and within the limit.
- **Binding via audio hash:** the certificate signs `audioSHA256`, so the file the autograder
  verifies is byte-identical to the one hashed inside the window. A pre-recorded file can't be
  swapped in after the certificate is issued without invalidating the signature.
- **Trust root:** all tokens are signed with the instructor secret (HMAC-SHA256 for v1; upgradeable
  to Ed25519 so the autograder verifies with only a *public* key). The secret lives only in the Signer.
- **Residual risk (documented, accepted for formative use):** a confederate could, within the
  2–5 min window, splice the spoken nonce onto a prepped answer. Mitigations: tight window, random
  mid-recording nonce, retained audio for human spot-check. This is a *formative* tool, not a proctored final.

## 5. Grading (Gradescope autograder)
- Autograder container receives the uploaded `.zip`. Steps: (1) verify certificate signature,
  hash match, timing, and nonce presence; (2) transcribe audio (local Whisper, or Purdue GenAI
  speech endpoint); (3) grade transcript against `rubric`/`keyPoints` via **one** Purdue GenAI
  call; (4) emit Gradescope `results.json` with score + rubric feedback. Integrity failures →
  score 0 with an explanation, flagged for instructor review.

## 6. Privacy & compliance
- Audio is created in the browser and handed to the student; it is uploaded **only** to
  Gradescope (Purdue's FERPA-covered system). The Signer sees hashes and metadata, never audio.
- No third-party analytics, no cookies beyond a local attempt cache. Signer logs are hash-only.
- Voice is retained (in Gradescope) solely for instructor spot-checking of authorship.

## 7. Constraints & requirements
- **No AI API at delivery time.** AI is used only offline (authoring) and inside the autograder.
- **No audio at rest** outside Gradescope. Backend must be stateless and horizontally trivial.
- Web app must run as static files; the Signer is the only server component and may be a single
  Cloudflare Worker / Vercel / AWS Lambda function.
- Browser support: Chrome/Edge/Firefox on desktop; graceful mic-permission handling.

## 8. Future tiers (out of scope for v1, see roadmap)
- **T2 — Adaptive:** follow-up question chosen from the frozen bank based on a cheap local
  transcript keyword match (still no live AI).
- **T3 — Socratic:** true back-and-forth via live Purdue GenAI inference (opt-in, metered).
