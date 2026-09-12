# Disclaimer

**OralScale is alpha software distributed to a small group of invited faculty for evaluation.**
Read this before using it with students.

## Status

Version `0.1.0-alpha.1`. It has been run in one course by its author. It has not been independently
audited, institutionally certified, or deployed at any other institution. Interfaces, file formats,
token formats, and configuration keys **will** change between alpha versions, sometimes without a
migration path.

## No warranty

The software is provided "as is", without warranty of any kind, as set out in [`LICENSE`](LICENSE).
There is no service-level commitment, no guaranteed response time, and no promise that a reported
problem will be fixed within any particular semester.

## You are the deploying institution

If you run OralScale, **you** are the operator of an assessment system that processes student work.
That means you — not the author, and not this repository — are responsible for:

- **Privacy and records.** Whether your deployment is consistent with FERPA or your local
  equivalent is a determination your institution makes, not one this software can make for you. See
  [`PRIVACY.md`](PRIVACY.md) for what actually moves where, so that determination has facts to work
  from.
- **Institutional approval.** Security review, privacy review, and any required approval for
  third-party services in your teaching stack.
- **Accessibility and accommodation.** See the limitation below — this one needs your attention
  before students are involved.
- **Academic-integrity policy.** The system produces evidence; the judgement about what that
  evidence means, and any consequence, is yours.
- **Grades.** Automated grading is an aid. Every score is subject to your review, and students must
  have a route to a human.

## Automated grading is not a decision-maker

Scores come from a language model working from a transcript of speech. It will sometimes be wrong,
and it will be wrong in ways that are not uniformly distributed: transcription accuracy varies with
accent, with recording conditions, and with speech differences. **Do not treat an automated score
as final.** Review flagged submissions, offer a human appeal, and weight these assessments in a way
that survives a score being wrong.

## Known limitations

**Accessibility — accommodations are worked out case by case, and we want to hear how.**

**Extended time is supported directly.** A student taps "I have DRC accommodations" on the start
screen and selects 1.25x, 1.5x, 1.75x or 2x; their countdown scales accordingly. Keep the grants
themselves wherever you already keep them — Gradescope's Extensions page stays the system of record.
The autograder never sees them: it notes that a claim was made, assumes it correct, and grades
normally, so that no record of who holds an accommodation is ever bundled into a container. Audit
the claims offline whenever you choose, with `tools/audit-accommodations.js`, which you run yourself
in a terminal. Selecting less than granted, or nothing, is never held against a student; only
claiming more *and* using more is worth a look, and nothing about it ever changes a score. Grants above 2x cannot be delivered through the web app and need
arranging another way.

What does **not** yet exist is a single prescribed alternative format for a student who cannot use
a spoken modality at all.

That is deliberate for this alpha rather than an oversight waiting to be fixed: accommodation is a
conversation between an instructor, a student, and a disability services office, and the right
answer varies. Handle it as it arises, with your own office, the way you would for any other
assessment format.

`docs/project/DESIGN-QUESTIONS.md` (D2c) sets out three options with their trade-offs — a live oral with
you over video, which preserves exactly what the assessment measures and is the recommended
default; a typed real-time variant; or a written response, which is cheapest but measures something
different.

**If you have to make an accommodation, please tell us what you did and how it went.** Working out
the general answer from real cases is one of the things this pilot is for, and a pattern that shows
up two or three times is what should become a supported feature.

**Language.** Transcription and grading have been exercised in English. Other languages are
untested.

**Devices and browsers.** Mobile-first, tested on current Chrome, Safari, and Firefox. In-app
browsers inside other applications are known to be unreliable for audio capture.

**Question quality.** The system assesses what your bank asks. A bank of recall questions produces
a recall assessment, and no amount of machinery fixes that.

**Bank confidentiality.** The integrity properties assume the question bank is not public. If your
bank leaks, the assessment is compromised. Keep course content in a private repository — see
[`courses/README.md`](courses/README.md).

**Scale.** Exercised at the scale of one course. Behaviour at substantially larger enrolments,
or under a simultaneous deadline rush, is not characterised.

## Not legal or compliance advice

Nothing in this repository is legal advice. Statements about privacy, records, or regulation are
descriptions of how the software behaves, offered so your institution's own experts can evaluate
it. They are not a determination that any deployment complies with anything.
