# OralScale

**Scalable, privacy-preserving oral assessment** using the tools Purdue already provides
(Gradescope, Brightspace, Purdue GenAI). Students open one class link, speak a 2–3 minute answer
to a random question, and a cryptographic certificate proves it was recorded **live**. The audio is
uploaded **only to Gradescope** and graded automatically. No logins, no audio stored anywhere else,
free to run.

Built with **[MAGE](docs/project/MAGE.md)** — the models in [`models/`](models/README.md) are the source of
truth; code is written to satisfy them.

> **Continuing this in a fresh chat (ChatGPT/Claude) or new to the repo?** Start with
> **[`docs/project/ONBOARDING.md`](docs/project/ONBOARDING.md)** — a self-contained briefing that needs no prior
> context. The house rules live in [`AGENTS.md`](AGENTS.md); `CLAUDE.md` imports it, so every
> assistant reads the same file.

## Why
The course redesign this serves argues that AI has broken
the old proxies for learning: *"a polished AI-assisted artifact no longer proves a principle was
learned."* Oral, unassisted, real-time explanation is a proxy AI can't fake — but oral exams never
scaled. OralScale makes them scale to hundreds of students at ~$0 and near-zero instructor time.

## Quickstart

Four steps to a working oral quiz **in your own course**. Then three optional ones. Full version
with prerequisites and troubleshooting: [`docs/guides/QUICKSTART.md`](docs/guides/QUICKSTART.md).

**Prerequisites:** Node 18+, Python 3.9+, a free [Cloudflare
account](https://dash.cloudflare.com/sign-up), a Gradescope course. You do *not* install wrangler.[^prereq]

Step 1 builds your real course with a **`demo-quiz`** assignment already in it, on generic
questions — so you test on your own Signer, secret and Gradescope, and what works is *your* setup.[^demo]

**1. Create your course.**

```bash
npm install
npx wrangler login          # needs the Cloudflare account; launch will not do this for you
node tools/setup.js --title "SCI 101 — Example Course" --term fall2026 --assignments "Quiz 1"
```

Writes `courses/<id>/`: config, starter bank, signing secret, `.gitignore`, commit guard, and its
own git repository. Add a **private** remote and push.[^private]

**2. Launch it.**

```bash
npm run launch -- courses/<id>/course.json
```

Deploys the Signer and student page, then builds one autograder zip per assignment.[^launch]

**3. Create the `demo-quiz` Gradescope assignment.** A *Programming Assignment*. Upload the zip
whose **filename names it**, from `courses/<id>/autograders/`. Two settings matter:

| Setting | Value | If you get it wrong |
|---|---|---|
| Container | as printed by `npm run launch` | Too small and the speech model cannot load — no transcripts, for anyone |
| Timeout | **40 minutes** | A throttled submission is killed mid-retry and the student gets nothing |

Nothing to set for scoring: Gradescope grades the most recent submission, and students re-activate
an earlier one from Submission History.[^scoring]

**4. Take it yourself, end to end.**

```bash
node tools/gen-access-keys.js --course courses/<id>/course.json --student you@your.edu
node tools/gen-url.js        --course courses/<id>/course.json --assignment demo-quiz
```

Open the link on your phone, answer out loud, download the `.zip`, **submit it to Gradescope**.
Do not skip the upload — it is the only check that your Signer and autograder share a secret.[^why]

---

### Optional — your own questions

The starter bank proves the machinery; it does not assess your course. Read
[`QUESTION-DESIGN-GUIDE.md`](docs/guides/QUESTION-DESIGN-GUIDE.md) first — it is about what is worth
asking aloud.

Then in any chat interface, upload that guide,
[`bank-generation-spec.md`](docs/reference/bank-generation-spec.md), your course's
`question-design.md`, and your lecture slides, and ask:

```text
I am building a frozen oral-quiz question bank for <course>, week <N>, on <topics>.
The uploaded design guide and generation spec define what a good question looks like
and the exact JSON schema.

Interview me first: what should a student be able to explain after this week, and
what does a confident wrong answer look like? Ask me questions until you can write
against my goals rather than the slide titles. Then draft 20 questions in the schema,
with referenceAnswer, keyPoints, scoringBands and commonErrors on every one.

Do not write questions answerable by recall alone.
```

Save to `courses/<id>/banks/quiz-1.json`, point `quiz-1` at it, then validate and relaunch:

```bash
node tools/validate-bank.js courses/<id>/banks/quiz-1.json
npm run launch -- courses/<id>/course.json
```

Using a coding agent instead? The prompt in
[`QUICKSTART.md`](docs/guides/QUICKSTART.md#let-an-agent-do-it) drives the setup steps too.

### Optional — roll it out to students

```bash
node tools/gen-access-keys.js --course courses/<id>/course.json --roster <lms-export.csv>
```

Create the real assignment, paste the `gen-url.js` link into its description, upload the keys to
your LMS and **delete the local file**.[^keys] Give students
[`docs/guides/STUDENT-GUIDE.md`](docs/guides/STUDENT-GUIDE.md), and make the first quiz that
counts an ungraded practice run.

### Optional — the settings worth knowing

All in `courses/<id>/course.json`; every key has a `…Note` beside it explaining itself.

| | Default | |
|---|---|---|
| `questionsPerAttempt` | 3 | Questions in **one** recording, each timed and graded separately. 5 × 120 s is a ~12-minute recording — a lot to ask on a phone. |
| `limitSec` | 120 | Seconds **per question**, including reading and thinking. |
| `gradingBackend` | `local` | Which grader scores the answers. |

```bash
node tools/set-grading.js --course courses/<id> --show
node tools/set-grading.js --course courses/<id> --backend genai
```

`local` bundles a small open-weights model (Qwen 2.5 3B) into the autograder image, so transcripts
never leave the Gradescope container. It is the default because of **where it runs**, not because it
grades best — and if you only ever try `local`, you will underestimate what oral quizzes can do.

#### Use `genai` if your institution allows it

Measured on one real 100-question bank, 396 answers, both graders on the shipped code path:

| | ordering | inversions | ties | on a confidently **wrong** answer |
|---|---:|---:|---:|---:|
| `local` (Qwen 2.5 3B) | 74% | 15 / 594 | 24% | 2.7 / 10 |
| **`genai`** (Purdue GenAI Studio) | **94%** | **1 / 594** | **6%** | **0.4 / 10** |

They agree on 59% of answers outright and land within one band on 78%, and **every** large
disagreement is on a weak or wrong answer, with the local model the more generous one. So the
difference is not that `genai` marks good work better — it is that `local` struggles to reject bad
work. A fluent, confident answer to the *wrong question* still collects a quarter of the marks.

That matters for how you read your first run of results. If answers that should have failed come
back with partial credit, the honest diagnosis is usually the backend, not the format and not your
questions.

**What actually leaves the container:** the **transcript text only** — de-identified and
PII-redacted before it is sent. The **audio never leaves Gradescope**, and neither does the
student's name, email, or any identifier derived from one.

⚠️ It is still a service carrying **no FERPA certification**, so this is your institution's call,
not a default this project should make for you. If the answer is no, `local` needs no key, no
account and no network, and everything else in OralScale works identically.

#### Getting a Purdue GenAI key

1. Sign in at **[genai.rcac.purdue.edu](https://genai.rcac.purdue.edu)**.
2. Click the **account icon** (top right) → **Account**.
3. Find **API keys** and click **Show**.

Put it in `courses/<id>/.env` — inside the course folder, so the folder stays the whole course:

```
GENAI_STUDIO_API_KEY=<the key you just revealed>
GENAI_STUDIO_BASE_URL=https://genai.rcac.purdue.edu
GENAI_STUDIO_MODEL=qwen3.6:27b
```

All three are needed, and the key is read at **build** time and written into the autograder zip, so
rebuild and re-upload after changing any of them. `.env` is gitignored before anything secret is
generated; never commit it.

`heuristic` is keyword matching and grades markedly worse than either. There are **no fallbacks
between the three**: the grader you name is used, and if it cannot run, those submissions are
flagged for regrade rather than quietly scored by a different method — two students who said the
same thing must not be measured differently because one of them submitted during an outage.[^grader]

---

[^prereq]: Every command that needs wrangler runs `npx wrangler`, fetched on demand. No domain, no
credit card, no server, no AI API key. Python is only for running the test suite locally —
Gradescope brings its own.

[^demo]: A shared public demo would collide on namespace, and testing on someone else's course
teaches you nothing about yours. `demo-quiz` is not scaffolding to delete: it is where you re-test
after any change, and it costs one Gradescope assignment nobody grades.

[^private]: A bank holds your questions *and* their reference answers — publishing one ends the
assessment. `courses/<id>/` is gitignored by the engine and is meant to be its own private repo;
see [`courses/GOVERNANCE.md`](courses/GOVERNANCE.md).

[^launch]: `npm run launch` is `npm run deploy` then `npm run package`; both still work alone. It is
wrapped because the order matters and getting it wrong is silent — deploy writes `signerUrl` and
`webappUrl` back into `course.json`, and the zip has to carry them. A failed deploy stops before
packaging.

[^scoring]: There is no "highest score" option on a Programming Assignment — Gradescope grades the
**active** submission, newest by default. If a retake scores worse, the student re-activates their
best from Submission History. The student guide says so; this used to claim a setting that does not
exist.

[^why]: Everything up to the download can succeed while the Signer and the autograder hold
*different* secrets, and you would not know: that mismatch surfaces only at grading, as an entire
cohort scoring zero.

[^keys]: The export pairs student emails with credentials. A pre-commit guard refuses to commit it,
but it is dangerous while it exists. Keys are derived rather than stored, so regenerate them freely.

[^grader]: Two students who said the same thing must not be measured differently for having
submitted at different times. Full comparison:
[`GRADER-BACKENDS.md`](docs/reference/GRADER-BACKENDS.md).

## How it works
1. **Frozen question banks** (~100 principle-focused questions/week) are authored once with an LLM,
   then frozen — no AI at quiz time.
2. **One public link** in the Gradescope assignment description, plus a **personal quiz key** the
   instructor posts in Brightspace once per term. The key is the *only* thing a student enters —
   no email, no login — and it does two jobs: it proves they are enrolled (so nobody can script
   the public link and harvest the bank) and it *is* their identity, which the quiz server cannot
   read as a person. Their work is matched to them where they are already authenticated: at upload
   to Gradescope. Keys carry their own cryptographic proof, so there is no roster to sync anywhere.
3. The **web app records in the browser** — mic starts *before* the question appears; a spoken
   six-digit **boundary code** brackets every answer (one before the first question, one after each
   "I'm done with this question"); a server-authoritative clock bounds each window. Nothing
   interrupts the answer itself. An assignment asks **several questions in one recording**
   (3 × 2 min by default), each with its own timer, its own code, and its own grade — so one strong
   answer cannot cover a blank on another. Prompts support Markdown and LaTeX (rendered to MathML)
   without ever parsing HTML.
4. The student downloads one `.zip` (audio + signed certificate) and uploads it to **Gradescope**.
5. The autograder **verifies integrity** (signature, audio hash, time window, spoken-challenge
   timing), transcribes locally, and grades content with **Purdue GenAI**.
6. **Unlimited retakes**, each a fresh question. Gradescope grades the student's *most recent*
   upload, not their best;[^scoring] they re-activate the attempt they want from Submission History.

## Real-time integrity, briefly (see [threat model](models/06-threat-model.md))
- **Byte binding** — the certificate signs the audio's SHA-256; altered/swapped audio is rejected.
- **Window binding** — the server clock bounds reveal→finish; late submissions get no certificate.
- **Duration ≈ window** — a pre-recorded file longer than the live window is rejected.
- **Boundary liveness** — a server-timed code opens the recording and another is issued at each
  "I'm done", each only at its moment; all must appear in the transcript, matched with a one-digit
  error tolerance. The recording provably began after the reveal and ran through every boundary.
- **Enrolment-gated bank** — the quiz server serves a question only when the presented key's own
  MAC verifies against the signing secret, so the bank cannot be mined by an outsider. Keys are
  derived and self-authenticating: no roster ever reaches the edge, and there is nothing to sync.
- **No identity on the wire** — the server never receives an email or anything computed from one;
  the identity it derives from a key is keyed by a secret the browser never holds.
- **Unforgeable** — every token is HMAC-signed with a secret only the Signer and autograder hold.
- **Identity bound at submission** — a recording is graded only for the person Gradescope
  authenticated as its submitter, so forwarding a finished `.zip` earns nothing.
- **Anti-shopping** — a student who abandons a question without finishing waits before drawing
  another; finishing clears the wait instantly, so answering is never penalised.
- **Accepted residual** (formative use): script-reading and off-mic collusion. These are not
  prevented — they are handled by retained audio, post-hoc review, and a real 1-on-1 conversation
  when something looks off. Not a proctored-exam substitute, and not trying to be.

## Repository layout
```
models/     MAGE models (source of truth): domain, requirements+invariants, state machine,
            architecture, protocol flows, threat model, test model, measurement model
docs/        guides/    read start to finish (QUICKSTART, QUESTION-DESIGN, STUDENT, PILOT-PACKET)
             reference/ look things up (TEACHER, SETUP, GRADER-BACKENDS, LIVE-DEMO, HOSTING, bank schema)
             project/   the record (STATUS, DESIGN-QUESTIONS, MAGE, ONBOARDING, reviews/)
server/      Signer: signer.js (dev) + worker/ (Cloudflare prod) + lib/protocol.js
web/         static, mobile-first student app (capture-before-question, rolling nonce)
autograder/  Gradescope: verify identity + validate + transcribe + grade (Python)
courses/     per-course config AND banks — one private repo per course
             (demo/ ships and works out of the box; see courses/README.md)
tools/       config, URL/token gen, bank tooling, build scripts, tests
```

## Run it locally, with no accounts at all

Everything works offline first — no Cloudflare, no Gradescope, no API key.

```bash
npm install
node tools/setup.js --title "Trial Course"   # course + secret + starter bank + git repo
npm run signer                               # :8787   (terminal 1)
npm run web                                  # :8080   (terminal 2)
node tools/gen-url.js --course courses/trial-course-fall2026/course.json --assignment quiz-1
```

Open the printed link and take the quiz. `npm test` runs the full suite: crypto interoperability
between the JS Signer and the Python autograder, then an end-to-end honest-pass / attack-fail
system test.

**Grading runs inside Gradescope by default.** A small open-weights model is bundled into the
autograder image, so the transcript never leaves the container: no API key, no account, no outage.
Purdue GenAI Studio grades **markedly** better and is one word away in `course.json` — it receives
the redacted transcript text only, never the audio and never an identifier, but it carries no FERPA
certification, so it is offered as a choice rather than assumed. Either way,
`tools/calibrate-grader.py` checks a grader is consistent and ranks answers correctly *before*
students meet it.

## Documentation

**Public guides:** [OralScale overview](docs/public/site/index.html) ·
[Students](docs/public/site/student.html) · [Faculty](docs/public/site/faculty.html).
Each guide includes an illustrated Quickstart, FAQs, and a matching two-page printable PDF.
Maintenance: [public guide governance](docs/public/GOVERNANCE.md).

Three working-document folders, by **how a document is used** rather than what it is about — full index in
[`docs/README.md`](docs/README.md).

**[`docs/guides/`](docs/guides/) — read start to finish**

| | |
|---|---|
| **[QUICKSTART.md](docs/guides/QUICKSTART.md)** | Seven steps to a running quiz, ~1 hour. **Start here.** |
| **[QUESTION-DESIGN-GUIDE.md](docs/guides/QUESTION-DESIGN-GUIDE.md)** | What is worth asking aloud — the part that decides whether any of this is any good. |
| **[STUDENT-GUIDE.md](docs/guides/STUDENT-GUIDE.md)** | Give to students verbatim. |
| [PILOT-PACKET.md](docs/guides/PILOT-PACKET.md) | For invited pilot participants. |

**[`docs/reference/`](docs/reference/) — look things up**

[TEACHER-GUIDE](docs/reference/TEACHER-GUIDE.md) (every knob) ·
[SETUP-GUIDE](docs/reference/SETUP-GUIDE.md) (long-form quickstart) ·
[GRADER-BACKENDS](docs/reference/GRADER-BACKENDS.md) (which grader, measured) ·
[LIVE-DEMO](docs/reference/LIVE-DEMO.md) (deployment chain + failure table) ·
[HOSTING](docs/reference/HOSTING.md) ($0) ·
[bank-generation-spec](docs/reference/bank-generation-spec.md) (bank schema) ·
[courses/GOVERNANCE](courses/GOVERNANCE.md) (what lives in a course folder)

**[`docs/project/`](docs/project/) — the record, for maintainers**

[STATUS](docs/project/STATUS.md) (engineering handoff) ·
[DESIGN-QUESTIONS](docs/project/DESIGN-QUESTIONS.md) (every decision and why) ·
[MAGE](docs/project/MAGE.md) (the method) ·
[ONBOARDING](docs/project/ONBOARDING.md) (cold start) ·
[MOTIVATION](docs/project/MOTIVATION.md) · [SPECIFICATION](docs/project/SPECIFICATION.md) ·
[PILOT-RELEASE-PLAN](docs/project/PILOT-RELEASE-PLAN.md) ·
[PARKING-LOT](docs/project/PARKING-LOT.md) · [reviews/](docs/project/reviews/)

And [`models/`](models/README.md) — not documentation *about* the system but the **source of truth**
for its behaviour, invariants and tests.

## Status & tests
`npm test` runs component (crypto/interop, identity parity) + full system E2E with an **attack
suite** (pre-recording, audio-swap, forgery, late-submit, missing-challenge, certificate-resale,
DoS — all must fail to earn credit). Current state and the invariant→test board: [docs/project/STATUS.md](docs/project/STATUS.md).

## Portability
Everything course-specific lives in `courses/<id>/` (config **and** banks). Porting to another course is
data-only — no code changes.

A course folder is self-contained on purpose, so it can be **its own private git repository**
cloned into `courses/`. That is the recommended setup, and the tools will nag until it is: a
question bank holds the questions *and* the reference answers, so a public bank is a bank your
students have read. `.gitignore` allow-lists `courses/`, which means a course folder you create is
private by default. See **[courses/README.md](courses/README.md)**, and
**[courses/AGENTS.md](courses/AGENTS.md)** for the agent-guided path from lecture material to a
validated bank.

## Status: alpha, invited pilot

`0.1.0-alpha.1`. This is **experimental software shared with a small group of invited faculty.**
It has been run in one course by its author, and it has not been independently audited or
institutionally certified anywhere.

**Read [DISCLAIMER.md](DISCLAIMER.md) before using it with students.** In particular: automated
grading is an aid and not a decision-maker, and **accommodations are handled case by case** — there
is no single prescribed alternative format yet for a student who cannot use a spoken modality.
Extended time is supported; beyond that, work with your own disability services office as you would
for any assessment format, and **please tell us what you did** — deriving the general answer from
real cases is part of what this pilot is for.

[PRIVACY.md](PRIVACY.md) describes exactly what moves where, so your privacy office has facts to
evaluate rather than claims. OralScale makes no compliance determination on any institution's
behalf.

Found a bug? [Open an issue](../../issues/new/choose) — but never paste student data, secrets,
quiz keys, or bank content. Security problems go through
[private reporting](SECURITY.md), never a public issue.

## Licence and credit

MIT — see [LICENSE](LICENSE). Copyright © 2026 David I. Inouye.

You are free to use, modify, and redistribute this, including in your own courses, with no
obligation beyond keeping the copyright notice. If you find it useful, an acknowledgement in your
course materials or a link back to this repository is genuinely appreciated — not required, just
the kind of thing that helps a project like this find the colleagues it is for. If you build on the
design in published work, [CITATION.cff](CITATION.cff) has the citation.

Created by **[David I. Inouye](https://www.davidinouye.com)**, Purdue University.
