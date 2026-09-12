# OralScale Models (MAGE)

These are the **living models** for OralScale, built and maintained per
[Model-Based Agentic Software Engineering](../docs/project/MAGE.md). They are the
source of truth: code is written to satisfy them, and when code and model
disagree that is a **drift bug** to fix in one place or the other.

MAGE in one line: *engineer the environment, not the agent* — make intent explicit
as models, give the models authority through tests/gates, and convert every
recurring failure into durable structure.

## The model set

| # | Model | Captures | MAGE class |
|---|-------|----------|-----------|
| [01](01-domain-model.md) | Domain | Entities, relationships, vocabulary | Knowledge graph |
| [02](02-requirements-and-invariants.md) | Requirements & Invariants | Functional reqs + the hard, testable properties | Policy + measurement |
| [03](03-state-machine.md) | State machine | The attempt lifecycle and legal transitions | State machine |
| [04](04-architecture-and-zones.md) | Architecture & trust zones | Components, trust boundaries, deployment | Architectural + deployment |
| [05](05-protocol-flows.md) | Protocol flows | Capture-before-question + unique-URL sequences | Service-flow |
| [06](06-threat-model.md) | Threat model | Attacker capabilities, attacks, mitigations, residual risk | Policy |
| [07](07-test-model.md) | Test model | Requirement → test traceability | Measurement/validator |
| [08](08-measurement-model.md) | Measurement | UX + teaching-effort metrics and targets | Measurement |

Related living docs: [DESIGN-QUESTIONS](../docs/project/DESIGN-QUESTIONS.md) (open decisions,
each with a best-guess the build proceeds on), [STATUS](../docs/project/STATUS.md) (handoff /
current state), [MAGE.md](../docs/project/MAGE.md) (methodology reference),
the course's own `curriculum-analysis.md`, which lives in that course's private folder (question-bank source).

## How these stay current (the loop)
1. **Model intent** — a change starts by editing the relevant model here.
2. **Align** — invariants in [02] get a test in [07]; the CI/self-test gate enforces them.
3. **Run** — implement to the model.
4. **Observe** — a failure/attack that slips through means a model was missing or wrong.
5. **Govern** — encode the lesson back here (new invariant + new test), so it can't recur.

Every invariant has a stable ID (e.g. `INV-INTEGRITY-3`). Tests reference these IDs, so
requirement→test→code traceability is greppable. **Drift check:** `INV` IDs named in a
model must each appear in [07] and in a test; unreferenced invariants are a gate failure.

## Substitutability test (MAGE maturity)
If we swapped the reasoning model building this, quality should hold because the rules
live *here*, not in one agent's head. These models exist to make that true.
