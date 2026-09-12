#!/usr/bin/env python3
"""A held-out ORDERING test, on questions the prompt was never tuned against.

Eight variants were iterated against 8 questions. That is few enough to overfit,
so this checks the one property that needs no new reference scores and cannot be
gamed by matching GenAI: given three answers to the same question that are known
by construction to be ordered, does the grader order them?

Answers are made by DEGRADING each question's own referenceAnswer:
  full    the reference answer as written
  partial its first ~60%, cut at a sentence boundary
  weak    its first sentence only

That ordering is a fact about the inputs, not a judgement, so a grader that
inverts it is wrong whatever GenAI would have said.
"""
import json, os, re, sys, itertools

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'autograder', 'source'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'eval'))
import variants                                            # noqa: E402

CAL_IDS = {'s-002','s-004','s-005','s-006','s-008','s-009','s-011','s-012'}
# Point ORALSCALE_EVAL_BANKS at a course's banks/ directory for a real hold-out;
# the demo bank is only twelve questions, so it is a smoke run, not a measurement.
BANKS = os.environ.get('ORALSCALE_EVAL_BANKS', os.path.join(ROOT, 'courses', 'demo', 'banks'))


def sentences(t):
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+', t.strip()) if s.strip()]


def build(n_questions=8):
    out = []
    files = sorted(os.listdir(BANKS))
    for f in files:
        bank = json.load(open(os.path.join(BANKS, f)))
        for q in bank['questions']:
            if q['id'] in CAL_IDS:
                continue
            ref = (q.get('referenceAnswer') or '').strip()
            ss = sentences(ref)
            if len(ss) < 3 or not q.get('keyPoints'):
                continue
            cut = max(1, int(len(ss) * 0.6))
            out.append((q, {'full': ref,
                            'partial': ' '.join(ss[:cut]),
                            'weak': ss[0]}))
            break                       # one question per bank, for spread
        if len(out) >= n_questions:
            break
    return out[:n_questions]


def main(variant_name):
    v = variants.get(variant_name)
    url = os.environ['ORALSCALE_LOCAL_URL'].rstrip('/')
    # the harness filename is hyphenated (it is a CLI, not a module), so load it
    # by path rather than keeping a second copy of it in sync
    import importlib.util
    _spec = importlib.util.spec_from_file_location(
        'qwen_vs_genai', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'qwen-vs-genai.py'))
    H = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(H)
    ok = tot = 0
    ties = 0
    per = []
    for q, answers in build():
        scores = {}
        for level, ans in answers.items():
            content = H._chat(url, v.system(q), v.prompt(q, ans))
            p = v.parse(content, q)
            scores[level] = None if not p else p.get('score')
        per.append((q['id'], scores))
        order = ['full', 'partial', 'weak']
        for a, b in itertools.combinations(order, 2):
            sa, sb = scores.get(a), scores.get(b)
            if sa is None or sb is None:
                continue
            tot += 1
            if sa > sb: ok += 1
            elif sa == sb: ties += 1
    print(f"\n=== HELD-OUT ordering: {variant_name} ===")
    for qid, s in per:
        print(f"  {qid:10s} full={s.get('full')}  partial={s.get('partial')}  weak={s.get('weak')}")
    print(f"  correct order : {ok}/{tot} = {ok/max(1,tot):.0%}")
    print(f"  ties          : {ties}/{tot}")
    print(f"  inversions    : {tot-ok-ties}/{tot}")


if __name__ == '__main__':
    sys.argv[0] = 'holdout'
    main(sys.argv[1] if len(sys.argv) > 1 else 'band_v2')
