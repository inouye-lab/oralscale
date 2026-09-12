#!/usr/bin/env python3
"""Compare candidate local graders: memory, ordering, and CALIBRATED accuracy.

WHY A SECOND HARNESS AND NOT MORE FLAGS ON bench.py
---------------------------------------------------
`bench.py` answers "is the shipped grader good enough?" for ONE model against
Purdue GenAI. This answers a different question -- "which model should ship?" --
and that question needs three things bench.py has no place for:

  1. SERVING many models one at a time, at one quantisation, with the reasoning
     mode switched off where the chat template has one.
  2. Recording the BAND the model chose, not the score. A score is a band plus a
     mapping table, and the mapping is ours, so storing the score throws away the
     only thing the model actually produced and makes step 3 impossible.
  3. FITTING that mapping per model, and scoring it out-of-fold.

WHY THE MAPPING IS PER-MODEL, AND WHY IT CHANGES NOTHING ABOUT ORDERING
-----------------------------------------------------------------------
The shipped table (full 1.0 / partial 0.65 / weak 0.3 / none 0.0) is shared by
both graders on purpose, so marks are commensurable. But when COMPARING
CANDIDATES, a fixed table punishes a model for a bias that one number would fix:
Gemma-family models are systematically generous and Qwen-family harsh, so MAE
under a fixed table mostly measures which direction a model leans, not whether
it can tell answers apart.

So each model gets a table fitted to its own behaviour. Note what this can and
cannot do:

  * It CANNOT change ordering, inversions or ties. Those are computed from the
    band the model chose, and any monotone table preserves them exactly. A model
    that ranks a worse answer above a better one still does after calibration.
  * It CAN remove systematic generosity or harshness, which is the part of MAE
    that is our problem to fix rather than the model's.

That split is the whole point: judge SEPARATION by inversions and ties, judge
what is left by calibrated MAE, and never let a fixable bias decide the choice.

The fitted table is scored OUT OF FOLD (k-fold, grouped by question, so a
question's four answers never straddle the split). An in-sample table would
flatter every model equally and rank them by how much room each had to cheat.

  python3 tools/eval/model-study.py --list
  python3 tools/eval/model-study.py --model qwen3-4b --set calibration
  python3 tools/eval/model-study.py --model qwen3-4b --set constructed --per-bank 2
  python3 tools/eval/model-study.py --report
"""
import argparse, json, os, re, statistics, subprocess, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, 'autograder', 'source'))

import bench as B                                                   # noqa: E402
import variants as V                                                # noqa: E402

ORDER = ["full", "partial", "weak", "none"]
NOMINAL = {"full": 1.0, "partial": 0.65, "weak": 0.3, "none": 0.0}
SLATE = json.load(open(os.path.join(HERE, 'model-slate.json')))['models']
BY_KEY = {m['key']: m for m in SLATE}
MODELDIR = os.path.join(HERE, 'models')
RESULTS = os.path.join(HERE, 'study-results')


# ---------------------------------------------------------------------------
# serving — llama-server, one model at a time, deliberately
#
# Not ollama: the Homebrew build on this machine is CPU-only (measured, 17 s per
# answer against ~1 s here), and more importantly ollama re-quantises and re-wraps
# a GGUF behind its own name, so what runs is a step removed from the file the
# autograder would download. llama-server loads the exact Q4_K_M artefact at the
# exact context the grader uses.
#
# ONE AT A TIME is a hard rule, not a nicety: this is someone's working laptop,
# and holding two 5 GB models resident takes it away from them. The server is
# started for a run and killed at the end of it, even on failure.
# ---------------------------------------------------------------------------
LCPP = os.environ.get("ORALSCALE_LCPP", os.path.join(
    os.path.dirname(os.path.dirname(HERE)), '.lcpp'))
PORT = int(os.environ.get("ORALSCALE_STUDY_PORT", "8899"))
URL = f"http://127.0.0.1:{PORT}"


class Server:
    """llama-server for one model, as a context manager."""

    def __init__(self, key, ctx=4096):
        self.spec, self.ctx, self.proc = BY_KEY[key], ctx, None
        self.path = os.path.join(MODELDIR, self.spec['file'])
        self.log = os.path.join(RESULTS, f"server.{key}.log")

    def __enter__(self):
        if not os.path.exists(self.path):
            raise SystemExit(f"model file missing: {self.path}")
        env = dict(os.environ, DYLD_LIBRARY_PATH=LCPP)
        cmd = [os.path.join(LCPP, 'llama-server'), '-m', self.path,
               '-c', str(self.ctx), '-b', '256', '--port', str(PORT),
               '-ngl', '999', '--no-webui', '--jinja', '-np', '1']
        # A rubric task gains nothing from a <think> block and pays minutes per
        # question for it, so reasoning is switched OFF at the server rather than
        # hoped away in the prompt. Both flags: `--reasoning off` covers the
        # template, `--reasoning-budget 0` covers a model that starts anyway.
        if self.spec.get('think'):
            cmd += ['--reasoning', 'off', '--reasoning-budget', '0']
        os.makedirs(RESULTS, exist_ok=True)
        self.proc = subprocess.Popen(cmd, env=env, stdout=open(self.log, 'w'),
                                     stderr=subprocess.STDOUT)
        for _ in range(600):
            if self.proc.poll() is not None:
                raise SystemExit(f"llama-server died; see {self.log}\n"
                                 + open(self.log).read()[-3000:])
            try:
                with urllib.request.urlopen(URL + "/health", timeout=2) as r:
                    if r.status == 200:
                        return self
            except Exception:
                time.sleep(1)
        raise SystemExit(f"llama-server did not come up; see {self.log}")

    def __exit__(self, *exc):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        return False


def chat(system, prompt, timeout=600):
    """One completion. Returns (content, seconds)."""
    body = {"model": "local", "temperature": 0, "top_p": 1, "seed": 1729,
            "max_tokens": 400,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": prompt}]}
    req = urllib.request.Request(
        URL + "/v1/chat/completions", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode())
    return data["choices"][0]["message"]["content"], time.time() - t0


# ---------------------------------------------------------------------------
_SCORE_BAND = {v: k for k, v in NOMINAL.items()}


def band_of(parsed):
    """The band a variant's parse() implies. None if it produced no judgement."""
    if not parsed or parsed.get('score') is None:
        return None
    s = parsed['score']
    if s in _SCORE_BAND:
        return _SCORE_BAND[s]
    # a numeric fallback reply: bucket it to the nearest band so it still counts
    return min(ORDER, key=lambda b: abs(NOMINAL[b] - s))


def run(key, variant, cases, checkpoint):
    """Grade every case, checkpointing. Stores the BAND, not a score."""
    v = V.get(variant)
    out = {}
    if os.path.exists(checkpoint):
        out = json.load(open(checkpoint))
        print(f"  resuming: {len(out)} already graded", flush=True)
    todo = [c for c in cases if c[0] not in out]
    print(f"  {key}/{variant}: {len(todo)} to grade ({len(cases)} total)", flush=True)
    t_start = time.time()
    for n, (cid, _bank, q, ans, _nom) in enumerate(todo, 1):
        try:
            content, sec = chat(v.system(q), v.prompt(q, ans))
            parsed = v.parse(content, q)
            out[cid] = {"band": band_of(parsed), "sec": round(sec, 2),
                        "raw": (content or "")[:200]}
        except Exception as e:
            out[cid] = {"band": None, "sec": None, "err": f"{type(e).__name__}: {e}"[:200]}
        if n % 10 == 0 or n == len(todo):
            json.dump(out, open(checkpoint, 'w'))
            rate = (time.time() - t_start) / n
            print(f"    {n}/{len(todo)}  {rate:.1f}s/answer  "
                  f"eta {(len(todo)-n)*rate/60:.1f}m", flush=True)
    json.dump(out, open(checkpoint, 'w'))
    return out


# ---------------------------------------------------------------------------
# metrics
# ---------------------------------------------------------------------------
def fit_map(pairs):
    """band -> score, fitted to minimise MAE, then forced monotone.

    For absolute error the best constant for a group is its MEDIAN, so each
    predicted band maps to the median NOMINAL score of the answers that got it.
    Bands the model never used keep their shipped value.

    Monotonicity is then enforced along full > partial > weak > none. Without it
    a sparsely-used band can invert the table and turn a grader that ranks
    correctly into one that does not -- introducing, in the calibration step, the
    exact failure the calibration step exists to avoid.
    """
    groups = {}
    for pred, true in pairs:
        groups.setdefault(pred, []).append(NOMINAL[true])
    m = {b: (statistics.median(groups[b]) if groups.get(b) else NOMINAL[b]) for b in ORDER}
    for i in range(1, len(ORDER)):
        hi, lo = ORDER[i - 1], ORDER[i]
        if m[lo] > m[hi]:
            m[lo] = m[hi]
    return {b: round(m[b], 3) for b in ORDER}


def cv_mae(cases, got, folds=4):
    """Out-of-fold MAE under a per-model fitted map, plus the full-data map.

    Folds are grouped by QUESTION: a question's four answers go to the same fold,
    so a map is never fitted on one rung of a question and tested on another.
    """
    qids = sorted({cid.split('/')[0] for cid, *_ in cases})
    fold_of = {q: i % folds for i, q in enumerate(qids)}
    usable = [(cid, nom) for cid, _bk, _q, _a, nom in cases
              if got.get(cid, {}).get('band')]
    errs = []
    for f in range(folds):
        train = [(got[cid]['band'], nom) for cid, nom in usable
                 if fold_of[cid.split('/')[0]] != f]
        test = [(got[cid]['band'], nom) for cid, nom in usable
                if fold_of[cid.split('/')[0]] == f]
        if not train or not test:
            continue
        m = fit_map(train)
        errs += [abs(m[p] - NOMINAL[t]) for p, t in test]
    full = fit_map([(got[cid]['band'], nom) for cid, nom in usable])
    return (statistics.mean(errs) if errs else None), full


def summarise(key, variant, cases, got):
    by_q = {}
    for cid, bank, q, _a, nom in cases:
        by_q.setdefault((q['id'], bank), {})[nom] = got.get(cid, {}).get('band')

    ok = tot = ties = inv = 0
    for _k, g in by_q.items():
        for i, a in enumerate(ORDER):
            for b in ORDER[i + 1:]:
                ba, bb = g.get(a), g.get(b)
                if not ba or not bb:
                    continue
                tot += 1
                ra, rb = NOMINAL[ba], NOMINAL[bb]
                if ra > rb: ok += 1
                elif ra == rb: ties += 1
                else: inv += 1

    fixed, per_band, unparsed, collapse, fullish = [], {b: [] for b in ORDER}, 0, 0, 0
    secs = []
    for cid, _bk, _q, _a, nom in cases:
        g = got.get(cid, {})
        if g.get('sec'): secs.append(g['sec'])
        if not g.get('band'):
            unparsed += 1
            continue
        s = NOMINAL[g['band']]
        fixed.append(abs(s - NOMINAL[nom]))
        per_band[nom].append(s)
        if nom in ('full', 'partial'):
            fullish += 1
            if s == 0.0: collapse += 1

    cal, table = cv_mae(cases, got)
    return {"model": key, "variant": variant, "n": len(cases),
            "order_ok": ok, "order_tot": tot, "ties": ties, "inversions": inv,
            "mae_fixed": statistics.mean(fixed) if fixed else None,
            "mae_calibrated": cal, "map": table,
            "collapse": collapse, "collapse_of": fullish, "unparsed": unparsed,
            "sec_median": round(statistics.median(secs), 2) if secs else None,
            "band_means": {b: (round(statistics.mean(per_band[b]), 3)
                               if per_band[b] else None) for b in ORDER}}


def show(s):
    print(f"\n=== {s['model']} / {s['variant']} ===  ({s['n']} answers)")
    print(f"  ordering, strict    : {s['order_ok']}/{s['order_tot']} = "
          f"{s['order_ok']/max(1,s['order_tot']):.1%}")
    print(f"  INVERSIONS          : {s['inversions']}/{s['order_tot']} = "
          f"{s['inversions']/max(1,s['order_tot']):.1%}")
    print(f"  ties                : {s['ties']}/{s['order_tot']} = "
          f"{s['ties']/max(1,s['order_tot']):.0%}")
    print(f"  MAE, shipped table  : {s['mae_fixed']:.3f}" if s['mae_fixed'] is not None else "")
    print(f"  MAE, tuned (out-of-fold): "
          f"{s['mae_calibrated']:.3f}" if s['mae_calibrated'] is not None else "")
    print(f"  fitted map          : {s['map']}")
    print(f"  collapsed to 0      : {s['collapse']}/{s['collapse_of']}")
    print(f"  unparsed            : {s['unparsed']}")
    print(f"  median s/answer     : {s['sec_median']}")
    print("  mean score by band  : " + "  ".join(
        f"{b}={s['band_means'][b]}" for b in ORDER))


# ---------------------------------------------------------------------------
if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--model')
    ap.add_argument('--variant', default='band_v3')
    ap.add_argument('--set', default='calibration', choices=['constructed', 'calibration'])
    ap.add_argument('--per-bank', type=int, default=2)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--report', action='store_true')
    a = ap.parse_args()
    os.makedirs(RESULTS, exist_ok=True)

    if a.list:
        for m in SLATE:
            p = os.path.join(MODELDIR, m['file'])
            print(f"  {m['key']:14s} {m['gb']:5.2f} GB  {m['family']:8s} "
                  f"{'downloaded' if os.path.exists(p) else 'MISSING'}")
        sys.exit(0)

    if a.report:
        rows = []
        for f in sorted(os.listdir(RESULTS)):
            if f.endswith('.summary.json'):
                rows.append(json.load(open(os.path.join(RESULTS, f))))
        for r in rows:
            show(r)
        sys.exit(0)

    cases = (B.calibration_dataset() if a.set == 'calibration'
             else B.dataset(a.per_bank))
    if a.limit:
        cases = cases[:a.limit]
    tag = f"{a.model}.{a.variant}.{a.set}{'' if a.set=='calibration' else a.per_bank}"
    with Server(a.model):
        got = run(a.model, a.variant, cases, os.path.join(RESULTS, tag + '.raw.json'))
    s = summarise(a.model, a.variant, cases, got)
    s['set'] = a.set
    json.dump(s, open(os.path.join(RESULTS, tag + '.summary.json'), 'w'), indent=1)
    show(s)
