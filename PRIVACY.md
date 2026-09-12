# What OralScale sends where

A deployment-neutral description of the data flows, so that your institution's privacy office can
evaluate them. It describes how the software behaves. It is **not** a compliance determination —
see [`DISCLAIMER.md`](DISCLAIMER.md).

Terms follow the House Lexicon in [`models/01-domain-model.md`](models/01-domain-model.md).

## The four parties

| Party | What it is | Who runs it |
|---|---|---|
| **Student's browser** | Records the audio; nothing is installed | The student's device |
| **Signer** | Stateless edge service issuing signed tokens | You (Cloudflare Worker, or local Node) |
| **Gradescope** | Receives the submission; system of record | Your institution |
| **Grader** | Scores the transcript — **local by default** | Inside the Gradescope container, or a remote service you choose |

## What each party receives

### The browser
Captures audio and holds it locally until the student uploads it. There is a local attempt cache.
There are no third-party analytics and no tracking cookies.

### The Signer — hashes and timings, never content

The Signer **never receives audio and never receives a transcript** (INV-PRIV-1). It receives an
audio hash, timing offsets, and an opaque student reference.

In the default **key-only** mode the browser sends exactly one identifying value: the student's
AccessKey. The Signer derives an opaque `studentRef` from it using the deployment Secret, which the
browser never holds (INV-PRIV-2). A party holding the course link, the public salt, and a complete
class roster still cannot map that reference back to a person — only a holder of the Secret can.

Every identifier the Signer writes to its database is a keyed HMAC truncated to 64 bits, never a
plain hash, and every table has an enforced retention bound (INV-PRIV-5). The keying matters: an
IP address is 32 bits, so an unkeyed hash of one is reversible by enumeration in seconds.

> **Open mode** (`requireAccessKey: false`) is a documented weaker configuration. It sends a
> browser-computed HMAC of the email under a **public** salt, which is pseudonymisation rather than
> anonymisation — a party holding the salt and a roster can brute-force it back. Real courses
> should leave key-only mode on.

### Gradescope — the audio, and everything in it

The audio is uploaded **only to Gradescope** (INV-PRIV-1). Transcription runs with a local Whisper
model **inside the Gradescope container** (INV-PRIV-3) — the audio does not go to a transcription
service. Gradescope therefore holds the recording and the full transcript, inside your
institution's own boundary.

### The Grader — depends on a setting you make deliberately

`gradingBackend` has two real values, and **the default is `local`**:

- **`local` (default)** — a small open-weights model bundled in the container. The transcript
  **never leaves the Gradescope container**. Nothing is sent to any external service.
- **`genai`** — the transcript is sent to a remote grading service. Only text, never audio, and
  only after PII redaction (below).

The default is not a claim that local grades better; it does not. The default is `local` because
the alternative exports student work to an external service, and that is a decision the instructor
should have to make rather than inherit. **If you select a remote backend, student work leaves your
institution's boundary, and that flow is the one your privacy office needs to evaluate.**

`heuristic` is a third value: keyword coverage only, deterministic, sends nothing, and grades
markedly worse. It exists for testing.

## Minimisation on the one outbound flow

When and only when a remote backend is selected (INV-PRIV-4):

1. **Students are told before they record** to answer the question and say nothing personal. This
   is the control that does the real work — nothing said is nothing to protect.
2. **The outbound copy is redacted** (`autograder/source/pii.py`) as a backstop for the student who
   introduces themselves out of habit.
3. **The instructor is told what kind of thing was removed and how much, never the text.**
4. **The student is told plainly, without penalty.**

Redaction applies only to the outbound copy. Gradescope keeps the full transcript, because it
already holds the audio — redacting the instructor's own view would be theatre.

A false positive here is a **grading** bug, not harmless caution: stripping a technical term
changes the answer the grader reads. Patterns are anchored to shapes that spoken mathematics does
not produce, and capitalised-name matches are vetoed against a list of field eponyms.

## Extended-time accommodations

Students who hold a DRC/disability accommodation select their own extension (1.25x–2x) in the web
app. That claim is verified afterwards against a roster you export from Gradescope. **Gradescope
remains the system of record** — this is a derived copy, because Gradescope does not expose
accommodations to an autograder (`submission_metadata.json` has no accommodation or extension
field, and there is no public API).

Who holds a disability accommodation is the most sensitive datum this system touches, so:

- **The roster holds no names or emails.** It is keyed by the same opaque `studentRef` the Signer
  derives, and building it requires the signing Secret. It is gitignored (`accommodations.json`)
  and must never be committed or sent anywhere.
- **It never leaves the Gradescope container.** It is bundled in the autograder zip and read there.
  The multiplier is **never** sent to a grading backend, local or remote.
- **It is never stored on the quiz server — at all.** The Signer is told a claimed multiplier so it
  can compute the deadline (unavoidable: the deadline is enforced server-side) and then drops it.
  It is written to **no table, no key, and no log**. This is stricter than the "no PII" rule that
  governs everything else here, deliberately: the multiplier names nobody, but disability status is
  the most sensitive datum this system touches and an edge database is the worst place for it. A
  test fails the build if a schema column, a persistence call, or a key derivation ever mentions
  it.
- **It exists at rest in exactly one place:** the signed Certificate, inside the student's own
  submission, in Gradescope — already the system of record for their accommodation.
- **Email notification is OFF by default.** Mailing an accommodation review would hand an outside
  mail provider the fact that a particular submission needs accommodation review — a disclosure
  leaving the institutional boundary, and a decision for your records office rather than a default.
  It requires an explicit `ORALSCALE_NOTIFY_ENABLED=1`; SMTP credentials alone do not enable it.
  When enabled the message is a **pointer, not a copy**: assignment and Gradescope submission id,
  nothing else — no name, no identifier, no accommodation detail.
- **The claim is recorded in the signed Certificate**, which goes only to Gradescope — already the
  system of record for that student's accommodation, so this discloses nothing new there.
- **The autograder zip is readable by anyone with staff access to your course.** If you bundle a
  roster, those people can read who has an extended-time grant. They can already read Gradescope's
  Extensions page, so this is not a new disclosure — but it is worth knowing you made it.

Verification never changes a score. Selecting less time than granted, or none at all, is never
recorded as an event. Claiming more than granted is reported to you only if the student also *used*
more time than their grant allows — and even then it is a note for a human, with the likeliest
explanations (a grant added after you exported; a course-level rather than assignment-level
extension) stated alongside it.

## What is never in the repository

No secrets, API keys, rosters, quiz keys, or student data — in the working tree, the web bundle,
logs, or URLs (INV-SEC-4). Secrets live in `.env`, Worker secrets, or the autograder's
`secret.env`, all gitignored. Private course content lives in its own private repository.

## What you should tell your students

The student-facing disclosure is in the web app and in [`docs/guides/STUDENT-GUIDE.md`](docs/guides/STUDENT-GUIDE.md).
**Check that it matches your configuration before you deploy.** If you switch to a remote grading
backend, the disclosure must say so — a disclosure describing a data flow the deployment does not
have is worse than none.

## Questions to put to your privacy office

1. Is the Signer, as an edge service holding only keyed hashes and timings, acceptable in your
   teaching stack?
2. If you intend to use a remote grading backend, does that service hold the certifications your
   institution requires for education records?
3. What retention applies to the recordings held in Gradescope, and who can access them?
4. Does your institution require student consent or notice for recorded assessment?
