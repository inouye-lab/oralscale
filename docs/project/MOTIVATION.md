# OralScale — Motivation, Goals & Mission

## Mission
Make **oral assessment scalable** — bringing the pedagogical power of "explain it out loud"
to large courses **without human proctors, without per-student instructor time, and without
compromising student privacy** — using only the teaching tools Purdue already provides
(Gradescope, Brightspace, Purdue GenAI) as the systems of record.

## Why oral assessment, and why now
Speaking an answer aloud is one of the strongest tests of genuine understanding: it resists
copy-paste, forces synthesis, and surfaces misconceptions that multiple-choice hides. Yet
oral exams have never scaled — historically they cost ~10–20 minutes of faculty time *per
student per assessment*. In a 100–300 student ECE course this is impossible weekly.

At the same time, the rise of generative AI has quietly broken many written take-home
assessments: a written short-answer question can now be answered by a chatbot in seconds.
Oral, time-boxed, real-time responses are far more robust — but only if we can make them
**cheap to administer** and **hard to fake**.

## The core insight
Question *generation* is the expensive-but-one-time part; question *delivery* and
*verification* is the cheap-but-repeated part. We therefore:

1. **Generate a large question bank once** with Claude/ChatGPT, then **freeze it**. No AI API
   is required at quiz time, so delivery is free, deterministic, and offline-capable.
2. **Deliver a dynamic quiz** that selects a random subset per attempt, so no two students
   (and no two retakes) see the same prompt.
3. **Capture a short spoken answer in the browser**, bind it cryptographically to a real-time
   challenge so it *cannot* be prepared offline, and hand the audio back to the student to
   submit **through Gradescope** — the institutional system of record, already approved for
   student work at the deploying institution. (OralScale makes no compliance claim on any
   institution's behalf; whether a given deployment satisfies FERPA or a local equivalent
   is that institution's determination. See [PRIVACY.md](../../PRIVACY.md).)

## Goals (what success looks like)
- **Scalable:** marginal cost per student per assessment ≈ $0 of human time; only a one-time
  bank-authoring cost and near-zero compute.
- **Low friction — students:** open a page, paste a token, speak for 2–5 minutes, download,
  upload. Retake freely to reduce anxiety; each retake is a fresh question, so retaking is
  itself productive practice, not gaming.
- **Low friction — instructors:** author a bank, publish an assignment, let Gradescope +
  Purdue GenAI autograde. One grading configuration per assignment, reused all term.
- **Real-time integrity:** a submission is cryptographically provable to have been recorded
  *after* the question was revealed and *within* the time limit — not fetched, not pre-recorded.
- **Privacy-first:** audio is never stored on instructor hardware or third-party servers. It
  lives only where the student's other coursework already lives — Gradescope. Any backend is
  stateless and touches only hashes, never audio.

## Non-goals (at least for v1)
- Not a replacement for high-stakes proctored final exams; this targets frequent, formative,
  lower-stakes oral checks that build the habit of explaining.
- Not a biometric identity system. We record voice for later human spot-checking, not
  automated identity verification.
- Not a fully Socratic back-and-forth tutor (that needs live AI inference — see the roadmap
  in the specification as a future, opt-in tier).

## Guiding principles
- **Purdue tools own the sensitive data.** We add a thin, stateless layer; we never become a
  new place where grades or recordings live.
- **Freeze the AI.** AI authors content; frozen artifacts serve it. Reproducible, auditable, free.
- **Reduce stress, preserve rigor.** Unlimited fresh-question retakes make the *honest* path
  the *easy* path.
- **Verifiable, not surveillant.** Prove real-time authorship with cryptography and a spoken
  challenge — not with webcams, lockdown browsers, or keystroke spyware.
