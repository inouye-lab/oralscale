# Documentation

Start with the [public OralScale guides](public/site/index.html) for polished Student and Faculty
Quickstarts, FAQs, and matching printable PDFs. Their maintenance contract is
[public/GOVERNANCE.md](public/GOVERNANCE.md).

The three working-document folders below serve different purposes.

| | | |
|---|---|---|
| **[`guides/`](guides/)** | **Read start to finish.** Written to be followed once, in order. | You are setting up or running a course. |
| **[`reference/`](reference/)** | **Look things up.** Complete rather than readable; nobody reads these front to back. | Something did not behave as the guide said, or you want a knob the guide did not mention. |
| **[`project/`](project/)** | **The record.** How the system got this way and why. Not needed to run a course. | You are changing the code, or you want to know why a decision went the way it did. |

---

## `guides/` — read these

| | |
|---|---|
| [QUICKSTART.md](guides/QUICKSTART.md) | Seven steps to a running quiz, ~1 hour. The two that need a human are called out. **Start here.** |
| [QUESTION-DESIGN-GUIDE.md](guides/QUESTION-DESIGN-GUIDE.md) | What is worth asking aloud. The part that decides whether any of this is any good. |
| [STUDENT-GUIDE.md](guides/STUDENT-GUIDE.md) | Give to students verbatim. Read it yourself first — it is what you are asking them to do. |
| [PILOT-PACKET.md](guides/PILOT-PACKET.md) | For invited pilot participants: what you have, what it is not, and the order to do things in. |

## `reference/` — look things up

| | |
|---|---|
| [TEACHER-GUIDE.md](reference/TEACHER-GUIDE.md) | Every knob, the per-week workflow, grading, and when to intervene. |
| [SETUP-GUIDE.md](reference/SETUP-GUIDE.md) | The long-form quickstart, with every option explained. |
| [GRADER-BACKENDS.md](reference/GRADER-BACKENDS.md) | Which grader to use, **measured**: local vs Purdue GenAI vs keyword, with memory footprints and the FERPA position. |
| [LIVE-DEMO.md](reference/LIVE-DEMO.md) | The deployment chain in order, with a failure table. |
| [HOSTING.md](reference/HOSTING.md) | Hosting options and costs (the answer is $0). |
| [bank-generation-spec.md](reference/bank-generation-spec.md) | The question-bank JSON schema. Feed to an LLM alongside the design guide. |

Also reference, and not in this folder because it belongs beside what it governs:
[`../courses/GOVERNANCE.md`](../courses/GOVERNANCE.md) — what lives in a course folder, what is
never committed, and why.

## `project/` — the record

| | |
|---|---|
| [STATUS.md](project/STATUS.md) | Rolling engineering handoff: what was built, what broke, what was decided. Long by design; newest first. |
| [DESIGN-QUESTIONS.md](project/DESIGN-QUESTIONS.md) | Every design decision, open and settled, with its reasoning. |
| [MAGE.md](project/MAGE.md) | The model-based method this repository is built with. |
| [ONBOARDING.md](project/ONBOARDING.md) | Cold-start briefing for a new contributor or AI assistant. |
| [MOTIVATION.md](project/MOTIVATION.md) · [SPECIFICATION.md](project/SPECIFICATION.md) | Why it exists; what v1 promised. |
| [PILOT-RELEASE-PLAN.md](project/PILOT-RELEASE-PLAN.md) | Release checklist and what is still open. |
| [PARKING-LOT.md](project/PARKING-LOT.md) · [IMPLEMENTATION_PLANS.md](project/IMPLEMENTATION_PLANS.md) | Deferred ideas; historical plans. |
| [reviews/](project/reviews/) | UX audit and use-case walkthroughs. |

---

## Not in `docs/`

Some documents live next to what they describe, on purpose — a reader who finds the code should
find the rules with it.

| | |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | House rules for any AI assistant. `CLAUDE.md` imports it, because Claude Code reads only `CLAUDE.md`. |
| [`../models/`](../models/README.md) | The MAGE models — **the source of truth** for behaviour, invariants and tests. Not documentation *about* the system; the specification *of* it. |
| [`../courses/GOVERNANCE.md`](../courses/GOVERNANCE.md) | What belongs in a course folder. |
| [`../DISCLAIMER.md`](../DISCLAIMER.md) · [`../PRIVACY.md`](../PRIVACY.md) · [`../SECURITY.md`](../SECURITY.md) | Read the first two before using this with real students. |

## Adding a document

Put it in the folder that matches **how it will be used**, not what it is about:

- Will someone follow it once, in order? → `guides/`
- Will someone arrive mid-way looking for one fact? → `reference/`
- Is it a record of what happened or why? → `project/`

Then add a row here. A document nobody can find is a document nobody reads.
