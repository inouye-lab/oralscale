# Setting up OralScale

**Goal:** in 15–30 minutes you have taken an oral quiz yourself, on your own phone, and you know
exactly what your students will experience. In another 30 you have your first real question bank.

**How much of this is coding:** none, if you do not want it to be. One command sets everything up
and asks you the two questions that matter. The rest of this page tells you the handful of things
only you can do, because they need accounts in your name.

---

## What you need before you start

| | | |
|---|---|---|
| **Now** | A computer with **Node 18+** and **Python 3** | Both are already on most machines. The wizard checks and tells you if not. |
| **Before students use it** | A **Cloudflare** account | Free tier. Hosts the quiz server so students can reach it from off campus. |
| **Before students use it** | A **Gradescope** course | Where recordings are submitted and grades live. You almost certainly have this already. |
| **Optional** | A **Purdue GenAI Studio** API key | For AI grading. Without it the system grades with a keyword heuristic, which is fine for testing. |

You do **not** need a server, a database, a domain name, or a credit card.

---

## Part 1 — Twenty minutes to your first quiz

### Step 1. Run the wizard

```
npm install
npm run setup
```

It asks for your course name and term, and then for the only two settings that really matter:

**How many questions per attempt?** Each question is a separate answer inside **one continuous
recording**, with a spoken code between them. The default is **5**.

Five sounds like a lot until you notice that the time limit is a *ceiling*, not an expectation.
Students tap **"I'm done with this question"** the moment they have finished, and a good answer to
one of these questions runs about a minute. So five questions at a 120-second limit budgets ~12½
minutes but typically produces a recording nearer six or seven.

Five is worth having because **the score is the best 4 of 5** — the weakest answer is dropped
automatically. One unlucky draw, one topic you happened to skip, one moment of going blank: none of
them decides the grade. That is a real reduction in student anxiety and it is only affordable
because you asked more than one question. (The dropped question's feedback is still shown, clearly
marked as not counting — it is usually the most useful feedback on the attempt.)

| | Budget (ceiling) | Good for |
|---|---|---|
| **5 (default)** | ~12½ min | A weekly check with drop-lowest. Five samples, one forgiven. |
| 3 | ~7½ min | Shorter takes; still allows drop-lowest (best 2 of 3, which forgives more aggressively). |
| 1 | ~2½ min | A first trial. A single draw is a much noisier measurement and nothing can be dropped. |

**How long per question?** **120 seconds**, and leave it there unless you have a reason. It is a
ceiling that only binds on a student who actually needs the time — which is exactly the student who
should not be cut off mid-sentence. Lowering it to 60 does not make attempts shorter (students
already finish early); it only makes the limit start biting on slower and non-native speakers.

The wizard prints the arithmetic so the total recording length is never a surprise.

**Who grades the answers?** This is the one setup choice with a privacy consequence, so the wizard
asks rather than deciding for you.

| | `local` **(the default)** | `genai` |
|---|---|---|
| What it is | A small AI model bundled inside the autograder image | Purdue GenAI Studio |
| Where the transcript goes | **Nowhere** — it never leaves the Gradescope container | The de-identified, PII-redacted **text** is sent there. Never the audio, never a name |
| Needs | Nothing | An API key |
| Quality | Ranks answers nearly as well; less precise about the exact mark, which calibration corrects | Better |
| Speed | ~10–25 s per question | ~2–4 s per question |

> **Before choosing `genai`:** Purdue GenAI Studio is on-premises at Purdue, and this system sends
> it only anonymised transcripts. But it carries **no FERPA certification**, and OralScale makes no
> FERPA claim on its behalf. Sending student work there is your decision and your risk. If you are
> unsure, keep `local`, or ask your privacy office first.

The backend you choose is the one that grades every submission. There are no automatic fallbacks:
if it is unavailable, the recording remains ungraded and is marked `REGRADE REQUIRED`, so an
outage cannot silently measure part of the cohort with a different grader (INV-GRADE-1).

### What the wizard writes for you

```
courses/<your-course>/course.json          every setting, each with a comment
courses/<your-course>/question-design.md   the template for Part 2
courses/<your-course>/sources/             drop your slides here later
server/config.json                         your signing secret (gitignored)
```

It also points your first assignment at a **starter bank**: twelve general-STEM reasoning
questions (averages, derivatives, units, sampling bias, feedback) that any technical discipline can
answer. They exist so you can hear the whole thing working before you write a single question of
your own.

### Step 2. Take the quiz yourself

Two terminals:

```
npm run signer
```
```
npm run web
```

Then get a link:

```
node tools/gen-url.js --course courses/<your-course>/course.json --assignment week-01-starter
```

Open it. **Answer a question out loud, on your phone, against the clock.**

This is the most valuable five minutes in the whole setup. You will learn more about your own
question design from answering one question aloud than from reading anything on this page. Note
how long two minutes actually feels, and how it feels to read four digits out loud before you have
seen what you are being asked.

### Step 3. Calibrate the grader

```bash
python3 tools/calibrate-grader.py --course courses/<your-course> --backend local
```

Do this before students use it. It answers two different questions, and the first matters more:

1. **Should this grader be used at all?** It checks that the same answer gets the same mark on a
   re-run (**consistency**), and that within one question a better answer always scores above a
   worse one (**ranking**). Neither is fixable by adjusting numbers, so it prints a verdict —
   GOOD / USABLE WITH SPOT-CHECKING / NOT RECOMMENDED — and refuses to certify a grader that fails
   either.
2. **Is the scale right?** A small model reliably squashes the range: wrong answers come back
   around 0.35 instead of 0. Left alone, that turns a zero into a three out of ten. The tool fits
   two numbers that stretch it back. The correction is monotone, so **it can move a mark but can
   never swap two students.**

Full explanation, including how to calibrate against your own graded answers instead of the
built-in set: [TEACHER-GUIDE — Choosing and calibrating a grader](TEACHER-GUIDE.md).

### Step 4. Grade your own recording

The app gives you a `.zip`. Run the grader on it locally:

```
node tools/test-course-smoke.js --course courses/<your-course>/course.json --assignment week-01-starter
```

That exercises the full path end to end. To grade your *actual* recording, see
[TEACHER-GUIDE.md](TEACHER-GUIDE.md).

**At this point you have a working, calibrated oral quiz.** Everything below is about letting other people
take it.

---

## Part 2 — Your own questions

Full walkthrough: **[QUESTION-DESIGN-GUIDE.md](../guides/QUESTION-DESIGN-GUIDE.md)**. The short version:

1. **Fill in `courses/<your-course>/question-design.md`.** One page. What you are trying to
   measure, what a score should mean, what is out of scope, what `intro`/`core`/`stretch` mean in
   your course, and the two or three principles behind each week.
2. **Drop your materials into `courses/<your-course>/sources/`.** Slides, notes, past exams —
   whatever you have, however it is formatted. Optional but strongly worth it: questions generated
   from your own materials use your notation and your emphasis. The files are kept, not consumed.
3. **Generate a bank.** Hand `question-design.md`, `sources/`, and
   [bank-generation-spec.md](bank-generation-spec.md) to an AI assistant and ask for one week —
   about 100 questions. This is the only place AI touches question content; **no AI is called when
   a student takes the quiz.**
4. **Validate and read it.**
   ```
   node tools/validate-bank.js courses/<your-course>/banks/week-01-<topic>.json
   ```
   Then sample twenty items, and answer three of them out loud against the clock.
5. **Point your course at it** — edit the `bank` line for that assignment in `course.json` — and
   freeze it. Do not regenerate a bank mid-term: which question a student draws depends on the
   bank's contents.

---

## Part 3 — Letting students in

Three things, in this order. Only the first two need an account.

### Step 5. Publish the quiz server (Cloudflare)

The quiz server is stateless and tiny. It never sees audio — only a fingerprint of it and some
timestamps — which is why it can live on a free Cloudflare Worker.

Full runbook with the exact commands: **[server/worker/README.md](../../server/worker/README.md)**.
The shape of it:

1. Create a free Cloudflare account, if you do not have one.
2. `node tools/build-worker.js courses/<your-course>/course.json` — bundles your config and banks.
3. Create the small database (one command; it holds counters and timestamps, no personal data).
4. Upload your signing secret (one command).
5. Deploy (one command).
6. Open `https://<your-worker>.workers.dev/health`. It should report your assignments and **no
   warning**. If it warns, it tells you exactly what is missing.

Then paste the worker URL into `signerUrl` in your `course.json`, and publish the student app —
`web/` is static files, so Cloudflare Pages, GitHub Pages, or your department web space all work.
Put that address in `webappUrl`.

### Step 6. Create the Gradescope assignment

Create a **Programming Assignment**. Four settings matter, and one of them will destroy grades if
you get it wrong.

> ### Which attempt counts — nothing for you to set
> Gradescope grades the **active** submission: the most recent one, unless the student activates an
> earlier one from their **Submission History**. There is no "highest score" option on a Programming
> Assignment.
>
> It still matters. Retakes are unlimited and each draws a new question, so a later attempt can
> score lower — and a submission with no recording is deliberately scored 0 so the autograder can
> hand the student their quiz key. Either would stand if left active. The fix is the student's and
> takes two clicks; the [student guide](../guides/STUDENT-GUIDE.md) explains it, so make sure they
> have it.
>
> (This guide previously told you to set "submission to be graded → highest score". That option
> does not exist here — it was assumed rather than checked.)

**Autograder settings** — the defaults are too small, and both symptoms are confusing:

| Setting | Set it to | Why |
|---|---|---|
| **Container** | **4.0 CPU, 6.0 GB RAM** | Two models run, one after the other: speech recognition (~1.7 GB) and then the local grader (~3.5 GB). The speech model is released before the grader loads, so the peak is the larger of the two and not their sum — but the 0.5 CPU / 0.75 GB default cannot load *either*, and every submission would come back untranscribed. With `gradingBackend: genai` and no local model bundled, 2.0 CPU / 3.0 GB is enough. |
| **Timeout** | **40 minutes** | Not because one submission takes 40 minutes — it takes a few. The headroom is for AI grading hitting a rate limit: the grader waits and retries rather than silently falling back to keyword matching, and a regrade of a 200-student roster is exactly when that happens. A container killed mid-retry gives the student nothing. |
| **Submission scoring** | *nothing to set* | There is no such option on a Programming Assignment. Gradescope grades the **active** submission — the newest unless the student activates an earlier one. See the warning above; the student guide tells them how. |
| **Autograder zip** | `courses/<courseId>/autograders/<courseId>-<assignmentId>-oralscale-v<version>.zip` | Built in the next step; contains plaintext secrets and is gitignored. |

A bigger Whisper model (`medium`, `large-v3`) is worth it for a class with many non-native English
speakers; set `ORALSCALE_WHISPER_MODEL` in `secret.env`. At 6 GB it still fits beside the local
grader, because the two never load at the same time.

**Name the assignment with its number in the title** — "Quiz 4", "Oral Quiz 4". The autograder
works out which week it is grading from the title, so one zip serves your whole term.

### Step 7. Build and upload the autograder

```
npm run package -- courses/<your-course>/course.json
```

This produces a course-named zip under that course's ignored `autograders/`, containing your config, your
banks, and your signing secret. Upload that exact zip to the Gradescope assignment. Packaging a
second course writes to its own folder and cannot overwrite this one.

> **Treat that zip like a password.** Gradescope has no secrets manager, so the signing secret is
> inside it in plain text. Anyone with staff access to your Gradescope course can read it.

### Step 8. Hand out quiz keys

```
node tools/gen-access-keys.js --course courses/<your-course>/course.json --roster <gradescope-export.csv>
```

Each student gets one 16-character key for the whole term. Post them individually in Brightspace
(or your LMS). That is the entire enrolment procedure: keys are derived, not stored, so nothing is
uploaded anywhere and adding a student mid-term is the same command plus one post.

Keys exist because the quiz link is public by design. Without them, anyone could request questions
in a loop and turn your hundred-question bank into a study sheet.

A student who loses their key can get it back by submitting to Gradescope with no recording — the
feedback prints their own key.

### Step 9. Post the link

```
node tools/gen-url.js --course courses/<your-course>/course.json --assignment week-01-<topic>
```

One link for the whole class. Put it in the Gradescope assignment description and point students
at [STUDENT-GUIDE.md](../guides/STUDENT-GUIDE.md).

---

## The settings you did not have to choose

Everything below has a default that works. They are listed so you know they exist, not because you
need to do anything.

| Setting | Default | What it does |
|---|---|---|
| `bufferSec` | 20 s | Grace after the countdown hits 0:00 — the student sees "finish your sentence". Separate from the visible limit on purpose, so the promise made to the student stays honest. |
| `codeDigits` | 4 | Length of the spoken code between questions; four is the tested safety floor. |
| `codeLeadSec` | *derived* | Time to read a code before the question appears. One second per digit, so four digits gets four seconds — measured, not guessed. |
| `tailLimitSec` | *derived* | Time between the final code and Finish. Double the lead, because nothing follows the last code to absorb a fumble. |
| `retakeCooldownSec` | 5 min | Stops question-shopping: opening a question, abandoning it, and drawing again for an easier one. **Cleared instantly by finishing an attempt**, so answering is never penalised. |
| `maxPoints` | 10 | Points for the assignment. |
| `scoreAggregation` | `mean` | How several questions combine. `min` if every question is a competency that must stand on its own; `dropLowest` to forgive one bad draw. |
| `difficultyMix` | — | Per-slot difficulty, e.g. `["intro","core","stretch"]` for warm-up / spine / discriminator. |
| `showTranscript` | on | Whether students see the automatic transcript of their own recording. Usually leave it on: a garbled transcript explains a low score better than anything you could write. |
| `requireAccessKey` | **on** | The enrolment gate. **Never turn this off on a live course.** |

Change any of them by editing `courses/<your-course>/course.json` — each one carries a note
explaining itself.

---

## Common first-run problems

| What you see | What it is |
|---|---|
| `/health` warns about no D1 binding | The database was not created or not bound. The retake cooldown and the access log are off; the quiz still works. Runbook step 3. |
| Every submission scores 0 with "not set up correctly" | The autograder cannot find its signing secret, or it does not match the one the Worker has. Rebuild the zip. |
| Every submission comes back with no transcript | The container is too small to load the speech model. Set 2.0 CPU / 3.0 GB. |
| Students get "we could not hear the last code" | Usually genuine — they tapped Finish before reading the digits. The grader re-checks the audio before saying this, so a transcription glitch has already been ruled out. If a whole section reports it, check the container size. |
| A student says their key does not work | Check they are on the right course link. If it still fails, re-run `gen-access-keys.js` for their email — keys are derived, so re-running produces the same key. |

---

## Roughly how long each part takes

| | |
|---|---|
| Wizard + take a quiz yourself | 20 min |
| Calibrate the grader | 10–15 min, mostly waiting |
| Question design + your first bank | 30–60 min (mostly thinking, once) |
| Cloudflare deploy | 15 min, once |
| Gradescope assignment + autograder | 15 min, once per course |
| Keys + link | 5 min |
| **Each week after that** | **~15 min** — drop in the week's bank, rebuild, post the link |
