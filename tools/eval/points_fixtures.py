#!/usr/bin/env python3
"""Spoken answers with a KNOWN per-point verdict vector, for points-mode evaluation.

WHY THIS EXISTS
---------------
Every other harness in this directory measures BAND mode, and measures ORDERING:
`bench.py` and `holdout.py` degrade a question's own `referenceAnswer` into
full/partial/weak/none and ask whether the grader ranks them correctly. That is
the right ground truth for a grader that returns one label per answer, and it
does not transfer to points mode at all — there is no way to degrade an answer
into a known *vector* of per-point verdicts.

Points mode needs the opposite construction. Instead of taking a whole answer
apart, build one up from a chosen subset of the question's own points, so the
correct verdict for every id is known BY CONSTRUCTION rather than by anyone's
judgement. That is what this module does, and it is what makes a claim like
"the grader never credits optional points" a measurement instead of an anecdote.

WHY THE ANSWERS ARE NOT THE POINT TEXT
--------------------------------------
Pasting `keyPoints` verbatim would measure string matching and flatter any
grader. Worse, it would measure the wrong thing twice over: bank points are
written in bank voice ("Noting that the bound is attained by…"), which is not
a sentence any student has ever said out loud. So each point is rewritten —
bank framing stripped, contractions, a spoken lead-in, clauses reordered — and
the renderings are seeded, so a rerun sees byte-identical inputs and two graders
can be compared paired.

CLEAN AND MESSY TWINS
---------------------
Every case is generated twice with the SAME content and the same verdict
vector: once fluent, once as the transcript of someone actually talking —
fillers, false starts, self-corrections, and the specific errors Whisper makes
on this material (spoken maths, split and merged words, homophones, digits).
The pair is the measurement: the two differ in delivery and in nothing else, so
any gap between their marks is the grader penalising *speech*, which is the one
thing an oral assessment must never do. INV-GRADE-3 requires a grader to be fair
to spoken phrasing; until now nothing measured it.

WHAT IS NOT CONSTRUCTED HERE, AND WHY
-------------------------------------
`contradicted` verdicts are NOT synthesised by negating a point. Mechanical
negation produces sentences that are ambiguous or nonsense as often as they are
contradictions ("the rank is not the number of nonzero singular values" — of
what, then?), and a fixture whose own label is doubtful cannot measure anything.
Instead the false-claim cases assert one of the bank's `commonErrors`, which the
course author has already certified as a wrong belief a student actually holds.
That is a real label, written by a human, and it tests the property that matters:
does an uncorrected misconception get caught?
"""
from __future__ import annotations
import random
import re

# --------------------------------------------------------------------------
# turning bank voice into student voice
# --------------------------------------------------------------------------

# Optional points are written as sentence fragments hanging off an implied "the
# student also gets credit for…": "Noting that…", "Observing that…", "Saying…".
# Left in place they are a tell — every optional point would start the same way
# and none of them would be a sentence.
_BANK_VOICE = re.compile(
    r'^(noting|observing|saying|admitting|recognising|recognizing|pointing out|'
    r'mentioning|acknowledging|noticing)\s+(that\s+)?', re.I)

_MATH = [
    (r'\$?\\mathrm\{([^}]*)\}\$?', r'\1'),
    (r'\$\\Sigma\$', 'sigma'), (r'\\Sigma', 'sigma'),
    (r'\$\\sigma_?\{?(\d)\}?\$', r'sigma \1'),
    (r'\$1\\times\s*1\$', 'one by one'),
    (r'\$([A-Za-z])\^T([A-Za-z])\$', r'\1 transpose \2'),
    (r'\$([A-Za-z])\^T\$', r'\1 transpose'),
    (r'\$([A-Za-z])\$', r'\1'),
    (r'\$([^$]*)\$', r'\1'),
]


def speak_math(text: str) -> str:
    """Render the bank's LaTeX the way a person says it aloud.

    A student never pronounces a dollar sign, and Whisper never writes one. A
    fixture that leaves the markup in is asking the grader to match on notation
    the transcript cannot contain.
    """
    for pat, rep in _MATH:
        text = re.sub(pat, rep, text)
    return text.replace('\\', '')


_LEAD_IN = ["I think ", "basically ", "so ", "I mean ", "the way I see it, ",
            "pretty much ", "essentially ", ""]
_CONTRACTIONS = [(" cannot ", " can't "), (" do not ", " don't "), (" does not ", " doesn't "),
                 (" is not ", " isn't "), (" it is ", " it's "), (" that is ", " that's "),
                 (" you are ", " you're "), (" they are ", " they're "),
                 (" will not ", " won't "), (" need not ", " doesn't have to be ")]


# "A, so B" and "B, because A" say the same thing in the other order. A real
# reordering rather than a word swap, and meaning-preserving by construction,
# which is the bar every transform in this file has to clear.
_SO = re.compile(r'^(.*?),\s+so\s+(.*)$', re.I)
_MID = ["basically", "really", "kind of", "honestly", "pretty much", "I guess"]


def to_student_voice(text: str, rng: random.Random) -> str:
    """One bank point, as a sentence someone might actually say.

    Strip the framing, reorder where the sentence allows it, contract, add a
    spoken lead-in and one mid-sentence marker. Nothing here changes the IDEA —
    the verdict label travels with the idea, so a rewrite that altered the
    meaning would silently corrupt the ground truth.

    IT MUST ALSO NOT BE VERBATIM, and that is a property, not a nicety
    (`t_points_fixtures`). An early version only lowercased the first letter and
    contracted, so a point written without contractions came through unchanged —
    and an eval whose answers contain the bank's own sentences measures string
    matching and flatters every grader that does it.
    """
    t = speak_math(text).strip().rstrip('.')
    t = _BANK_VOICE.sub('', t)
    m = _SO.match(t)
    if m and rng.random() < 0.5:
        t = f"{m.group(2)}, because {m.group(1)}"
    t = t[0].lower() + t[1:] if t else t
    for a, b in _CONTRACTIONS:
        if rng.random() < 0.7:
            t = t.replace(a, b)
    # One marker INSIDE the sentence, always. The lead-in alone leaves the
    # bank's own clause intact as a contiguous substring.
    w = t.split()
    if len(w) > 3:
        at = rng.randrange(1, min(4, len(w)))
        w.insert(at, rng.choice(_MID))
        t = " ".join(w)
    return rng.choice(_LEAD_IN) + t + "."


# Where a point can be cut in half and still be recognisably half-made.
_SPLIT = re.compile(r',\s+(?:so|and|which|because)\s+|\s+because\s+|:\s+', re.I)
_HEDGE = ["kind of", "sort of", "something like", "roughly", "more or less"]


def halve(text: str, rng: random.Random) -> str:
    """A `partly` rendering: the first clause only, hedged.

    `partly` is the vaguest of the four verdicts and therefore the one a
    constructed fixture is least certain about — see `EXPECTED_TOLERANCE`.
    """
    t = speak_math(text).strip().rstrip('.')
    t = _BANK_VOICE.sub('', t)
    head = _SPLIT.split(t)[0]
    head = head[0].lower() + head[1:] if head else head
    return f"{rng.choice(_LEAD_IN)}{rng.choice(_HEDGE)} {head}, I think."


# --------------------------------------------------------------------------
# messiness: what the transcript of a real attempt looks like
# --------------------------------------------------------------------------
_FILLER = ["um,", "uh,", "like,", "you know,", "I mean,", "sort of,"]
_FALSE_START = ["so the -- ", "it's -- ", "the thing is -- ", "wait, ", "let me -- "]
_SELF_CORRECT = [("smaller", "larger"), ("rows", "columns"), ("first", "second"),
                 ("up", "down"), ("more", "less")]

# Whisper's actual failure modes on this material, not generic typos. Each of
# these was observed in a real pilot-course transcript.
_ASR = [
    ("singular", "single"), ("singular values", "single values"),
    ("eigenvector", "eigen vector"), ("orthogonal", "orthogonal"),
    ("non-zeros", "non -zeros"), ("rank", "rank"),
    ("its", "it's"), ("their", "there"), ("affects", "effects"),
    ("norm", "norm"), ("matrix", "matrix"),
]


def messify(text: str, rng: random.Random) -> str:
    """The same words, delivered by a person and transcribed by a machine.

    Content-preserving on purpose. Every transform here adds noise, repetition
    or a corrected slip; none of them removes an idea or adds one. That is what
    makes the clean/messy pair a controlled comparison — if the grader marks the
    messy twin lower, the delivery is what it marked down.
    """
    out = []
    for sent in re.split(r'(?<=[.])\s+', text):
        if not sent.strip():
            continue
        if rng.random() < 0.5:
            sent = rng.choice(_FALSE_START) + sent
        words = sent.split()
        if words and rng.random() < 0.6:
            at = rng.randrange(len(words))
            words.insert(at, rng.choice(_FILLER))
        # A slip the student corrects within the same breath. Rule 5a says this
        # is NEVER an error, so a grader that books it as one is wrong — and this
        # is the only place that property is exercised on a real sentence.
        if rng.random() < 0.25:
            a, b = rng.choice(_SELF_CORRECT)
            for i, w in enumerate(words):
                if w.strip('.,').lower() == b:
                    words[i:i + 1] = [a + ",", "no", "sorry,", b]
                    break
        sent = " ".join(words)
        for a, b in _ASR:
            if a != b and rng.random() < 0.35:
                sent = re.sub(rf'\b{re.escape(a)}\b', b, sent, count=1)
        out.append(sent)
    # Spoken answers run on: drop some sentence boundaries, as Whisper does.
    joined = " ".join(out)
    if rng.random() < 0.5:
        joined = joined.replace(". ", " and ", 1)
    return joined


# --------------------------------------------------------------------------
# asserting one of the bank's own misconceptions
# --------------------------------------------------------------------------

# `commonErrors` are gerund phrases naming the mistake ("Treating X as Y"),
# because that is how you DESCRIBE an error to an instructor. A student never
# says it that way — they just make the mistake. Rendering the phrase as-is
# produces a sentence fragment that asserts nothing, and a false-claim fixture
# that asserts nothing cannot test whether false claims are caught.
#
# Two shapes, because the verbs split cleanly in two:
#   BELIEF verbs  ("Assuming X", "Believing X") — X is already a proposition, so
#                 the student simply says X.
#   ACTION verbs  ("Treating X as Y", "Reading X as Y") — no embedded
#                 proposition, so the student asserts the approach instead.
_BELIEF = {"assuming", "believing", "thinking", "claiming", "concluding",
           "expecting", "supposing", "imagining"}
_BASE = {"treating": "treat", "reading": "read", "equating": "equate",
         "confusing": "confuse", "forgetting": "forget", "overlooking": "overlook",
         "ignoring": "ignore", "mistaking": "mistake", "describing": "describe",
         "using": "use", "applying": "apply", "calling": "call",
         "picking": "pick", "taking": "take", "giving": "give"}

_BELIEF_LEAD = ["so ", "I think ", "basically ", "and honestly ", "which means "]
_ACTION_LEAD = ["so you just ", "I'd say you ", "basically you ", "so really you "]


def assert_misconception(text: str, rng: random.Random) -> str:
    """One `commonErrors` entry, as a student asserting it and leaving it there."""
    t = speak_math(text).strip().rstrip('.')
    head, _, rest = t.partition(' ')
    low = head.lower()
    if low in _BELIEF and rest:
        rest = rest[0].lower() + rest[1:]
        return rng.choice(_BELIEF_LEAD) + rest + "."
    base = _BASE.get(low)
    if base and rest:
        # "Reading X as Y and predicting Z" -> "…read X as Y and predict Z".
        # A conjoined gerund left behind reads as a fragment glued to a clause.
        for g, b in _BASE.items():
            rest = re.sub(rf'\band {g}\b', f'and {b}', rest, flags=re.I)
        rest = re.sub(r'\band (\w+)ing\b',
                      lambda m: 'and ' + _BASE.get(m.group(1).lower() + 'ing', m.group(0)[4:]),
                      rest, count=1)
        return rng.choice(_ACTION_LEAD) + base + " " + rest + "."
    # Unknown verb: keep the gerund but put it in a frame that still asserts.
    return "I think the right way is " + t[0].lower() + t[1:] + "."


# --------------------------------------------------------------------------
# building an answer with a known verdict vector
# --------------------------------------------------------------------------

def point_ids(question):
    """R1…Rn then O1…On, matching pointscore.point_list exactly."""
    req = question.get('keyPoints') or []
    opt = question.get('bonusPoints') or []
    return ([(f"R{i+1}", t) for i, t in enumerate(req)]
            + [(f"O{i+1}", t) for i, t in enumerate(opt)])


def synth(question, vector, rng, messy=False):
    """Render an answer conveying exactly what `vector` says it conveys.

    `vector` maps every point id to "stated", "partly" or "absent". The returned
    text contains the ideas of the stated points in full, the partly points in
    half, and nothing whatsoever about the absent ones.
    """
    parts = []
    for pid, text in point_ids(question):
        v = vector.get(pid, 'absent')
        if v == 'stated':
            parts.append(to_student_voice(text, rng))
        elif v == 'partly':
            parts.append(halve(text, rng))
    if not parts:
        return "um, I'm not really sure about this one, I didn't get to study it."
    rng.shuffle(parts)
    body = " ".join(parts)
    return messify(body, rng) if messy else body


# A constructed `partly` is the one label here that rests on a judgement (how
# half is half?), so exact-match accuracy on it would be measuring the fixture
# as much as the grader. These pairs are counted as ACCEPTABLE rather than
# correct: the grader saw something, which is what the fixture actually
# established. `absent` and `stated` carry no such doubt and are scored exactly.
EXPECTED_TOLERANCE = {
    ('partly', 'stated'), ('partly', 'partly'),
}


def cases(question, rng, include_messy=True):
    """The case set for one question. Seeded, so reruns are byte-identical.

    Chosen to span what actually happens and what the curve prices, not to be
    exhaustive: with 2 required and 3 optional points the full subset lattice is
    32 answers per question, which buys resolution nobody reads at 32x the cost.
    """
    ids = [p for p, _ in point_ids(question)]
    req = [p for p in ids if p.startswith('R')]
    opt = [p for p in ids if p.startswith('O')]
    if not req:
        return []

    def vec(stated=(), partly=()):
        v = {p: 'absent' for p in ids}
        v.update({p: 'stated' for p in stated})
        v.update({p: 'partly' for p in partly})
        return v

    plan = [
        # The mark the course cares most about: answered as asked, nothing extra.
        ('core-all', vec(stated=req)),
        # One core point alone — the curve prices this at 0.85 and the bank is
        # authored so that any one of them is "a sound if simplified answer".
        ('core-one', vec(stated=req[:1])),
        # Depth. These are the cases that reach 0.95/0.97/1.00, and the ones the
        # local grader was found never to credit.
        ('core+1opt', vec(stated=req + opt[:1])),
        ('everything', vec(stated=req + opt)),
        # Depth WITHOUT the core: noCoreCapScore must bite.
        ('opt-only', vec(stated=opt)) if opt else None,
        # Half-made points, which partlyFactor and curveRounding exist for.
        ('core-partly', vec(partly=req)),
        ('mixed', vec(stated=req[:1] + opt[:1], partly=req[1:2])),
        # Said nothing.
        ('nothing', vec()),
    ]
    out = []
    for item in plan:
        if item is None:
            continue
        name, v = item
        for messy in ((False, True) if include_messy else (False,)):
            # One rng stream per case so adding a case does not reshuffle the
            # others — a fixture set that changes when you extend it cannot be
            # compared against yesterday's run.
            r = random.Random(f"{question['id']}:{name}:{messy}")
            out.append({
                'case': f"{question['id']}/{name}/{'messy' if messy else 'clean'}",
                'qid': question['id'], 'kind': name, 'messy': messy,
                'question': question, 'vector': v,
                'answer': synth(question, v, r, messy=messy),
                'falseClaim': None,
            })
    # A complete answer with one of the bank's OWN certified misconceptions
    # asserted and left standing. Real label, written by the course author.
    errs = question.get('commonErrors') or []
    if errs:
        r = random.Random(f"{question['id']}:falseclaim")
        err = errs[0]
        body = synth(question, vec(stated=req), r)
        out.append({
            'case': f"{question['id']}/falseclaim/clean",
            'qid': question['id'], 'kind': 'falseclaim', 'messy': False,
            'question': question, 'vector': vec(stated=req),
            'answer': body + " " + assert_misconception(err, r),
            'falseClaim': err,
        })
    return out
