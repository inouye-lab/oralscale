#!/usr/bin/env python3
"""Measure the local grader against Purdue GenAI on a fixed answer set.

GenAI is the reference, not ground truth: the goal is a local grader an
instructor can swap in without the marks moving much, so agreement WITH GENAI is
the thing to optimise.

  python3 tools/eval/qwen-vs-genai.py --variant baseline        # score the local grader
  python3 tools/eval/qwen-vs-genai.py --reference               # (re)build the GenAI reference

Local grader must be reachable at ORALSCALE_LOCAL_URL.
Reference answers are cached so iteration does not re-pay for GenAI.
"""
import argparse, json, os, re, statistics, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'autograder', 'source'))
import localmodel as lm                                   # noqa: E402
import variants                                            # noqa: E402  (tools/eval/variants.py)

CAL = os.path.join(ROOT, 'tools', 'eval', 'grader-calibration.json')
DEMO = os.path.join(ROOT, 'courses', 'demo', 'banks', 'general-stem.json')
REF = os.path.join(ROOT, 'tools', 'eval', 'reference-genai.json')

# OPTIONAL real spoken answers, loaded from `tools/eval/local-answers.json` if it
# exists. That file is GITIGNORED and ships with nothing in it: a transcript is a
# student record, and student records do not live in this repo (INV-PRIV-1). The
# 32 synthetic calibration answers below run without it; drop your own
# [{"id","band","transcript"}] in that file to add real transcribed speech, which
# is messier than written answers and is what the grader actually meets.
REAL_FILE = os.path.join(ROOT, 'tools', 'eval', 'local-answers.json')


def real_answers():
    if not os.path.exists(REAL_FILE):
        return []
    return [(r['id'], r['band'], r['transcript']) for r in json.load(open(REAL_FILE))]


def dataset():
    """[(case_id, question, answer, intended_band)] — 35 cases."""
    out = []
    cal = json.load(open(CAL))
    for item in cal['items']:
        bank = json.load(open(os.path.join(ROOT, item['bank'])))
        q = {x['id']: x for x in bank['questions']}[item['questionId']]
        for band, ans in item['answers'].items():
            out.append((f"{item['questionId']}/{band}", q, ans, band))
    demo = {x['id']: x for x in json.load(open(DEMO))['questions']}
    for qid, band, ans in real_answers():
        out.append((f"{qid}/real", demo[qid], ans, band))
    return out


def genai(system, prompt):
    # GENAI_STUDIO_* come from the environment, or from the course .env named by
    # ORALSCALE_EVAL_ENV (e.g. courses/<id>/.env). No course is assumed.
    env = dict(os.environ)
    env_file = os.environ.get('ORALSCALE_EVAL_ENV')
    if env_file:
        for line in open(env_file):
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1); env[k.strip()] = v.strip()
    url = env['GENAI_STUDIO_BASE_URL'].rstrip('/') + '/api/chat/completions'
    body = json.dumps({"model": env['GENAI_STUDIO_MODEL'], "temperature": 0,
                       "messages": [{"role": "system", "content": system},
                                    {"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json",
                                             "Authorization": "Bearer " + env['GENAI_STUDIO_API_KEY']})
    # GenAI reports a rate limit as HTTP 400 with a message in the body, not 429
    # (documented in autograder/source/grade.py). So retry on 400 too, backing
    # off, rather than treating it as a permanent bad request.
    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read().decode())["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            detail = ''
            try: detail = e.read().decode()[:200]
            except Exception: pass
            if attempt == 7:
                raise SystemExit(f"GenAI gave up: HTTP {e.code} {detail}")
            wait = 5 * (attempt + 1)
            print(f"    (HTTP {e.code}; retry in {wait}s) {detail[:90]}")
            time.sleep(wait)


def build_reference():
    ref = json.load(open(REF)) if os.path.exists(REF) else {}
    v = variants.get('baseline')
    for cid, q, ans, _ in dataset():
        if cid in ref:
            continue
        content = genai(v.system(q), v.prompt(q, ans))
        parsed = v.parse(content, q) or {}
        ref[cid] = {"score": parsed.get('score'), "feedback": parsed.get('feedback', '')}
        print(f"  ref {cid:18s} {ref[cid]['score']}")
        json.dump(ref, open(REF, 'w'), indent=1)
    return ref


def run_local(variant_name, cases):
    v = variants.get(variant_name)
    out = {}
    for cid, q, ans, _ in cases:
        t0 = time.time()
        try:
            content = lm._chat_via_url(os.environ['ORALSCALE_LOCAL_URL'].rstrip('/'),
                                       v.prompt(q, ans), system=v.system(q))
        except TypeError:                      # older signature without system=
            content = _chat(os.environ['ORALSCALE_LOCAL_URL'].rstrip('/'), v.system(q), v.prompt(q, ans))
        parsed = v.parse(content, q)
        out[cid] = {"score": None if not parsed else parsed.get('score'),
                    "raw": content[:300], "sec": round(time.time() - t0, 1)}
    return out


def _chat(url, system, prompt):
    body = json.dumps({"model": "local", "temperature": 0, "max_tokens": 300,
                       "messages": [{"role": "system", "content": system},
                                    {"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(url + "/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer local"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())["choices"][0]["message"]["content"]


def report(name, local, ref, cases):
    rows, pairs_ok, pairs_tot = [], 0, 0
    by_q = {}
    for cid, q, ans, band in cases:
        g = ref.get(cid, {}).get('score')
        l = local.get(cid, {}).get('score')
        if g is None or l is None:
            rows.append((cid, g, l, None)); continue
        rows.append((cid, g, l, abs(g - l)))
        by_q.setdefault(cid.split('/')[0], []).append((g, l))
    errs = [r[3] for r in rows if r[3] is not None]
    # pairwise rank agreement WITHIN a question
    for qid, vals in by_q.items():
        for i in range(len(vals)):
            for j in range(i + 1, len(vals)):
                gi, li = vals[i]; gj, lj = vals[j]
                if gi == gj: continue
                pairs_tot += 1
                if (gi > gj) == (li > lj) and li != lj: pairs_ok += 1
    collapse = sum(1 for cid, q, a, b in cases
                   if ref.get(cid, {}).get('score', 0) and ref[cid]['score'] >= 0.3
                   and local.get(cid, {}).get('score') == 0.0)
    atrisk = sum(1 for cid, q, a, b in cases if (ref.get(cid, {}).get('score') or 0) >= 0.3)
    unparsed = sum(1 for cid in local if local[cid]['score'] is None)
    print(f"\n=== {name} ===")
    print(f"  MAE vs GenAI      : {statistics.mean(errs):.3f}   (n={len(errs)})")
    print(f"  within 0.15       : {sum(1 for e in errs if e<=0.15)/len(errs):.0%}")
    print(f"  rank agreement    : {pairs_ok}/{pairs_tot} = {pairs_ok/max(1,pairs_tot):.0%}")
    print(f"  COLLAPSE to 0     : {collapse}/{atrisk} answers GenAI scored >=0.3")
    print(f"  unparsed          : {unparsed}")
    return {"mae": statistics.mean(errs), "rank": pairs_ok/max(1,pairs_tot),
            "collapse": collapse, "atrisk": atrisk, "unparsed": unparsed, "rows": rows}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--variant', default='baseline')
    ap.add_argument('--reference', action='store_true')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--save', default='')
    a = ap.parse_args()
    cases = dataset()
    if a.limit: cases = cases[:a.limit]
    if a.reference:
        build_reference(); sys.exit(0)
    ref = json.load(open(REF))
    local = run_local(a.variant, cases)
    res = report(a.variant, local, ref, cases)
    if a.save:
        json.dump({"variant": a.variant, "local": local, "summary": {k: v for k, v in res.items() if k != 'rows'}},
                  open(a.save, 'w'), indent=1)
