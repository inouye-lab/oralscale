# OralScale — Cold-Start Onboarding (read this first)

You are joining the **OralScale** project with no prior context. This one file orients you
end-to-end. Read it, then the three files in **§2**, and you can work productively. It assumes
nothing from any previous chat.

---

## 1. What this is (and why)
OralScale delivers **scalable, privacy-preserving oral assessment** using the tools Purdue
already provides. A student opens a personal link, is asked a random question from a frozen bank,
and **speaks a 2–3 minute answer in the browser**. A cryptographic certificate proves the
recording was made **live** (not pre-recorded or fetched). The audio is uploaded **only to
Gradescope** (the FERPA system of record) and graded automatically by a Gradescope autograder that
calls **Purdue GenAI**. Unlimited retakes, each a fresh question.

**Why it exists:** the course redesign it serves argues AI has broken the old proxies for learning
— "a polished AI-assisted artifact no longer proves a principle was learned." Real-time, unassisted
oral explanation is a proxy AI can't fake, but oral exams never scaled. OralScale makes them scale
to hundreds of students at ~$0 and near-zero instructor time.

**Built with MAGE** (Model-based Agentic Software Engineering): the models in `models/` are the
**source of truth**. Code is written to satisfy them; if code and model disagree, that's a bug to
fix in one place or the other.

## 2. Start here — read these, in order
1. [`README.md`](../../README.md) — the front door (what/why/how, quick start).
2. [`AGENTS.md`](../../AGENTS.md) — the house rules you must follow. (`CLAUDE.md` is a one-line
   import of it: Claude Code reads `CLAUDE.md`, not `AGENTS.md`, so the pointer keeps one source.)
3. [`models/README.md`](../../models/README.md) — the model set (the source of truth) and how it stays current.
Then skim [`docs/project/STATUS.md`](STATUS.md) (current state / handoff) and
[`docs/project/DESIGN-QUESTIONS.md`](DESIGN-QUESTIONS.md) (open decisions, each already proceeding on a
best-guess). **Do this before changing anything.**

## 3. Run & test in 60 seconds (no cloud accounts needed)
Requires **Node 18+** and **Python 3.8+**.
```bash
node tools/make-config.js     # generate server/config.json with a random signing secret (gitignored)
npm test                      # component (crypto interop) + full system/attack suite — must be green
npm run test:banks            # 1/1 demo bank valid
# run it live:
npm run signer                # Signer on :8787   (terminal 1)
npm run web                   # web app on :8080  (terminal 2)
node tools/gen-url.js --assignment demo-oral --student you@purdue.edu   # open the printed link
```
If `npm test` is green, your environment is correct. (No third-party npm deps; everything uses
Node/Web Crypto and Python stdlib.)

## 4. Architecture at a glance
Three components across three trust zones (details: [`models/04`](../../models/04-architecture-and-zones.md)):
```
[Student browser]              [Edge: Signer]                 [Purdue: Gradescope + GenAI]
 web/ (static, mobile) ──hash+timing──► server/ (stateless)   autograder/ (mint URL, validate, grade)
 records audio, hashes it       signs tokens, checks clock     verifies certificate, transcribes,
 audio NEVER leaves the tab     never sees audio               grades with Purdue GenAI
        └──────────────── uploads .zip (audio + certificate) to Gradescope ─────────────────┘
```
The integrity idea (why it can't be faked) — see [`models/05`](../../models/05-protocol-flows.md) and
[`models/06`](../../models/06-threat-model.md):
- Recording **starts before the question appears** (capture-before-question).
- A **server-timed rolling challenge code** every ~45s must be spoken → the *whole* recording is
  pinned to real time, verified against transcript word-timestamps.
- The certificate signs the audio's **SHA-256** and a **server-clock window**; a late or
  pre-recorded (too-long) file is rejected.
- Every token is **HMAC-signed** with a secret only the Signer and autograder hold.

## 5. How to make changes (the MAGE loop)
1. **Model first.** Find the relevant model in `models/` and edit it in the same change.
2. **Invariants ↔ tests.** Every hard property is an `INV-…` id in
   [`models/02`](../../models/02-requirements-and-invariants.md) with a test in
   [`models/07`](../../models/07-test-model.md). New property → new INV + new test.
3. **Implement**, keeping the [House Lexicon](../../models/01-domain-model.md) vocabulary.
4. **Gate:** `npm test` green, touched invariants still pass.
5. **Log decisions** in [`docs/project/DESIGN-QUESTIONS.md`](DESIGN-QUESTIONS.md) with a best-guess and
   proceed — never block waiting on the instructor.
6. **Update** [`docs/project/STATUS.md`](STATUS.md) as a handoff for the next session.

## 6. Current status (as of this handoff)
**Done (v2, all committed on `main`, `npm test` green):**
- Models 01–08; Signer v2 (Node + Cloudflare Worker + optional D1); mobile web app; autograder v2
  (mint URL + validate + GenAI grade); **a demo question bank (real course banks live in private course repos)**;
  student/teacher/hosting guides; use-case + UX/teaching-effort audits.
- Tests: 6/6 component, 9/9 system + attack suite (all attacks rejected), 14/14 banks, real-course
  integration (`npm run test:course`).

**Not done / next (good first tasks):**
- **Real-device mic matrix** — actually record on an iPhone/Android/laptop (the one thing not
  verifiable in a headless environment). Checklist in [`TEACHER-GUIDE.md`](../reference/TEACHER-GUIDE.md).
- **Open design questions** in [`DESIGN-QUESTIONS.md`](DESIGN-QUESTIONS.md); the one flagged 🔴 is
  **D2c: a full accessibility pass**. **B1** (single- vs two-Gradescope-assignment flow) is the main
  UX decision.
- A `deploy:week` one-command wrapper to cut per-week teacher steps (see UX audit P2).

## 7. Conventions & gotchas (read before you trip on these)
- **Secrets are gitignored.** A fresh clone has no `server/config.json` — run `node tools/make-config.js`.
  Never commit `server/config.json`, `.env`, or `autograder/source/secret.env`. Never put a secret,
  API key, or PII in the repo, the web bundle, logs, or URLs.
- **Audio only goes to Gradescope.** The Signer/DB store only hashes, ids, timestamps — never audio.
- **JS ↔ Python must stay byte-compatible on tokens.** `server/lib/protocol.js` and
  `autograder/source/protocol.py` sign/verify identically; `tools/test-unit.js` guards this. If you
  touch signing, run it.
- **Build artifacts are generated, not committed:** `server/worker/bundle.json`,
  `autograder/source/course.json`, `autograder/source/banks/`. Regenerate with
  `npm run build:worker` / `npm run build:autograder` after changing banks or a course config.
- **Question banks are frozen.** AI authors them once (`docs/reference/bank-generation-spec.md`); no AI at quiz
  time. Course-specific data lives only in `courses/<id>/` (config **and** banks) — code stays generic.
- **The access gate fails CLOSED, and the key IS the identity.** `requireAccessKey` defaults to
  `true` everywhere (Signer, Worker, autograder) — an assignment that says nothing about it is
  gated. In that mode the browser sends **only the key**; the Signer derives `studentRef = k:<sid>`
  from it, and any client-supplied ref is ignored. Most demo assignments opt out explicitly so the
  local walkthrough needs no handout; run
  `node tools/gen-access-keys.js --course <course.json> --student you@purdue.edu` to exercise the
  real path (`demo-keyed`, `demo-browser`).
- **Question prompts are rendered, not printed.** Markdown + LaTeX go through
  `web/js/richtext.mjs`, which builds DOM from a whitelisted spec tree — there is no `innerHTML`
  on that path and there must never be one (INV-SEC-6, `t_richtext_safe`). It is `.mjs` only so
  Node's unit tests can import it.
- **`questionsPerAttempt` is live config again** (decision A1 was reopened 2026-08-20). N = 1 is
  byte-identical to the old single-question flow, including code derivation, so treat N > 1 as the
  case to test when touching the Signer, the app loop, or the autograder's transcript slicing.
- **No new runtime dependencies** without a note in STATUS — prefer standard library.

## 8. Repo map
```
models/      MAGE models = source of truth (01 domain … 08 measurement)
docs/        ONBOARDING (this), MAGE.md, STATUS, DESIGN-QUESTIONS, PARKING-LOT,
             SETUP-GUIDE + QUESTION-DESIGN-GUIDE (instructor onboarding),
             GRADER-BACKENDS (which grader, measured),
             STUDENT/TEACHER guides, reviews/
server/      Signer: signer.js (dev) · worker/ (Cloudflare prod) · lib/protocol.js
web/         static, mobile-first student app (capture-before-question, rolling nonce)
autograder/  Gradescope: source/ (mint URL, validate, transcribe, grade) + build.sh
courses/     per-course config AND frozen banks — courses/<id>/{course.json,banks/}
             Each real course is its OWN PRIVATE REPO cloned here; the engine repo
             ships only demo/, _template/ and _shell-for-testsuite/. See courses/README.md.
tools/       setup (first-run wizard), make-config, gen-url, gen-access-keys,
             validate-bank(s), build-worker/autograder, tests, demo-e2e
tools/eval/  grader calibration set + runner (small-model vs Purdue GenAI)
             calibrate-grader.py qualifies a grader and fits its scale
tests-as-scripts: tools/test-unit.js, tools/demo-e2e.js, tools/test-course-smoke.js
```

## 9. Command reference
| Command | Does |
|---------|------|
| `npm run setup` | first-run wizard: writes a course, a design brief, a secret, and points at the starter bank |
| `node tools/make-config.js` | create signing secret (`server/config.json`) |
| `npm test` | component + full system/attack suite |
| `npm run test:banks` / `test:course` | validate all banks / real-course integration |
| `npm run signer` / `npm run web` | run Signer (:8787) / web app (:8080) locally |
| `node tools/gen-url.js --assignment <id> --student <email>` | mint a test quiz link |
| `node tools/gen-access-keys.js --course <course.json> --roster <csv>` | mint the per-student quiz keys that gate the bank (INV-SEC-8) |
| `node tools/validate-bank.js <path>` | validate one bank + show distribution |
| `npm run build:worker` / `build:autograder` | bundle a course for deploy |
| `node tools/set-grading.js --course courses/<id> --show` | see / change the grading backend, local model, or a per-assignment score bonus |
| `python3 tools/calibrate-grader.py --course courses/<id> --backend local` | qualify + calibrate a grader (consistency, ranking, scale) and write `calibration.json` |
| `python3 tools/eval/bench.py --grader genai --per-bank 8` | compare graders across all 16 banks (needs `GENAI_STUDIO_*`, and `ORALSCALE_LOCAL_URL` for the local one). `--compare a.json b.json` prints the head-to-head; see [GRADER-BACKENDS.md](../reference/GRADER-BACKENDS.md) |
| `python3 tools/backfill-gradability.py courses/<course>/banks/*.json` | add referenceAnswer / scoringBands / commonErrors to existing banks |
| deploy | see [`docs/reference/TEACHER-GUIDE.md`](../reference/TEACHER-GUIDE.md) + [`docs/reference/HOSTING.md`](../reference/HOSTING.md) |

---

## 10. Kick off a fresh chat with this prompt
Paste this into a new ChatGPT or Claude session opened in this repo:

> I'm continuing work on **OralScale**, a system for scalable oral quizzes (static web app +
> stateless Signer + Gradescope autograder, built with MAGE). **Before doing anything**, read
> `docs/project/ONBOARDING.md`, then `README.md`, `AGENTS.md`, and `models/README.md`, then check
> `docs/project/STATUS.md` for current state and `docs/project/DESIGN-QUESTIONS.md` for open decisions. Follow the
> MAGE loop: change the relevant model in `models/` first, keep every `INV-` invariant tied to a
> test, run `npm test` (must stay green), and log any new decision in `docs/project/DESIGN-QUESTIONS.md`
> with a best guess rather than blocking. My task for this session is: __________.
