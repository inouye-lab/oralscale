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
  partly        gestured at, incomplete, or only half right         partlyFactor
                                                                    (half by default)
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

CURVE MODE: `table` (instructor, 2026-09-15)
--------------------------------------------
Set `scoring.table` and the bands stop deciding the mark. The point total is
read straight off a curve the instructor writes, one entry per whole point:

      table = [0, 0.70, 0.85, 0.90, 0.92, 0.95, 0.97, 1.00]
               0     1     2      3     4     5     6     7+

A total between two entries takes the lower one by default, or the higher when
`curveRounding` is "up"; anything at or above the last entry takes the last.
Two ceilings replace the band caps:

  falseClaimCapScore  the most an answer with an uncorrected false claim can
                      score, on top of the point the claim already cost.
  noCoreCapScore      the most an answer can score when it conveyed no CORE
                      point at all — depth and novel credit cannot stand in for
                      answering the question.

WHY A CURVE. Under the ladder, a correct but simplified answer was `partial`,
and the instructor wanted that to be a good mark rather than a middling one,
with the top of the scale reserved for genuine depth. Writing the curve out
point by point says exactly that, and says it in the units the instructor
actually thinks in: what is two points worth, what is three. It also removes the
last place a threshold could be misread, because there is no threshold left —
just a lookup.

PARTLY IS A COURSE KNOB: `partlyFactor`
---------------------------------------
What a half-made point is worth is a grading policy, not an engineering
constant, so it sits with the rest of them. The default is 0.5. A course that
would rather round up sets 1.0, and then a `partly` is worth exactly what a
`stated` is.

WHAT THAT COSTS, stated plainly because it is easy to miss: at 1.0 an answer
that gestures at every point scores the same as one that states every point
crisply, so vagueness stops costing anything and the verdict survives only as a
signal in the instructor record. That is a legitimate choice for a pilot that
would rather be generous than precise, and a poor one for a scale meant to
separate strong answers from adequate ones. The model is never told the number
either way — it reports what it saw, and the course prices it.

NOVEL POINTS (same decision)
----------------------------
The listed points are VALIDATED — checked by the course staff and known to be
true — but they were never meant to be the only correct things a student could
say. A student who explains the idea with their own example, or reaches it by a
route the bank author did not write down, has demonstrated the understanding the
question exists to find. So the model may also report points the student made
that are NOT on the list, each `full`, `partial` or `wrong`, with a quote.

  * A correct novel point earns `novelWeight`, half for `partial`.
  * Novel credit is capped per answer at `novelCap`, because a grader that can
    invent credit is a grader that can be talked into inventing it, and because
    the cap keeps the curve's top reachable by understanding rather than volume.
  * A `wrong` novel point IS a false claim: it costs the weight and trips
    `falseClaimCapScore`, exactly like one the model lists under `falseClaims`.
  * The evidence rule is unchanged and now cuts both ways: a novel point with no
    quote of the student's words is not counted, for or against.
"""
from __future__ import annotations

import json
import math
import re

VERDICTS = ("stated", "partly", "absent", "contradicted")
_FACTOR = {"stated": 1.0, "partly": 0.5, "absent": 0.0, "contradicted": -1.0}

# The verdicts for a point the student made that is NOT on the list. Different
# words from VERDICTS on purpose: "absent" is meaningless for a point nobody
# listed, and a shared vocabulary would let one list's verdict be read as the
# other's. `wrong` is a false claim by another name and is handled as one.
NOVEL_VERDICTS = ("full", "partial", "wrong")
_NOVEL_FACTOR = {"full": 1.0, "partial": 0.5, "wrong": -1.0}

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
    # What a `partly` verdict is worth, as a fraction of the point's weight.
    # 0.5 is the engine default; a course that would rather round a half-made
    # point UP sets 1.0 (see PARTLY IS A COURSE KNOB in the module docstring).
    # Never above 1.0: a half-made point cannot outscore a fully made one.
    "partlyFactor": 0.5,
    # --- CURVE MODE (below) -------------------------------------------------
    # Present `table` and the band ladder stops deciding the mark; see the
    # CURVE MODE note under THE ARITHMETIC above. Absent, all four are unused
    # and this module behaves exactly as it did.
    "table": None,             # [score for 0 points, 1 point, 2 points, ...]
    "curveRounding": "down",   # which way a half point goes: "down" or "up"
    "novelWeight": 1.0,        # an unlisted but correct point the student made
    "novelCap": 3.0,           # the most novel credit one answer can collect
    # AN UNGROUNDED QUOTE IS NOT EVIDENCE (default OFF — instructor's call).
    #
    # When on, a `stated` or `partly` verdict whose quote does not appear in the
    # transcript is scored `absent`: the grader awarded credit on words the
    # student never said. It is the same rule INV-GRADE-10 already applies to a
    # `contradicted` verdict with no quote and to an unquoted novel point — an
    # award with no evidence is not an award — extended from "no quote" to "a
    # quote of nothing".
    #
    # MEASURED, on 449 credited verdicts over 102 constructed answers
    # (tools/eval/points-bench.py, qwen2.5-3b, quiz-03):
    #
    #   quote NOT in the transcript   94 credits, 91 of them FALSE   (97%)
    #   quote in the transcript      355 credits, 125 of them FALSE  (35%)
    #
    # Turning it on removes 91 of 216 false credits (42%) and costs 3 correct
    # ones — roughly thirty to one. That is the single largest lever measured on
    # the over-crediting, and unlike everything else tried it is deterministic
    # code rather than a prompt.
    #
    # DEFAULT OFF ANYWAY, and deliberately. Those 3 are NEGATIVE mistakes, which
    # INV-GRADE-11 says to design against: a grader that paraphrases the student
    # instead of quoting them would cost marks for its own habits, not the
    # student's answer. Whether 42% less false credit is worth 0.7% of credits
    # wrongly withdrawn is a grading-policy decision, and those belong to the
    # instructor. Set `"requireGroundedEvidence": true` in `scoring` to take it.
    "requireGroundedEvidence": False,
    "falseClaimCapScore": None,   # ceiling after an uncorrected false claim
    "noCoreCapScore": None,       # ceiling when no CORE point was conveyed
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
    # CURVE MODE. A table the engine cannot read is REFUSED, never repaired: a
    # curve is the whole grading scale, and half of one is not a scale.
    if pol["table"] is not None:
        t = pol["table"]
        if not isinstance(t, (list, tuple)) or len(t) < 2:
            raise ValueError("`scoring.table` must be a list of at least two scores")
        vals = []
        for i, v in enumerate(t):
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ValueError(f"`scoring.table[{i}]` must be a number, not {v!r}")
            if not 0.0 <= float(v) <= 1.0:
                raise ValueError(f"`scoring.table[{i}]` must be between 0 and 1, not {v}")
            vals.append(float(v))
        # Monotone, for the same reason a ladder must be: a curve where more
        # points can score less cannot be explained to the student it happened to.
        if any(b < a for a, b in zip(vals, vals[1:])):
            raise ValueError("`scoring.table` must never decrease: more points cannot score less")
        pol["table"] = vals
    for k in ("novelWeight", "novelCap"):
        v = pol[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
            raise ValueError(f"`scoring.{k}` must be a non-negative number, not {v!r}")
        pol[k] = float(v)
    if pol["curveRounding"] not in ("up", "down"):
        raise ValueError('`scoring.curveRounding` must be "up" or "down", not '
                         f'{pol["curveRounding"]!r}')
    v = pol["partlyFactor"]
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.0 <= float(v) <= 1.0:
        # Above 1.0 would make a half-made point beat a fully made one, which is
        # not a generous policy but an incoherent one.
        raise ValueError(f"`scoring.partlyFactor` must be between 0 and 1, not {v!r}")
    pol["partlyFactor"] = float(v)
    for k in ("falseClaimCapScore", "noCoreCapScore"):
        v = pol[k]
        if v is None:
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.0 <= float(v) <= 1.0:
            raise ValueError(f"`scoring.{k}` must be a score between 0 and 1, not {v!r}")
        pol[k] = float(v)
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
    """Points mode lands on the five standard names; the ladder must price them all.

    CURVE MODE NEEDS NO LADDER. When `scoring.table` is set the mark comes off
    the curve and no band name is ever produced, so a course on a curve is not
    required to keep a five-rung ladder it no longer uses. `grade_all` skips
    this check in that case.
    """
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
   software computes it from your verdicts. The listed points are VALIDATED —
   the course staff have checked that each one is true — but they are NOT the
   only correct things a student could say, and they are not a checklist the
   student was shown. For EVERY point listed under an answer — core (R1, R2, …)
   and supporting (O1, O2, …) — give exactly one verdict:
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
5b. CREDIT WHAT THEY ACTUALLY SAID, not only what is on the list. In
   "novelPoints", list every SUBSTANTIVE and CORRECT point the student made that
   is NOT one of the listed points above. The clearest case is a concrete
   example or analogy that would convince an interviewer the student really
   understands the idea, rather than reciting the principle back. A correct
   route to the answer that the list simply does not mention counts too.
   For each, give:
     "claim"    one short sentence naming the point they made;
     "quote"    the student's OWN words it rests on (at most 25 words);
     "verdict"  "full"    a substantive, correct, relevant point, well made;
                "partial" substantive and correct but only half developed;
                "wrong"   they offered it as an additional point and it is
                          FALSE — this is a false claim and it costs them.
   Be strict about what earns this. It is NOT for restating a listed point in
   other words (that is already judged above), for fluent phrasing, for
   enthusiasm, for background they did not connect to the question, or for a
   true but irrelevant fact. When the answer adds nothing beyond the listed
   points, return an empty list — that is the normal case and it costs the
   student nothing. A novel point without a quote will be ignored.
5c. FALSE CLAIMS. Separately from the points, list in "falseClaims" every
   statement the student makes that is factually WRONG about the subject and
   that they leave standing at the end of the answer — including one that
   contradicts a point above. For each, give the student's words in "quote" and
   one short sentence in "why". Do not list: things they left out, vague or
   informal phrasing, an opinion, a claim that is merely imprecise, or a slip
   they corrected. When in doubt, it is not a false claim.
5d. "feedback" IS WRITTEN TO THE STUDENT, as a short narrative (3-6 sentences,
   second person, warm and specific). In this order, as flowing prose:
     - what they got right, in terms of the ideas themselves, INCLUDING a good
       example or line of reasoning of their own — say what made it work;
     - any false claim they left standing: name it kindly and say what is
       actually true, so they learn the correct idea;
     - only if the answer did not reach the core of the question: what the
       question was getting at, explained as an idea rather than as a gap.
   DO NOT list ideas the student did not mention. If they answered the question
   correctly, do not tell them what else they could have said: a student who
   answered well and is handed a list of unsaid things reads it as a tally of
   what they lost, and learns to pad rather than to think. Say what the answer
   did, and stop.
   NEVER mention points, scores, grades, bands, verdicts, a rubric, a
   checklist, "required" or "optional", or that anything was "missing" from a
   list. Do not enumerate the points; weave the ideas into sentences. The
   student must come away understanding the subject better, not guessing at a
   hidden answer key.
5e. Reply with ONLY the JSON described in the user message. No prose, no
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
            '"novelPoints":[{"claim":"<one sentence>","quote":"<the student\'s words>",'
            '"verdict":"full|partial|wrong"}],'
            '"falseClaims":[{"quote":"<the student\'s words>","why":"<one sentence>"}],'
            '"feedback":"<a 3-6 sentence narrative to the student, per rule 5d>",'
            '"injectionSuspected":false,"injectionEvidence":""}]}')


def points_block(question):
    """The per-answer list of points, with ids, for the user message."""
    rows = point_list(question)
    req = [f"{pid}: {t}" for pid, k, t in rows if k == "required"]
    opt = [f"{pid}: {t}" for pid, k, t in rows if k == "optional"]
    # NO SCORING LANGUAGE ON THE OPTIONAL POINTS (instructor decision, 2026-09-17).
    #
    # This used to read "validated depth beyond what was asked — judge them the
    # same way; an absent one is never a fault". Every clause of that is about
    # what the points are WORTH, addressed to a model that rule 5 has just told
    # it does not choose the grade. Measured against qwen2.5-3b it read as
    # permission to skip them: across 24 answers, 72 of 72 optional judgements
    # came back `absent` — including on answers that stated all three in plain
    # language, nearly verbatim. That capped every student at 0.92 and made the
    # curve's top three rungs unreachable.
    #
    # The "never a fault" guarantee (INV-GRADE-9) is not weakened by removing it
    # from here, because the prompt was never what enforced it: `optionalWeight`
    # is ADDED and never subtracted, so an absent optional point cannot lower a
    # mark whatever the model is told. The guarantee lives in the arithmetic,
    # which is where a guarantee belongs. What the model needs is the only thing
    # it is actually being asked: did the student convey this or not.
    out = ["CORE POINTS (validated, and what the question is getting at — any one of them, "
           "said correctly, is already a sound if simplified answer):\n" + "\n".join(req)]
    if opt:
        out.append("SUPPORTING POINTS (validated exactly like the core points, and judged by "
                   "exactly the same test — did the student convey this idea? Read the transcript "
                   "for each one on its own merits; students reach these often):\n"
                   + "\n".join(opt))
    out.append("Give a verdict for EVERY id above: " + ", ".join(pid for pid, _, _ in rows) + ".")
    out.append("Then, per rule 5b, list in \"novelPoints\" any substantive, correct point the "
               "student made that is NOT listed above — an example of their own, or a correct "
               "route the list does not mention. An empty list is the normal case.")
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
    # NOVEL POINTS are optional in the reply and absent from most answers, so an
    # empty or missing list is ordinary — unlike a missing VERDICT, which is a gap
    # in the judgement and makes the whole answer unparseable above. An entry
    # whose verdict we cannot read is dropped rather than guessed at.
    novel = []
    for n in a.get("novelPoints") or []:
        if not isinstance(n, dict):
            continue
        v = str(n.get("verdict") or "").strip().lower()
        if v not in NOVEL_VERDICTS:
            continue
        novel.append({"claim": str(n.get("claim") or "").strip(),
                      "quote": str(n.get("quote") or "").strip(), "verdict": v})
    return {"verdicts": {pid: got[pid] for pid in ids}, "falseClaims": claims, "novel": novel}


def _as_answers(obj):
    """An `answers` array, a single answer object, or a bare list — else None."""
    if isinstance(obj, dict) and isinstance(obj.get("answers"), list):
        return obj["answers"]
    if isinstance(obj, dict) and "points" in obj:
        return [obj]
    return obj if isinstance(obj, list) else None


def parse_reply(content):
    """The `answers` array (or a single answer object) from a reply, or None.

    WHY THIS SCANS RATHER THAN SLICING FIRST-BRACE-TO-LAST (2026-09-17)
    ------------------------------------------------------------------
    It used to fall back to `re.search(r"\{.*\}", ..., re.S)`, which is greedy:
    it runs from the FIRST `{` to the LAST `}` anywhere in the reply. That works
    for a model which answers with one object and stops, and fails completely for
    one that answers correctly and then keeps talking — and a 3B keeps talking.
    Observed on every question of a real Quiz 3 submission: qwen2.5-3b emitted a
    complete, valid, perfectly gradeable object and then appended "The JSON:"
    and a pretty-printed, TRUNCATED copy of it. The greedy slice glued the good
    object to the broken restatement, `json.loads` refused the pair, and the
    autograder reported `local model reply lacked a verdict for every point` —
    five times, then `REGRADE REQUIRED` and a zero. The model had graded the
    answer correctly and we threw it away over punctuation after the fact.

    So: decode the first BALANCED object that is actually an answer, using the
    JSON decoder's own bracket matching rather than a regex that cannot count.
    Trailing text after a complete object is ignored, which is the whole point;
    leading prose before one is too, which a small model also does.

    This is shared by both backends deliberately. A parser that is lenient for
    one grader and strict for the other would make the two produce different
    marks from the same judgement, which is the divergence INV-GRADE-1 exists to
    prevent.
    """
    content = content or ""
    try:
        got = _as_answers(json.loads(content))
        if got is not None:
            return got
    except Exception:
        pass
    dec = json.JSONDecoder()
    for i, ch in enumerate(content):
        if ch not in "{[":
            continue
        try:
            obj, _ = dec.raw_decode(content, i)
        except ValueError:
            continue
        got = _as_answers(obj)
        # A decodable object that is not an ANSWER is not the one we want: a
        # model may open with some other JSON entirely. Keep scanning.
        if got is not None:
            return got
    return None


# ---------------------------------------------------------------- the arithmetic

def _from_curve(total, table, rounding="down"):
    """The score for a point total, off the instructor's curve.

    One entry per whole point. Anything at or above the last entry takes the
    last, and below the first entry is the first entry — which is how a negative
    total (contradictions outweighing everything said) lands on zero without a
    special case.

    WHICH WAY A HALF POINT GOES IS THE COURSE'S CALL (`curveRounding`):

      "down" (the default)  a total between two entries takes the LOWER one, so
                            half a point never buys a rung on its own.
      "up"                  it takes the HIGHER one, so a half point always
                            buys something.

    Rounding UP is what makes a `partly` optimistic rather than pessimistic. At
    half weight a lone half-made point is worth 0.5, and rounding down that is
    indistinguishable from having said nothing at all — the student is told the
    grader saw something and the mark says it counted for nothing. Rounding up
    keeps `partly` cheap (two of them still buy only what one whole point buys)
    while guaranteeing it is never worth zero.
    """
    idx = int(math.ceil(total) if rounding == "up" else math.floor(total))
    return float(table[max(0, min(idx, len(table) - 1))])


def _words(t):
    return [w for w in re.findall(r"[a-z0-9]+", (t or "").lower())]


def _claim_has_a_reason(claim):
    """A false claim needs a REASON, not a restatement of the quote.

    PENALTIES NEED EVIDENCE is already the rule for an unquoted claim. This is the
    same rule one step further in: a claim whose `why` merely repeats the words it
    is accusing carries no reason at all, so there is nothing to check and nothing
    to tell the student.

    Found on a real Quiz 3 submission (2026-09-17), and it was not a rare slip —
    it was EVERY question. qwen2.5-3b judged all the points correctly, earned the
    full 7 of 7, and then emitted:

        FALSE: "The single values are ordered, 3, 1, 0."
             — The single values are ordered, 3, 1, 0.

    which is not false and not a reason. `falseClaimCapScore` then capped a 1.00
    answer to 0.85, on all five questions, for every student. A systematic mark
    taken off work that was done — the exact error INV-GRADE-11 exists to prevent,
    arriving through a penalty the grader could not justify.

    The test is deliberately crude and one-directional: a `why` that is empty, or
    that adds almost no words of its own to the quote, cannot support a penalty.
    Anything that reads like an actual explanation passes. Erring towards dropping
    a real false claim is the acceptable direction; erring towards keeping a
    fabricated one is not.
    """
    why, quote = _words(claim.get("why")), _words(claim.get("quote"))
    if len(why) < 3:
        return False
    # THE TEST IS "IS THIS THE WHOLE QUOTE BACK AGAIN", not "does it share words".
    #
    # The first version asked for a third of the reason's words to be its own,
    # and that was too blunt: it also threw out a SHORT reason naming the
    # misconception inside a LONG quote, which is a real detection poorly
    # justified rather than a fabricated one. Measured over the six planted
    # misconceptions in points-bench, it took detection from 6/6 to 2/6 — trading
    # a systematic negative mistake for four missed penalties, when a narrower
    # test gets both.
    #
    # What the fabricated claims actually looked like was the whole quote, echoed:
    #   FALSE: "The single values are ordered, 3, 1, 0."
    #        — The single values are ordered, 3, 1, 0.
    # So that is what this rejects — a `why` that is the quote over again, at
    # much the same length — and nothing else.
    if not quote:
        return True
    shorter, longer = sorted((why, quote), key=len)
    if len(shorter) / len(longer) < 0.7:
        return True                      # a short reason about a long quote is fine
    overlap = sum(1 for w in shorter if w in set(longer))
    return overlap / len(shorter) < 0.9


def _grounded(quote, transcript):
    """Does this quote rest on words that are actually in the transcript?

    Deliberately loose. The model reformats what it hears — punctuation, filler,
    a dropped word — and an exact-substring test would reject honest quotes and
    manufacture the negative mistakes this is supposed to avoid. Short words are
    ignored (they match by accident) and a clear majority of the rest must be
    present.
    """
    words = [w for w in re.findall(r"[a-z0-9]+", (quote or "").lower()) if len(w) > 3]
    if not words:
        return True                      # nothing to check is not a failed check
    heard = set(re.findall(r"[a-z0-9]+", (transcript or "").lower()))
    return sum(1 for w in words if w in heard) / len(words) >= 0.6


def compute(question, judged, policy, ladder, transcript=None):
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
        # AWARDS NEED EVIDENCE TOO, when the course asks for it. See
        # `requireGroundedEvidence` in DEFAULT_POLICY for the measurement and for
        # why it is off unless the instructor turns it on.
        elif (policy.get("requireGroundedEvidence") and transcript
              and verdict in ("stated", "partly")
              and not _grounded(ev, transcript)):
            notes.append(f"{pid}: '{verdict}' quoting words not in the transcript "
                         f"— counted as absent")
            verdict = "absent"
        # `partly` is the one verdict whose price a course owns (partlyFactor).
        # The model is never told what it is worth — it reports what it saw, and
        # the course decides what a half-made point buys.
        factor = policy["partlyFactor"] if verdict == "partly" else _FACTOR[verdict]
        pts = factor * w[kind]
        total += pts
        if kind == "required" and verdict in ("stated", "partly"):
            any_required = True
        breakdown.append({"id": pid, "kind": kind, "text": text, "verdict": verdict,
                          "evidence": ev, "points": pts, "weight": w[kind]})

    claims = [c for c in judged["falseClaims"] if c["quote"] and _claim_has_a_reason(c)]
    if len(claims) < len(judged["falseClaims"]):
        notes.append(f"{len(judged['falseClaims']) - len(claims)} false claim(s) with no "
                     f"quote or no reason — ignored")
    contradicted = [b for b in breakdown if b["verdict"] == "contradicted"]

    # NOVEL POINTS: what the student said that the list does not contain. The
    # same evidence rule as every penalty, applied to an award: no quote of the
    # student's own words, no effect. `wrong` is a false claim the model found
    # while looking for credit, so it joins `claims` and trips the same ceiling.
    novel = []
    for n in judged.get("novel") or []:
        if not n["quote"]:
            notes.append("novel point with no quote — not counted: " + (n["claim"][:60] or "?"))
            continue
        # A novel `partial` is the same judgement as a listed `partly` — half a
        # point, made — so it is priced by the same knob rather than a second one.
        nf = (policy["partlyFactor"] if n["verdict"] == "partial"
              else _NOVEL_FACTOR[n["verdict"]])
        pts = nf * policy["novelWeight"]
        if n["verdict"] == "wrong":
            claims.append({"quote": n["quote"],
                           "why": n["claim"] or "offered as an additional point, and not correct"})
        novel.append({**n, "points": pts})
    earned = sum(x["points"] for x in novel if x["points"] > 0)
    credited = min(earned, policy["novelCap"])
    if credited < earned:
        notes.append(f"novel credit {earned:g} capped at {policy['novelCap']:g}")
    total += credited + sum(x["points"] for x in novel if x["points"] < 0)

    n_req = sum(1 for _, k, _ in rows if k == "required")
    n_opt_w = sum(w["optional"] for _, k, _ in rows if k == "optional")
    base = w["required"] * n_req
    # A question with fewer optional points than a threshold asks for must still
    # have a reachable top: thresholds are clamped to what the question offers.
    strong_at = base + min(policy["strongAt"], n_opt_w)
    full_at = base + min(policy["fullAt"], n_opt_w)

    capped, capped_by = None, []
    if policy["table"]:
        # CURVE MODE: no band is chosen at all. The total is read off the curve,
        # then the two ceilings apply. They are ceilings and never floors — a
        # ceiling can only ever take away a mark the answer had earned, which is
        # the only direction a penalty is allowed to move.
        band = None
        score = _from_curve(total, policy["table"], policy["curveRounding"])
        before = score
        cap_fc = policy["falseClaimCapScore"]
        if (claims or contradicted) and cap_fc is not None and score > cap_fc:
            score, _ = cap_fc, capped_by.append("an uncorrected false statement")
        cap_nc = policy["noCoreCapScore"]
        if not any_required and cap_nc is not None and score > cap_nc:
            score, _ = cap_nc, capped_by.append("no core point conveyed")
        if capped_by:
            capped = before
    else:
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

        if (claims or contradicted) and BANDS.index(band) < BANDS.index(policy["falseClaimCap"]):
            capped = band
            band = policy["falseClaimCap"]
            capped_by.append("an uncorrected false statement")
        score = float(ladder.score_of(band))

    covered = [b["text"] for b in breakdown if b["kind"] == "required"
               and b["verdict"] in ("stated", "partly")]
    missed = [b["text"] for b in breakdown if b["kind"] == "required"
              and b["verdict"] in ("absent", "contradicted")]
    # Every optional point not fully made — shown whatever the mark, full included.
    stronger = [b["text"] for b in breakdown if b["kind"] == "optional"
                and b["verdict"] != "stated"]
    return {
        "score": float(score),
        "band": band,
        "covered": covered,
        "missed": missed,
        "strongerIf": stronger,
        "points": {
            "total": round(total, 2), "base": base, "strongAt": strong_at, "fullAt": full_at,
            "max": base + n_opt_w, "breakdown": breakdown, "falseClaims": claims,
            "cappedFrom": capped, "cappedBy": capped_by, "notes": notes,
            "novel": novel, "novelCredit": credited, "novelCap": policy["novelCap"],
            "curve": list(policy["table"]) if policy["table"] else None,
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
    mine = [x["claim"] for x in p.get("novel") or [] if x["points"] > 0 and x["claim"]]
    s = []
    if good:
        s.append(f"Your answer came across clearly on this: {_join(good)}.")
    if mine:
        s.append(f"It was good to hear you make the point yourself that {_join(mine)}.")
    if part:
        s.append(f"You were heading in the right direction on {_join(part)}; saying it "
                 f"out loud in full would have made it land.")
    if p["falseClaims"]:
        s.append("One thing to revisit: " + _join(
            [c["why"] or f"\"{c['quote']}\" is not right" for c in p["falseClaims"]]) + ".")
    # NOTHING ABOUT WHAT THEY DID NOT SAY unless the question itself went
    # unanswered (instructor, 2026-09-15). A student who answered well and is
    # handed a list of unsaid things reads it as what they lost, and the listed
    # points were never a list they were shown — several of them are not
    # derivable from the prompt at all. The supporting points the student did not
    # make stay in the instructor record and out of their feedback.
    if gap and not good:
        s.append(f"What the question was getting at is this: {_join(gap)}.")
    return " ".join(s) or "Thank you for your answer."

_LABEL = {"stated": "addressed", "partly": "partly addressed", "absent": "not addressed",
          "contradicted": "contradicted (not corrected)"}


def _fmt(x):
    return f"{x:+g}" if x else "0"


def instructor_text(p):
    rows = [f"  {b['id']} {b['verdict']:<12} {_fmt(b['points']):>5}  {b['text'][:70]}"
            + (f"\n        ev: \"{b['evidence'][:120]}\"" if b["evidence"] else "")
            for b in p["breakdown"]]
    if p.get("curve"):
        s = (f"points {p['total']:g} (listed max {p['max']:g}, novel credit "
             f"{p.get('novelCredit', 0):g} of {p.get('novelCap', 0):g}) on curve "
             + "/".join(f"{x:g}" for x in p["curve"]) + "\n" + "\n".join(rows))
    else:
        s = (f"points {p['total']:g} (base {p['base']:g}, strong ≥{p['strongAt']:g}, "
             f"full ≥{p['fullAt']:g}, max {p['max']:g})\n" + "\n".join(rows))
    for n in p.get("novel") or []:
        s += (f"\n  NOVEL {n['verdict']:<8} {_fmt(n['points']):>5}  {n['claim'][:70]}"
              + (f"\n        ev: \"{n['quote'][:120]}\"" if n["quote"] else ""))
    for c in p["falseClaims"]:
        s += f"\n  FALSE: \"{c['quote'][:120]}\" — {c['why'][:120]}"
    if p["cappedFrom"] is not None:
        why = ", ".join(p.get("cappedBy") or ["an uncorrected false statement"])
        s += f"\n  capped from {p['cappedFrom']} by {why}"
    for n in p["notes"]:
        s += f"\n  NOTE: {n}"
    return s
