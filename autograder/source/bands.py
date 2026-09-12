"""The grading ladder: what bands exist, what each is worth, and what each means.

WHY THIS IS A MODULE AND NOT A CONSTANT
---------------------------------------
It began as a four-name tuple in two files. Then an instructor wanted a fifth
rung, then wanted the prices moved, then wanted the ladder itself to be theirs.
Each step was reasonable and each one was a code edit, which is the signal that
the ladder was never an engineering constant — it is a grading policy that had
been living in engineering's house.

So a course may now define the whole ladder: the names, how many, what each is
worth, and what each means. The engine keeps only two things:

  * a DEFAULT ladder, which is the one every measurement in STATUS.md was taken
    on, and
  * the guarantee that whatever ladder is in force is applied identically by
    both graders, so a course that switches backend mid-term does not move
    anybody's scale.

WHAT A COURSE CANNOT DO
-----------------------
Give a band a name the parser cannot safely look for, price the ladder so a
lower band outscores a higher one, or ship a one-band ladder. Those are rejected
WHOLE and the default is used, because a half-applied ladder would draw part of
a student's mark from each of two scales — the one outcome nobody could defend
to the student.

THE MEASURED PROMPT ONLY COVERS THE DEFAULT LADDER
--------------------------------------------------
The band boundaries in both graders' prompts were tuned against the default
names on real answers (see STATUS.md). A course that defines its own ladder gets
those boundaries GENERATED from its own `meaning` strings instead, which is the
honest thing to do — we cannot claim a measurement we did not take. `is_default`
below is what lets each grader tell which prompt it is entitled to use.
"""
from __future__ import annotations
import re

# The engine's ladder: name, score, and the boundary wording the prompts use.
# The scores are an even tenth per rung with a single cliff between the lowest
# on-topic band and `none`; the reasoning is in DESIGN-QUESTIONS A6.
DEFAULT = (
    ("full", 1.0,
     "the student ANSWERS THE QUESTION AS ASKED and says nothing false. That is the whole "
     "test. If they answered what was actually asked, this is full credit even when they "
     "did not mention every key point: unstated optional points, a missing example, a "
     "missing caveat, clumsy wording and thin phrasing NEVER cost full credit."),
    ("strong", 0.9,
     "the core reasoning is there and correct, but one REQUIRED piece of it is left out or "
     "only gestured at. An absent OPTIONAL point is never this band — it is `full`."),
    ("partial", 0.8,
     "the main idea is there but a REQUIRED piece of the reasoning is missing or muddled."),
    ("weak", 0.7,
     "the student is on the topic and says nothing wrong, but does not reach the "
     "reasoning the question is asking for."),
    ("none", 0.0,
     "does not answer the question, or is wrong about the central idea."),
)

DEFAULT_ORDER = tuple(n for n, _, _ in DEFAULT)
DEFAULT_SCORE = {n: s for n, s, _ in DEFAULT}

# A band name has to survive being (a) written into a prompt, (b) asked back as a
# JSON string, and (c) looked for with a word-boundary regex. Letters, digits,
# underscore and hyphen only, starting with a letter, and short enough to read.
_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,23}$")


class Ladder:
    """An ordered grading ladder, highest band first."""

    __slots__ = ("bands", "is_default", "source")

    def __init__(self, bands, is_default, source):
        self.bands = tuple(bands)                 # ((name, score, meaning), ...)
        self.is_default = is_default
        self.source = source                      # why this ladder, for the log

    @property
    def names(self):
        return tuple(n for n, _, _ in self.bands)

    @property
    def scores(self):
        return {n: s for n, s, _ in self.bands}

    def meaning(self, name):
        for n, _, m in self.bands:
            if n == name:
                return m
        return ""

    def score_of(self, name):
        for n, s, _ in self.bands:
            if n.lower() == str(name).lower():
                return s
        return None

    def alternation(self):
        """Regex alternation over the names, LONGEST FIRST.

        Longest-first matters: with bands named `partial` and `part`, a shortest
        -first alternation matches `part` inside `partial` and silently books the
        wrong mark. Python's `|` is first-match, not longest-match, so the order
        here is the fix.
        """
        return "|".join(re.escape(n) for n in sorted(self.names, key=len, reverse=True))

    def json_shape(self):
        return "|".join(self.names)

    def describe(self):
        """The band list as prompt text: one line per rung, highest first."""
        return "\n".join(f"`{n}`: {m}" for n, _, m in self.bands)


DEFAULT_LADDER = Ladder(DEFAULT, True, "engine default")


def _clean(bands):
    """Validate an ordered [(name, score, meaning)]; return it, or None to reject.

    Rejection is always WHOLE. A partially-applied ladder is worse than the
    wrong-but-consistent one, because half of a student's mark would come from
    each scale and neither number would mean anything.
    """
    if len(bands) < 2:
        return None                                  # a one-rung ladder is not a grade
    seen = set()
    prev = None
    for name, score, meaning in bands:
        if not isinstance(name, str) or not _NAME.match(name):
            return None
        if name.lower() in seen:                     # the parser is case-insensitive
            return None
        seen.add(name.lower())
        try:
            score = float(score)
        except (TypeError, ValueError):
            return None
        if not (0.0 <= score <= 1.0):
            return None
        if prev is not None and score > prev:        # must not climb as it descends
            return None
        prev = score
        if not isinstance(meaning, str):
            return None
    return tuple((n, float(s), m) for n, s, m in bands)


def resolve(bands=None, band_scores=None):
    """The ladder in force, from a course's config. Never raises.

    Two knobs, deliberately:

      `bands`        the WHOLE ladder — an ordered map of name -> score, or
                     name -> {"score": …, "meaning": …}. Use it to change how
                     many rungs there are or what they are called.
      `bandScores`   a re-pricing of the DEFAULT ladder — name -> score over
                     exactly the default names. The common case, and it keeps
                     the measured prompt wording.

    `bands` wins if both are given. Anything unusable falls back to the default
    ladder, so a typo in course.json degrades to the documented scale rather
    than to an invented one.
    """
    if isinstance(bands, dict) and bands:
        rows = []
        for name, v in bands.items():               # insertion order IS the ladder
            if isinstance(v, dict):
                rows.append((name, v.get("score"), v.get("meaning") or _default_meaning(name)))
            else:
                rows.append((name, v, _default_meaning(name)))
        cleaned = _clean(rows)
        if cleaned:
            same = tuple((n, s) for n, s, _ in cleaned) == tuple((n, s) for n, s, _ in DEFAULT)
            return Ladder(cleaned, same, "course `bands`")

    if isinstance(band_scores, dict) and set(band_scores) == set(DEFAULT_ORDER):
        rows = [(n, band_scores[n], m) for n, _, m in DEFAULT]
        cleaned = _clean(rows)
        if cleaned:
            same = tuple((n, s) for n, s, _ in cleaned) == tuple((n, s) for n, s, _ in DEFAULT)
            return Ladder(cleaned, same, "course `bandScores`")

    return DEFAULT_LADDER


def _default_meaning(name):
    """Reuse the engine's wording when a course reuses an engine band name."""
    for n, _, m in DEFAULT:
        if n.lower() == str(name).lower():
            return m
    return ""
