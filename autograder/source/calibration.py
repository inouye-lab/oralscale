"""Calibrating a grader's scores against a gold standard.

THE PROBLEM THIS SOLVES, AND THE ONE IT DOES NOT
------------------------------------------------
Measured on the calibration set, a small local model gets the ORDER of answers
almost as right as a large one but squashes the RANGE: wrong answers come back
around 0.35 instead of 0.0, weak ones around 0.6. Nothing is mis-ranked; the
numbers are just compressed. Handed straight to Gradescope as marks out of ten,
that turns a zero into a three.

That is a calibration problem, and calibration problems have a calibration fix:

    score' = clamp(scale x score + shift, 0, 1)

**An affine map with a positive scale cannot reorder anything.** That property is
the whole reason this is safe to do automatically. The three things an instructor
cares about, in the order they said they care about them:

  1. **Consistency** — the same answer always gets the same mark. Untouched: this
     is a deterministic function of the score.
  2. **Ranking** — a better answer never scores below a worse one. Untouched, and
     provably so, because a strictly increasing function preserves order. If the
     underlying grader flips a pair, calibration will faithfully preserve the
     flip — it cannot introduce one, and it cannot repair one either.
  3. **Absolute value** — what this actually fixes.

So calibration is a remedy for (3) alone. If the diagnostics say (1) or (2) are
bad, the answer is a different grader, not a different scale — and
`tools/calibrate-grader.py` reports both and says so.

WHY AFFINE AND NOT SOMETHING CLEVERER
-------------------------------------
Isotonic regression or a per-band lookup would fit the gold scores more tightly.
Both were rejected for the same reason: with a calibration set of a few dozen
answers they would fit the noise, and neither is explainable to a student who
asks why they got a 7. Two numbers an instructor can read, and a guarantee about
ranking, is worth more here than a better fit.
"""
from __future__ import annotations
import json
import os


def load(course_dir_or_path):
    """Load calibration.json from a course directory (or an explicit path)."""
    p = os.environ.get("ORALSCALE_CALIBRATION")
    if not p:
        cand = course_dir_or_path
        if cand and os.path.isdir(cand):
            cand = os.path.join(cand, "calibration.json")
        p = cand
    if not p or not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def for_backend(cal, backend: str):
    """The {scale, shift} to apply for this backend, or None.

    Matching is exact first, then by prefix ("local:" / "genai:"), so a
    calibration fitted for one model file still applies if the instructor bumps a
    quantisation and the tag changes — but a switch from local to remote does not
    silently inherit the other one's numbers.
    """
    if not cal or not backend:
        return None
    b = (cal.get("backends") or {})
    if backend in b:
        return b[backend]
    for key, val in b.items():
        if key.endswith("*") and backend.startswith(key[:-1]):
            return val
    return None


def apply(cal, result: dict) -> dict:
    """Apply calibration to one grading result, in place, and record that it was.

    Recording it is not bookkeeping: a score an instructor sees in Gradescope
    should be traceable to how it was produced, and "0.35 raw -> 0.06 calibrated"
    is the difference between a defensible mark and a mysterious one.
    """
    if not cal or not isinstance(result, dict) or "score" not in result:
        return result
    params = for_backend(cal, result.get("backend", ""))
    if not params:
        return result
    try:
        scale = float(params.get("scale", 1.0))
        shift = float(params.get("shift", 0.0))
    except (TypeError, ValueError):
        return result
    # A non-positive scale would invert the ranking, which is the one thing this
    # is not allowed to do. Refuse rather than apply it.
    if scale <= 0:
        return result
    raw = float(result.get("score", 0.0))
    result["rawScore"] = round(raw, 4)
    result["score"] = max(0.0, min(1.0, scale * raw + shift))
    result["calibration"] = {"scale": scale, "shift": shift,
                             "fittedAt": (cal or {}).get("fittedAt")}
    return result


def _sse(pairs, scale, shift):
    return sum((max(0.0, min(1.0, scale * r + shift)) - g) ** 2 for r, g in pairs)


def fit(raw_scores, gold_scores):
    """Fit raw -> gold. Returns {scale, shift, ...}.

    TWO CANDIDATE FITS, AND WHY THE OBVIOUS ONE IS NOT ALWAYS RIGHT
    ---------------------------------------------------------------
    The textbook answer is a least-squares affine fit. Measured against a real
    small model, that turned out to have a specific and nasty failure:

        raw          full=0.606  partial=0.188  weak=0.037  wrong=0.000
        affine fit   full=0.950  partial=0.463  weak=0.281  wrong=0.236

    It fixed the top of the scale and **broke the bottom**. The model was already
    correct about wrong answers — it gave them zero — and a positive shift lifted
    every one of them to 0.236. On a ten-point assignment that hands 2.4 marks to
    an answer the grader correctly identified as worthless, which is a worse
    error than the compression it was fixing.

    So we also fit a **scale-only** map through the origin, and prefer it whenever
    the affine fit would raise the bottom of the distribution. Scale-only cannot
    lift a zero, by construction. Both are monotone, so INV-GRADE-2 holds either
    way: neither can reorder anything.

    Falls back to the identity when the raw scores carry no spread — a grader that
    returns one number for everything is not miscalibrated, it is broken, and
    scaling it would only disguise that.
    """
    pairs = [(r, g) for r, g in zip(raw_scores, gold_scores)
             if r == r and g == g]           # drop NaN
    n = len(pairs)
    if n < 4:
        return {"scale": 1.0, "shift": 0.0, "n": n, "note": "too few points to fit"}
    mr = sum(r for r, _ in pairs) / n
    mg = sum(g for _, g in pairs) / n
    var = sum((r - mr) ** 2 for r, _ in pairs)
    if var < 1e-9:
        return {"scale": 1.0, "shift": 0.0, "n": n,
                "note": "raw scores have no spread — nothing to calibrate"}

    cov = sum((r - mr) * (g - mg) for r, g in pairs)
    aff_scale = cov / var
    aff_shift = mg - aff_scale * mr

    denom = sum(r * r for r, _ in pairs)
    sc_scale = (sum(r * g for r, g in pairs) / denom) if denom > 1e-12 else 1.0

    # The AFFINE slope is the one that carries the direction of the relationship,
    # because it is the covariance. If it is non-positive the grader's scores run
    # *against* the gold standard, and there is no map worth fitting: a
    # scale-only fit through the origin would still come back positive (it never
    # sees the anti-correlation) and would look like a confident calibration of a
    # grader that is ranking backwards. Refuse here, before that can happen.
    # calibrate-grader.py will independently reject it on ranking.
    if aff_scale <= 0:
        return {"scale": 1.0, "shift": 0.0, "n": n, "form": "identity",
                "note": ("this grader's scores run OPPOSITE to the gold standard — refusing to "
                         "fit, it would invert the ranking. Calibration cannot repair a grader "
                         "that ranks backwards.")}

    cands = []
    if aff_scale > 0:
        cands.append(("affine", aff_scale, aff_shift))
    if sc_scale > 0:
        cands.append(("scale-only", sc_scale, 0.0))
    if not cands:
        return {"scale": 1.0, "shift": 0.0, "n": n,
                "note": "fit wanted a non-positive slope — refusing, it would invert the ranking"}

    # The bottom of the scale is the part we refuse to make worse. "Bottom" is
    # the quartile of answers the GOLD standard scores lowest — the ones a
    # student most needs the grader to be right about.
    lo = sorted(pairs, key=lambda p: p[1])[:max(1, n // 4)]
    lo_gold = sum(g for _, g in lo) / len(lo)
    lo_raw = sum(max(0.0, min(1.0, r)) for r, _ in lo) / len(lo)

    def lifts_bottom(scale, shift):
        after = sum(max(0.0, min(1.0, scale * r + shift)) for r, _ in lo) / len(lo)
        # Only a problem if the raw scores were ALREADY at or below the gold
        # standard down there. If the grader is too generous at the bottom, a
        # positive shift is not what is happening anyway.
        return lo_raw <= lo_gold + 1e-9 and after > lo_gold + 0.05

    ok = [c for c in cands if not lifts_bottom(c[1], c[2])] or cands
    kind, scale, shift = min(ok, key=lambda c: _sse(pairs, c[1], c[2]))

    # NEVER SHRINK THE SCALE. A calibrated score is `scale * raw + shift`, so a
    # scale below 1 compresses the whole distribution — the exact opposite of
    # what calibration is here to do.
    #
    # Least squares asks for that surprisingly often, because regression toward
    # the mean lowers squared error against noisy targets. Measured on an
    # already-well-calibrated grader (full 1.000, wrong 0.000, separation 1.000),
    # the "best" least-squares fit was scale 0.876 — which lowered SSE and pushed
    # band separation down to 0.876, making a good grader worse to fit a fixture
    # of a few dozen answers more tightly. Refuse it: this exists to restore range
    # a compressed grader lost, never to take range away from one that has it.
    if scale < 1.0:
        return {"scale": 1.0, "shift": 0.0, "n": n, "form": "identity",
                "note": (f"best fit wanted to SHRINK the scale (x{scale:.3f}) — refused. This "
                         "grader's range is already at least as wide as the gold standard's, so "
                         "there is nothing for calibration to restore.")}

    out = {"scale": round(scale, 4), "shift": round(shift, 4), "n": n, "form": kind}
    if kind == "scale-only" and any(c[0] == "affine" for c in cands):
        out["note"] = ("scale-only: the affine fit would have lifted correctly-zeroed answers "
                       "off the bottom of the scale")
    return out
