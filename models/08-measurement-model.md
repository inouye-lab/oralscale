# 08 — Measurement Model (UX + teaching-effort)

What we measure to know the product is actually *easy*, and the target for each. These are
the acceptance criteria for the "super easy to use" requirement. Reviewed in the UX and
teaching-effort audits ([docs/reviews/](../docs/project/reviews/)).

## Student experience
Public release acceptance (INV-DOC-1): `docs/public/site/` provides a landing page and distinct
Student/Instructor paths. Each path leads with a one-page Quickstart followed by a one-page FAQ.
HTML is primary and scrolls continuously, without paper borders, repeated running headers or
page numbers. Only the PDF uses page framing and pagination. The same content and stylesheet
render the downloadable two-page Letter PDF.
Review at 360px and desktop, in color and print, and after meaningful UI or specification changes.
The Faculty path is distinct: AI-assisted setup of an owned demo Course, quiz website and
Gradescope autograder, followed by source-grounded AI Bank generation and a first real quiz.
It includes a copyable starter prompt and Question-design brief guidance; no coding experience,
prewritten Bank or technical colleague is a prerequisite. The Instructor supplies accounts,
teaching goals, source materials, and release judgment. A text-only assistant can guide, but
execution requires file/terminal access. The source mapping and review procedure live in
`docs/public/GOVERNANCE.md`.

| Metric | Target | How measured |
|--------|--------|--------------|
| Taps from link-open to recording | ≤5 | use-case walkthrough [UC-1] |
| Interface time for a first attempt (excl. thinking) | ≤3 min | walkthrough + timer |
| Comprehension of instructions | 1-page sheet, no jargon | [docs/guides/STUDENT-GUIDE.md] readability |
| Failure recoverability | every failure → retake offered | [03] Aborted/Expired/Blocked routes |
| Mobile usability | one-handed at 360px | device screenshots |
| Anxiety-reduction | unlimited fresh-Q retakes visible up-front | UI copy review |

## Teacher experience (effort audit)
| Metric | Target | How measured |
|--------|--------|--------------|
| Repo → first live Assignment | ≤30 min | [docs/reference/TEACHER-GUIDE.md] dry-run |
| Per-week ongoing effort | ≤15 min | steps counted (author bank → validate → deploy) |
| One-time deploy steps | ≤10 commands, copy-paste | teacher guide |
| Grading intervention | 0 per normal submission; only flagged ones | autograder auto-flags |
| Portability to a new course | new `courses/` + `banks/` only | [FR-8] test |

## Use cases (drive the UX audit — see [docs/project/reviews/use-cases.md])
- **UC-1** Student takes a quiz on a phone, first time.
- **UC-2** Student retakes 3× to improve, on flaky dorm wifi.
- **UC-3** Student denied mic / on an old browser.
- **UC-4** Instructor sets up Week 4 from scratch.
- **UC-5** Instructor reviews a flagged (integrity-failed) submission.
- **UC-6** Instructor ports the tool to a different course.
- **UC-7** Accommodation: student with 1.5× extended time.

## Pain-point ledger (updated by audits; feeds Governance Conversion)
| ID | Pain point | Severity | Resolution / status |
|----|-----------|----------|--------------------|
| _tbd from UX audit_ | | | |

Public faculty quickstart places the copyable starter prompt immediately after prerequisites,
before the five agent-guided steps. The accommodation FAQ describes instructor-only offline
review under INV-ACCOM-1/2 and INV-PRIV-6: no approval list in the autograder or AI context,
human review of flags, local-copy cleanup subject to institutional retention rules, and
instructor responsibility for FERPA and institutional policy. No compliance guarantee.

Public guide visual identity: plum/apricot on white with dark neutral charcoal body copy and
deep-plum headings. Student accents use plum, Faculty accents use accessible burnt apricot;
secondary panels mix both colors. Audience labels remain explicit so color is never the only
distinction. Shared styles apply equally to HTML and print. Check normal text/button contrast
at 4.5:1 or better and preserve the one-page Quickstart plus one-page FAQ per audience.

The two public landing-page audience cards align their Quickstart and download actions at
the bottom when side by side, regardless of title/body wrapping; stacked mobile cards retain
normal reading order. This remains part of INV-DOC-1 responsive visual review.
