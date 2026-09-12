# OralScale — Implementation Plans & Chosen Approach

This document weighs 4 candidate architectures against the mission constraints
(scalable, low-friction, real-time-verifiable, privacy-first, Purdue-tools-as-record)
and selects one to prototype.

---

## Plan A — Pure client-side, no backend ("trustless-ish")
Everything runs in static JS. Question selection, timing, and "fingerprint" all in the browser.
Real-time is "enforced" by a client timer and a nonce shown on screen.

**Pros**
- Zero server to run or pay for; trivially hostable on GitHub Pages/Brightspace.
- Absolutely no audio or data leaves the browser except to Gradescope. Maximum privacy.
- Simplest possible thing to build and reason about.

**Cons**
- **No real cryptographic real-time guarantee.** If signing happens client-side, the signing
  key is in the client → any student can extract it and forge certificates with any timestamp.
- The client clock is attacker-controlled; "start time" is meaningless.
- Fails the core requirement ("fingerprint must be cryptographically secure so it must be
  answered in real time"). Good demo, weak integrity.

**Verdict:** Rejected as the primary design — but its *packaging* and *recording* code are reused
by every other plan, and it is worth shipping as an offline "practice mode."

---

## Plan B — Client app + minimal stateless Signer  ★ CHOSEN
Static web app for UI/recording/hashing; a single **stateless** serverless function (the Signer)
holds the instructor secret and does two things: `/start` (issue signed question+nonce+clock) and
`/finish` (verify timing, sign a certificate over the audio hash). No database; nothing stored.

**Pros**
- **Real cryptographic real-time proof:** the secret never reaches the client, the clock is
  server-authoritative, and the certificate binds the exact audio hash within a signed window.
- Still **privacy-first:** the Signer receives only hashes + metadata, never audio; keeps no state.
- Cheap and scalable: one tiny function; requests are milliseconds; free tiers cover a whole course.
- Question selection is deterministic HMAC → stateless, reproducible, auditable.
- Autograder verifies with the same secret (or an Ed25519 public key) — clean separation of concerns.

**Cons**
- One piece of infrastructure to deploy and keep the secret in (mitigated: it's ~150 lines,
  stateless, and standard serverless).
- Requires network at start/finish (but not during recording).

**Verdict:** **Chosen.** It is the minimal design that actually satisfies the real-time
cryptographic requirement while preserving the privacy and scalability goals.

---

## Plan C — Gradescope-native (Online Assignment) only, no companion site
Use Gradescope's built-in timed Online Assignments and file-upload questions. Students record
with any tool and upload; Gradescope's own timer bounds the attempt.

**Pros**
- Nothing to build or host; one system for students; inside FERPA boundary end-to-end.
- Gradescope's timer gives a coarse real-time bound "for free."

**Cons**
- Gradescope cannot reveal a per-attempt nonce, cannot cryptographically bind the audio to a
  reveal time, and cannot force browser recording — students record offline with unlimited prep
  before "starting." Weak integrity, exactly the gap we set out to close.
- Dynamic per-attempt question randomization from a large bank is clumsy; retakes-with-new-question
  is not a native concept.
- No control over the recording UX or the spoken-challenge mechanism.

**Verdict:** Rejected as sole solution; **adopted as the submission+grading substrate** underneath
Plan B. We use Gradescope for what it is best at (record of submission + autograding), not for delivery.

---

## Plan D — Full live backend with real-time AI (Socratic)
A real backend streams audio to a live LLM (Purdue GenAI) for adaptive, back-and-forth questioning
and immediate grading.

**Pros**
- Pedagogically richest: genuine Socratic dialogue, adaptive difficulty, instant feedback.
- Strong real-time guarantee (the server drives the whole interaction).

**Cons**
- **Violates two core constraints:** requires AI API usage at delivery time (cost + rate limits
  at scale) and a stateful backend that necessarily touches/streams audio (privacy + storage risk).
- Much larger build; harder FERPA story; per-student inference cost scales with enrollment.

**Verdict:** Rejected for v1; **kept on the roadmap** as an opt-in Tier-3 upgrade for small
sections or high-stakes uses, layered on Plan B's foundations.

---

## Decision
**Build Plan B**, using **Plan C's Gradescope** as the submission/grading system of record and
shipping **Plan A's recorder** as a bundled offline practice mode. Plan D is future work.

### What the prototype delivers
1. `bank/` — frozen question-bank JSON + schema + a sample ECE bank.
2. `server/` — stateless Signer (Node, standard-lib crypto): `/start`, `/finish`, `/health`.
   Deterministic HMAC question selection; HMAC-SHA256 signed tokens; server-authoritative clock.
3. `web/` — static app: token paste, `/start`, question + spoken-nonce display, MediaRecorder
   capture, live countdown, in-browser SHA-256, `/finish`, and a downloadable `.zip` package.
   Includes an offline "practice mode" (Plan A) that needs no Signer.
4. `autograder/` — Gradescope-format Python: verify certificate → check hash/timing/nonce →
   transcribe (pluggable) → grade via Purdue GenAI (pluggable, stubbed) → emit `results.json`.
5. `tools/` — bank builder/validator, assignment-token generator, and an authoring prompt
   template so instructors can mass-generate questions with Claude/ChatGPT, then freeze them.
6. Docs + a local end-to-end demo that runs without any cloud deployment.

### Sequencing
Signer core (crypto + selection) → bank + schema → web recorder/packager → wire web↔Signer →
autograder verify+grade → tooling → local end-to-end demo → README/run instructions.

### Key risks & mitigations
- **Secret leakage** → secret lives only in Signer env; autograder can use Ed25519 public key later.
- **Nonce-splicing within the window** → tight window + optional mid-recording nonce + retained audio.
- **Browser codec variance** (`webm`/`ogg`) → hash raw bytes; autograder transcriber is codec-tolerant.
- **Grading reliability** → GenAI grade is advisory with rubric feedback; instructor spot-checks flags.
