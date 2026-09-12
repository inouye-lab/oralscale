# UX & Teaching-Effort Audit

Scored against the targets in [models/08-measurement-model.md](../../../models/08-measurement-model.md).
Metrics are measured where possible (browser walkthrough) and estimated otherwise (⌀).

## Student UX
| Metric | Target | Result | Notes |
|--------|--------|--------|-------|
| Taps from link-open to recording | ≤5 | **1** ✅ | one "Allow mic & start" (+ browser Allow) |
| Interface time, first attempt | ≤3 min | ⌀ ~30 s + speaking | verified flow; speaking time is the rest |
| Instructions length | 1 page | **1 page** ✅ | [STUDENT-GUIDE.md](../../guides/STUDENT-GUIDE.md), no jargon |
| Every failure → retake offered | yes | ✅ | Blocked/Expired/Aborted all route to retake |
| One-handed at 360px | yes | ✅ | verified at 375px; big targets, no h-scroll |
| Anxiety reduction visible up-front | yes | ✅ | landing states unlimited fresh-question retakes + best-score |

**Strengths:** capture-before-question is invisible to the student (they just tap Start); the
rolling code is large and centered; the countdown changes color at 60 s/15 s; the certified/
download state is unambiguous.

**Pain points & dispositions**
- ⚠️ *Two-step Gradescope link → record → resubmit* is the top confusion risk (UC-1). Mitigated by
  copy + guide; ❓open design question B1b (single vs two assignments).
- ⚠️ *Saying codes mid-thought* can break flow. Kept infrequent (45 s) and short (2 words); copy
  frames it as one second. Acceptable.
- ⚠️ *iOS `.zip` download* lands in Files, not an obvious "done." Guide calls this out; consider a
  clearer "now upload to Gradescope" nudge after download (already shown in `certState`).

## Teacher effort
| Metric | Target | Result | Notes |
|--------|--------|--------|-------|
| Repo → first live assignment | ≤30 min | ⌀ ~30 min | 5 steps, copy-paste; [TEACHER-GUIDE.md](../../reference/TEACHER-GUIDE.md) |
| Per-week ongoing effort | ≤15 min | ⌀ ~10–15 min | drop bank → course.json line → 2 builds+deploy → GS zip |
| One-time deploy commands | ≤10 | **~8** ✅ | clone, make-config, build-worker, wrangler ×3, build-autograder, build.sh |
| Grading intervention / normal submission | 0 | **0** ✅ | auto integrity + GenAI grade; only flags need eyes |
| Port to a new course | data-only | ✅ | copy `courses/` + `banks/`, no code (FR-8) |

**Pain points & dispositions**
- ⚠️ *`secret.env` edited per week* (only `ORALSCALE_ASSIGNMENT` changes). Minor; ❓design-Q T3
  (auto-derive from GS title). Kept explicit for clarity in v1.
- ⚠️ *Rebuild-after-bank-change* (`build-worker` + `build-autograder`) is easy to forget. Documented
  as a rule; npm scripts added. Consider a single `npm run deploy:week` wrapper later.
- ⚠️ *No class-wide flags dashboard* (UC-5). Rely on Gradescope's score view for v1; ❓design-Q T4.

## Accessibility
- ✅ Large text, high contrast, tabbable buttons, `playsinline` audio, `viewport-fit=cover`.
- ✅ Challenge shown as large text (not audio-only) — works for deaf/HoH students who sign/read;
  spoken-answer format itself is a consideration → accommodations via extended time / alternative
  assessment are the instructor's call (noted, not automated).
- ⚠️ Screen-reader labels are basic; a pass to add `aria-live` on the banner/nonce would help.
  ❓design-Q D2c: full a11y pass. Logged.

## Pain-point ledger (feeds Governance Conversion)
| ID | Pain point | Sev | Disposition |
|----|-----------|-----|-------------|
| P1 | Two-step link/record/resubmit confuses first-timers | med | mitigated (copy+guide); B1b open |
| P2 | Per-week `secret.env` edit + rebuilds | low | documented; T3/wrapper later |
| P3 | No flags dashboard | low | Gradescope view for v1; T4 open |
| P4 | iOS zip→upload handoff not obvious | low | `certState` nudge + guide |
| P5 | Basic screen-reader support | med | a11y pass (D2c) |
| P6 | Lost connection loses the attempt | low | free retake; C4 open |

None are release-blocking for a formative tool. P1 and P5 are the first two to revisit.
