#!/usr/bin/env python3
"""Compare the local grader and Purdue GenAI across every bank in the repo.

WHY THIS EXISTS, AND WHAT IT MEASURES
-------------------------------------
`qwen-vs-genai.py` scores a prompt variant against GenAI on 35 hand-authored
answers. That was the right tool while GenAI was the reference. It stopped being
the right tool the moment the local grader started AGREEING WITH THE BANK AUTHOR
MORE OFTEN THAN GENAI DID -- at that point "agreement with GenAI" is measuring
the wrong thing, and a grader could only get worse by improving.

So this benchmark drops GenAI as the reference and uses two ground truths that
exist independently of any model:

  ORDERING (the primary metric, and the one INV-GRADE-3 actually cares about).
  For each question we build four answers whose RELATIVE quality is fixed by
  CONSTRUCTION, not by anyone's judgement:

      full    the question's own referenceAnswer, written by the bank author
      partial that answer truncated to ~60% of its sentences
      weak    its first sentence only
      none    a DIFFERENT question's referenceAnswer from the SAME bank

  `none` is drawn from the same bank on purpose: an off-topic answer about
  cooking is trivially rejected, while a fluent, confident, on-domain answer to
  the neighbouring question is the hard negative that actually separates graders.
  The six pairwise orderings per question are facts, so ordering accuracy needs
  no human labels and scales to every bank in the repo.

  BANDS (secondary). The nominal band above is a reasonable label but not a
  certainty -- a first sentence sometimes IS the whole answer. Treated as
  advisory, and reported as distance rather than exact match, except on the
  calibration set (`--set calibration`), whose 32 answers were written by hand
  for a specific intended band and are the only true absolute labels here.

Sampling is deterministic (seeded by bank name), so two runs of two graders see
byte-identical inputs and the comparison is paired.

  python3 tools/eval/bench.py --grader qwen   --per-bank 8 --save qwen.json
  python3 tools/eval/bench.py --grader genai  --per-bank 8 --save genai.json
  python3 tools/eval/bench.py --compare qwen.json genai.json
"""
import argparse, glob, json, os, random, re, statistics, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, 'autograder', 'source'))

# Imported, not restated. This is the price list the SHIPPED grader uses, and a
# copy of it here would silently make every reported MAE a measurement of the
# copy. (`tools/eval/variants.py` and `genai_variants.py` deliberately keep their
# own four-band tables: those modules exist to re-run historical prompt-variant
# measurements, and a number you can no longer reproduce is a number you have to
# take on trust.)
from grade import BAND_SCORE                                        # noqa: E402

# The four CONSTRUCTED qualities, in descending order. Not the same list as the
# grader's five bands: `strong` is a judgement a grader may reach, never a label
# this harness manufactures an answer for.
ORDER = ["full", "partial", "weak", "none"]


def banks():
    """Every bank in the repo, deduplicated by content.

    demo / _testsuite (and any course started from them) ship the same
    general-stem bank; counting it once per copy would over-weight twelve
    questions against a real course's bank.
    """
    seen, out = {}, []
    for f in sorted(glob.glob(os.path.join(ROOT, 'courses', '*', 'banks', '*.json'))):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        qs = d.get('questions') or []
        if not qs:
            continue
        sig = (len(qs), qs[0].get('id'), qs[0].get('prompt', '')[:60])
        if sig in seen:
            continue
        seen[sig] = f
        out.append((os.path.relpath(f, ROOT), qs))
    return out


def _sentences(text):
    parts = re.split(r'(?<=[.!?])\s+', (text or '').strip())
    return [p for p in parts if p.strip()]


def degrade(ref):
    """full / partial / weak from one reference answer. Mechanical, no judgement."""
    s = _sentences(ref)
    if len(s) < 3:
        return None
    keep = max(1, int(round(len(s) * 0.6)))
    return {"full": ref.strip(), "partial": " ".join(s[:keep]), "weak": s[0]}


def dataset(per_bank, seed=1729, only=None):
    """[(case_id, bank, question, answer, nominal_band)] with exact ORDERING truth.

    `only` restricts to banks whose path contains that substring. The default is
    still every bank in the repo: a single-bank number is a statement about that
    week's questions, not about the grader, and the two should not be confused.
    """
    cases = []
    for name, qs in banks():
        if only and only not in name:
            continue
        usable = [q for q in qs if degrade(q.get('referenceAnswer', ''))]
        if len(usable) < 2:
            continue
        rng = random.Random(f"{seed}:{name}")
        picked = rng.sample(usable, min(per_bank, len(usable)))
        for q in picked:
            d = degrade(q['referenceAnswer'])
            # hard negative: a confident, fluent answer to a NEIGHBOURING question
            others = [o for o in usable if o['id'] != q['id']]
            d["none"] = rng.choice(others)['referenceAnswer'].strip()
            for band in ORDER:
                cases.append((f"{q['id']}/{band}", name, q, d[band], band))
    return cases


def calibration_dataset():
    """The 32 hand-authored answers, the only true absolute band labels we have."""
    cal = json.load(open(os.path.join(HERE, 'grader-calibration.json')))
    out = []
    for item in cal['items']:
        bank = json.load(open(os.path.join(ROOT, item['bank'])))
        q = {x['id']: x for x in bank['questions']}[item['questionId']]
        for band, ans in item['answers'].items():
            band = 'none' if band == 'wrong' else band
            out.append((f"{item['questionId']}/{band}", os.path.basename(item['bank']), q, ans, band))
    return out


# ---------------------------------------------------------------------------
# graders — each returns {case_id: score}
# ---------------------------------------------------------------------------
def grade_qwen(cases, variant, checkpoint=None):
    """Score every case, CHECKPOINTING as it goes.

    A full local pass is ~500 questions at ~8 s each, and this machine has
    OOM-killed the run (and Docker under it) twice at around the fifty-minute
    mark. Without a checkpoint a kill costs the whole hour and tells you nothing;
    with one it costs the last few answers. Resuming is safe because the sampler
    is seeded, so a resumed run sees byte-identical inputs.
    """
    import variants as V
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        'qwen_vs_genai', os.path.join(HERE, 'qwen-vs-genai.py'))
    H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
    url = os.environ['ORALSCALE_LOCAL_URL'].rstrip('/')
    v = V.get(variant)
    out = {}
    if checkpoint and os.path.exists(checkpoint):
        out = json.load(open(checkpoint))
        print(f"  resuming from {checkpoint}: {len(out)} already scored", flush=True)
    for n, (cid, _bank, q, ans, _b) in enumerate(cases, 1):
        if cid in out:
            continue
        content = H._chat(url, v.system(q), v.prompt(q, ans))
        parsed = v.parse(content, q)          # {"score": float, "feedback": str} or None
        out[cid] = None if not parsed else parsed.get('score')
        if n % 10 == 0:
            if checkpoint:
                json.dump(out, open(checkpoint, 'w'))
            print(f"  qwen {n}/{len(cases)}", flush=True)
    if checkpoint:
        json.dump(out, open(checkpoint, 'w'))
    return out


def grade_local(cases, bands=None, checkpoint=None):
    """The SHIPPED local grader, in-process, exactly as the autograder runs it.

    `grade_qwen` above drives a variant prompt against a local HTTP server; that
    is the right tool for choosing BETWEEN prompts. It is the wrong tool for the
    question "how does the grader this course actually uses compare to GenAI",
    because the thing it measures is a candidate, not the shipped code. This one
    calls localmodel.grade_one, which is the function the container calls, so a
    number from here and a number from grade_genai are about the same two graders
    a student would actually meet.
    """
    import localmodel as LM
    if not LM.available():
        raise SystemExit("local model unavailable: " + (LM.unavailable_reason() or "?"))
    out = {}
    if checkpoint and os.path.exists(checkpoint):
        out = json.load(open(checkpoint))
        print(f"  resuming from {checkpoint}: {len(out)} already scored", flush=True)
    for n, (cid, _bank, q, ans, _b) in enumerate(cases, 1):
        if cid in out:
            continue
        r = LM.grade_one(q, ans, "BENCHFENCE", bands=bands)
        out[cid] = None if 'error' in r else r.get('score')
        if n % 10 == 0:
            if checkpoint:
                json.dump(out, open(checkpoint, 'w'))
            print(f"  local {n}/{len(cases)}", flush=True)
    if checkpoint:
        json.dump(out, open(checkpoint, 'w'))
    return out


def grade_genai(cases, variant='baseline', batch=5, bands=None, checkpoint=None):
    """Through grade.py's REAL code path, so what is measured is what ships.

    CHECKPOINTED for the same reason the local pass is: a full-bank run is
    hundreds of remote calls over a couple of hours, and a rate limit or a
    dropped connection near the end used to cost the whole run. Resuming is safe
    because the sampler is seeded, so a resumed run sees byte-identical inputs.
    """
    import grade as G, genai_variants as GV
    GV.apply(G, variant)
    out = {}
    if checkpoint and os.path.exists(checkpoint):
        out = json.load(open(checkpoint))
        print(f"  resuming from {checkpoint}: {len(out)} already scored", flush=True)
    for i in range(0, len(cases), batch):
        chunk = [c for c in cases[i:i + batch] if c[0] not in out]
        if not chunk:
            continue
        items = [{"question": q, "transcript": ans, "outbound": ans}
                 for _cid, _bk, q, ans, _b in chunk]
        for attempt in range(6):
            try:
                res = G._genai_batch(items, [])
                break
            except Exception as e:
                if attempt == 5:
                    raise
                time.sleep(min(60, 4 * 2 ** attempt))
        if not isinstance(res, dict) or res.get('error'):
            raise SystemExit(f"genai batch failed: {res}")
        answers = res.get('answers') or []
        for (cid, _bk, _q, _a, _b), raw in zip(chunk, answers):
            if raw is None:
                out[cid] = None
                continue
            r = G._normalise(raw, res.get('backend', 'genai'), bands)
            out[cid] = None if r.get('_unparsed') else r.get('score')
        if checkpoint:
            json.dump(out, open(checkpoint, 'w'))
        print(f"  genai {min(i + batch, len(cases))}/{len(cases)}", flush=True)
    if checkpoint:
        json.dump(out, open(checkpoint, 'w'))
    return out


# ---------------------------------------------------------------------------
def report(label, scored, cases, bands=None):
    # The nominal band's expected VALUE depends on how the course prices the
    # bands, so the band-distance metric has to use the same table the grader
    # used. Ordering, the primary metric, does not depend on the prices at all.
    bands = bands or BAND_SCORE
    by_q = {}
    for cid, _bank, q, _a, band in cases:
        by_q.setdefault((q['id'], _bank), {})[band] = scored.get(cid)

    # A TIE AND AN INVERSION ARE NOT THE SAME MISTAKE, and lumping them together
    # is how a genuinely better grader looks worse. Bands quantise to four values,
    # so a `full` and a `partial` both judged `full` tie -- less discriminating,
    # but nobody is ranked ABOVE someone better. An inversion is the failure
    # INV-GRADE-2/3 are about: it puts a worse answer above a better one, and no
    # monotone calibration can repair it. Reported separately, always.
    pairs_ok = pairs_tot = ties = inversions = 0
    for key, got in by_q.items():
        for a, b in [(x, y) for i, x in enumerate(ORDER) for y in ORDER[i + 1:]]:
            sa, sb = got.get(a), got.get(b)
            if sa is None or sb is None:
                continue
            pairs_tot += 1
            if sa > sb:
                pairs_ok += 1
            elif sa == sb:
                ties += 1
            else:
                inversions += 1

    errs, unparsed, collapse, full_n = [], 0, 0, 0
    per_band = {b: [] for b in ORDER}
    for cid, _bank, _q, _a, band in cases:
        s = scored.get(cid)
        if s is None:
            unparsed += 1
            continue
        errs.append(abs(s - bands[band]))
        per_band[band].append(s)
        if band in ('full', 'partial'):
            full_n += 1
            if s == 0.0:
                collapse += 1

    per_bank = {}
    for key, got in by_q.items():
        bk = key[1]
        ok = tot = 0
        for a, b in [(x, y) for i, x in enumerate(ORDER) for y in ORDER[i + 1:]]:
            sa, sb = got.get(a), got.get(b)
            if sa is None or sb is None:
                continue
            tot += 1
            ok += 1 if sa > sb else 0
        d = per_bank.setdefault(bk, [0, 0]); d[0] += ok; d[1] += tot

    print(f"\n=== {label} ===  ({len(cases)} answers, {len(by_q)} questions)")
    print(f"  ordering, strict    : {pairs_ok}/{pairs_tot} = {pairs_ok/max(1,pairs_tot):.0%}")
    print(f"  INVERSIONS          : {inversions}/{pairs_tot} = {inversions/max(1,pairs_tot):.1%}"
          f"   (a worse answer scored ABOVE a better one)")
    print(f"  ties                : {ties}/{pairs_tot} = {ties/max(1,pairs_tot):.0%}"
          f"   (equal marks; not unfair, just blunt)")
    print(f"  MAE vs nominal band : {statistics.mean(errs) if errs else float('nan'):.3f}")
    print(f"  collapsed to 0      : {collapse}/{full_n} full-or-partial answers")
    print(f"  unparsed            : {unparsed}")
    print("  mean score by band  : " + "  ".join(
        f"{b}={statistics.mean(per_band[b]):.2f}" if per_band[b] else f"{b}=--" for b in ORDER))
    return {"label": label, "scores": scored, "order_ok": pairs_ok, "order_tot": pairs_tot,
            "ties": ties, "inversions": inversions, "mae": statistics.mean(errs) if errs else None,
            "collapse": collapse, "collapse_of": full_n, "unparsed": unparsed,
            "per_bank": per_bank,
            "band_means": {b: (statistics.mean(per_band[b]) if per_band[b] else None) for b in ORDER}}


def compare(paths):
    runs = [json.load(open(p)) for p in paths]
    print(f"\n{'':34s} " + "  ".join(f"{r['summary']['label']:>16s}" for r in runs))
    def row(name, fn):
        print(f"  {name:32s} " + "  ".join(f"{fn(r['summary']):>16s}" for r in runs))
    row("ordering (strict)", lambda s: f"{s['order_ok']/max(1,s['order_tot']):.1%}")
    row("INVERSIONS", lambda s: f"{s['inversions']}/{s['order_tot']} = {s['inversions']/max(1,s['order_tot']):.1%}")
    row("ties", lambda s: f"{s['ties']}/{s['order_tot']} = {s['ties']/max(1,s['order_tot']):.0%}")
    row("MAE vs nominal band", lambda s: f"{s['mae']:.3f}")
    row("collapsed to 0", lambda s: f"{s['collapse']}/{s['collapse_of']}")
    row("unparsed", lambda s: str(s['unparsed']))
    for b in ORDER:
        row(f"mean score, {b}", lambda s, b=b: f"{s['band_means'][b]:.2f}"
            if s['band_means'][b] is not None else "--")
    print("\n  per-bank ordering:")
    keys = sorted(runs[0]['summary']['per_bank'])
    for k in keys:
        cells = []
        for r in runs:
            ok, tot = r['summary']['per_bank'].get(k, [0, 0])
            cells.append(f"{ok/max(1,tot):>15.0%} ")
        print(f"  {os.path.basename(k)[:32]:34s} " + " ".join(cells))
    if len(runs) == 2:
        a, b = runs
        sa, sb = a['summary']['scores'], b['summary']['scores']
        both = [k for k in sa if sa.get(k) is not None and sb.get(k) is not None]
        agree = sum(1 for k in both if abs(sa[k] - sb[k]) < 1e-9)
        print(f"\n  the two graders give the SAME score on {agree}/{len(both)} = "
              f"{agree/max(1,len(both)):.0%} of answers")
        gap = statistics.mean(abs(sa[k] - sb[k]) for k in both) if both else 0
        print(f"  mean |qwen - genai|: {gap:.3f}")


def paired(cases, ckpt_a, ckpt_b, label_a, label_b, bands=None):
    """Report two graders on EXACTLY the cases both have finished.

    A checkpoint from a run still in flight is a perfectly good sample -- the
    sampler is seeded, so both graders walked the same list in the same order --
    but only if the two are intersected first. Comparing a grader's 396 answers
    against another's 200 compares different questions and silently favours
    whichever one happened to draw the easier tail.
    """
    a = json.load(open(ckpt_a))
    b = json.load(open(ckpt_b))
    shared = set(a) & set(b)
    sub = [c for c in cases if c[0] in shared]
    qs = len({c[2]['id'] for c in sub})
    print(f"paired on {len(sub)} answers ({qs} questions) that BOTH graders finished\n")
    sa = report(label_a, {k: a[k] for k in shared}, sub, bands)
    sb = report(label_b, {k: b[k] for k in shared}, sub, bands)
    both = [k for k in shared if a[k] is not None and b[k] is not None]
    agree = sum(1 for k in both if abs(a[k] - b[k]) < 1e-9)
    print(f"\n=== head to head ===")
    print(f"  identical mark        : {agree}/{len(both)} = {agree/max(1,len(both)):.0%}")
    print(f"  mean |{label_a} - {label_b}| : "
          f"{statistics.mean(abs(a[k] - b[k]) for k in both):.3f}")
    return {label_a: sa, label_b: sb}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--grader', choices=['qwen', 'local', 'genai'],
                    help="'local' is the SHIPPED local grader in-process; 'qwen' drives a "
                         "prompt VARIANT against ORALSCALE_LOCAL_URL for prompt selection")
    ap.add_argument('--course', default='', help='course.json whose defaults.bandScores prices '
                    'the bands for BOTH graders (default: the engine table)')
    ap.add_argument('--variant', default='', help="prompt variant; defaults to what SHIPS "
                    "for the chosen grader (qwen: band_v3, genai: baseline). The two graders "
                    "have separate variant namespaces, so one shared default was a foot-gun.")
    ap.add_argument('--set', default='constructed', choices=['constructed', 'calibration'])
    ap.add_argument('--per-bank', type=int, default=8)
    ap.add_argument('--bank', default='', help='substring of a bank path; restricts the '
                    'constructed set to matching banks (default: every bank in the repo)')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--save', default='')
    ap.add_argument('--checkpoint', default='')
    ap.add_argument('--compare', nargs='*')
    ap.add_argument('--paired', nargs=2, metavar=('A_CKPT', 'B_CKPT'),
                    help='two raw checkpoints; report both on the cases they SHARE. '
                         'Use the same --bank/--per-bank/--course the runs used.')
    ap.add_argument('--labels', nargs=2, default=['local', 'genai'])
    a = ap.parse_args()

    if a.compare:
        compare(a.compare); sys.exit(0)

    if not a.variant:
        a.variant = 'band_v3' if a.grader == 'qwen' else 'baseline'
    if not a.grader and not a.paired:
        ap.error('--grader is required unless --paired or --compare is given')

    cases = (calibration_dataset() if a.set == 'calibration'
             else dataset(a.per_bank, only=a.bank or None))
    if a.set == 'constructed' and a.bank and not cases:
        sys.exit(f"no bank path matched {a.bank!r}")
    if a.limit:
        cases = cases[:a.limit]
    bands = None
    if a.course:
        import grade as _G
        _tbl = (json.load(open(a.course)).get('defaults') or {}).get('bandScores')
        bands = _G.resolve_bands(_tbl)
        print(f"band prices from {a.course}: {bands}")
    if a.paired:
        paired(cases, a.paired[0], a.paired[1], a.labels[0], a.labels[1], bands)
        sys.exit(0)

    label = f"{a.grader}/{a.variant}" if a.grader == 'qwen' else a.grader
    if a.grader == 'qwen':
        scored = grade_qwen(cases, a.variant, a.checkpoint or None)
    elif a.grader == 'local':
        scored = grade_local(cases, bands=bands, checkpoint=a.checkpoint or None)
    else:
        scored = grade_genai(cases, a.variant, bands=bands,
                             checkpoint=a.checkpoint or None)
    summary = report(label, scored, cases, bands)
    if a.save:
        json.dump({"summary": summary, "set": a.set, "per_bank": a.per_bank,
                   "bank": a.bank or "(all)"},
                  open(a.save, 'w'), indent=1)
        print(f"\nsaved {a.save}")
