#!/usr/bin/env python3
"""Points-mode benchmark: does the grader give each point the verdict it earned?

    python3 tools/eval/points-bench.py --grader local --bank courses/<id>/banks/quiz-03.json \
        --per-bank 12 --save local.json
    python3 tools/eval/points-bench.py --compare before.json after.json

WHAT IS MEASURED, AND WHY THESE NUMBERS
---------------------------------------
`bench.py` measures ORDERING, because a band grader's job is to rank. A points
grader's job is different and stricter: for every listed point it returns a
verdict, and the code turns those into a mark. So the thing to measure is the
VERDICT, against a vector known by construction (`points_fixtures.py`).

  readable     the fraction of answers that came back with a verdict for every
               point. Not a nicety: INV-GRADE-1 has no fallback, so one
               unreadable question costs the whole submission. This is the
               number that decided Quiz 3, and it belongs first.

  exact        verdicts equal to the constructed truth. A constructed `partly`
               is the one label resting on a judgement, so grader-said-`stated`
               where truth says `partly` is counted ACCEPTABLE, not wrong.

  under        THE HEADLINE. The fraction of judgements where the grader gave
               LESS credit than the answer earned — marked `absent` something
               the student said, or `partly` something they stated outright.
               Under INV-GRADE-11 this is the error that must be rare; `over` is
               the error we accept in exchange.

  over         credit the answer did not earn. Reported honestly, and deliberately
               NOT weighted equally with `under`: a grader tuned to minimise total
               error will buy accuracy on `over` with exactly the mistakes that
               cost students marks.

  optCredit    of the optional points the answer genuinely conveyed, how many were
               credited. Broken out because a grader can look fine overall while
               being structurally blind to the O points — which caps every student
               below the top of the curve, and is exactly what was happening on
               2026-09-17 (72 of 72 `absent`).

  messyCost    the mean score of the CLEAN twin minus its MESSY twin. The two
               carry identical content, so anything above zero is the grader
               marking down speech — fillers, false starts, a corrected slip,
               Whisper's own errors. An oral assessment that does that is
               measuring fluency, not understanding.

  falseClaim   of answers that assert one of the bank's own certified
               misconceptions and leave it standing, how many were caught.

  scoreErr     mean SIGNED difference between the mark given and the mark the
               constructed vector earns under the course's own `scoring` policy.
               Negative means the grader is costing students marks. The deserved
               mark is computed by running the shipped `pointscore.compute` on
               the true vector, so the comparison is against the course's policy
               rather than against an opinion about what the answer was worth.

Every case is checkpointed, and sampling is seeded by question id, so a run can
be resumed and two graders compared paired.
"""
import argparse, json, os, re, statistics, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, 'autograder', 'source'))

import points_fixtures as F                                        # noqa: E402
import bands as bands_mod                                          # noqa: E402
import pointscore                                                  # noqa: E402

RANK = {'absent': 0, 'partly': 1, 'stated': 2, 'contradicted': -1}


# ---------------------------------------------------------------------------
# prompt variants — what the LOCAL grader is told about each question
#
# Substituted into `localmodel.bank_context`, which is the one hook the shipped
# prompt exposes for this. Measuring by editing localmodel.py between runs and
# trusting that nothing else moved is how you get two numbers that are not
# comparable; this way `--variant` is the only difference.
# ---------------------------------------------------------------------------
VARIANTS = {
    # What points mode sent before 2026-09-17: prompt, rubric, points, commonErrors.
    'bare': lambda q: "",
    # + the bank's own full-credit answer.
    'ref': lambda q: _block_ref(q),
    # + verbatim lecture/slide quotes: the one thing in the bank a model cannot
    #   have got from its weights.
    'ref+evidence': None,      # the shipped bank_context; filled in at run time
    'evidence': lambda q: _block_ev(q),
}


def _block_ref(q):
    if not q.get('referenceAnswer'):
        return ""
    return ("AN EXAMPLE OF A FULL-CREDIT ANSWER (the student need not match its wording, "
            "and an answer unlike this one can still convey the points):\n" + q['referenceAnswer'])


def _block_ev(q):
    quotes = [e.get('quote') for e in (q.get('evidence') or [])
              if isinstance(e, dict) and e.get('quote')]
    if not quotes:
        return ""
    return ("WHAT THE COURSE ITSELF SAID (verbatim, from the lecture or slide this question "
            "comes from — use it to judge what counts as correct here):\n"
            + "\n".join(f'- "{q}"' for q in quotes))


# The optional-point framing, as a second axis. `old` is the wording that
# shipped until 2026-09-17 and under which 72 of 72 optional judgements came back
# `absent`; it is kept here — not in pointscore.py — for the reason
# tools/eval/variants.py keeps its own copies: a measurement you cannot re-run is
# one the reader has to take on trust. Restated rather than imported, so removing
# dead wording from the shipped prompt can never silently change what `old` means.
_OLD_OPT_FRAMING = ("SUPPORTING POINTS (validated depth beyond what was asked — judge them the "
                    "same way; an absent one is never a fault):\n")


def apply_opt_framing(which):
    import pointscore as P
    if which != 'old':
        return
    orig = P.points_block

    def patched(question):
        block = orig(question)
        i = block.find("SUPPORTING POINTS (")
        if i < 0:
            return block
        j = block.find("\n", i)
        return block[:i] + _OLD_OPT_FRAMING + block[j + 1:]
    P.points_block = patched


def apply_variant(name):
    """Point the shipped prompt at one variant. Returns the tokens it adds."""
    import localmodel
    if name and name != 'ref+evidence':
        fn = VARIANTS.get(name)
        if fn is None:
            raise SystemExit(f"unknown --variant {name!r}; have {', '.join(VARIANTS)}")
        localmodel.bank_context = fn


def load_policy(course_path):
    """The course's OWN scoring policy and ladder, never a copy.

    A benchmark that restates the curve measures the restatement. When the
    instructor re-prices `partlyFactor` the numbers here have to move with it.
    """
    course = json.load(open(course_path))
    d = course.get('defaults') or {}
    pol = pointscore.resolve_policy(d.get('scoring'))
    ladder = bands_mod.resolve(bands=d.get('bands'), band_scores=d.get('bandScores'))
    # The RAW specs travel too, because `grade()` resolves its own policy from
    # them. Handing it the resolved objects and the raw spec separately is how
    # the first version of this file measured the grader against a curve it was
    # never run under: `scoring="points"` is band pricing, and the course's
    # `scoring` is a table. Same verdicts, 0.80 against 0.92, and the gap looked
    # like a grader defect.
    return pol, ladder, d.get('scoring'), d.get('bands')


def deserved(case, pol, ladder):
    """The mark the constructed answer earns under the course's own policy."""
    q, vec = case['question'], case['vector']
    judged = {"verdicts": {p: (v, "their words" if v != 'absent' else "")
                           for p, v in vec.items()},
              "falseClaims": [], "novel": []}
    return pointscore.compute(q, judged, pol, ladder)


def grade_case(case, backend, scoring_spec, bands_spec):
    """Grade one case through the SHIPPED path, not a reimplementation."""
    import grade as G
    try:
        r = G.grade(case['answer'], case['question'], backend=backend,
                    bands=bands_spec, scoring=scoring_spec)
    except Exception as e:
        return {'error': f"{type(e).__name__}: {e}"}
    if not r or r.get('points') is None:
        return {'error': 'no points breakdown'}
    return r


def run(cases, backend, pol, ladder, scoring_spec, bands_spec, checkpoint=None):
    out = {}
    if checkpoint and os.path.exists(checkpoint):
        out = json.load(open(checkpoint))
        print(f"  resuming: {len(out)} already graded", flush=True)
    for n, c in enumerate(cases, 1):
        if c['case'] in out:
            continue
        t0 = time.time()
        r = grade_case(c, backend, scoring_spec, bands_spec)
        d = deserved(c, pol, ladder)
        rec = {'kind': c['kind'], 'messy': c['messy'], 'qid': c['qid'],
               'truth': c['vector'], 'deservedScore': d['score'],
               'deservedTotal': d['points']['total'],
               'hadFalseClaim': bool(c['falseClaim']), 'sec': round(time.time() - t0, 1)}
        if r.get('error'):
            rec['error'] = r['error']
        else:
            rec['score'] = r['score']
            rec['total'] = r['points']['total']
            rec['verdicts'] = {p['id']: p['verdict'] for p in r['points']['breakdown']}
            rec['falseClaims'] = len(r['points'].get('falseClaims') or [])
            # The EVIDENCE is kept so grounding can be checked after the fact:
            # does the quote the grader leant on actually appear in the answer it
            # was reading? A `stated` verdict resting on words the student never
            # said is a fabricated award, and it is the most likely remaining
            # lever on the over-crediting this harness measures. Kept rather than
            # scored here, because turning it into a DOWNGRADE would manufacture
            # exactly the negative mistakes INV-GRADE-11 forbids — that needs
            # measuring before it is trusted, not asserting.
            rec['evidence'] = {p['id']: (p.get('evidence') or '')[:160]
                               for p in r['points']['breakdown']}
            rec['answer'] = c['answer']
        out[c['case']] = rec
        if checkpoint and n % 10 == 0:
            json.dump(out, open(checkpoint, 'w'))
        print(f"  {n}/{len(cases)}  {c['case']}  "
              f"{'ERR ' + rec['error'][:40] if 'error' in rec else rec['score']}", flush=True)
    if checkpoint:
        json.dump(out, open(checkpoint, 'w'))
    return out


def report(res, label=""):
    graded = {k: v for k, v in res.items() if 'error' not in v}
    n = len(res)
    under = over = exact = accept = judged = optHit = optTot = 0
    for v in graded.values():
        for pid, truth in v['truth'].items():
            got = v['verdicts'].get(pid)
            if got is None:
                continue
            judged += 1
            gr, tr = RANK.get(got, 0), RANK[truth]
            if got == truth:
                exact += 1
            elif (truth, got) in F.EXPECTED_TOLERANCE:
                accept += 1
            if gr < tr:
                under += 1
            elif gr > tr:
                over += 1
            if pid.startswith('O') and truth == 'stated':
                optTot += 1
                optHit += (gr >= RANK['partly'])
    pairs = []
    for k, v in graded.items():
        if not v['messy']:
            mk = k.replace('/clean', '/messy')
            if mk in graded:
                pairs.append(v['score'] - graded[mk]['score'])
    fc = [v for v in graded.values() if v['hadFalseClaim']]
    errs = [v['score'] - v['deservedScore'] for v in graded.values()]
    below = sum(1 for e in errs if e < -0.001)

    def pct(a, b):
        return f"{100.0*a/b:5.1f}%" if b else "    -"
    print(f"\n=== {label or 'points-bench'} — {n} cases")
    print(f"  readable    {pct(len(graded), n)}   ({len(graded)}/{n})")
    print(f"  exact       {pct(exact, judged)}   (+{pct(accept, judged).strip()} acceptable partly)")
    print(f"  under       {pct(under, judged)}   <-- the error INV-GRADE-11 says must be rare")
    print(f"  over        {pct(over, judged)}   (the acceptable direction)")
    print(f"  optCredit   {pct(optHit, optTot)}   ({optHit}/{optTot} conveyed optional points credited)")
    if pairs:
        print(f"  messyCost   {statistics.mean(pairs):+.3f}  mean clean-minus-messy score "
              f"(max {max(pairs):+.2f}) over {len(pairs)} twins")
    if fc:
        print(f"  falseClaim  {pct(sum(1 for v in fc if v.get('falseClaims')), len(fc))}   "
              f"caught, of {len(fc)}")
    if errs:
        print(f"  scoreErr    {statistics.mean(errs):+.3f} mean signed; "
              f"{pct(below, len(errs)).strip()} of answers marked BELOW what they earned")
    # GROUNDING: of the verdicts that awarded credit, how many rest on words that
    # actually appear in the answer? Reported, never applied.
    gtot = ghit = 0
    for v in graded.values():
        ans = set(re.findall(r'[a-z0-9]+', (v.get('answer') or '').lower()))
        for pid, ev in (v.get('evidence') or {}).items():
            if v['verdicts'].get(pid) not in ('stated', 'partly') or not ev.strip('-  '):
                continue
            w = [x for x in re.findall(r'[a-z0-9]+', ev.lower()) if len(x) > 3]
            if not w:
                continue
            gtot += 1
            ghit += (sum(1 for x in w if x in ans) / len(w)) >= 0.6
    if gtot:
        print(f"  grounded    {pct(ghit, gtot)}   of credited verdicts quote words the student "
              f"actually said")

    bad = [k for k, v in res.items() if 'error' in v]
    if bad:
        print(f"  unreadable: {', '.join(bad[:6])}{' …' if len(bad) > 6 else ''}")
    return {'readable': len(graded) / n if n else 0,
            'under': under / judged if judged else 0, 'over': over / judged if judged else 0,
            'optCredit': optHit / optTot if optTot else 0,
            'scoreErr': statistics.mean(errs) if errs else 0}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grader', default='local')
    ap.add_argument('--bank', required=False)
    ap.add_argument('--course', required=False)
    ap.add_argument('--per-bank', type=int, default=8)
    ap.add_argument('--no-messy', action='store_true')
    ap.add_argument('--save')
    ap.add_argument('--checkpoint')
    ap.add_argument('--compare', nargs='+')
    ap.add_argument('--opt-framing', default='new', choices=['new', 'old'],
                    help="'old' restores the pre-2026-09-17 optional-point wording")
    ap.add_argument('--variant', default='ref+evidence',
                    help="what the local grader is told: " + ', '.join(VARIANTS))
    a = ap.parse_args()

    if a.compare:
        for f in a.compare:
            report(json.load(open(f)), os.path.basename(f))
        return

    import random
    # These historical ablations target the Qwen2.5 line prompt specifically.
    # Use local-profile-eval.py for the Qwen3.5 context profile.
    if a.grader == 'local':
        import localmodel
        localmodel.configure('qwen2.5-3b')
    apply_variant(a.variant)
    apply_opt_framing(a.opt_framing)
    bank = json.load(open(a.bank))
    pol, ladder, scoring_spec, bands_spec = load_policy(a.course)
    qs = bank['questions']
    rng = random.Random(f"points-bench:{bank.get('bankId')}")
    picked = rng.sample(qs, min(a.per_bank, len(qs)))
    cases = []
    for q in sorted(picked, key=lambda x: x['id']):
        cases += F.cases(q, rng, include_messy=not a.no_messy)
    print(f"{len(cases)} cases from {len(picked)} questions, "
          f"grader={a.grader}, variant={a.variant}, opt-framing={a.opt_framing}")
    res = run(cases, a.grader, pol, ladder, scoring_spec, bands_spec, a.checkpoint)
    report(res, f"{a.grader}/{a.variant}/opt-{a.opt_framing}")
    if a.save:
        json.dump(res, open(a.save, 'w'), indent=1)
        print(f"\nsaved {a.save}")


if __name__ == '__main__':
    main()
