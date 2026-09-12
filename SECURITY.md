# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability),
or email the maintainer directly if you already have the address.

Expect an acknowledgement within about a week. This is a research project maintained by one person
alongside a teaching load — there is no on-call rotation and no guaranteed remediation window. If
something is actively harming students in a live course, say so in the first line.

## 🚨 Never include in a report

Reports get read, quoted, and sometimes turned into tests. Do not paste:

- **Student data** — names, emails, IDs, grades, transcripts, or audio.
- **The signing Secret**, API keys, Worker secrets, or the contents of `.env` / `secret.env`.
- **Quiz keys or access keys** — these are live credentials.
- **Question banks or reference answers** — a bank in a public issue is a leaked assessment.
- **Unredacted logs or full URLs** — a course link carries a signed token.

Redact first. If a value is essential to the report, say what *kind* of value it is and where it
appeared, and we will work out the rest privately. **A report is never rejected for being too
redacted.**

## What is in scope

- Forging, replaying, or tampering with any signed token or certificate.
- Defeating the live-recording integrity property: passing an attempt that was not recorded live.
- Extracting question-bank content without a valid key, or mining a bank at scale.
- Recovering a student's identity from anything the Signer holds or stores (INV-PRIV-2, INV-PRIV-5).
- Causing a student's honest attempt to fail, or to be graded as another student's.
- Secret, key, or PII exposure in the repository, the web bundle, logs, or URLs.
- Prompt injection through a transcript that changes a grade.
- Privilege or scope escalation in the autograder or the Worker.

## What is out of scope

- Findings that require the attacker to already hold the deployment Secret.
- Attacks assuming a **public** question bank — bank confidentiality is a stated precondition, not
  a defence the software provides.
- A student cheating with help from another person in the room. This system proves an answer was
  spoken live; it does not prove who was in the room.
- Denial of service against your own deployment by volume alone.
- Vulnerabilities in Gradescope, Cloudflare, or a third-party grading service — report those to
  their vendors.
- Missing hardening headers with no demonstrated impact.

## If you believe student data has been exposed

Report it privately **and** notify your own institution's privacy office immediately. Their
obligations run on their own clock and do not wait for this repository.

## Supported versions

Alpha. Only the most recent release is supported. There are no backports to earlier alpha
snapshots, and no security guarantees of any kind — see [`DISCLAIMER.md`](DISCLAIMER.md).

| Version | Supported |
|---|---|
| `0.1.0-alpha.x` | Current alpha — report against the latest |
| anything earlier | No |

## Handling on our side

Reports are triaged privately. Fixes to security, privacy, or grading-correctness paths get extra
review and a regression test tied to the relevant invariant (`INV-…` in
[`models/02-requirements-and-invariants.md`](models/02-requirements-and-invariants.md)). Reporters
are credited by name unless they prefer otherwise.
