#!/usr/bin/env python3
"""Add referenceAnswer / scoringBands / commonErrors to an existing question bank.

    python3 tools/backfill-gradability.py courses/<id>/banks/*.json
    python3 tools/backfill-gradability.py --dry-run --limit 5 banks/.../week-04-*.json

WHY BACKFILL AT ALL
-------------------
Measured (tools/eval/, report in docs/project/STATUS.md): giving the grader a model answer,
explicit score bands, and the misconceptions that must not earn credit raised
Purdue GenAI from 0.83 to 0.92 within-question pair accuracy and from 0.975 to
1.000 band separation. It matters even more to a small local model, which has far
less background knowledge to fall back on — it is most of the difference between
that model ranking answers correctly and guessing.

SAFETY
------
* The generated fields are **additive**. Nothing existing is edited, and no
  question's `id`, `prompt`, `rubric` or `keyPoints` is touched — so **which
  question a student draws does not change** (selection keys on bank contents in
  `id` order, not on these fields).
* An item that already has a field keeps it. Re-running is safe and resumable.
* Writes are atomic (temp file + rename), so an interrupted run cannot leave a
  half-written bank.
* `--dry-run` prints what it would write and changes nothing.

**Read a sample before you ship it.** This is generated content going into a
frozen bank. It is graded *against*, so a wrong `commonErrors` entry actively
costs students marks. The tool prints a sample and the validator runs afterwards,
but neither is a substitute for reading twenty of them.
"""
from __future__ import annotations
import argparse
import glob
import json
import os
import random
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "autograder", "source"))
import grade as grader   # noqa: E402  (reuse its endpoint + retry policy)

FIELDS = ("referenceAnswer", "scoringBands", "commonErrors")

SYSTEM = """\
You are helping an instructor enrich an existing, FROZEN oral-exam question bank.

For each question you are given, produce three things that help an automatic grader
apply the instructor's standard rather than its own. You are NOT rewriting the
question, the rubric, or the key points — those are fixed and authoritative, and
everything you write must be consistent with them.

  referenceAnswer  A model full-credit answer as a student would SPEAK it: 60-100
                   words, plain spoken register, contractions and all. Not a
                   textbook paragraph, not a bulleted list, no LaTeX. It must
                   cover the key points without merely reciting them verbatim.

  scoringBands     What each band looks like, as a rule a grader can apply:
                     full    what earns 1.0
                     partial ~0.65 - typically the fact without the mechanism
                     weak    ~0.3 - the vocabulary with nothing behind it
                     none    what earns nothing, INCLUDING the specific wrong
                             answer a student is most likely to give
                   One sentence each. Concrete, not generic praise.

  commonErrors     2-4 misconceptions that must NOT earn credit. These are the
                   things a student plausibly says that sound right and are wrong.
                   Specific to THIS question, never generic study advice.

Reply with ONLY a JSON object: {"items":[{"id":"...","referenceAnswer":"...",
"scoringBands":{"full":"...","partial":"...","weak":"...","none":"..."},
"commonErrors":["...","..."]}]}
One entry per question, in the order given, with the id copied exactly.
"""


def build_user(qs):
    parts = [f"Enrich these {len(qs)} questions.", ""]
    for q in qs:
        parts += [
            f"===== id: {q['id']} =====",
            f"TOPIC: {q.get('topic', '')}",
            f"PRINCIPLE: {q.get('principle', '')}",
            f"DIFFICULTY: {q.get('difficulty', 'core')}   KIND: {q.get('kind', 'explain')}",
            f"QUESTION: {q.get('prompt', '')}",
            f"RUBRIC: {q.get('rubric', '')}",
            "KEY POINTS:\n" + "\n".join(f"- {k}" for k in q.get("keyPoints", [])),
            "",
        ]
    return "\n".join(parts)


def call_model(qs, log):
    url, key, model = grader._genai_endpoint()
    if not (url and key and model):
        raise SystemExit("Set GENAI_STUDIO_BASE_URL / _API_KEY / _MODEL (they are in .env).")
    # Three enriched questions run to roughly 2,000 characters of JSON, and the
    # reply is cut off — silently, mid-string — if the server's default output
    # budget is smaller than the batch needs. Ask for room explicitly, and keep
    # batches small enough that a cut-off costs one retry rather than the run.
    body = json.dumps({
        "model": model, "temperature": 0.3,
        "max_tokens": 900 * max(1, len(qs)),
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": build_user(qs)}],
    }).encode()
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    data = grader._post_with_retry(url, body, headers, log)
    msg = (data.get("choices") or [{}])[0].get("message") or {}
    content = msg.get("content")
    # Some OpenAI-compatible servers return content as a list of parts rather
    # than a string. Flatten it rather than crashing three hundred questions in.
    if isinstance(content, list):
        content = "".join(part.get("text", "") if isinstance(part, dict) else str(part)
                          for part in content)
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("model returned no usable content")
    try:
        obj = json.loads(content)
    except Exception:
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            raise RuntimeError("model reply was not JSON")
        obj = json.loads(m.group(0))
    items = obj.get("items") if isinstance(obj, dict) else obj
    if not isinstance(items, list):
        raise RuntimeError("model reply had no items array")
    return items


BAD = re.compile(r"<[a-zA-Z/!]|\$\$|```")


def clean(entry, q):
    """Accept only well-formed, plausible content. Returns dict of fields to add."""
    out = {}
    ref = str(entry.get("referenceAnswer", "")).strip()
    # Length bounds are a proxy for "did it do the job": under 25 words it cannot
    # cover the key points, over 200 it has stopped being a spoken answer.
    if 25 <= len(ref.split()) <= 200 and not BAD.search(ref):
        out["referenceAnswer"] = ref
    bands = entry.get("scoringBands")
    if isinstance(bands, dict):
        keep = {k: str(bands[k]).strip() for k in ("full", "partial", "weak", "none")
                if isinstance(bands.get(k), str) and bands[k].strip()
                and not BAD.search(bands[k])}
        if len(keep) == 4:
            out["scoringBands"] = keep
    errs = entry.get("commonErrors")
    if isinstance(errs, list):
        keep_e = [str(e).strip() for e in errs
                  if isinstance(e, str) and 3 <= len(e.split()) <= 40 and not BAD.search(e)]
        if 2 <= len(keep_e) <= 6:
            out["commonErrors"] = keep_e[:4]
    return out


def _write(path, bank):
    """Atomic write: an interrupted run can never leave a half-written bank."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(bank, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def process_bank(path, args, log):
    with open(path, "r", encoding="utf-8") as f:
        bank = json.load(f)
    qs = bank["questions"]
    todo = [q for q in qs if any(k not in q for k in FIELDS)]
    if args.limit:
        todo = todo[:args.limit]
    name = os.path.basename(path)
    if not todo:
        print(f"  {name:44s} already complete ({len(qs)} q)")
        return 0, 0
    by_id = {q["id"]: q for q in qs}
    filled = failed = 0
    for i in range(0, len(todo), args.batch):
        chunk = todo[i:i + args.batch]
        try:
            items = call_model(chunk, log)
        except Exception as e:
            # A truncated or malformed reply is a batch-size problem, not a
            # content problem: the same questions asked one at a time almost
            # always succeed. Splitting beats discarding the work.
            print(f"\n  ~ {name} batch {i // args.batch + 1} unusable ({e}); retrying singly")
            items = []
            for q1 in chunk:
                try:
                    items.extend(call_model([q1], log))
                except Exception as e2:
                    print(f"  ! {name} {q1['id']}: {e2}")
        got = {str(it.get("id")): it for it in items if isinstance(it, dict)}
        for q in chunk:
            entry = got.get(q["id"])
            if not entry:
                failed += 1
                continue
            add = clean(entry, q)
            if not add:
                failed += 1
                continue
            for k, v in add.items():
                if k not in q:
                    q[k] = v
            filled += 1
        print(f"\r  {name:44s} {min(i + args.batch, len(todo))}/{len(todo)}",
              end="", flush=True)
        # Checkpoint after EVERY batch, not at the end of the bank. This is a
        # long job against a rate-limited service; losing an hour of work to an
        # interruption is the difference between a tool that gets used and one
        # that gets abandoned halfway.
        if not args.dry_run:
            _write(path, bank)
        # Be a good citizen even though _post_with_retry already backs off: this
        # is a long batch job, not a student waiting for a grade.
        time.sleep(random.uniform(0.5, 1.5))
    print(f"\r  {name:44s} filled {filled}, failed {failed}, of {len(todo)} needing work")

    if args.dry_run:
        sample = next((q for q in todo if "referenceAnswer" in q), None)
        if sample:
            print(f"    sample {sample['id']}: {sample['referenceAnswer'][:160]}…")
        return filled, failed

    _write(path, bank)
    return filled, failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("banks", nargs="+", help="bank json paths (globs are fine)")
    ap.add_argument("--batch", type=int, default=3,
                    help="questions per model request (default 3 — bigger batches get truncated)")
    ap.add_argument("--limit", type=int, default=0, help="only the first N per bank")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    paths = []
    for pat in args.banks:
        paths.extend(sorted(glob.glob(pat)) or [pat])
    log, tot_f, tot_x = [], 0, 0
    t0 = time.time()
    print(f"Backfilling {len(paths)} bank(s)"
          + (" — DRY RUN, nothing will be written" if args.dry_run else "") + "\n")
    for p in paths:
        f, x = process_bank(p, args, log)
        tot_f += f
        tot_x += x
    print(f"\nfilled {tot_f}, failed {tot_x}, in {time.time() - t0:.0f}s")
    if log:
        print(f"({len(log)} rate-limit retries along the way)")
    if not args.dry_run and tot_f:
        print("\nNow:")
        print("  node tools/validate-all-banks.js")
        print("  …and READ a sample. This is generated content that students are graded")
        print("  against — a wrong commonErrors entry actively costs marks.")
    return 0 if tot_x == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
