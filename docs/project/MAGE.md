# MAGE — Model-Based Agentic Software Engineering

A practical, distilled reference for building a software product the MAGE way.

Source: James Davis, "Model-Based Agentic Software Engineering (MAGE)," Medium, Aug 2026,
plus the MAGE project site and quick-start. Links in the last section.

> This is a working reference for engineers who will *follow* MAGE. It merges the
> theory from the blog post with the concrete artifact catalogue and adoption steps
> from the MAGE website/quick-start.

---

## 1. Core thesis and motivation

**The problem.** For all of software history, *implementation capacity was scarce*, and
that scarcity shaped how we work. Agents change the economics: implementation is now
cheap and abundant, so the bottleneck moves *upstream* to engineering judgment —
deciding what to build, representing the system well enough to reason about it, defining
what "correct" means, and keeping a fast-changing system coherent.

**The central shift.** *When agents write the code, the environment in which they work
determines its quality.* The engineer's leverage moves from producing each
implementation to **engineering the conditions under which implementations are produced.**
Keystrokes are delegated; accountability is not.

**The thesis in one line.** Don't engineer the agent — **engineer the environment the
agent acts in.** Do it with two complementary ideas plus one repeated operation:

- **Modeling** — make intent *explicit* as structured, machine-readable models the
  agent reasons *through* instead of reasoning directly over raw code.
- **Alignment** — give that intent *authority* via mechanisms that constrain actions,
  produce evidence, validate it, and control admission into the product.
- **Governance Conversion** — turn each recurring failure/lesson into durable structure
  (a lint, constraint, model, validator, or gate) that every future agent inherits.

Modeling gives the agent the right *context* to reason with; Alignment lets you pick the
right *validation* for the job. Over time this accumulates as **engineering capital** —
prior judgment that later work inherits automatically. The alternative is **churn**:
rediscovering context, repairing regressions, and re-solving yesterday's problems.

Contrast with "surround agents with tests" (Uncle Bob): MAGE argues tests give intent
*authority* but don't tell the agent *what to reason through* — the missing piece is the
**models**.

Two supporting arguments worth remembering:
- **Reasoning Horizon.** Finite reasoners (human brains, model context windows) have
  finite fast working state. A model is a *purposeful compression* that preserves the
  relationships needed to answer a class of engineering questions while discarding
  irrelevant detail — extending effective reasoning reach.
- **Model floor & substitutability.** Stronger engineered structure lets *weaker/cheaper*
  models do useful work (lowering the "model floor"). A maturity test: if you swap in a
  different sufficiently-capable model and quality holds, your quality lives in the
  environment, not in one proprietary reasoner. If quality collapses, you're over-reliant
  on probabilistic reasoning.

---

## 2. The models MAGE prescribes

MAGE is deliberately *not* a fixed template list — the rule is: **"What are the models in
your context, and how do you enforce alignment to them?"** But it names **five common
classes of model** and a concrete artifact catalogue.

### 2a. The five common classes of models
A model is a *structured approximation of a system that engineers and agents reason
through instead of reasoning over the raw implementation.* Each answers a class of
engineering questions more cheaply than reconstructing the answer from code.

| Class | Captures | Answers / Purpose | Representation |
|---|---|---|---|
| **System knowledge graph** | Typed entities + relationships: dependencies, ownership, lineage | "What connects to what? Who owns this? What breaks if I change X?" | Typed nodes/edges, machine-readable graph |
| **Architectural model** | Components/zones, service flows, deployment topology | "What are the boundaries and layers? How does data/control flow?" | Typed component/zone/flow/topology views |
| **State machine** | Legal states and transitions of the system or a component | "What states exist? Which transitions are legal?" | Explicit state/transition spec (executable) |
| **Policy model** | Obligations/rules the system must uphold (e.g. every endpoint has an authz policy) | "What must always be true? What is prohibited?" | Machine-checkable policy/invariant list |
| **Measurement model** | What is measured and how (metrics, SLAs, WCET-style params) | "What do we observe, and against what target?" | Typed measurement/metric definitions |

**Rule for a good model:** make it structured enough that (a) agents can *reason through*
it, (b) generators can *consume* it, and (c) automated checks keep model and
implementation from *silently diverging*. One artifact then serves four roles at once:
reasoning interface, specification, generation source, and assurance surface.

### 2b. Concrete artifact catalogue (from the quick-start)
The artifacts to actually create and maintain in a repo:

| Artifact | What it is | Purpose |
|---|---|---|
| **`AGENTS.md`** (house-rules) | The AI-first method + a curated **rule index** | Governs agent behavior; central house-rules file. `CLAUDE.md` imports it, because Claude Code reads only `CLAUDE.md` — one source, no drift |
| **System models** | Executable, typed data: *state-machine, component/zone, service-flow, deployment-topology* views | Executable "source of truth" agents read every run; cite real files to prevent drift |
| **Agent Brief** | Dispatch/task template with required markers | The unit of work handed to an agent; lint-gated before launch |
| **Epic** | Multi-step effort tracker with a **Definition-of-Done** | Track and bound larger efforts |
| **Design Doc** | Implementation-plan template (has Definition-of-Done) | Plan before build; human-approvable |
| **Handoff** | Machine-generated context carrier across sessions | Preserve context between agent runs |
| **Operational Playbook** | Situation-keyed manual: symptom → cause → fix | Repair guidance for the highest-failure substrate |
| **House Lexicon** | Terms with one consistent meaning across the codebase | Kill ambiguity; enforce a shared engineering register |

**Rule for the `AGENTS.md` rule index** — a mechanism earns inclusion only if it is:
1. **Regression-preventing**, 2. **Not derivable from local code**, and 3. **Non-local**.
(Otherwise it's noise; keep the index lean.)

---

## 3. Alignment mechanisms (how intent gets authority)

Alignment encodes engineering obligations into **authoritative mechanisms**. You don't
control the agent's internal reasoning — you control the *observable boundaries*: what
state it sees, which actions it may take, how success is evaluated, and whether its result
advances. Four mechanism kinds:

| Mechanism | Role | Example |
|---|---|---|
| **Constraint** (preventive) | Restrict what *can* happen | type system, permission scope, narrow API, sandbox syscall allowlist — costs *zero* failed iterations |
| **Sensor** (observational) | Produce evidence about what *did* happen | static/dynamic analysis, metric, trace, call/log scan |
| **Validator** | Evaluate that evidence against an obligation | test suite, model checker, conformance checker, or an *agent/human judgment* |
| **Gate** | Control admission | CI rule blocking merge/deploy unless required validators pass |

Mechanisms may be **deterministic** (mechanically checkable) or **judgment-laden**
(checked by an agent or a human escalation). What varies is *who* judges; what stays
constant is the obligation's **authority** over the process.

**Four layers where you can place mechanisms** (steer at the cheapest correct level):
1. **Foundation-model interaction** (the model call / prompt)
2. **Agent harness** (runs the agent, manages context window)
3. **Engineering environment** (git, hooks, CI)
4. **Application** (codebase, tests, CI rules)

---

## 4. The process / workflow

### 4a. The MAGE loop (the operating cycle)
Two reinforcing loops turning on a shared axis:

1. **Model** intent into explicit, structured representations (the *knowledge loop*).
2. **Align**: attach constraints/sensors/validators/gates so obligations have authority.
3. **Run** the agent fleet to do implementation; the agent reasons *through* the models.
4. **Observe failures.** When something breaks, diagnose *what was missing*: knowledge,
   obligation, evidence, judgment, or consequence.
5. **Governance Conversion** (the *governance loop*): encode the lesson as durable
   structure (lint/constraint/model/validator/gate) so every future agent inherits it.
6. Result accumulates as **engineering capital** → higher velocity → faster arrival at the
   next novel, judgment-laden failure. Repeat.

**Human vs. agent division of labor:**
- **Human:** authors/architects models, confirms assumptions, defines acceptable
  evidence, approves writes, maintains the lexicon, and decides which judgments become
  machinery. Human attention is reserved for *novel* failures, ambiguous trade-offs, and
  architecture — not repeat inspection.
- **Agent:** reads the catalogue/models on every run, proposes adaptations, does
  implementation, audits against known failure classes, and generates documentation/drafts.
- **Default posture / gate:** *"Advise only; change nothing"* until a human greenlights a
  write.

### 4b. Adoption sequence (bootstrapping MAGE in a repo)
1. Integrate the AI-first method into existing governance docs (`AGENTS.md`).
2. Audit the repo against the artifact catalogue; mark each item **adopt / adapt / skip**.
3. Model system topology using the provided scaffolds (state-machine, component/zone,
   service-flow, deployment-topology).
4. Add **brief linting** — validate agent briefs *before* dispatch.
5. Wire operator-loop hooks (reflection, memory-routing, banking) — *skill path only*.
6. Adopt **Epic / design-doc / handoff** templates and wire their generators.
7. Draft an **operational playbook** for the highest-failure substrate.
8. Bootstrap the **house lexicon**; audit prose against the engineering register.

**Quick-win entry points** (start small):
- Running multiple agents → add a **brief-linting gate + pre-commit hook**.
- "Unrelated" things keep breaking → make **executable system-models the source of truth**.
- User-facing work → add a **content validator + repair vocabulary**.

---

## 5. Keeping models in sync (and inspectable later)

The historic reason teams distrusted models: keeping a representation synced with fast-
changing code was too expensive, so a stale diagram became worse than useless. **Commodity
intelligence removes that maintenance cost.** Agents can regenerate representations,
reconcile them against implementation, update projections, and run **drift checks**
continuously.

Concrete sync mechanics MAGE relies on:
- **Executable, typed models** — not prose diagrams. They govern both codebase behavior
  and agent reasoning.
- **Models cite real files** — each model element points at the implementation it
  describes, so divergence is detectable.
- **Drift detection as a mechanism** — a sensor+validator+gate combination keeps
  model↔code correspondence; mechanically maintained correspondence is the top rung of the
  representation ladder.
- **Agents read models every run** — the model is *in the loop*, not beside it, so it
  can't quietly rot.

**Why this makes later human change possible:** because intent is *explicit and
addressable* (not implicit and only rediscoverable), a human can inspect a model, change
an obligation, and let validators/gates propagate and enforce the consequences — rather
than reverse-engineering intent from raw code. Models become "working infrastructure,"
not documentation.

---

## 6. Principles, rules, and anti-patterns

**Principles**
1. **Engineer the environment, not the agent.** The important object is the *distribution
   of responsibility* between probabilistic reasoning and the engineered environment.
2. **Move each kind of work to its cheapest durable home:** knowledge → models;
   procedure → skills; permissible action → constraints; judgment → validators; authority
   → gates. Each move reduces what the model must get right unaided.
3. **Prefer constraints over sensors** where possible — a constraint costs *zero* failed
   iterations; a sensor needs at least one failure to act on.
4. **Governance Conversion over repeated repair.** If you catch the same defect class
   twice, don't become a faster reviewer — make the *environment* catch it.
5. **Model substitutability is a maturity test.** Quality should survive swapping the
   underlying model. If it collapses, you're over-reliant on the reasoner.
6. **Steer at the cheapest correct semantic level** (model call / harness / env / app).
7. **Keep the rule index lean** — include a mechanism only if it's regression-preventing,
   non-derivable-from-local-code, and non-local.

**Anti-patterns**
- **Churn** — rediscovering context, repairing regressions, re-solving old problems
  because lessons never became durable structure.
- **Trapping agents in the IDE** — limits impact to the "15% of time spent typing";
  MAGE is about getting agents *out* of the IDE without losing control.
- **Stale prose models** — a diagram nobody trusts. Use executable, drift-checked models.
- **Heavyweight up-front design** — MAGE is *not* a retreat to big design up front; models
  are viable precisely because they now evolve at agentic speed.
- **Human review as the primary quality scaler** — can't scale when agents out-produce
  reviewers; move human judgment to novel/ambiguous problems.
- **Launching under-specified agent briefs** — refuse to launch a brief missing required
  markers.

---

## 7. Artifact checklist for *this* repo

Minimum viable MAGE setup to create and maintain:

- [ ] **`AGENTS.md`** with the AI-first method + a lean, curated rule index (plus a `CLAUDE.md` that imports it).
- [ ] **System models** as executable typed data:
      state-machine, component/zone, service-flow, deployment-topology — each citing real
      files.
- [ ] **Agent Brief template** + a **brief-linting** pre-dispatch gate.
- [ ] **Epic** and **Design Doc** templates, each with a **Definition-of-Done**.
- [ ] **Handoff** generator for cross-session context.
- [ ] **Operational Playbook** (symptom → cause → fix) for the riskiest subsystem.
- [ ] **House Lexicon** of canonical terms + a prose/register audit.
- [ ] **Alignment mechanisms**: constraints (types/permissions/sandbox), sensors
      (analyses/metrics), validators (tests/checkers/agent-judgment), gates (CI merge/deploy
      blocks), including a **model↔code drift check**.
- [ ] A **Governance Conversion habit**: when a failure recurs, encode it as a durable
      mechanism instead of just fixing the instance.

---

## 8. Linked resources, tools, and skills

From the article and site:

- **MAGE website (overview, manuscript, case studies):**
  https://davisjam.github.io/model-based-agentic-software-engineering/
- **MAGE book:** https://davisjam.github.io/model-based-agentic-software-engineering/book/index.html
- **Quick-start (Claude skills, adoption steps):**
  https://davisjam.github.io/model-based-agentic-software-engineering/quick-start.html
- **"Cheap Code, Costly Judgment" (paper):** https://arxiv.org/pdf/2607.01087
- **Claude skills** — reusable procedure encoded for agent work (install path noted below).
- **DocAble** — the production system MAGE was originally induced from.
- **ScholAccess:** https://scholaccess.com
- Background references cited: ACM Queue (Butler et al.) https://queue.acm.org/detail.cfm?id=3807963 ;
  "Semantic gap" https://en.wikipedia.org/wiki/Semantic_gap
- **Case-study systems examined in the book:** Cloudflare, Shopify, Spotify, Docker,
  Siemens, Zenseact (six independent agent-development approaches).
- **Install (skill path):** `/plugin install mage@agent-governance-mechanisms`
  (auto-triggers; ships partner skills for governance / operations / communication).
  DIY path: vendor the catalogue folder and adapt by hand.

**Companion posts / related work (by same author + peers):**
- James Davis, "Governing Agents and the Future of Software Engineering," Medium, Jul 2026:
  https://davisjam.medium.com/governing-agents-and-the-future-of-software-engineering-075cc72e9882
  — companion framing on *governance*: as agents produce faster, quality must scale through
  governed environments and mechanism design rather than human inspection (the same
  Governance-Conversion idea applied at org scale).
- Other agentic-SE books referenced: Ahmed Hassan, https://agenticse-book.github.io/ (2026);
  Kla Tantithamthavorn, https://book.agentic-swe.dev/ (2026).

---
*Distilled from the primary Medium article and the MAGE project site. Where the blog was
conceptual, concrete artifacts/steps were pulled from the MAGE quick-start and catalogue.*
