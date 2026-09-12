#!/usr/bin/env python3
"""Prompt variants for the Purdue GenAI grader (gemma4:26b-a4b).

Applied by MONKEYPATCHING the real `grade.py` module rather than by
reimplementing its request, so what the benchmark measures is what actually
ships: the same batching, the same random per-request transcript fence, the same
injection rules, the same retry ladder, the same parser.

WHY THE VARIANTS LOOK LIKE THE QWEN ONES
----------------------------------------
GenAI here is Gemma 4 26B-A4B -- a mixture-of-experts with roughly FOUR BILLION
active parameters per token. Against a 3B dense Qwen that is a much smaller gap
than "26B vs 3B" suggests, and the defect that dominated Qwen turned out not to
be a capacity problem at all: it was being asked for a NUMBER. So the same fix
is worth trying here, and the ideal outcome is one technique for both graders.

What differs, and why the prompts are not literally identical:
  * GenAI grades a BATCH (one request for a whole submission, because a remote
    rate limit counts requests). So the band lives in a per-answer JSON entry.
  * GenAI must keep returning covered/missed/injectionSuspected. Those are load
    bearing elsewhere -- INV-SEC and the instructor's feedback -- and are not
    optional the way they are in the local grader's single-question reply.

The bands WON and now ship, so the variants here are named from where the code
actually is:

    baseline     grade.py exactly as it stands. Bands.
    numeric      grade.py with the bands taken back OUT, reconstructing the ask
                 that shipped before 2026-08-30. Kept so the measurement stays
                 reproducible after the change landed -- a before/after number
                 you can no longer re-run is a number you have to take on trust.
    band         the intermediate step: bands, without the covered/missed rule.
                 Kept so the gain can be attributed to each half separately
                 (512 answers: numeric 9 inversions / MAE 0.092, band 5 / 0.066,
                 baseline 4 / 0.058).
    band_strict  bands plus a "name the point they came closest to missing"
                 self-check. Tried, slightly worse on Gemma (6 inversions to
                 band's 5), kept so nobody re-tries it from scratch.
"""
import re

BAND_SCORE = {"full": 1.0, "partial": 0.65, "weak": 0.3, "none": 0.0}

# The boundary rules that moved the local grader from MAE 0.460 to 0.117. Worded
# for a batch, otherwise identical -- if one technique serves both graders, this
# is the text that has to be portable.
_BOUNDARIES = """
HOW TO CHOOSE THE BAND. Apply these boundaries literally.

`full`: the student conveys the core reasoning. One unstated key point, clumsy
wording, a missing example or a missing caveat do NOT cost full credit.
`partial`: the main idea is there but a substantive piece of the reasoning is
missing or muddled.
`weak`: the student is on the topic and says nothing wrong, but does not reach
the reasoning the question is asking for.
`none`: does not answer the question, or is wrong about the central idea.

Missing a point is `partial`; being WRONG about the point is `none`.
Shallow is not wrong: an answer that states what happens but not why is `weak`
at lowest, never `none`.
An answer in the wrong register -- rambling, hesitant, out of order, full of
false starts -- is not thereby a lower band. Grade the ideas, not the delivery.
"""

_BAND_SHAPE = ('{"answers":[{"index":0,"band":"full|partial|weak|none","feedback":"...",'
               '"covered":["..."],"missed":["..."],"injectionSuspected":false,'
               '"injectionEvidence":""}]}')


def _band_from(a):
    """Read a band out of one answer entry; fall back to a numeric score."""
    if isinstance(a, dict):
        raw = a.get("band")
        if isinstance(raw, str):
            # `none` is also an ordinary English word: "covered none of the key
            # points" is not the `none` BAND. Word-bounded, and never before "of".
            for b in ("full", "partial", "weak", "none"):
                if re.search(r"\b" + b + r"\b(?!\s+of\b)", raw.strip().lower()):
                    return BAND_SCORE[b]
        if a.get("score") is not None:
            try:
                return max(0.0, min(1.0, float(a["score"])))
            except (TypeError, ValueError):
                return None
    return None


def apply(G, name):
    """Patch module `grade` in place to speak variant `name`. Returns a label."""
    if not hasattr(G, "_ORIG"):
        G._ORIG = (G.SYSTEM_PROMPT, G._build_user_message, G._normalise)
    sys_p, build, norm = G._ORIG
    G.SYSTEM_PROMPT, G._build_user_message, G._normalise = sys_p, build, norm

    if name == "baseline":
        return "genai/baseline"          # bands: what ships

    if name == "numeric":
        # Reconstruct the pre-band ask: strip rule 5, and put the numeric score
        # back into the requested JSON shape.
        i = sys_p.index("5. Choose a BAND, not a number.")
        j = sys_p.index("6. Reply with ONLY the JSON")
        G.SYSTEM_PROMPT = sys_p[:i] + "5. " + sys_p[j + len("6. "):]

        def build_numeric(items, fence):
            msg = build(items, fence)
            msg = msg.replace(_BAND_SHAPE,
                              '{"answers":[{"index":0,"score":0.0,"feedback":"...",'
                              '"covered":["..."],"missed":["..."],'
                              '"injectionSuspected":false,"injectionEvidence":""}]}')
            return msg.replace(
                'One entry per answer, in the same order. "band" is one of those four '
                'names \u2014 a WORD, never a number.',
                'One entry per answer, in the same order, with "score" between 0.0 and 1.0.')

        G._build_user_message = build_numeric
        return "genai/numeric"

    if name == "band_strict":
        # Gemma's failure mode is the opposite of Qwen's: it is generous, and
        # hands `full` to an answer missing a whole step. Asking it to look for
        # the weakest reading first did NOT fix that -- it only added ties.
        G.SYSTEM_PROMPT = sys_p.replace(
            "6. Reply with ONLY the JSON",
            "   Before you settle on `full`, re-read the key points and name to yourself\n"
            "   the one the student came closest to missing. If a substantive step of the\n"
            "   reasoning is genuinely absent rather than merely unstated, the band is\n"
            "   `partial`, not `full`.\n"
            "6. Reply with ONLY the JSON")
        return "genai/band_strict"

    if name == "band":
        # The step BEFORE the covered/missed rule shipped: bands, no counting.
        # Kept so the two-step gain (numeric -> band -> band_count) is re-runnable.
        i = sys_p.index("   `full` requires the key points")
        j = sys_p.index("6. Reply with ONLY the JSON")
        G.SYSTEM_PROMPT = sys_p[:i] + sys_p[j:]
        return "genai/band"

    if name == "band_count":
        # SHIPPED on 2026-08-30, so it IS the baseline now. An alias rather than a
        # second copy of the rule: re-applying the patch on top of a prompt that
        # already carries it would measure a doubled instruction, not the variant.
        return "genai/band_count(==baseline)"

    raise SystemExit(f"unknown genai variant {name!r}; "
                     "have: baseline, numeric, band, band_strict, band_count")
