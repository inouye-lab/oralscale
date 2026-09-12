#!/usr/bin/env python3
"""Assemble the model-selection study into the tables that go in the docs.

Reads everything under tools/eval/study-results/ -- the memory screen
(memory.jsonl), the per-model local runs (*.summary.json) and the Purdue GenAI
runs (genai.*.json) -- and prints markdown.

Kept separate from model-study.py on purpose: the study driver must be safe to
re-run and interrupt, and a reporting bug should never cost a measurement.
"""
import glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, 'study-results')
SHIPPED = 'band_v3'
ORDER = ["full", "partial", "weak", "none"]
SLATE = {m['key']: m for m in json.load(open(os.path.join(HERE, 'model-slate.json')))['models']}
CEILING = 5.5


def memory():
    p = os.path.join(RESULTS, 'memory.jsonl')
    if not os.path.exists(p):
        return {}
    return {json.loads(l)['key']: json.loads(l)['probe'] for l in open(p) if l.strip()}


def local_runs():
    out = {}
    for f in glob.glob(os.path.join(RESULTS, '*.summary.json')):
        s = json.load(open(f))
        out.setdefault((s['model'], s['variant']), {})[s.get('set', 'constructed')] = s
    return out


def shipped_only(runs):
    """The headline tables compare MODELS, so they must hold the prompt fixed."""
    return {m: v for (m, var), v in runs.items() if var == SHIPPED}


def genai_runs():
    out = {}
    for f in glob.glob(os.path.join(RESULTS, 'genai.*.json')):
        base = os.path.basename(f)[len('genai.'):-len('.json')]
        model, _, setname = base.rpartition('.')
        out.setdefault(model.replace('_', ':'), {})[setname] = json.load(open(f))['summary']
    return out


def pct(a, b):
    return f"{a/b:.0%}" if b else "--"


def main():
    mem, allruns, gen = memory(), local_runs(), genai_runs()
    loc = shipped_only(allruns)

    print("## Memory screen — measured, not estimated\n")
    print("| model | file | **peak RSS** | headroom in 6 GB | verdict |")
    print("|---|---|---|---|---|")
    for k, p in sorted(mem.items(), key=lambda kv: kv[1]['peak_gb']):
        peak = p['peak_gb']
        v = ("**ruled out** (over 5.5 GB)" if peak > CEILING
             else "tight" if peak > 5.0 else "comfortable")
        print(f"| `{k}` | {p['file_gb']:.2f} GB | **{peak:.2f} GB** | "
              f"{(6-peak)/6:.0%} | {v} |")

    for setname, title, note in [
        ('constructed', 'A — 512 constructed answers, all 16 banks',
         'Ordering is fixed by construction. Inversions are the fairness metric.'),
        ('calibration', 'B — 32 hand-authored answers',
         'The only true absolute band labels. Small, but it is where the weak/none '
         'boundary is judged.')]:
        print(f"\n## {title}\n\n_{note}_\n")
        # `levels` is the guard on the tuned MAE. Fitting a table to a model
        # that ties everything can COLLAPSE two bands onto one score, which
        # improves MAE while destroying the resolution the grade depends on. A
        # model showing 4 bands and 2 levels is not calibrated, it is flattened.
        print("| model | peak | ordering | **inversions** | ties | MAE shipped | "
              "**MAE tuned** | tuned table | levels | collapse | **unparsed** | s/answer |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        rows = [(k, v[setname]) for k, v in loc.items() if setname in v]
        rows.sort(key=lambda r: (r[1]['inversions'] / max(1, r[1]['order_tot']),
                                 r[1]['mae_calibrated'] if r[1]['mae_calibrated'] is not None else 9))
        for k, s in rows:
            peak = mem.get(k, {}).get('peak_gb')
            tbl = "/".join(f"{s['map'][b]:g}" for b in ORDER)
            levels = len({s['map'][b] for b in ORDER})
            over = peak and peak > CEILING
            name = f"~~`{k}`~~" if over else f"`{k}`"
            print(f"| {name} | {peak:.2f} GB | {pct(s['order_ok'], s['order_tot'])} | "
                  f"**{s['inversions']}/{s['order_tot']}** | {pct(s['ties'], s['order_tot'])} | "
                  f"{s['mae_fixed']:.3f} | **{s['mae_calibrated']:.3f}** | {tbl} | "
                  f"{'**' + str(levels) + '**' if levels < 4 else levels} | "
                  f"{s['collapse']}/{s['collapse_of']} | "
                  f"{'**' + str(s['unparsed']) + '**' if s['unparsed'] else '0'} | "
                  f"{s['sec_median']} |")

        if gen:
            print(f"\n**Purdue GenAI, same {setname} set:**\n")
            print("| model | ordering | inversions | ties | MAE | " +
                  " | ".join(ORDER) + " |")
            print("|---|---|---|---|---|" + "---|" * len(ORDER))
            for m, v in sorted(gen.items()):
                if setname not in v:
                    continue
                s = v[setname]
                bm = " | ".join(f"{s['band_means'][b]:.2f}"
                                if s['band_means'][b] is not None else "--" for b in ORDER)
                print(f"| `{m}` | {pct(s['order_ok'], s['order_tot'])} | "
                      f"**{s['inversions']}/{s['order_tot']}** | "
                      f"{pct(s['ties'], s['order_tot'])} | {s['mae']:.3f} | {bm} |")

    print("\n## Mean score by intended band (local, constructed set)\n")
    print("| model | " + " | ".join(ORDER) + " |")
    print("|---|" + "---|" * len(ORDER))
    print("| _nominal_ | 1.00 | 0.65 | 0.30 | 0.00 |")
    for k, v in sorted(loc.items()):
        s = v.get('constructed')
        if not s:
            continue
        print(f"| `{k}` | " + " | ".join(
            f"{s['band_means'][b]:.2f}" if s['band_means'][b] is not None else "--"
            for b in ORDER) + " |")


def variants_table(allruns, setname):
    by_model = {}
    for (m, var), v in allruns.items():
        if setname in v:
            by_model.setdefault(m, {})[var] = v[setname]
    out = [m for m in by_model if len(by_model[m]) > 1]
    if not out:
        return
    print(f"\n## Prompt variants, {setname} set\n")
    print("_`band_v3` is the shipped prompt. It carries an ANTI-HARSHNESS rule written "
          "for Qwen2.5-3B; every other model here errs generous, so the rule pushes them "
          "the wrong way._\n")
    print("| model | prompt | ordering | **inversions** | ties | **MAE tuned** | levels | unparsed |")
    print("|---|---|---|---|---|---|---|---|")
    for m in sorted(out):
        for var, s in sorted(by_model[m].items(),
                             key=lambda kv: kv[1]['inversions'] / max(1, kv[1]['order_tot'])):
            lv = len({s['map'][b] for b in ORDER})
            mark = " *(shipped)*" if var == SHIPPED else ""
            print(f"| `{m}` | `{var}`{mark} | {pct(s['order_ok'], s['order_tot'])} | "
                  f"**{s['inversions']}/{s['order_tot']}** | "
                  f"{pct(s['ties'], s['order_tot'])} | "
                  f"**{s['mae_calibrated']:.3f}** | {lv} | {s['unparsed']} |")


if __name__ == '__main__':
    main()
    _all = local_runs()
    for _s in ('calibration', 'constructed'):
        variants_table(_all, _s)
