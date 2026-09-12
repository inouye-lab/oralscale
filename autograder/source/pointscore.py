"""Point-by-point grading: the model judges each point, the CODE computes the mark.

WHY (INV-GRADE-10)
------------------
The band ladder asks a model to read five paragraphs of policy and pick the one
that fits. That puts the grading POLICY inside the prompt, where the model has to
count against it — and on a pilot quiz it did not have to be wrong to be
inconsistent: the course's own band wording overlapped ("ONE OR TWO" optional
points for `strong`, "TWO OR THREE" for `full`), so an answer with exactly two
was a coin flip and nothing described an answer with four.

This mode takes the policy out of the prompt entirely. The model answers only
narrow questions it is good at — "did the student convey THIS point?" and "did
they say anything false and leave it standing?" — and this module does the
arithmetic, so:

  * a threshold cannot be misread, because no model ever reads one;
  * the same verdicts always produce the same mark, on every backend;
  * the verdicts are recorded, so a policy change is a re-computation, not a
    re-grade; and
  * the feedback is itemised by construction.

THE VERDICTS (what the model is asked for, per point)
-----------------------------------------------------
  stated        conveyed correctly, in the student's own words      full weight
  partly        gestured at, incomplete, or only half right         half weight
  absent        not conveyed                                        0
  contradicted  the student asserted the OPPOSITE and never          minus full weight
                corrected it before the answer ended

Names were chosen for the model, not for us: none of them is a band name (so the
band parser can never mistake one for a band), and each is an ordinary word whose
everyday meaning is the rule. "contradicted" in particular says what it means —
"wrong" invited the model to use it for anything imperfect.

SELF-CORRECTION IS NOT AN ERROR. A student thinking aloud says the wrong thing,
catches it and fixes it; that is the skill an oral exam exists to see. Only the
student's FINAL position counts, both for a point and for a false claim.

PENALTIES NEED EVIDENCE. A `contradicted` verdict or a false claim with no quote
of the student's own words is not applied: it degrades to `absent` / is dropped,
and the instructor log says so. Taking marks away on the model's unquoted say-so
is the one thing this mode must not do.

THE ARITHMETIC (defaults; every number is a course knob under `scoring`)
------------------------------------------------------------------------
  required point weight 2, optional point weight 1.
  base = 2 x (number of required points) — what answering the question earns.

      points <= 0                          none
      no required point stated or partly   weak at most   (answered around it)
      points <  base                       weak
      points <  base + strongAt (1)        partial
      points <  base + fullAt   (2)        strong
      otherwise                            full

  Thresholds are RELATIVE to each question's own required total, because banks
  mix 2- and 3-required questions and fixed numbers mean different things on
  each (a 3-required answer with no depth would already sit at 6).

  An answer that states something FALSE and leaves it standing is capped at
  `partial` (the `falseClaimCap` knob), whatever its points: a confident
  misconception is not a strong answer. This is in addition to the point
  deduction when the false claim contradicts a listed point — the course chose
  to treat an uncorrected error as a penalty, not merely as a missing point.

  The band is then priced by the course's ladder exactly as in band mode, so the
  Gradescope number a student sees is on the same scale either way.
"""
from __future__ import annotations

import json
import re

VERDICTS = ("stated", "partly", "absent", "contradicted")
_FACTOR = {"stated": 1.0, "partly": 0.5, "absent": 0.0, "contradicted": -1.0}

# The band names this mode lands on. A ladder must carry all five for points mode
# to be usable (check_ladder), because the arithmetic has to have somewhere to go.
BANDS = ("full", "strong", "partial", "weak", "none")

DEFAULT_POLICY = {
    "mode": "points",
    "requiredWeight": 2.0,
    "optionalWeight": 1.0,
    "strongAt": 1.0,         # points ABOVE the required total needed for `strong`
    "fullAt": 2.0,           # ... and for `full`
    "falseClaimCap": "partial",
}


# ---------------------------------------------------------------- configuration

def resolve_policy(spec):
    """The scoring policy in force, or None for band mode. Raises ValueError.

    `spec` is the course/assignment `scoring` knob: absent, "bands", or
    {"mode": "bands"} keep the ladder exactly as it was — every existing course and
    every frozen assignment is untouched. "points" or {"mode": "points", ...} opts
    in. A points policy the engine cannot apply is REFUSED rather than repaired,
    because a mark computed under a half-understood policy is not defensible.
    """
    if spec is None or spec == "bands":
        return None
    if spec == "points":
        spec = {"mode": "points"}
    if not isinstance(spec, dict):
        raise ValueError(f"`scoring` must be \"bands\", \"points\" or an object, not {spec!r}")
    mode = spec.get("mode", "bands")
    if mode == "bands":
        return None
    if mode != "points":
        raise ValueError(f"`scoring.mode` must be \"bands\" or \"points\", not {mode!r}")
    unknown = set(spec) - set(DEFAULT_POLICY)
    if unknown:
        raise ValueError("unknown `scoring` key(s): " + ", ".join(sorted(unknown)))
    pol = dict(DEFAULT_POLICY)
    pol.update(spec)
    for k in ("requiredWeight", "optionalWeight", "strongAt", "fullAt"):
        v = pol[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
            raise ValueError(f"`scoring.{k}` must be a non-negative number, not {v!r}")
        pol[k] = float(v)
    if pol["requiredWeight"] <= 0:
        raise ValueError("`scoring.requiredWeight` must be above zero")
    if pol["fullAt"] < pol["strongAt"]:
        raise ValueError("`scoring.fullAt` must be at least `scoring.strongAt`")
    if pol["falseClaimCap"] not in BANDS:
        raise ValueError(f"`scoring.falseClaimCap` must be one of {', '.join(BANDS)}")
    return pol


def check_ladder(ladder):
    """Points mode lands on the five standard names; the ladder must price them all."""
    missing = [b for b in BANDS if ladder.score_of(b) is None]
    if missing:
        raise ValueError("points scoring needs a ladder with the bands "
                         + ", ".join(BANDS) + "; this one lacks " + ", ".join(missing))


# ---------------------------------------------------------------- the points

def point_list(question):
    """[(id, kind, text)] — R1.. for required points, O1.. for optional ones.

    The model refers to points by these short ids and never by their text, so a
    paraphrased echo of a point cannot be mistaken for a different one.
    """
    req = [str(x) for x in (question.get("keyPoints") or [])]
    opt = [str(x) for x in (question.get("bonusPoints") or [])]
    return ([(f"R{i}", "required", t) for i, t in enumerate(req, 1)]
            + [(f"O{i}", "optional", t) for i, t in enumerate(opt, 1)])


# ---------------------------------------------------------------- the prompt

# Placed in the SYSTEM prompt, replacing the band section. Deliberately says
# nothing about how many points earn what: the model is not asked to know.
RULES = """\
5. JUDGE EACH POINT ON ITS OWN. You do not choose a grade; the course staff's
   software computes it from your verdicts. For EVERY point listed under an
   answer — required (R1, R2, …) and optional (O1, O2, …) — give exactly one
   verdict:
     "stated"        the student conveyed this point correctly. Their own words,
                     informal or hesitant phrasing, and a different but correct
                     way of putting it all count.
     "partly"        the student gestured at it, got part of it, or said it
                     vaguely enough that it is only half there.
     "absent"        the student did not convey it.
     "contradicted"  the student asserted the OPPOSITE of this point (or
                     something incompatible with it) and did NOT correct
                     themselves before the answer ended.
   Judge ideas, not keywords: a point is stated when its meaning is conveyed,
   even with none of its words, and is not stated merely because its words
   appear.
   For "stated", "partly" and "contradicted", quote in "evidence" the student's
   OWN words (copied from the transcript, at most 25 words) that the verdict
   rests on. A "contradicted" verdict without a quote will be ignored.
5a. SELF-CORRECTION IS NOT AN ERROR. Students think aloud. If a student says
   something wrong and then corrects it later in the same answer ("…so it gets
   smaller — no, sorry, larger…"), judge ONLY what they finally said. A
   corrected slip is never "contradicted" and never a false claim.
5b. FALSE CLAIMS. Separately from the points, list in "falseClaims" every
   statement the student makes that is factually WRONG about the subject and
   that they leave standing at the end of the answer — including one that
   contradicts a point above. For each, give the student's words in "quote" and
   one short sentence in "why". Do not list: things they left out, vague or
   informal phrasing, an opinion, a claim that is merely imprecise, or a slip
   they corrected. When in doubt, it is not a false claim.
5c. "feedback" IS WRITTEN TO THE STUDENT, as a short narrative (3-6 sentences,
   second person, warm and specific). In this order, as flowing prose:
     - what they got right, in terms of the ideas themselves;
     - any false claim they left standing: name it kindly and say what is
       actually true, so they learn the correct idea;
     - anything the question asked for that the answer did not reach, phrased
       as what the question was getting at;
     - the optional points they did not fully make, as further ideas that would
       have STRENGTHENED or deepened the answer — extensions, never faults.
       Mention these even when the answer was excellent.
   NEVER mention points, scores, grades, bands, verdicts, a rubric, a
   checklist, "required" or "optional", or that anything was "missing" from a
   list. Do not enumerate the points; weave the ideas into sentences. The
   student must come away understanding the subject better, not guessing at a
   hidden answer key.
5d. Reply with ONLY the JSON described in the user message. No prose, no
   markdown fence, no explanation outside the JSON.
"""


def system_prompt(base_rules):
    """The shared ABSOLUTE RULES (1–4b) followed by the per-point rules above.

    `base_rules` is the band-mode system prompt text up to and not including its
    rule 5, so the injection and fairness rules are word-for-word the ones both
    modes share and cannot drift.
    """
    return base_rules.rstrip() + "\n" + RULES


def shape(n_answers):
    return ('{"answers":[{"index":0,'
            '"points":[{"id":"R1","verdict":"stated|partly|absent|contradicted",'
            '"evidence":"<the student\'s words>"}],'
            '"falseClaims":[{"quote":"<the student\'s words>","why":"<one sentence>"}],'
            '"feedback":"<a 3-6 sentence narrative to the student, per rule 5c>",'
            '"injectionSuspected":false,"injectionEvidence":""}]}')


def points_block(question):
    """The per-answer list of points, with ids, for the user message."""
    rows = point_list(question)
    req = [f"{pid}: {t}" for pid, k, t in rows if k == "required"]
    opt = [f"{pid}: {t}" for pid, k, t in rows if k == "optional"]
    out = ["REQUIRED POINTS (what the question asked for):\n" + "\n".join(req)]
    if opt:
        out.append("OPTIONAL POINTS (depth beyond what was asked — judge them the same way; "
                   "an absent one is never a fault):\n" + "\n".join(opt))
    out.append("Give a verdict for EVERY id above: " + ", ".join(pid for pid, _, _ in rows) + ".")
    return "\n".join(out)


# ---------------------------------------------------------------- parsing

def _norm_verdict(v):
    v = str(v or "").strip().lower()
    return v if v in VERDICTS else None


def read_answer(a, question):
    """A model entry -> {"verdicts": {id: (verdict, evidence)}, "falseClaims": [...]}.

    None if the entry does not carry a readable verdict for EVERY point. A missing
    verdict is a gap in the judgement, not an `absent` — booking it as absent
    would silently take marks away over a formatting slip — so it is treated as an
    unparseable answer and the INV-GRADE-4 ladder re-asks.
    """
    if not isinstance(a, dict):
        return None
    got = {}
    for p in a.get("points") or []:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "").strip().upper()
        v = _norm_verdict(p.get("verdict"))
        if pid and v:
            got[pid] = (v, str(p.get("evidence") or "").strip())
    ids = [pid for pid, _, _ in point_list(question)]
    if not ids or any(pid not in got for pid in ids):
        return None
    claims = []
    for c in a.get("falseClaims") or []:
        if isinstance(c, dict):
            claims.append({"quote": str(c.get("quote") or "").strip(),
                           "why": str(c.get("why") or "").strip()})
        elif isinstance(c, str):
            claims.append({"quote": "", "why": c.strip()})
    return {"verdicts": {pid: got[pid] for pid in ids}, "falseClaims": claims}


def parse_reply(content):
    """The `answers` array (or a single answer object) from a reply, or None."""
    try:
        obj = json.loads(content)
    except Exception:
        m = re.search(r"\{.*\}", content or "", re.S)
        if not m:
            return None
        try:
            obj = json.loads(m.group(0))
        except Exception:
            return None
    if isinstance(obj, dict) and isinstance(obj.get("answers"), list):
        return obj["answers"]
    if isinstance(obj, dict) and "points" in obj:
        return [obj]
    return obj if isinstance(obj, list) else None


# ---------------------------------------------------------------- the arithmetic

def compute(question, judged, policy, ladder):
    """Verdicts -> points -> band -> score. Pure; the same input always gives the same mark.

    Returns the result dict the rest of the autograder already understands
    (score, covered, missed, strongerIf, feedback) plus the full breakdown under
    "points" so the student and the instructor can both trace the arithmetic.
    """
    rows = point_list(question)
    w = {"required": policy["requiredWeight"], "optional": policy["optionalWeight"]}
    notes, breakdown = [], []
    total = 0.0
    any_required = False
    for pid, kind, text in rows:
        verdict, ev = judged["verdicts"][pid]
        # PENALTIES NEED EVIDENCE: an unquoted contradiction is not applied.
        if verdict == "contradicted" and not ev:
            notes.append(f"{pid}: 'contradicted' with no quote — counted as absent")
            verdict = "absent"
        pts = _FACTOR[verdict] * w[kind]
        total += pts
        if kind == "required" and verdict in ("stated", "partly"):
            any_required = True
        breakdown.append({"id": pid, "kind": kind, "text": text, "verdict": verdict,
                          "evidence": ev, "points": pts, "weight": w[kind]})

    claims = [c for c in judged["falseClaims"] if c["quote"]]
    if len(claims) < len(judged["falseClaims"]):
        notes.append(f"{len(judged['falseClaims']) - len(claims)} false claim(s) with no "
                     f"quote — ignored")
    contradicted = [b for b in breakdown if b["verdict"] == "contradicted"]

    n_req = sum(1 for _, k, _ in rows if k == "required")
    n_opt_w = sum(w["optional"] for _, k, _ in rows if k == "optional")
    base = w["required"] * n_req
    # A question with fewer optional points than a threshold asks for must still
    # have a reachable top: thresholds are clamped to what the question offers.
    strong_at = base + min(policy["strongAt"], n_opt_w)
    full_at = base + min(policy["fullAt"], n_opt_w)

    if total <= 0:
        band = "none"
    elif not any_required or total < base:
        band = "weak"
    elif total >= full_at:
        band = "full"
    elif total >= strong_at:
        band = "strong"
    else:
        band = "partial"

    capped = None
    if (claims or contradicted) and BANDS.index(band) < BANDS.index(policy["falseClaimCap"]):
        capped = band
        band = policy["falseClaimCap"]

    covered = [b["text"] for b in breakdown if b["kind"] == "required"
               and b["verdict"] in ("stated", "partly")]
    missed = [b["text"] for b in breakdown if b["kind"] == "required"
              and b["verdict"] in ("absent", "contradicted")]
    # Every optional point not fully made — shown whatever the mark, full included.
    stronger = [b["text"] for b in breakdown if b["kind"] == "optional"
                and b["verdict"] != "stated"]
    return {
        "score": float(ladder.score_of(band)),
        "band": band,
        "covered": covered,
        "missed": missed,
        "strongerIf": stronger,
        "points": {
            "total": round(total, 2), "base": base, "strongAt": strong_at, "fullAt": full_at,
            "max": base + n_opt_w, "breakdown": breakdown, "falseClaims": claims,
            "cappedFrom": capped, "notes": notes,
        },
    }


# ---------------------------------------------------------------- presentation

def _join(items):
    items = [str(x).rstrip(".") for x in items]
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def narrative_fallback(p):
    """Narrative feedback built from the verdicts, when the model gave none.

    Used by the keyword heuristic and for an empty model `feedback`. Same shape
    as rule 5c asks of the model — right, corrected, not reached, extensions —
    and, like it, never names points, scores or a rubric.
    """
    b = p["breakdown"]
    good = [x["text"] for x in b if x["verdict"] == "stated"]
    part = [x["text"] for x in b if x["verdict"] == "partly"]
    gap = [x["text"] for x in b if x["kind"] == "required" and x["verdict"] == "absent"]
    more = [x["text"] for x in b if x["kind"] == "optional" and x["verdict"] != "stated"]
    s = []
    if good:
        s.append(f"Your answer came across clearly on this: {_join(good)}.")
    if part:
        s.append(f"You were heading in the right direction on {_join(part)}; saying it "
                 f"out loud in full would have made it land.")
    if p["falseClaims"]:
        s.append("One thing to revisit: " + _join(
            [c["why"] or f"\"{c['quote']}\" is not right" for c in p["falseClaims"]]) + ".")
    if gap:
        s.append(f"The question was also getting at this: {_join(gap)}.")
    if more:
        s.append(f"To take the answer further, you could have added that {_join(more)}.")
    return " ".join(s) or "Thank you for your answer."

_LABEL = {"stated": "addressed", "partly": "partly addressed", "absent": "not addressed",
          "contradicted": "contradicted (not corrected)"}


def _fmt(x):
    return f"{x:+g}" if x else "0"


def instructor_text(p):
    rows = [f"  {b['id']} {b['verdict']:<12} {_fmt(b['points']):>5}  {b['text'][:70]}"
            + (f"\n        ev: \"{b['evidence'][:120]}\"" if b["evidence"] else "")
            for b in p["breakdown"]]
    s = (f"points {p['total']:g} (base {p['base']:g}, strong ≥{p['strongAt']:g}, "
         f"full ≥{p['fullAt']:g}, max {p['max']:g})\n" + "\n".join(rows))
    for c in p["falseClaims"]:
        s += f"\n  FALSE: \"{c['quote'][:120]}\" — {c['why'][:120]}"
    if p["cappedFrom"]:
        s += f"\n  capped from {p['cappedFrom']} by an uncorrected false statement"
    for n in p["notes"]:
        s += f"\n  NOTE: {n}"
    return s
