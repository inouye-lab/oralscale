#!/usr/bin/env python3
"""Run/replay frozen synthetic cases against the integrated local points profile.

Use only synthetic/approved de-identified cases. No service other than the loopback
llama-server is contacted. Freeze references BEFORE running; do not tune on holdout.
See docs/reference/LOCAL-GRADING.md for reproduction commands and label limitations.
"""
import argparse,hashlib,json,pathlib,statistics,sys,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'autograder/source'))
import qwen35 as Q,pointscore as P,bands as B,grade as G

def digest(x):return hashlib.sha256(json.dumps(x,sort_keys=True).encode()).hexdigest()
def read(path):
    p=pathlib.Path(path)
    return [json.loads(l) for l in p.read_text().splitlines() if l] if p.suffix=='.jsonl' else json.loads(p.read_text())
def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--bank',required=True);ap.add_argument('--course',required=True)
    ap.add_argument('--assignment',required=True);ap.add_argument('--cases')
    ap.add_argument('--replay',nargs='+');ap.add_argument('--out',required=True)
    ap.add_argument('--limit',type=int)
    a=ap.parse_args();bank=json.loads(pathlib.Path(a.bank).read_text());course=json.loads(pathlib.Path(a.course).read_text())
    qmap={q['id']:q for q in bank['questions']};ac=course['assignments'][a.assignment];defaults=course.get('defaults',{})
    policy=P.resolve_policy(ac.get('scoring',defaults.get('scoring')))
    if not policy:raise ValueError('This evaluation requires points scoring')
    ladder=G.resolve_bands(ac.get('bandScores',defaults.get('bandScores')), ac.get('bands',defaults.get('bands')))
    rows=[r for f in a.replay for r in read(f)] if a.replay else read(a.cases)
    if a.limit:rows=rows[:a.limit]
    dest=pathlib.Path(a.out);dest.parent.mkdir(parents=True,exist_ok=True)
    # Refuse overwrite: a run is evidence, not a mutable cache.
    errors=[];under=over=exact=0;replay_checks=0;elapsed=time.monotonic()
    with dest.open('x') as f:
        for r in rows:
            q=qmap[r['questionId']];transcript=r['transcript'];payload=Q.payload(q,transcript)
            if a.replay:
                if payload != r['diagnostic']['payload']:raise ValueError('Frozen request changed: '+r['id'])
                obj,flags=Q.parse(r['diagnostic']['raw'],q,transcript)
                result=P.compute(q,P.read_answer(obj,q),policy,ladder,transcript)
                if result['points']['total']!=r['result']['points']['total'] or result['score']!=r['result']['score']:
                    raise ValueError('Scoring changed: '+r['id'])
                replay_checks+=1
            else:
                for attempt in range(4):
                    result=Q.grade_one(q,transcript,'synthetic-evaluation',policy=policy,ladder=ladder,
                        reminder=attempt>0,temperature=.3 if attempt==3 else 0)
                    if 'error' not in result:break
                if 'error' in result:raise RuntimeError(result['error'])
            gold=r.get('gold')
            if gold is None and r.get('reference'):
                gold=P.compute(q,P.read_answer(r['reference'],q),policy,ladder,transcript)['points']['total']
            row={'id':r['id'],'questionId':r['questionId'],'gold':gold,'computed':result['points']['total'],
                 'score':result['score'],'requestSha256':digest(payload),'result':result}
            if not a.replay:row.update(transcript=transcript,diagnostic=Q.LAST_DIAGNOSTIC)
            f.write(json.dumps(row,ensure_ascii=False)+'\n');f.flush()
            if gold is not None:
                e=row['computed']-gold;errors.append(e);under+=e<0;over+=e>0;exact+=e==0
    summary={'profile':Q.PROFILE,'n':len(rows),'replayParity':replay_checks,'seconds':time.monotonic()-elapsed,
       'goldCases':len(errors),'under':under,'over':over,'exact':exact,
       'mae':statistics.mean(abs(e) for e in errors) if errors else None,
       'meanLostCredit':statistics.mean(max(0,-e) for e in errors) if errors else None,
       'meanExcessCredit':statistics.mean(max(0,e) for e in errors) if errors else None}
    dest.with_suffix('.summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
if __name__=='__main__':main()
