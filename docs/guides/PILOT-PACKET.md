# OralScale pilot — read this first

_Everything an invited pilot participant needs, in one page. Version `0.1.0-alpha.1`._

## What you have been given

Read access to a **private** repository containing an alpha oral-assessment system. You may use it
in your teaching, modify it, and share it under the MIT licence. Please do not make the repository
or its contents public while the pilot is running — students reading the integrity mechanism
defeats the point of it.

## What this is

Students open one class link, answer a randomly drawn question aloud for two to three minutes, and
a cryptographic certificate establishes the answer was spoken **live** rather than prepared. The
audio goes only to your LMS. Grading runs **inside the grading container by default**, so student
work does not leave your institution.

## What this is not

- Not audited, not certified, not compliant with anything by default.
- Not a proctoring system. It proves an answer was spoken live; it does not prove who was in the
  room.
- Not a grading authority. Every score is subject to your review.

## Before you do anything

1. Read **[`../DISCLAIMER.md`](../../DISCLAIMER.md)** — twelve minutes, and it is the honest account of
   what does not work yet.
2. Read **[`../PRIVACY.md`](../../PRIVACY.md)** and decide whether you need to take it to your privacy
   office. If you plan to use a remote grading backend, you do.
3. Note how **accommodations** are handled below — case by case, with your own office.

## The five documents, in order

Everything else in `docs/` is reference or project history. These are the pilot set:

| | | |
|---|---|---|
| 1 | [`QUICKSTART.md`](QUICKSTART.md) | **Four commands to a running quiz.** Start here. ~1 hour. |
| 2 | [`STUDENT-GUIDE.md`](STUDENT-GUIDE.md) | Hand to students verbatim. Also read it yourself — it is what they will be doing. |
| 3 | [`QUESTION-DESIGN-GUIDE.md`](QUESTION-DESIGN-GUIDE.md) | Writing questions worth asking aloud. The part that decides whether this is any good. |
| 4 | [`TEACHER-GUIDE.md`](../reference/TEACHER-GUIDE.md) | The full reference. Read when you hit something the quickstart did not cover. |
| 5 | [`SETUP-GUIDE.md`](../reference/SETUP-GUIDE.md) | The long-form version of the quickstart, with every option explained. |

Plus [`../DISCLAIMER.md`](../../DISCLAIMER.md) and [`../PRIVACY.md`](../../PRIVACY.md) before you use it
with real students — see *Before you do anything* above.

## Order of operations

**Step 1 — Run it on yourself.** Follow [`QUICKSTART.md`](QUICKSTART.md): four commands, about an
hour, ending with you taking your own quiz. Take it end to end, including the Gradescope upload.
That single run is what proves the two copies of your signing secret match — the failure that
otherwise shows up as every student scoring zero.

**Step 2 — Run it on synthetic data.** Make a fake roster of three, mint keys, and take it as each
of them. This is where setup mistakes surface.

**Step 3 — Talk to your institution.** Security and privacy review, and a heads-up to your
disability services office that an oral format is coming, so a request is not a surprise.

**Step 4 — One low-stakes assignment.** Ungraded, or worth very little. Give students a practice
run before anything counts — the prerequisite-quiz pattern in the guides exists for this.

**Step 5 — Tell us what broke.**

## Accommodations — case by case, and we want to hear about it

**Extended time is supported directly, and it is worth setting up before your first quiz.**
Students tap "I have DRC accommodations" on the start screen and pick 1.25x, 1.5x, 1.75x or 2x;
their countdown scales. Keep the grants wherever you already keep them — Gradescope's Extensions page is fine.

**The autograder never sees them.** It writes an instructor-only note (*"1.5x extended time
claimed"*), assumes the claim is correct, and grades normally. Nothing about who holds an
accommodation is ever bundled into the zip (INV-PRIV-6).

Audit whenever you like, offline, against a CSV of your own:

```bash
node tools/audit-accommodations.js --submissions <export.zip> \
  --course courses/<id>/course.json --roster <email,multiplier.csv>
```

⚠️ Run it yourself, in a terminal. It refuses to run under an AI assistant or in CI, and has no
override — its inputs name students with disability accommodations. Students are never penalised for selecting less time than they hold, or none at all; only
selecting *more* than granted **and** using it is reported, and it never changes a score. Grants
above 2x cannot be delivered through the web app — arrange those another way and tell the student
in advance.

(`gen-url.js --time-mult` still mints a per-student accommodation link, if you prefer to issue one
directly rather than have the student select.) The interface has had a technical accessibility
pass.

There is **no single prescribed alternative format** yet for a student who cannot use a spoken
modality at all. For this alpha that is deliberate rather than a gap waiting to be filled —
accommodation is a conversation between you, the student, and your disability services office, and
the right answer varies with the student and the course. Handle it as it comes up, the way you
would for any other assessment format.

If it helps, `../docs/project/DESIGN-QUESTIONS.md` (D2c) works through three options and what each one
costs:

1. **A live oral with you over video or in office hours.** Same construct — unassisted, real-time
   explanation — no code needed, doesn't scale past a handful of students, which is fine because
   this is rare. *Recommended default.*
2. **A typed real-time variant** — same bank, same timed window, codes typed rather than spoken.
   Preserves "unassisted and real-time" but does not exist yet.
3. **A written response.** Cheapest, and measures something different — it is the exact proxy this
   whole approach exists because AI has broken.

**Please tell us what you did and how it went.** Deriving the general answer from real cases is one
of the things this pilot is for, and a solution that works two or three times is what should become
a supported feature. Suggestions are genuinely welcome — you know your students and your
institution's process better than this repository does.

## Supported environment

| | |
|---|---|
| **Students** | Current Chrome, Safari, Firefox. Mobile-first. In-app browsers inside other apps are unreliable for audio capture. |
| **Language** | English. Other languages untested. |
| **Instructor machine** | Node 22+, Python 3.11+. Runs entirely locally with no cloud account. |
| **Production hosting** | Cloudflare Worker, free tier, or your own Node host. |
| **Grading container** | 2.0 CPU / 3.0 GB, 40-minute timeout. **Check this — the defaults are too small and fail silently.** |

## Known limitations

Automated grading is imperfect and not uniformly so — transcription accuracy varies with accent and
recording conditions. Bank confidentiality is assumed, not enforced. Scale beyond one course is
uncharacterised. Alpha versions may break compatibility with each other. Full list in
[`../DISCLAIMER.md`](../../DISCLAIMER.md).

## Reporting

| What | Where |
|---|---|
| Reproducible bug | Issue → 🐛 Bug report |
| Question, experience, idea | Discussions |
| Feature proposal | Issue → 💡 Feature or change proposal |
| **Security or privacy** | **Private reporting — never a public issue.** [`../SECURITY.md`](../../SECURITY.md) |

**Never paste** student names, emails, IDs, grades, transcripts, audio, `.env` contents, quiz keys,
course links, or question banks. Redact first. A report is never rejected for being too redacted.

Reproduce against `courses/demo/` where you can — a demo reproduction is worth far more to us than
a description of your private course.

## What we would most like to know

1. Where did setup stop being obvious?
2. What did students find confusing, and what did they email you about?
3. Did any device or browser fail to record?
4. Where was a grade wrong in a way that mattered?
5. What did your institution ask that the documentation could not answer?
6. Did you have to make an accommodation, and what did you do? (See below — this one is especially
   useful to us.)
7. What did this cost you in time, honestly, compared with what it saved?

## Support expectations

One maintainer, alongside a teaching load. Expect an acknowledgement within about a week. There is
no guaranteed fix window. If something is blocking students in a live course, say so in the first
line and it goes to the front.

Do not deploy an upgrade mid-semester without reading the release notes — alpha versions can break
compatibility, and a course in flight is exactly where that hurts.
