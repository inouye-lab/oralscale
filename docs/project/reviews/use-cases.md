# Use-Case Walkthroughs (system-level review)

Each use case is walked step by step against the built system, noting **friction/pain points**
and their resolution (fixed, mitigated, or logged as a design question). Feeds the pain-point
ledger in [ux-audit.md](ux-audit.md) and Governance Conversion (new invariants/tests).

Legend: ✅ handled · ⚠️ mitigated / watch · 🔧 fix applied this pass · ❓ logged design question

---

## UC-1 — Student takes a quiz on a phone, first time
Flow: open Gradescope → submit once → get link → open link → allow mic → record → say codes →
stop → download `.zip` → upload to Gradescope.
- ✅ Capture-before-question, question + rolling codes, countdown, certified download all verified
  in-browser (mobile 375px).
- ⚠️ **Two-step "submit to get a link, then resubmit the recording"** is the biggest first-time
  confusion risk. Mitigated by the autograder's link message and the [student guide](../../guides/STUDENT-GUIDE.md).
  ❓ DESIGN-Q B1b: is a two-assignment split ("Get link" / "Submit") clearer? Default: single-assignment.
- 🔧 On iOS the mic prompt must be inside the tap — the app calls `getUserMedia` synchronously in
  the Start handler (done). Downloading a `.zip` on iOS Safari opens Files; the guide notes this.
- ⚠️ Saying codes while thinking can interrupt flow. Mitigated: codes are infrequent (45s) and short.

## UC-2 — Student retakes 3× on flaky dorm wifi
- ✅ "New question / retake" reloads with a fresh question; best-score policy makes retries safe.
- 🔧 `/pulse` failures don't abort recording — the app retries and keeps the last code shown
  (graceful; INV-PLAT-3). A dropped `/finish` shows a retake path rather than a dead end.
- ⚠️ If wifi dies mid-record, the attempt is lost (no partial credit). Acceptable: retake is free.
  ❓ DESIGN-Q C4: offline-tolerant mode (client-derived nonce schedule) as a fallback? Trade-off:
  weaker liveness. Default: stay online; retake on failure.

## UC-3 — Student denied mic / on an old browser
- ✅ `recordingSupported()` gate → clear "Recording not supported" screen with what to use.
- ✅ Denied mic → actionable "Microphone blocked" message with iOS/Android steps. Verified.

## UC-4 — Instructor sets up Week 4 from scratch
- ✅ Path is: drop bank → add course.json line → `build-worker` + deploy → Gradescope assignment +
  `secret.env` (`ORALSCALE_ASSIGNMENT`) → `build.sh` → upload zip. Documented in the teacher guide.
- ⚠️ **`secret.env` must be edited per week** (only `ORALSCALE_ASSIGNMENT` changes). Minor friction.
  ❓ DESIGN-Q T3: derive `ORALSCALE_ASSIGNMENT` from the Gradescope assignment title to avoid the
  per-week edit? Default: explicit env var (clearer, less magic).
- ⚠️ Two build steps (`build-worker`, `build-autograder`) must be re-run when banks change. 🔧
  Added `npm run build:worker` / `build:autograder` and documented the "rebuild after bank change" rule.

## UC-5 — Instructor reviews a flagged (integrity-failed) submission
- ✅ Autograder emits per-check pass/fail tests + a top-line "INTEGRITY CHECK FAILED — flagged".
  The instructor sees exactly which check failed (hash / window / duration / challenges / identity).
- ✅ The retained audio is in Gradescope for a voice/authenticity spot-check.
- ⚠️ No dashboard aggregating flags across the class. ❓ DESIGN-Q T4: a small "flags" report tool?
  Default: rely on Gradescope's own filtering/score view for v1.

## UC-6 — Instructor ports the tool to a different course
- ✅ `courses/<id>/` + `banks/<id>/` only; no code changes (FR-8). Verified conceptually by the
  demo course + a real course coexisting. 🔧 Bank paths are course-relative; bundlers rewrite them.

## UC-7 — Accommodation: student with 1.5× extended time
- ✅ `gen-url.js --time-mult 1.5` mints a link whose `limitSec` (and deadline) scale on the Signer.
- ⚠️ In the single-assignment flow, the *autograder-minted* link uses multiplier 1. ❓ DESIGN-Q D2b:
  per-student multipliers need a roster of accommodations the autograder can read (e.g., an env list
  or a small map). Default v1: issue accommodation links manually with `gen-url.js`; documented.

---

## New design questions surfaced (added to DESIGN-QUESTIONS.md)
- B1b single- vs two-assignment Gradescope flow.
- C4 offline-tolerant recording fallback.
- T3 auto-derive assignment id from Gradescope title.
- T4 class-wide flags report.
- D2b per-student accommodation roster for autograder-minted links.

## New invariants/tests proposed (Governance Conversion)
- INV-PLAT-3 already covers pulse/finish failure recovery — confirmed by UC-2; keep the E2E
  "network blip during pulse" case in mind for a future integration test.
- Consider an integration test asserting the autograder's flagged output names the *specific*
  failed check (supports UC-5).
