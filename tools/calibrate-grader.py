#!/usr/bin/env python3
"""Calibrate and QUALIFY a grader before you use it on students.

    python3 tools/calibrate-grader.py --course courses/<id> --backend local
    python3 tools/calibrate-grader.py --course courses/<id> --backend local --gold genai

Writes `courses/<id>/calibration.json`, which the autograder applies at grading
time, and prints a verdict on whether this grader should be used at all.

WHAT IS BEING ASKED, IN PRIORITY ORDER
--------------------------------------
Three separate questions get conflated as "is it accurate". They are not the same
question, they fail differently, and only one of them is fixable by calibration:

1. **Is it CONSISTENT?**  Does the same answer get the same mark every time?
   A grader that moves a student between bands on a re-run makes the grade depend
   on when they submitted. That is the worst failure available here and it is not
   fixable by scaling — it disqualifies the grader.
2. **Does it RANK correctly?**  Within one question, does a better answer always
   score above a worse one? A flip means it is not grading; it is guessing near
   that pair. Calibration cannot repair a flip (a monotone map preserves order
   faithfully, including the wrong order), so this too is a qualification test,
   not something to fix afterwards.
3. **Is the ABSOLUTE value right?**  Do wrong answers land near 0 and full ones
   near 1? This is the least important of the three — and it is the only one
   calibration fixes. A small model that ranks perfectly but squashes everything
   into 0.35–0.9 is a good grader wearing the wrong scale.

The verdict below refuses to certify on (1) or (2) and simply repairs (3).

THE GOLD STANDARD
-----------------
`--gold intent`  (default) the four intended quality bands in the built-in
                 calibration set. Author's intent, not a grader's opinion.
`--gold genai`   Purdue GenAI's own scores on the same items. Use this when you
                 intend to keep GenAI as the standard and want the local model to
                 agree with it — for instance so that a mid-term fallback does not
                 shift the grading standard under the students.
`--gold <file>`  your own: a JSON list of {"questionId","level"/"score",...}
                 matching the fixture order. Twenty of your own graded answers are
                 worth more than any number of ours.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "autograder", "source"))
import calibration as calib   # noqa: E402


def _load_eval_module():
    """Reuse the evaluation harness rather than reimplementing its statistics."""
    path = os.path.join(ROOT, "tools", "eval", "run-grader-eval.py")
    spec = importlib.util.spec_from_file_location("grader_eval", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def band(x):
    """Which of the four bands a score falls in — used for 'did it move a student'."""
    return 0 if x < 0.15 else 1 if x < 0.5 else 2 if x < 0.85 else 3


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--course", required=True, help="courses/<id> — where calibration.json goes")
    ap.add_argument("--backend", default="local",
                    help="local | genai | ollama:<model> (ollama is for trying one out)")
    ap.add_argument("--gold", default="intent", help="intent | genai | <path to your own>")
    ap.add_argument("--condition", default="rich", choices=["basic", "rich"])
    ap.add_argument("--repeat", type=int, default=2,
                    help="runs used to measure consistency; 2 is enough to catch drift")
    ap.add_argument("--write", action="store_true",
                    help="write calibration.json even if the verdict is NOT RECOMMENDED")
    args = ap.parse_args()

    ev = _load_eval_module()
    items = ev.load_fixture()
    n = len(items)

    # --- gold ---------------------------------------------------------------
    if args.gold == "intent":
        gold = [it["target"] for it in items]
        gold_name = "intended quality bands (fixture)"
    elif args.gold == "genai":
        print("Scoring the gold standard with Purdue GenAI…", file=sys.stderr)
        gold = []
        for k, it in enumerate(items):
            sc, _ = ev.score_with("genai", it, "rich")
            gold.append(sc if sc is not None else float("nan"))
            print(f"\r  gold: {k+1}/{n}", end="", file=sys.stderr, flush=True)
        print(file=sys.stderr)
        gold_name = "Purdue GenAI (gemma4-class), rich prompt"
    else:
        with open(args.gold, "r", encoding="utf-8") as f:
            gold = [float(x["score"]) for x in json.load(f)]
        gold_name = args.gold

    # --- the grader under test ---------------------------------------------
    backend = args.backend
    runs, secs = [], 0.0
    for rep in range(max(1, args.repeat)):
        scores, t0 = [], time.time()
        for k, it in enumerate(items):
            try:
                sc, _ = ev.score_with(backend, it, args.condition)
            except Exception as e:
                print(f"\n  ! item {k}: {e}", file=sys.stderr)
                sc = None
            scores.append(sc if sc is not None else float("nan"))
            print(f"\r  {backend} run{rep+1}: {k+1}/{n}", end="", file=sys.stderr, flush=True)
        secs = (time.time() - t0) / n
        print(f"  ({secs:.1f}s/item)", file=sys.stderr)
        runs.append(scores)

    raw = runs[0]
    usable = [i for i in range(n) if raw[i] == raw[i] and gold[i] == gold[i]]
    if len(usable) < 8:
        print("\nNot enough scored items to calibrate — check the errors above.")
        return 1
    kept = [items[i] for i in usable]
    raw_ok = [raw[i] for i in usable]
    gold_ok = [gold[i] for i in usable]

    # --- the three questions ------------------------------------------------
    consistency = ev.self_consistency(runs) if len(runs) > 1 else None
    inversions, ties, pairs = ev.rank_failures(kept, raw_ok, truth=gold_ok)
    pair_acc = (pairs - inversions - ties) / pairs if pairs else float("nan")
    fitted = calib.fit(raw_ok, gold_ok)
    cal_ok = [max(0.0, min(1.0, fitted["scale"] * x + fitted["shift"])) for x in raw_ok]

    def sep(vals):
        full = [v for it, v in zip(kept, vals) if it["level"] == "full"]
        wrong = [v for it, v in zip(kept, vals) if it["level"] == "wrong"]
        return (sum(full) / len(full) - sum(wrong) / len(wrong)) if full and wrong else float("nan")

    moved = sum(1 for r, g in zip(cal_ok, gold_ok) if band(r) != band(g))
    moved_raw = sum(1 for r, g in zip(raw_ok, gold_ok) if band(r) != band(g))

    print(f"\n=== {backend} vs {gold_name} — {len(usable)}/{n} items ===\n")
    print("1. CONSISTENCY  (same answer, same mark — the one that must hold)")
    if consistency:
        print(f"     identical across {args.repeat} runs : {consistency['identical_frac']:.1%}")
        print(f"     mean score movement              : {consistency['mean_spread']:.3f}")
        print(f"     worst score movement             : {consistency['max_spread']:.3f}")
    else:
        print("     not measured (--repeat 1)")
    print("\n2. RANKING  (a better answer never scores below a worse one)")
    print(f"     within-question pair accuracy    : {pair_acc:.3f}  of {pairs} pairs")
    print(f"     INVERSIONS (worse ranked above)  : {inversions}   <- the one that matters")
    print(f"     ties (same mark, different work) : {ties}")
    if inversions == 0 and ties:
        print("     → it never ranks a pair backwards; it is just too blunt to separate")
        print("       some adjacent answers. Richer scoring anchors in the bank, or a")
        print("       larger model, is the fix — not calibration.")
    print("\n3. ABSOLUTE VALUE  (the only one calibration fixes)")
    print(f"     band separation  raw             : {sep(raw_ok):.3f}")
    print(f"     band separation  calibrated      : {sep(cal_ok):.3f}")
    print(f"     wrong band       raw / calibrated: {moved_raw} / {moved} items in the wrong band")
    print(f"     fitted map                       : score' = {fitted['scale']} x raw "
          f"+ {fitted['shift']}")
    if fitted.get("note"):
        print(f"     NOTE                             : {fitted['note']}")
    print(f"\n     speed: {secs:.1f}s per question")

    # --- verdict ------------------------------------------------------------
    problems, warnings = [], []
    if consistency and consistency["identical_frac"] < 0.90:
        problems.append(f"INCONSISTENT — only {consistency['identical_frac']:.0%} of answers got "
                        "the same mark on a re-run. A student's grade would depend on when they "
                        "submitted. Do not use this grader.")
    if consistency and consistency["max_spread"] >= 0.25:
        problems.append(f"UNSTABLE — one answer moved by {consistency['max_spread']:.2f} between "
                        "runs, which is a whole band.")
    # Judged on INVERSIONS, not on pair accuracy. A grader with many ties and no
    # inversions is blunt; a grader with inversions is wrong. Only the second is
    # disqualifying, and conflating them would reject a usable grader.
    if inversions > 0.08 * pairs:
        problems.append(f"MIS-RANKS — {inversions} of {pairs} same-question pairs come out in "
                        "the wrong ORDER (a worse answer scored above a better one). Calibration "
                        "cannot fix this: a monotone map preserves the wrong order just as "
                        "faithfully as the right one.")
    elif inversions:
        warnings.append(f"{inversions} of {pairs} pairs are inverted. Below the rejection "
                        "threshold, but read those questions.")
    if ties > 0.35 * pairs:
        warnings.append(f"BLUNT — {ties} of {pairs} pairs got identical marks, so it often "
                        "cannot separate adjacent quality levels. Not unfair (it never ranks "
                        "backwards), but it will compress your grade distribution. Adding "
                        "referenceAnswer / scoringBands / commonErrors to the bank helps most.")

    print()
    if problems:
        print("VERDICT: NOT RECOMMENDED")
        for p in problems:
            print("  ✗ " + p)
        print("\n  Try a larger local model, or add referenceAnswer / scoringBands / "
              "commonErrors to the bank — both raise ranking accuracy more than calibration can.")
    elif warnings:
        print("VERDICT: USABLE, WITH SPOT-CHECKING")
        print(f"  ✓ consistent, and never ranks a pair backwards ({inversions} inversions).")
        for w in warnings:
            print("  ! " + w)
        print("  → Fine for formative weekly checks. Read a sample of borderline scores.")
    else:
        print("VERDICT: GOOD")
        print(f"  ✓ consistent, {inversions} inversions, {ties} ties in {pairs} pairs.")

    if problems and not args.write:
        print("\nNot writing calibration.json. Re-run with --write to override.")
        return 2

    # --- write --------------------------------------------------------------
    probe = ev.score_with(backend, kept[0], args.condition)
    tag = None
    if backend == "local":
        sys.path.insert(0, os.path.join(ROOT, "autograder", "source"))
        import localmodel
        tag = "local:" + localmodel.local_model_name()
    elif backend == "genai":
        import grade as grader
        tag = "genai:" + (grader._genai_endpoint()[2] or "unknown")
    else:
        tag = backend
    del probe

    out_path = os.path.join(args.course, "calibration.json")
    existing = {}
    if os.path.exists(out_path):
        try:
            with open(out_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
        except Exception:
            existing = {}
    backends = existing.get("backends") or {}
    backends[tag] = {
        "scale": fitted["scale"], "shift": fitted["shift"],
        "diagnostics": {
            "gold": gold_name, "condition": args.condition, "n": len(usable),
            "pairAccuracy": round(pair_acc, 3), "inversions": inversions,
            "ties": ties, "pairs": pairs,
            "bandSeparationRaw": round(sep(raw_ok), 3),
            "bandSeparationCalibrated": round(sep(cal_ok), 3),
            "selfConsistency": consistency, "secPerQuestion": round(secs, 2),
        },
    }
    doc = {
        "version": 1,
        "fittedAt": time.strftime("%Y-%m-%d"),
        "note": ("score' = clamp(scale x raw + shift, 0, 1). A monotone affine map: it can move a "
                 "mark but can NEVER reorder two answers. Re-fit with tools/calibrate-grader.py."),
        "backends": backends,
    }
    os.makedirs(args.course, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print(f"\nWrote {out_path}  ({tag}: scale {fitted['scale']}, shift {fitted['shift']})")
    print("Rebuild the autograder zip so the container picks it up:")
    print(f"  node tools/build-autograder.js {args.course}/course.json --zip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
