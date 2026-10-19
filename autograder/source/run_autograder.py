#!/usr/bin/env python3
"""OralScale autograder v2 — Gradescope entry logic (see models/05-protocol-flows.md).

Identity is bound at SUBMISSION time (v3): the quiz link is public and lives in the
assignment description, and the student self-identifies in the app with an opaque ref
that we re-derive here from their Gradescope-authenticated email (INV-SEC-2).

  * Valid recording present -> VALIDATE integrity, transcribe, grade, score.
  * No valid recording -> explain where the link is and hand over the opt-out private
    code. This scores 0, and Gradescope grades the ACTIVE submission, so that 0 STANDS
    if it is the student's newest upload -- which is why this branch tells them so
    and how to re-activate a better attempt (INV-DEPLOY-1).

Env (from secret.env / container):
  ORALSCALE_SECRET      (required) signing secret (matches the Signer)
  ORALSCALE_ASSIGNMENT  (required) which assignment id this Gradescope assignment grades
  ORALSCALE_WEBAPP_URL  web app base URL (for the minted link)
  ORALSCALE_COURSE      course.json path (default: bundled ./course.json)
  ORALSCALE_MAX_POINTS  total points (default 10)
  GENAI_STUDIO_*        Purdue GenAI grading (optional; heuristic fallback)
  ORALSCALE_SUBMISSION / ORALSCALE_RESULTS / ORALSCALE_METADATA  (paths; Gradescope defaults)
"""
from __future__ import annotations
import glob
import json
import os
import re
import sys
import textwrap
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import runtiming           # noqa: E402
import protocol            # noqa: E402
import transcribe as stt   # noqa: E402
import grade as grader     # noqa: E402
import calibration as calib # noqa: E402
import notify               # noqa: E402
import latepolicy           # noqa: E402
import injection           # noqa: E402
import pii                 # noqa: E402
import pointscore          # noqa: E402
import time                # noqa: E402

# When this container started. The grading budget is measured against it, because
# what Gradescope kills is the WHOLE run -- transcription included -- not the part
# that happens to be waiting on the grading service.
_T0 = time.time()


def _f_env(name, default):
    try:
        return float(os.environ.get(name) or default)
    except Exception:
        return float(default)

AUDIO_EXTS = (".webm", ".ogg", ".m4a", ".mp3", ".wav", ".mp4", ".aac")


def env(n, d=None):
    return os.environ.get(n, d)


def load_course():
    path = env("ORALSCALE_COURSE", os.path.join(HERE, "course.json"))
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_bank(course, assignment_id):
    a = course["assignments"][assignment_id]
    raw = a["bank"]
    candidates = ([raw] if os.path.isabs(raw) else
                  [os.path.join(HERE, raw),                       # source/banks/<base> (bundled)
                   os.path.join(HERE, os.path.basename(raw)),     # source/<base>
                   os.path.join(HERE, "..", raw)])                # repo-relative (local dev)
    bank_path = next((c for c in candidates if os.path.exists(c)), candidates[0])
    with open(bank_path, "r", encoding="utf-8") as f:
        return json.load(f), a


def knob(course, acfg, name, default):
    """Assignment knob, falling back to course defaults, then to `default`.

    The Signer resolves knobs the same way (assignment -> defaults -> code
    default). Both sides must agree or an instructor's `course.json` would mean
    one thing at quiz time and another at grading time.
    """
    if acfg.get(name) is not None:
        return acfg[name]
    d = (course.get("defaults") or {})
    if d.get(name) is not None:
        return d[name]
    return default


def _norm(x):
    return "".join(ch for ch in str(x).lower() if ch.isalnum())


def _week_number(assignment_id):
    """The week number inside an id like 'week-04-methods-core' -> 4."""
    m = re.search(r"week[-_ ]?(\d+)", str(assignment_id), re.I)
    return int(m.group(1)) if m else None


# NO ROSTER LOADER LIVES HERE ANY MORE (INV-PRIV-6).
#
# There used to be one: accommodations.json, keyed by studentRef, bundled into
# the zip so a claim could be verified at grading time. It is gone, and the
# absence is the feature. A record of who holds a disability accommodation was
# being copied into a build artifact, and from there into every container that
# ever ran it — permanently, and replicated wherever the zip went — to support a
# check that is needed at most once per quiz and works perfectly well afterwards.
#
# Verification moved to tools/audit-accommodations.js, which the INSTRUCTOR runs
# on their own machine against downloaded submissions. The autograder now only
# NOTES that a claim was made. See INV-ACCOM-1.
# extensions.json is gone too, for the same reason and one more: it was keyed by
# student EMAIL, so it put addresses in the zip. It existed as a fallback for the
# case where Gradescope did not pass a per-student due date to the autograder —
# and measurement on 2026-09-02 showed that it does, at
# users[0].assignment.due_date. The fallback was for a problem that turned out
# not to exist (latepolicy.effective_due).
def attempt_budget_sec(cert, grace=0, tol=0):
    """Total wall-clock an HONEST attempt may take, for the whole attempt.

    An attempt of N questions is N x (code lead + answer limit + buffer), plus
    the tail window for the final code. The per-question `limitSec` describes ONE
    question and says nothing about how long the attempt may run.

    This exists because those two were computed separately and drifted: the
    duration check was generalised to N questions and the timing-window check was
    not, so a five-question attempt was measured against a one-question budget and
    every honest multi-question submission failed. One function now, used by both.
    """
    segs = cert_segments(cert)
    per_q = int(cert.get("limitSec", 0) or 0)
    lead = int(cert.get("codeLeadSec", 0) or 0)
    tail = int(cert.get("tailLimitSec") or protocol.tail_limit_default(
        cert.get("codeDigits") or protocol.CODE_DIGITS))
    # The first question's offset already contains the lead; take whichever is
    # larger so a generous client clock cannot shrink the budget.
    per_q_lead = max(lead, int(cert.get("questionOffsetSec", 0) or 0))
    total_limit = sum(int(sg.get("limitSec") or per_q)
                      + int(sg.get("bufferSec") or 0) for sg in segs)
    return len(segs) * per_q_lead + total_limit + tail + grace + tol


def resolve_assignment(course, meta_path):
    """Which assignment does this zip grade? Exactly one, and it says so.

    ONE ZIP PER ASSIGNMENT. `ORALSCALE_ASSIGNMENT` is written into the zip at build
    time and is the only thing consulted. There is no inference and no precedence.

    WHAT THIS REPLACED, and why removing it was the fix rather than tuning it.
    A single zip used to serve a whole course, so the assignment had to be guessed
    from the Gradescope assignment itself: its numeric id, a declared title alias,
    a declared title substring, the assignment id appearing inside the title, a
    week number inside the title, or "there is only one". Six rules, and the
    guessing was the defect:

      * It made a SUPERFICIAL property load-bearing. Renaming a Gradescope
        assignment -- presentation, to everyone who has not read the source --
        could silently change which bank a submission was graded against.
      * A wrong guess produces a SCORE, not an error. Nobody goes looking.
      * The rules could disagree, so there had to be conflict detection, which is
        machinery whose entire purpose was to notice the guessing going wrong.

    Pinning is not less flexible, only more honest: changing which assignment a
    Gradescope assignment grades has always required rebuilding and re-uploading
    the zip, because the bank lives inside it. The title was never the real
    control. (Decision R15.)

    `meta_path` is unused and kept so callers need not change; the Gradescope
    metadata no longer influences routing at all.

    Returns (assignment_id, how) or (None, reason).
    """
    assignments = course.get("assignments") or {}
    ids = list(assignments.keys())
    pinned = env("ORALSCALE_ASSIGNMENT")

    if pinned and pinned in assignments:
        return pinned, f"ORALSCALE_ASSIGNMENT={pinned!r} (pinned at build time)"

    if pinned:
        return None, (
            f"This autograder is pinned to {pinned!r}, which is not an assignment in the "
            f"course.json inside the zip.\n"
            "The zip and the course have drifted apart — rebuild it:\n"
            "  node tools/build-autograder.js <course.json> --assignment <id> --zip\n"
            f"Known ids in this zip: {', '.join(ids) or '(none)'}")

    return None, (
        "This autograder does not say which assignment it grades.\n"
        "Every zip is built for exactly ONE assignment and carries its id inside; this one was "
        "built without it, or the file was assembled by hand.\n"
        "Rebuild it:\n"
        "  node tools/build-autograder.js <course.json> --assignment <id> --zip\n"
        "That writes one zip per assignment, each named for the assignment it grades, so the one "
        "you upload is the one it belongs to.\n"
        f"Known ids in this zip: {', '.join(ids) or '(none)'}")


def student_ref():
    p = env("ORALSCALE_METADATA", "/autograder/submission_metadata.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            meta = json.load(f)
        users = meta.get("users") or meta.get("submitters") or []
        if users:
            return (users[0].get("email") or users[0].get("name") or "").strip()
    except Exception:
        pass
    return env("ORALSCALE_STUDENT", "")  # local-test override


def find_submission_files(sub_dir):
    def scan():
        cert = audio = None
        for root, _, files in os.walk(sub_dir):
            for fn in files:
                p = os.path.join(root, fn)
                if fn == "certificate.json":
                    cert = p
                elif fn.lower().endswith(AUDIO_EXTS):
                    audio = audio or p
        return audio, cert
    audio, cert = scan()
    if cert and audio:
        return audio, cert
    for z in glob.glob(os.path.join(sub_dir, "**", "*.zip"), recursive=True):
        try:
            with zipfile.ZipFile(z) as zf:
                zf.extractall(os.path.join(sub_dir, "_extracted"))
        except zipfile.BadZipFile:
            pass
    return scan()


def _text_in_window(words, text, lo, hi):
    """Transcript restricted to [lo, hi] seconds, or the whole text if untimed."""
    if not words:
        return text
    return " ".join(w.get("word", "") for w in words
                    if lo <= float(w.get("start", 0)) <= hi)


def cert_segments(cert):
    """The attempt's answered segments, normalised.

    A v6 certificate carries `segments` (one per question). A v5 certificate
    described a single question with flat fields; it is presented here as one
    segment so every check below has exactly one shape to reason about.
    """
    segs = cert.get("segments")
    if isinstance(segs, list) and segs:
        return segs
    return [{
        "index": 0,
        "questionId": cert.get("questionId"),
        "questionOffsetSec": cert.get("questionOffsetSec", cert.get("codeLeadSec", 0)) or 0,
        "closingOffsetSec": cert.get("closingOffsetSec", cert.get("elapsedSec", 0)),
        "limitSec": cert.get("limitSec", 0),
    }]


def _words_in_window(words, lo, hi):
    """How many transcribed words fall in [lo, hi]. None when untimed."""
    if not words:
        return None
    return sum(1 for w in words if lo <= float(w.get("start", 0)) <= hi)


def check_boundary_codes(secret, cert, text, words, audio_path=None, duration=None):
    """INV-INTEGRITY-4 (first code) + INV-INTEGRITY-5 (every later code).

    An attempt with N questions has N+1 boundary codes:

        b0 ─ Q1 ─ b1 ─ Q2 ─ … ─ Q(N) ─ bN

    Each interior code closes the answer just given AND opens the next question,
    so a multi-question recording is pinned at every boundary, not only at its
    two ends. Offsets in the certificate are measured from tStart — when the
    recording and the first code began — so they line up with word timestamps.

    Matching is fuzzy by design: we re-derive the expected digits, so there is
    nothing to error-correct, only a transcription slip to tolerate. One
    Damerau-Levenshtein edit is allowed (drop / add / substitute / swap).

    THE RESCUE PASS (INV-INTEGRITY-9). A code missing from the main transcript is
    ambiguous — the student may not have said it, or Whisper may not have heard
    it. Those two deserve opposite treatments, and the system's credibility rests
    on not confusing them: an honest student told "you did not read the digits"
    when they demonstrably did will not trust anything else it says. So before
    concluding a code is absent we go back to the AUDIO and re-transcribe just
    that boundary's window with settings tuned for bare digits
    (`transcribe.rescue_window`). Only if the rescue also comes up empty is the
    code recorded as missing. This adds a few seconds per missing code and runs
    for at most a handful of them; it never runs on a clean attempt.

    Each entry also carries `heardWords` — how much speech the main pass found in
    that window — so the instructor output can separate "silence there" (likely a
    capture fault) from "talking, but no digits" (likely a genuinely skipped code).
    """
    attempt = cert["attemptId"]
    segs = cert_segments(cert)
    n = len(segs)
    W = 15  # timestamp slack (s)
    out = []
    n_digits = int(cert.get("codeDigits") or protocol.CODE_DIGITS)
    # Cap the open-ended final window at the real end of the audio, so the rescue
    # slice has something finite to cut.
    end = float(duration) if duration else None
    # WHERE EACH CODE IS SPOKEN. Boundary k closes segment k-1, so it is uttered
    # at that segment's closingOffsetSec; b0 sits at the very start.
    def boundary_at(i):
        if i <= 0:
            return 0.0
        return float(segs[i - 1]["closingOffsetSec"])

    for k in range(n + 1):
        code = protocol.derive_boundary_code(secret, attempt, k, n, n_digits)
        if k == 0:
            # Spoken in the lead-in, before the first question appeared.
            lead = float(segs[0].get("questionOffsetSec", 0) or 0)
            lo = -W
            hi = min(float(segs[0]["closingOffsetSec"]), max(lead, 10) + 30) + W
        elif k == n:
            lo, hi = float(segs[-1]["closingOffsetSec"]) - W, float("inf")
        else:
            # Between "I'm done with question k" and question k+1 appearing.
            lo = float(segs[k - 1]["closingOffsetSec"]) - W
            hi = float(segs[k].get("questionOffsetSec", 0) or 0) + 30 + W

        # A WINDOW MUST NOT REACH ITS NEIGHBOURS (INV-INTEGRITY-5).
        #
        # The slack above is generous on purpose — a student pauses, a timestamp
        # drifts — and it is sized for the 120 s questions this is normally used
        # for, where ±15 s cannot reach the code 120 s away. It is NOT safe on
        # its own: with short questions the windows overlap, and then a code the
        # student never said can be satisfied by the digits of the one next to
        # it. `code_spoken_in` also forgives one edit, which widens the
        # coincidence further.
        #
        # Found by a flaky test (e2e S5, ~1 run in 4): a submission that skipped
        # an interior code was accepted, because the fixture's questions are
        # three seconds apart and every window covered the whole recording.
        # The fixture was unrealistic; the window arithmetic that let it through
        # was not test-only, and on a course with short `limitSec` it would have
        # weakened the guarantee that every boundary is pinned.
        #
        # Clamping to the MIDPOINT between neighbouring boundaries keeps the
        # slack wherever there is room for it and guarantees the windows are
        # disjoint wherever there is not.
        if 0 < k:
            prev_mid = (boundary_at(k - 1) + boundary_at(k)) / 2.0
            lo = max(lo, prev_mid)
        if k < n:
            next_mid = (boundary_at(k) + boundary_at(k + 1)) / 2.0
            hi = min(hi, next_mid)

        ok = protocol.code_spoken_in(_text_in_window(words, text, lo, hi), code)
        via = "transcript" if ok else None
        # No rescue in sidecar (test-harness) mode: there the "transcript" is a
        # fixture and the audio is a synthetic tone, so re-transcribing it can
        # only waste a model load. Production never sets that flag, so the rescue
        # always runs where it matters (INV-INTEGRITY-8 / INV-INTEGRITY-9).
        if not ok and audio_path and not stt.sidecars_allowed():
            hi_cut = hi if hi != float("inf") else (end if end else lo + 60)
            # Each chunk is tested on its own, so digits from two neighbouring
            # chunks can never be spliced into a code nobody spoke.
            for chunk in (stt.rescue_window(audio_path, max(0.0, lo), hi_cut) or []):
                if protocol.code_spoken_in(chunk, code):
                    ok, via = True, "rescue"
                    break
        out.append({"k": k, "ok": ok, "code": code, "via": via,
                    "heardWords": _words_in_window(words, lo, hi if hi != float("inf")
                                                   else (end or 1e9))})
    return out, (words is not None)


def boundary_label(k, n_questions):
    """Where in the attempt boundary `k` was shown, in the student's own terms."""
    if n_questions <= 1:
        return "at the very start" if k == 0 else "at the very end"
    if k == 0:
        return "before question 1"
    if k >= n_questions:
        return "at the very end, after question %d" % n_questions
    return "after question %d" % k


def segment_transcript(words, text, seg):
    """What the student said while THIS question was on screen.

    Without word timestamps there is nothing to slice by, so every question is
    graded against the whole transcript — a real degradation on a multi-question
    attempt (an answer to question 1 can earn credit on question 2), which is why
    the grader says so in the instructor output rather than hiding it.
    """
    if not words:
        return text
    return _text_in_window(words, text,
                           float(seg.get("questionOffsetSec", 0) or 0),
                           float(seg.get("closingOffsetSec", 0) or 0))


def main():
    timing = runtiming.current
    timing.start_console()
    timing.start_resources()
    secret = env("ORALSCALE_SECRET")
    sub_dir = env("ORALSCALE_SUBMISSION", "/autograder/submission")
    results_path = env("ORALSCALE_RESULTS", "/autograder/results/results.json")
    max_points = float(env("ORALSCALE_MAX_POINTS", "10"))   # container default; course.json may override
    grace = int(env("ORALSCALE_GRACE_SEC", "30"))
    dur_tol = int(env("ORALSCALE_DURATION_TOL", "20"))

    tests = []
    debug_identity = False
    flags = []          # instructor-facing reasons this submission needs a look

    # Students see exactly this on ANY validation failure — never which check, and
    # never why. Naming the failing check tells someone probing the system precisely
    # what to adjust; it also spares an honest student a confusing accusation.
    VALIDATION_FAILED_MSG = (
        "We could not validate this recording, so it scores 0.\n\n"
        "This is usually something small. Please record a fresh attempt, following the steps "
        "exactly: open the quiz link from this assignment, enter the same email you use for "
        "Gradescope, read the digits aloud when they appear, and upload the .zip the page gives "
        "you without renaming or editing it.\n\n"
        "Retakes are unlimited, so a retry costs you nothing — but Gradescope grades your MOST "
        "RECENT upload, not your best one. If a later attempt scores lower, open Submission "
        "History and re-activate the attempt you want counted; it is two clicks and the choice "
        "is yours.\n\n"
        "If it happens again, contact a TA and we will look into it — it may well be our bug.")
    STUDENT_FAILED_TOP = ("This attempt could not be validated, so it scores 0. "
                          "Please try a fresh attempt; if it keeps happening, contact a TA.")

    # THE ONE VALIDATION FAILURE A STUDENT IS TOLD THE CAUSE OF (INV-USE-1).
    #
    # Everything else stays behind VALIDATION_FAILED_MSG on purpose: naming the
    # failing check hands someone probing the system a map of what to defeat.
    # The wrong-link case is different in kind, on both halves of that trade.
    #
    # It gives nothing away. The student already knows which assignment they are
    # looking at and which link they clicked; there is no mechanism here to learn
    # and nothing to adjust. Using another week's link is not an attack — it is
    # already caught, and a would-be attacker learns nothing they did not have.
    #
    # And the generic message actively misleads here. It says "record a fresh
    # attempt, following the steps exactly", which is precisely what the student
    # did: their recording is perfect, every code was spoken, the microphone
    # worked. They will do it again with the same wrong link and fail again.
    # A student can loop on that indefinitely without the one fact that ends it.
    #
    # This was the commonest real failure of the first pilot quiz, and it led
    # the instructor's reminder announcement. The app now names the assignment on
    # its front page (web/js/app.js showWhichQuiz) so it is caught before
    # recording; this is the other half, for a recording already made.
    WRONG_LINK_MSG = (
        "YOU USED THE WRONG QUIZ LINK. Nothing is wrong with your recording, your microphone, "
        "your quiz key or your upload \u2014 this recording is simply for a different quiz.\n\n"
        "Every quiz has its OWN link, and they all look the same. Opening last week's link, or a "
        "link from an announcement, or one you had bookmarked, produces a recording that belongs "
        "to that quiz and cannot be graded here.\n\n"
        "What to do:\n"
        "  1. Open THIS assignment in Gradescope \u2014 the one you are reading now.\n"
        "  2. Use the quiz link in THIS assignment's description. Do not reuse an older one.\n"
        "  3. Check the top of the OralScale page before you start: it names the quiz the link "
        "is for. If that is not this quiz, go back and get the right link.\n"
        "  4. Record again and upload the new .zip.\n\n"
        "Retakes are unlimited, so this costs you nothing but the time. Gradescope grades your "
        "MOST RECENT upload rather than your best one \u2014 if you want an earlier attempt "
        "counted, re-activate it from Submission History.")
    # Set when the failure is one we can name to the student without teaching
    # anyone anything. None means "use the generic message".
    student_reason = [None]

    def name_reason(msg):
        """Tell the student WHY, for the failures where that is safe and useful."""
        if student_reason[0] is None:
            student_reason[0] = msg

    # Shown to EVERY submitter, not hidden, and deliberately styled as a failed
    # test so Gradescope renders it in red at the top. A demo bypass that is easy
    # to overlook is a demo bypass that reaches a real course.
    DEMO_IDENTITY_OFF_MSG = (
        "*** DEMO MODE — THIS IS NOT A REAL ASSESSMENT ***\n\n"
        "Identity verification is TURNED OFF for this assignment. The autograder did NOT check "
        "that the certificate in this submission was issued to the person submitting it. Anyone "
        "holding a copy of this .zip would receive the same score.\n\n"
        "This exists so someone evaluating OralScale can record on the public demo site — which "
        "hands out one shared quiz key — and upload the result to their own Gradescope course "
        "without first minting a personal key for their own address.\n\n"
        "NEVER USE THIS SETTING FOR REAL COURSEWORK. Binding a recording to the student who "
        "submitted it is the single check that makes an oral quiz worth anything: without it one "
        "student can record once and any number of others can submit that same recording, and "
        "every one of them is graded on it (INV-SEC-2).\n\n"
        "To turn it off: remove \"demoSkipIdentityCheck\" from this assignment in course.json and "
        "rebuild the autograder zip. A real course mints a key per student with "
        "tools/gen-access-keys.js.")

    # Written for an honest student who is simply doing it wrong. The codes are the
    # one thing they are asked to DO, so naming this check is coaching, not a hint.
    CODES_HELP = (
        "We could not hear {which} in your recording.\n\n"
        "{outcome}"
        "{ledger}"
        "How it should go:\n"
        "  1. Four digits appear FIRST. Read them out loud, one at a time — \"four, seven, one, "
        "nine\" — BEFORE you start answering.\n"
        "  2. Then the question appears and you give your answer.\n"
        "  3. When you tap \"I'm done with this question\" the question disappears and a NEW set "
        "of four digits appears. Keep recording and read those out loud too. If another question "
        "follows, it appears right after — so every set of digits has to be spoken, including "
        "the very last one before you tap Finish.\n\n"
        "Common mix-ups:\n"
        "  - Reading the digits silently, or only in your head. They have to be spoken.\n"
        "  - Reading them as one number (\"four hundred seventy-one thousand…\") instead of "
        "digit by digit.\n"
        "  - Still talking over the last code — pause for a beat, then read the digits.\n"
        "  - Tapping Finish before reading the second code, or stopping the recording early.\n"
        "  - A noisy room or a far-away microphone, so the digits did not come through.\n\n"
        "Retakes are unlimited, so just try again. Remember that Gradescope grades your MOST "
        "RECENT upload rather than your best one — if a retake comes out worse, re-activate the "
        "attempt you want from Submission History. If you are doing all of the above and it still "
        "fails, contact a TA — that would be our problem, not yours.")

    # HALF THE CODES HEARD IS GRADED; FEWER, OR ANY OTHER FAILURE, SCORES 0 BUT IS
    # STILL GRADED FOR THE INSTRUCTOR (INV-CODE-4).
    #
    # Even with the rescue pass (INV-INTEGRITY-9), transcription still drops a
    # code the student plainly said — observed on Quiz 4, where the opening digits
    # simply never came out of Whisper. Failing the whole attempt for that is a
    # negative mistake (INV-GRADE-11), so when at least HALF the codes were heard
    # the answers are graded as usual and the attempt goes to the instructor.
    # Below that, or when any other check fails, the attempt scores 0 — but it is
    # still graded, out of the student's sight, so that overriding a benign case
    # is one edit in Gradescope rather than a re-mark from the audio.
    CODES_PARTIAL_OUTCOME = (
        "YOUR ANSWERS WERE STILL GRADED, and the score above is the one they earned. Because not "
        "every code was heard, this attempt has been flagged for your instructor to review, and "
        "that review MAY AFFECT YOUR FINAL GRADE. If you can, record a fresh attempt and read "
        "every code clearly — a clean attempt needs no review.\n\n")
    CODES_LOW_OUTCOME = (
        "Because fewer than half of the codes were heard, this attempt scores 0 automatically. "
        "Your instructor can still review it, so if this was our mistake it can be corrected — "
        "but please record a fresh attempt rather than counting on that.\n\n")
    CODES_PARTIAL_VALIDATION_MSG = (
        "Not every spoken code was heard (see \u201cSpoken codes\u201d). Every other check "
        "passed, so your answers were graded and the score stands for now \u2014 but this attempt "
        "is flagged for instructor review, which MAY AFFECT YOUR FINAL GRADE.\n\n"
        "We encourage you to record a fresh attempt. Gradescope grades your MOST RECENT upload, "
        "so if the new one scores lower, re-activate whichever attempt you want counted from "
        "Submission History.")
    CODES_LOW_VALIDATION_MSG = (
        "Fewer than half of the spoken codes were heard (see \u201cSpoken codes\u201d), so this "
        "attempt could not be confirmed as a live recording and scores 0.\n\n"
        "Your instructor can review it, so a transcription mistake on our side can be put right. "
        "Please record a fresh attempt \u2014 that is the quickest way to a score.")
    # What the instructor's REVIEW block says about the submission. None means the
    # default: it failed validation and scored 0.
    review_lead = [None]

    def wrap(text, width=88):
        """Gradescope renders output verbatim, so wrap it or it is one long line."""
        out = []
        for para in str(text).split("\n"):
            out.append(textwrap.fill(para, width=width) if para.strip() else "")
        return "\n".join(out)

    def add(name, ok, out, score=None, mx=None, visible=False):
        """visible=False (the default) means INSTRUCTOR-ONLY.

        Students must not learn which integrity check failed — that is a roadmap
        for defeating it. They get one generic validation result; every detail
        stays in hidden tests, which Gradescope retains for the instructor.
        """
        t = {"name": name, "output": wrap(out), "status": "passed" if ok else "failed",
             "visibility": "visible" if visible else "hidden"}
        if score is not None:
            t["score"], t["max_score"] = score, mx
        tests.append(t)

    def flag(reason):
        flags.append(reason)

    def instructor_answer_dump(segs, questions, words, text, cert):
        """WHAT WAS ACTUALLY SAID, PER QUESTION — instructor-only (INV-GRADE-8).

        Shown on a validation FAILURE, which is the one time nobody else will
        produce it. The student is told only that the attempt failed and gets 0;
        deciding whether that was right means reading what they said, and until
        now that meant an instructor with a .zip, an audio player and a stopwatch.

        Two clocks are printed for every question, because they answer different
        questions and disagree by a knowable amount:

          * SERVER  — the certificate's own offsets. Authoritative, signed,
            unforgeable, and shifted a second or two later than the audio because
            the recording began before /reveal was answered.
          * AUDIO   — the browser's marks, measured from the first byte of the
            file (INV-GRADE-8). Right for scrubbing to; client-asserted, so it is
            evidence for a human and never for a check.

        The transcript slice under each question is cut on the SERVER clock, the
        same way grading cuts it, so what is printed here is what the grader would
        have graded had the attempt passed.
        """
        marks = protocol.client_marks(cert)
        csegs = {c["index"]: c for c in
                 protocol.client_segments_from_marks(marks, len(segs))}
        lines = [
            "The student saw these questions and said these things. Shown because this "
            "submission FAILED validation and scored 0: if the failure was benign — a "
            "fumbled last code, a noisy room — this is what you would be marking, and you "
            "can mark it by hand without opening the audio.",
            "",
            "Two clocks. SERVER is the certificate's own offsets: signed, authoritative, and "
            "one to two seconds LATER than the audio, because recording starts before the "
            "Signer answers. AUDIO is the browser's own marks measured from the first byte "
            "of the file — right for scrubbing to, client-asserted, and never used by any "
            "check. Where AUDIO is missing, the recording came from a version of the app "
            "that did not report it; subtract a second or two from SERVER and listen.",
            "",
        ]
        for i, sg in enumerate(segs):
            q = questions[i] if i < len(questions) else {}
            srv_a = float(sg.get("questionOffsetSec", 0) or 0)
            srv_b = float(sg.get("closingOffsetSec", 0) or 0)
            c = csegs.get(i)
            lines.append("=" * 72)
            lines.append("QUESTION %d of %d  [%s]" % (i + 1, len(segs), sg.get("questionId")))
            lines.append("  SERVER: %.1fs \u2192 %.1fs   (%.0fs spoken)"
                         % (srv_a, srv_b, srv_b - srv_a))
            if c and c.get("endSec") is not None:
                lines.append("  AUDIO : %.1fs \u2192 %.1fs   (%.0fs spoken)  \u2190 scrub here"
                             % (c["startSec"], c["endSec"], c["answerSec"]))
            elif c:
                lines.append("  AUDIO : %.1fs \u2192 (no end mark)" % c["startSec"])
            else:
                lines.append("  AUDIO : not reported by this recording")
            lines.append("")
            lines.append("  ASKED: " + str(q.get("prompt", "(question not in the bundled bank)")))
            said = segment_transcript(words, text, sg)
            if not words:
                lines.append("")
                lines.append("  NOTE: no word timestamps, so the transcript could not be cut. The "
                             "WHOLE transcript is shown under every question below.")
            lines.append("")
            lines.append("  SAID: " + (said.strip() if said and said.strip()
                                       else "(nothing was transcribed in this window)"))
            lines.append("")
        add("What the student said, question by question", False, "\n".join(lines))

    def finish(total, top, student_top=None):
        # `output` is shown to STUDENTS, so it must stay generic.
        if debug_identity:
            top = "DEBUG AUTOGRADER — instructor testing only.\n\n" + top
            if student_top is not None:
                student_top = "DEBUG AUTOGRADER — instructor testing only.\n\n" + student_top
        if flags:
            tests.insert(0, {
                "name": "⚑ REVIEW — instructor only",
                "status": "failed",
                "visibility": "hidden",
                "output": wrap(
                    ("DEBUG AUTOGRADER: identity mismatches are diagnostic only. All other "
                     "validation failures still score 0. These marks are for instructor testing.\n\n"
                     if debug_identity else
                     review_lead[0] + "\n\n" if review_lead[0] else
                     "This submission failed one or more validation checks and scored 0. The student "
                     "was told only that validation failed and to retry. It was still graded: see "
                     "\u201cWould-have-been score\u201d below to override if the failure was benign.\n\n")
                    + "Treat as benign until shown otherwise: a mistyped email, a stale link, a "
                    "half-finished attempt or a bug on our side all look like this. The point of "
                    "recording it is to spot a PATTERN across submissions.\n\n"
                    "What failed:\n" + "\n".join("  - " + f for f in flags)),
            })
        summary, breakdown = timing.finish()
        tests[:] = runtiming.feedback_first(tests)
        add("Grading time", True, summary, visible=True)
        add("Timing breakdown (instructor only)", True, breakdown)
        os.makedirs(os.path.dirname(results_path) or ".", exist_ok=True)
        timing.emit("RESULTS_WRITE_STARTED")
        with open(results_path, "w", encoding="utf-8") as f:
            json.dump({"score": round(total, 3),
                       "output": wrap(student_top if student_top is not None else top),
                       "tests": tests, "visibility": "visible",
                       "stdout_visibility": "hidden"}, f, indent=2)
        timing.emit("RESULTS_WRITE_COMPLETED bytes=" + str(os.path.getsize(results_path)))
        print(top, flush=True)          # full detail to the autograder log (instructor-only)

    if not secret:
        add("Configuration", False, "ORALSCALE_SECRET must be set (autograder/source/secret.env).")
        add("Setup", False, "This assignment isn't set up correctly yet. This is not a problem with "
            "your submission — please tell your instructor or a TA.", visible=True)
        return finish(0, "Autograder misconfigured: no ORALSCALE_SECRET.",
                      student_top="This assignment isn't set up correctly yet — please contact your instructor.")

    course = load_course()
    assignment_id, how = resolve_assignment(
        course, env("ORALSCALE_METADATA", "/autograder/submission_metadata.json"))

    debug_spec = course.get("debugAutograder") or {}
    debug_identity = (isinstance(debug_spec, dict)
                      and debug_spec.get("identityCheck") == "flag-only"
                      and debug_spec.get("assignmentId") == assignment_id)
    if debug_identity:
        add("⚠ DEBUG AUTOGRADER — instructor testing only", False, visible=True,
            out="DEBUG: identity is checked and any mismatch is flagged, but identity does not "
                "block grading in this package. All other integrity checks remain enforced. "
                "Do not use these marks as official student grades. Upload the normal package "
                "before deploying or regrading the class.")
        flag("DEBUG AUTOGRADER: identity comparison is diagnostic only; instructor testing.")

    # Pointers for the accommodation-review notification. These are the ONLY
    # things that email may carry: what to open, never who or what about
    # (INV-ACCOM-3). Best-effort — a missing id degrades the email, never grading.
    gs_submission_id, gs_assignment_title = None, None
    gs_submitted_at, gs_due_at = None, None
    gs_meta_full, gs_due_source, gs_due_authoritative = {}, "none", False
    try:
        with open(env("ORALSCALE_METADATA", "/autograder/submission_metadata.json"),
                  "r", encoding="utf-8") as _f:
            _meta = json.load(_f) or {}
        gs_submission_id = _meta.get("id")
        gs_assignment_title = ((_meta.get("assignment") or {}).get("title") or "").strip() or None
        gs_submitted_at = _meta.get("created_at")
        gs_meta_full = _meta
    except Exception:
        pass
    if not assignment_id:
        add("Configuration", False, "Could not determine which week this assignment grades.\n\n" + how)
        add("Setup", False, "This assignment isn't set up correctly yet. This is not a problem with "
            "your submission — please tell your instructor or a TA.", visible=True)
        return finish(0, "Autograder misconfigured (assignment): " + how,
                      student_top="This assignment isn't set up correctly yet — please contact your instructor.")
    try:
        bank, acfg = load_bank(course, assignment_id)
    except Exception as e:
        add("Configuration", False, f"Could not load bank for {assignment_id}: {e}")
        add("Setup", False, "This assignment isn't set up correctly yet. This is not a problem with "
            "your submission — please tell your instructor or a TA.", visible=True)
        return finish(0, f"Autograder misconfigured (bank for {assignment_id}): {e}",
                      student_top="This assignment isn't set up correctly yet — please contact your instructor.")
    by_id = {q["id"]: q for q in bank["questions"]}
    ref = student_ref()

    # WHOSE due date. Most specific wins: an instructor-recorded extension, then
    # a per-user date if this Gradescope emits one, then the date on this
    # submission's own metadata. The last of those may already BE the student's
    # extended date — `submission_metadata.json` is written per submission — but
    # nothing here can prove that from one submission, so it is used and flagged
    # rather than trusted silently.
    gs_due_at, gs_due_source, gs_due_authoritative = latepolicy.effective_due(
        gs_meta_full, student_ref=ref, email=ref)

    # course.json is authoritative for the knobs an instructor tunes per assignment;
    # the env var stays the container-wide fallback so an unconfigured course still
    # grades out of 10.
    if knob(course, acfg, "maxPoints", None) is not None:
        max_points = float(knob(course, acfg, "maxPoints", 10))
    aggregation = str(knob(course, acfg, "scoreAggregation", "mean")).lower()
    show_transcript = bool(knob(course, acfg, "showTranscript", True))
    offer_private_code = bool(knob(course, acfg, "allowPrivateCode", True))

    audio_path, cert_path = find_submission_files(sub_dir)

    # ---- Branch 0: captured audio survived, certification did not ------------
    # The browser offers this only after /finish fails with a complete, non-empty
    # recording. Nothing in the backup is trusted: a student can make an audio-only
    # zip themselves, so it is always 0 and never sent through the content grader.
    # Its value is evidentiary — Gradescope retains the recording and the instructor
    # can diagnose rollout bugs or manually override after listening (INV-INTEGRITY-7).
    if audio_path and not cert_path:
        add("UNCERTIFIED BACKUP — automatic score 0", False, visible=True, out=
            "This upload contains your recording but no signed OralScale certificate, so it "
            "cannot be graded automatically and receives 0.\n\n"
            "Your recording has been preserved in Gradescope for instructional-staff review. "
            "Please make a fresh certified attempt if you can — that is strongly preferred and "
            "full credit will normally require it. If you cannot retry, contact the instructional "
            "staff; after carefully reviewing the audio and circumstances, they may manually "
            "override this 0. The automatic system will not do that.")
        add("⚑ REVIEW — uncertified recording retained", False,
            "Audio is present but certificate.json is absent. Automatic score is 0 and no content "
            "grader ran. Listen to the retained recording and inspect the submission before any "
            "manual override. This may indicate a /finish network/deadline failure or a rollout "
            "bug; the student's backup metadata, if present, is untrusted.")
        return finish(0, "UNCERTIFIED BACKUP — audio retained; no certificate; manual review required.",
                      student_top="Uncertified backup received. Automatic score: 0. Make a fresh "
                                  "certified attempt if possible, or contact instructional staff "
                                  "for careful manual review.")

    # ---- Branch 1: no recording -> explain, and hand over the private code ----
    # v3: the quiz link is PUBLIC and lives in the assignment description, so this
    # branch is no longer on the critical path — a student can go straight from the
    # description to recording. It exists for two reasons: someone submitted the
    # wrong file, or someone wants the opt-out private code (DESIGN-QUESTIONS B5).
    if not (audio_path and cert_path):
        webapp = env("ORALSCALE_WEBAPP_URL", course.get("webappUrl", "")).strip()
        # Everything below is DERIVED from the Gradescope-authenticated email, so this
        # branch doubles as a self-service key desk: a student who lost the Brightspace
        # handout can always get their own key here, and nobody keeps a table of them.
        course_id = course.get("courseId", "")
        epoch = int(course.get("accessKeyEpoch", 1) or 1)
        quiz_key = protocol.access_key_for(secret, course_id, ref, epoch) if ref else None
        code = protocol.pseudonym_for_email(secret, ref) if ref else "(unknown student)"
        wants_key = acfg.get("requireAccessKey")
        if wants_key is None:
            wants_key = (course.get("defaults") or {}).get("requireAccessKey")
        if wants_key is None:
            wants_key = True
        add("Submission", True, visible=True, out=
            "No recording found in this submission.\n\n"
            "The quiz link is in this assignment's description — open it, enter your quiz key,\n"
            "record your answer, download the .zip, and submit that .zip here. Unlimited retakes.\n"
            + (f"\n    {webapp}\n" if webapp else "")
            + ("\nThe quiz server never receives your email or anything derived from it.\n\n"
               if wants_key else
               "\nYour email is scrambled in your browser before anything is sent; the quiz\n"
               "server never receives your address.\n\n")
            + ((
                "YOUR PERSONAL QUIZ KEY (the same one posted in Brightspace) — this is the ONLY\n"
                "thing the quiz page asks you for. You never type your email there:\n"
                f"\n    {quiz_key}\n\n"
                "It is yours for the whole term. Keep it private: anyone with it can open quiz\n"
                "questions as you.\n\n"
              ) if (wants_key and quiz_key) else "")
            + (("PREFER NOT TO TYPE YOUR EMAIL AT ALL? Use this private code instead — on the quiz\n"
                "page choose \"Use a private code instead\" and enter:\n"
                f"\n    {code.replace('p:', '')}\n"
                + "\nIt is yours for the whole term. Keep it private: anyone with it can submit as you.")
               if (offer_private_code and not wants_key) else ""))
        # INV-DEPLOY-1: this branch scores 0 by design, and Gradescope grades the
        # ACTIVE submission — the most recent one unless the student activates an
        # earlier one. There is no instructor setting for "highest score" on a
        # Programming Assignment; this used to claim there was, which sent people
        # looking for a control that does not exist. So it is said to the STUDENT,
        # where the fix actually lives.
        add("Instructor note — how Gradescope picks the graded attempt", True,
            "This 'get a link' submission scores 0 by design.\n\n"
            "Gradescope grades the ACTIVE submission, which is the most recent one unless the "
            "student activates an earlier one from Submission History. There is no 'highest score' "
            "setting on a Programming Assignment. So a student whose last upload is this one, or a "
            "weaker retake, keeps that score until they re-activate a better attempt — which they "
            "are told how to do in the visible output and in the student guide.")
        return finish(
            0,
            "Quiz link generated — open it, record, and resubmit the .zip.",
            student_top=(
                "This submission has no recording, so it scores 0 — that is expected: it exists to "
                "hand you your quiz link.\n\n"
                "IMPORTANT: Gradescope grades your MOST RECENT upload. Once you record and upload a "
                "real attempt, that becomes your score. If you ever retake and score lower, you can "
                "go to Submission History and re-activate your best attempt — it is two clicks and "
                "it is entirely up to you which one counts."))

    # ---- Branch 2: validate + grade ----
    add("Submission", True, visible=True,
        out=f"Found your recording ({os.path.basename(audio_path)}) and its certificate.")
    add("Submission format (detail)", True, f"audio={audio_path} cert={cert_path}")
    with open(cert_path, "r", encoding="utf-8") as f:
        cert_obj = json.load(f)
    try:
        cert = protocol.verify_token(secret, cert_obj.get("certificateToken", ""))
    except Exception as e:
        add("Certificate signature", False, f"Invalid or forged certificate: {e}")
        flag(f"certificate signature did not verify ({e})")
        add("Validation checks", False, visible=True, out=VALIDATION_FAILED_MSG)
        return finish(0, f"Certificate signature invalid: {e}", student_top=STUDENT_FAILED_TOP)
    add("Certificate signature", True, "Signature valid (issued by the Signer).")

    integrity_ok = True

    # Identity (INV-SEC-2) — bound at SUBMISSION time, not at link time.
    # The certificate carries an opaque ref; we re-derive every accepted form from
    # the Gradescope-authenticated email and require one to match. Because we
    # cannot invert the hash, we tell the student exactly what to type instead.
    salt = course.get("pseudonymSalt", "")
    epoch = int(course.get("accessKeyEpoch", 1) or 1)
    course_id = course.get("courseId", "")

    # DEMO ONLY (INV-DEMO-1). Deliberately per-assignment and never a course
    # default, so it cannot be inherited by a course that copied a working
    # example -- which is what everyone does. tools/check-course-safety.js
    # refuses the commit if any course outside courses/demo/ sets it.
    #
    # WHY it exists: an instructor evaluating OralScale records on the public
    # demo site with the ONE SHARED demo quiz key, then uploads to THEIR OWN
    # Gradescope. The certificate names the demo key's holder; Gradescope names
    # them. Those never match, so an honest evaluation scores 0 and looks like a
    # broken product. Minting each evaluator a key first is the friction this
    # removes.
    #
    # WHY it must never ship in a real course: identity binding at SUBMISSION
    # time is the whole of INV-SEC-2. Without it, one recording can be uploaded
    # by any number of students and every one of them is graded on it.
    demo_skip_identity = bool(acfg.get("demoSkipIdentityCheck"))
    if demo_skip_identity:
        add("⚠ DEMO MODE — identity verification DISABLED", False, visible=True, out=DEMO_IDENTITY_OFF_MSG)
        flag("DEMO MODE: identity verification disabled (demoSkipIdentityCheck) -- "
             "this assignment grades ANY submitter's certificate. Never use in production.")
        add("Identity (demo mode — not checked)", True,
            f"Skipped by demoSkipIdentityCheck on assignment {assignment_id!r}.\n\n"
            f"  Gradescope submitter : {ref}\n"
            f"  certificate studentRef: {cert.get('studentRef')}\n\n"
            "Had this been checked, the result would have been: "
            + ("MATCH." if (ref and protocol.student_ref_matches(
                secret, salt, cert.get("studentRef", ""), ref, course_id, epoch)) else "MISMATCH."))
    elif debug_identity:
        identity_matches = bool(ref and protocol.student_ref_matches(
            secret, salt, cert.get("studentRef", ""), ref, course_id, epoch))
        add("Identity (DEBUG — " + ("MATCH" if identity_matches else "MISMATCH") + ")",
            identity_matches, visible=True,
            out=("Identity matches the authenticated submitter." if identity_matches else
                 "Identity does not match the authenticated submitter, or submitter metadata "
                 "is missing. Flagged for instructor testing; grading continues in DEBUG only."))
        if not identity_matches:
            flag("DEBUG identity mismatch or absent submitter metadata; content grading allowed.")
    elif ref and not protocol.student_ref_matches(secret, salt, cert.get("studentRef", ""), ref,
                                                course_id, epoch):
        add("Identity", False,
            "The certificate was NOT issued to the submitting student.\n\n"
            f"  Gradescope submitter : {ref}\n"
            f"  their expected ref    : {protocol.student_ref_for_email(secret, course_id, ref, epoch)}\n"
            f"  certificate studentRef: {cert.get('studentRef')}\n\n"
            "Most likely benign: the student took the quiz with SOMEONE ELSE'S key (or one from "
            "another course), or submitted from a different Gradescope account than the roster "
            "address their key was minted for. It is also what submitting someone else's .zip "
            "looks like — so this is worth a glance if it recurs for the same student.")
        flag(f"identity mismatch: submitter {ref} vs certificate {cert.get('studentRef')}")
        integrity_ok = False
    elif not demo_skip_identity:
        add("Identity", True, f"Certificate matches submitter ({ref or cert.get('studentRef')}).")

    # Access key (INV-SEC-8) — the certificate must record that the Signer gated
    # this attempt behind a valid personal quiz key.
    #
    # Checking it HERE, and not only at /reveal, is what makes the gate hold: a
    # Signer accidentally deployed with the gate off, or an old certificate minted
    # before keys existed, would otherwise produce gradeable work for an identity
    # nobody ever proved was enrolled. The flag is inside the signed certificate,
    # so a student cannot add it.
    require_key = acfg.get("requireAccessKey")
    if require_key is None:
        require_key = (course.get("defaults") or {}).get("requireAccessKey")
    if require_key is None:
        require_key = True          # fails closed, like the Signer
    if require_key:
        if cert.get("accessKeyVerified"):
            add("Access key", True,
                f"Attempt was gated by the Signer (via {cert.get('keyChecked', 'accessKey')}).")
        else:
            add("Access key", False,
                "The certificate does not record a verified quiz key "
                f"(keyChecked={cert.get('keyChecked')!r}).\n\n"
                "Benign reading: the certificate predates access keys, or was made against a "
                "Signer deployed with requireAccessKey off — check GET /health on the Signer, "
                "because in that state anyone can open questions under an invented identity and "
                "mine the bank. It is also what a certificate minted outside the gate looks like.")
            flag("certificate carries no verified access key (INV-SEC-8)")
            integrity_ok = False

    # Assignment match
    # COURSE match. The signature usually catches this on its own, because each
    # course has its own Secret -- but not always: a course still on the legacy
    # shared secret (tools/lib/secrets.js) verifies another such course's
    # certificates perfectly well, and assignment ids collide readily across
    # courses ("week-01-intro" in both). Checking the id costs nothing and closes
    # the case the signature cannot.
    cert_course = cert.get("courseId")
    if cert_course and course_id and cert_course != course_id:
        add("Course", False,
            f"Certificate was issued for course {cert_course!r}, but this autograder grades "
            f"{course_id!r}.\n\n"
            "Benign reading: the student opened a link for a different OralScale course they are "
            "also enrolled in. It is also what submitting another course's recording looks like. "
            "If both courses share a signing Secret, the signature alone would NOT have caught "
            "this — give them their own Secrets (secrets/<courseId>.json).")
        flag(f"wrong course: certificate for {cert_course}, this autograder grades {course_id}")
        name_reason(WRONG_LINK_MSG)
        integrity_ok = False

    if cert.get("assignmentId") != assignment_id:
        add("Assignment", False,
            f"Certificate is for {cert.get('assignmentId')}, but this autograder grades "
            f"{assignment_id}.\n\n"
            "Benign reading: the student opened another assignment's link, or uploaded the .zip to "
            "the wrong Gradescope assignment. It is also how someone would try to reuse an easier "
            "question from another week.\n\n"
            "Every autograder zip grades exactly one assignment and says which in its filename "
            f"({assignment_id}), so check that the zip uploaded here is the right one before "
            "reading anything into a run of these.")
        flag(f"wrong assignment: certificate for {cert.get('assignmentId')}, "
             f"this autograder grades {assignment_id}")
        name_reason(WRONG_LINK_MSG)
        integrity_ok = False

    # Audio hash binding (INV-INTEGRITY-1)
    actual = protocol.sha256_hex_file(audio_path)
    if actual != cert.get("audioSHA256"):
        add("Audio integrity", False,
            "The uploaded audio does NOT hash to the value in the certificate.\n\n"
            f"  certificate audioSHA256: {cert.get('audioSHA256')}\n"
            f"  uploaded file           : {actual}\n\n"
            "The audio was altered, re-encoded, or swapped after it was certified. Benign causes are "
            "rare here — most often the student uploaded a different file than the one in their .zip.")
        flag("audio hash mismatch (file altered or swapped after certification)")
        integrity_ok = False
    else:
        add("Audio integrity", True, "Uploaded audio matches the certified hash.")

    # Window (INV-INTEGRITY-2)
    #
    # `limitSec` is ONE question's answer limit. The attempt's budget is the sum
    # over its questions plus the code windows, or a five-question attempt is
    # judged against a one-question clock — which is what used to happen, failing
    # every honest multi-question submission.
    #
    # The per-question deadline is enforced live by the Signer and re-checked via
    # tFinish <= deadline; this bound is the whole-attempt backstop.
    elapsed = int(cert.get("elapsedSec", 0))
    budget = attempt_budget_sec(cert, grace)
    n_q = len(cert_segments(cert))
    window_ok = cert.get("tFinish", 0) <= cert.get("deadline", 0) and elapsed <= budget
    add("Timing window", window_ok,
        f"Finished {elapsed}s after reveal (budget {budget}s for {n_q} question(s): "
        f"{int(cert.get('limitSec', 0) or 0)}s + buffer each, plus code windows and {grace}s grace).")
    if not window_ok:
        flag(f"outside the time window: {elapsed}s elapsed against a {budget}s budget "
             f"for {n_q} question(s)")
    integrity_ok = integrity_ok and window_ok

    # Transcribe (INV-PRIV-3) + duration (INV-INTEGRITY-3)
    timing.stage("Audio transcription (including speech model load)")
    text, words, method = stt.transcribe(audio_path, os.path.dirname(cert_path))
    timing.stage("Post-transcription validation (including spoken-code rescue)")
    D = stt.audio_duration_sec(audio_path, words)
    if D is None:
        add("Duration", True, "Could not measure audio duration (no ffprobe/timestamps) — check skipped.")
    else:
        segs_dur = cert_segments(cert)
        # Same budget as the timing window, from the same function — these two
        # drifted once and produced a false failure on every multi-question
        # attempt. They cannot drift again.
        budget = attempt_budget_sec(cert, grace, dur_tol)
        dur_ok = D <= budget and D <= elapsed + dur_tol
        add("Duration", dur_ok,
            f"Audio is {D:.0f}s vs window {elapsed}s "
            f"({len(segs_dur)} question(s), budget {budget}s: code lead + answer limit + buffer "
            f"per question, plus the tail window). "
            + ("Consistent." if dur_ok else
               "The file is LONGER than the live window it claims — the signature of a recording made "
               "outside the attempt. Benign causes are unusual."))
        if not dur_ok:
            flag(f"audio longer than the live window ({D:.0f}s of audio vs {elapsed}s elapsed)")
        integrity_ok = integrity_ok and dur_ok

    if not text:
        if method == "none" and not stt.whisper_available():
            # Not the student's fault. Say so loudly and in instructor language --
            # otherwise a container built without Whisper silently zeroes the class.
            add("Transcription", False,
                "AUTOGRADER MISCONFIGURED — no speech-to-text backend is installed in this "
                "container, so no submission can be graded. This is not a problem with your "
                "recording.\n\nInstructor: setup.sh must install faster-whisper and cache the "
                "model at image build time; check the autograder build log.")
            add("Setup", False, visible=True,
                out="This assignment isn't set up correctly yet. This is not a problem with your "
                    "submission — please tell your instructor or a TA.")
            return finish(0, "AUTOGRADER MISCONFIGURED: no transcription backend installed.",
                          student_top="This assignment isn't set up correctly yet — please contact your instructor.")
        add("Transcription", False,
            f"No transcript could be produced ({method}). Usually a silent, corrupt or empty "
            "recording — worth listening to the audio.")
        flag("no transcript could be produced from the audio")
        integrity_ok = False
    else:
        add("Transcription", True, f"Transcribed via {method} ({len(text.split())} words).")
        # Students see this too: if the transcript is garbled, that explains a low score
        # or a missed code far better than any message we could write. An instructor who
        # would rather not show it sets showTranscript:false — the grader still uses it,
        # the student just does not see it.
        if show_transcript:
            add("What we heard (automatic transcript)", True, visible=True,
                out="This is the automatic transcript of your recording. It is what the grading "
                    "is based on, so if it looks garbled, the audio was hard to hear — try a "
                    "quieter room, speak a little closer to the microphone, and retake.\n\n"
                    + (text[:4000] + ("\n\n…truncated…" if len(text) > 4000 else "")))

    # ---- grading-prompt injection (INV-SEC-10) -------------------------------
    # The transcript is about to be pasted into a prompt that decides a grade, so
    # it is untrusted input to a privileged decision. Detect it HERE, in Python,
    # before any model sees it: a defence that lives inside the prompt can be
    # argued with, and this one cannot.
    #
    # Two severities, and the difference matters (see injection.py). `high` is an
    # instruction aimed at the grader about the grade — treated as an integrity
    # failure. `possible` is injection-adjacent vocabulary without a
    # grader-directed instruction, which in an AI course is usually a student
    # correctly explaining what prompt injection IS; it is graded normally and
    # merely flagged, because zeroing that student would be a false accusation
    # produced by a regex.
    inj = injection.scan(text)
    if inj["severity"] == "high":
        add("Answer content", False,
            "PROMPT INJECTION DETECTED — the transcript contains an instruction "
            "addressed to the grading model, attempting to influence the score.\n\n"
            "Evidence:\n" + "\n".join("  - " + e for e in inj["evidence"])
            + "\n\nThe answer was NOT sent to the grading model and was not graded. "
              "The student was told only that validation failed.\n\n"
              "This is not a transcription artefact and not an ambiguous phrasing: the "
              "detector requires an imperative addressed to the grader together with a "
              "grading outcome, and deliberately does not fire on a student merely "
              "DISCUSSING prompt injection as course material. Listen to the audio to "
              "confirm the words were spoken, then handle it as you would any other "
              "attempt to obtain a grade dishonestly — at Purdue that means a report to "
              "the Office of the Dean of Students. Full transcript is in the "
              "transcription test above.")
        flag("prompt injection aimed at the grading model: "
             + "; ".join(inj["evidence"][:3]))
        integrity_ok = False
    elif inj["severity"] == "possible":
        add("Answer content", True,
            "Injection-adjacent language, graded normally.\n\n"
            + "\n".join("  - " + e for e in inj["evidence"])
            + "\n\nThis did NOT meet the bar for an injection attempt: no instruction "
              "was addressed to the grader. In this course that is the expected shape of "
              "an on-topic answer about LLMs. Shown so a genuine attempt phrased just "
              "below the threshold is still visible to you.")

    # Spoken boundary codes (INV-INTEGRITY-4 first code / INV-INTEGRITY-5 the rest).
    # N questions => N+1 codes; each interior one closes an answer and opens the
    # next question, so the whole recording is pinned boundary by boundary.
    segs = cert_segments(cert)
    n_q = len(segs)
    # `audio_path` enables the rescue pass: a code missing from the main transcript
    # is re-sought in the audio itself before we call it absent (INV-INTEGRITY-9).
    bounds, positional = check_boundary_codes(secret, cert, text, words,
                                              audio_path=audio_path, duration=D)
    missing = [b for b in bounds if not b["ok"]]
    # INV-CODE-4: at least half heard -> graded and flagged; fewer -> scores 0,
    # graded out of sight. 5 questions = 6 codes, so 3 heard is enough.
    n_heard = len(bounds) - len(missing)
    codes_low = 2 * n_heard < len(bounds)
    codes_partial = bool(missing) and not codes_low
    rescued = [b for b in bounds if b.get("via") == "rescue"]
    detail = (", ".join(f"code {b['k']} " + ("✓" if b["ok"] else "MISSING")
                        + (" (rescued)" if b.get("via") == "rescue" else "")
                        for b in bounds)
              + (" (timed)" if positional else " (presence only — no word timestamps)"))
    if rescued:
        # Worth surfacing even on a pass: a rising rate here means the main
        # transcription pass is degrading (bad model, starved container, or a
        # room/mic problem across a whole section), which is an instructor
        # signal long before it becomes a wrongly-failed student.
        detail += ("\n\nRESCUED: code(s) "
                   + ", ".join(str(b["k"]) for b in rescued)
                   + " were not in the main transcript but WERE found by re-transcribing "
                     "their window of the audio. The student did nothing wrong. If this "
                     "happens often, check the Whisper model and the container size "
                     "(TEACHER-GUIDE, \u201cAutograder settings\u201d).")
    if not missing:
        add("Spoken codes", True, detail + ". Recording confirmed live from start to finish.")
        add("Spoken codes", True, visible=True,
            out="Every code was heard. Nothing to change.")
    else:
        # The ONE check students are told about by name. They already know the codes
        # exist — the app shows them — so this is coaching, not a roadmap. Everything
        # else stays hidden.
        if n_q == 1:
            which = ("the first code and the last code" if len(missing) == 2
                     else "the first code" if missing[0]["k"] == 0 else "the last code")
        elif len(missing) == len(bounds):
            which = "any of the codes"
        else:
            which = ("the code" if len(missing) == 1 else "the codes") + " you were shown " + \
                ", ".join(("at the very start" if b["k"] == 0 else
                           "at the very end" if b["k"] == n_q else
                           f"after question {b['k']}") for b in missing)
        # EVERY CODE, AND WHICH ONES WE HEARD (INV-CODE-3).
        #
        # "We could not hear one of your codes" is true and useless: the student
        # cannot tell which four digits they failed to say, so they cannot check
        # whether they said them, and the honest ones conclude the system is
        # broken. Naming the codes turns it into something they can verify for
        # themselves against the transcript printed further down this page.
        #
        # SHOWING THE EXPECTED DIGITS IS SAFE, and is the reason this can be a
        # student-visible message at all. A code is HMAC(Secret, attemptId:phase):
        # it belongs to THIS attempt and no other. The attempt it belongs to is
        # over, certified, and pinned to the hash of audio that already exists, so
        # a code learned here cannot be spoken into anything. The next attempt gets
        # a fresh server-random attemptId and therefore fresh codes, which nobody
        # can derive without the Secret. There is nothing here to reuse.
        ledger = ["The codes you were asked to read aloud during this attempt, in order:", ""]
        for b in bounds:
            ledger.append("  %-28s %-12s %s"
                          % (boundary_label(b["k"], n_q),
                             protocol.speak_code(b["code"]),
                             "heard" if b["ok"] else "NOT HEARD"))
        ledger += [
            "",
            "Find the digits marked NOT HEARD in the automatic transcript further down this "
            "page. If they are genuinely not there, that is what went wrong and a retake will "
            "fix it. If you can see them in the transcript and we still marked them missing, "
            "that is our bug and not yours \u2014 send a TA this page.",
            "",
        ]
        ledger = "\n".join(ledger) + "\n"
        # The outcome is only promised when the codes are the ONLY problem. If
        # another check failed too, the attempt is not graded at all and the
        # generic validation message below says so.
        outcome = ("" if not integrity_ok else
                   CODES_PARTIAL_OUTCOME if codes_partial else CODES_LOW_OUTCOME)
        add("Spoken codes", False, visible=True,
            out=CODES_HELP.format(which=which, outcome=outcome, ledger=ledger))
        add("Spoken codes", False,
            detail + ".\n\nExpected but not heard: "
            # The index and the code are BOTH digit runs, so they need a separator that
            # is not a space: "boundary 2 8 3 4 2" reads as one five-digit code, and the
            # codes are four digits (protocol.CODE_DIGITS = 4). Reported from a real
            # submission, where it looked like the grader expected the wrong length.
            + "; ".join(f"boundary {b['k']} — spoken as \"{protocol.speak_code(b['code'])}\""
                        for b in missing)
            + "\n\nEach of these was searched for TWICE: in the full transcript, and again by "
            "re-transcribing just that window of the audio with digit-tuned settings "
            "(INV-INTEGRITY-9). So a transcription miss has already been ruled out as far as "
            "this grader can rule it out.\n\n"
            + "\n".join(
                f"  boundary {b['k']}: "
                + ("NO SPEECH was transcribed anywhere in that window — suspect a capture or "
                   "microphone fault, or a recording that stopped early. Listen to the audio "
                   "before treating this as non-compliance."
                   if b.get("heardWords") == 0 else
                   f"{b['heardWords']} words were heard in that window but no matching digits — "
                   "the student was talking, just not reading the code."
                   if b.get("heardWords") else
                   "no word timestamps, so the whole transcript was searched.")
                for b in missing)
            + "\n\nBenign causes are common: the student talked over the digits, stopped early, "
            "or the room was noisy. A MISSING FINAL code with everything else intact is usually "
            "just a fumbled last step. Several missing is more unusual.")
        flag("spoken codes not heard (%d of %d): " % (len(missing), len(bounds))
             + "; ".join(f"boundary {b['k']} {protocol.speak_code(b['code'])}" for b in missing))
        if integrity_ok:
            review_lead[0] = (
                "GRADED DESPITE MISSING CODES (INV-CODE-4). Every other validation check passed. "
                "%d of %d spoken codes were heard (at least half), so the answers were graded and the score "
                "stands; the student was told it is under review and may change, and was "
                "encouraged to retake. Listen at the missing boundaries before acting: a "
                "transcription miss on a code the student plainly said is the common case."
                % (len(bounds) - len(missing), len(bounds))
                if codes_partial else
                "FEWER THAN HALF THE SPOKEN CODES WERE HEARD (%d of %d; INV-CODE-4). Every other "
                "validation check passed. The submission scores 0, but it WAS graded: see "
                "“Would-have-been score” below. If the recording is genuine, override the "
                "score in Gradescope with that figure. The student was told it scored 0 and to "
                "retake." % (n_heard, len(bounds)))
    # INV-CODE-4: nothing below blocks grading any more. A failure only decides
    # whether the grade is SHOWN and COUNTED, or kept for the instructor at 0.
    shadow = (not integrity_ok) or codes_low

    # Every question the certificate names must be in the bundled bank.
    questions = []
    for sg in segs:
        q = by_id.get(sg.get("questionId"))
        if not q:
            add("Question", False,
                f"Certificate names question {sg.get('questionId')}, which is not in the bundled "
                f"bank for {assignment_id}. The zip and the Signer may be serving different bank "
                "versions.")
            flag(f"question {sg.get('questionId')} not found in the bundled bank")
            add("Validation checks", False, visible=True, out=VALIDATION_FAILED_MSG)
            return finish(0, f"Question {sg.get('questionId')} not in bank for {assignment_id}.",
                          student_top=STUDENT_FAILED_TOP)
        questions.append(q)

    if not integrity_ok:
        # The student is told ONLY that validation failed. Which check failed, and why,
        # stays in the hidden tests — naming it would hand over a map of what to defeat.
        # The single exception is the wrong-link case (see WRONG_LINK_MSG), where the
        # generic advice is actively wrong and there is nothing to give away.
        #
        # The INSTRUCTOR still gets everything, including the per-question split of
        # what was said (INV-GRADE-8) and, below, the grade it would have earned
        # (INV-CODE-4) — a failed attempt is exactly when someone has to decide by hand.
        instructor_answer_dump(segs, questions, words, text, cert)
        add("Validation checks", False, visible=True,
            out=student_reason[0] or VALIDATION_FAILED_MSG)
        shadow_log = "INTEGRITY FAILED (" + "; ".join(flags) + ")"
        shadow_top = (STUDENT_FAILED_TOP if student_reason[0] is None else
                      "This recording is for a DIFFERENT QUIZ. See below \u2014 you "
                      "need the link from this assignment.")
    elif codes_low:
        add("Validation checks", False, visible=True, out=CODES_LOW_VALIDATION_MSG)
        shadow_log = f"Integrity: FEWER THAN HALF THE CODES HEARD ({n_heard}/{len(bounds)}); scored 0."
        shadow_top = (f"Score: 0. Fewer than half of the spoken codes were heard, so this attempt "
                      f"could not be confirmed as a live recording. Please record a fresh attempt "
                      f"\u2014 see \u201cSpoken codes\u201d below for what to do differently.")
    elif codes_partial:
        add("Validation checks", False, visible=True, out=CODES_PARTIAL_VALIDATION_MSG)
    else:
        add("Validation checks", True, visible=True,
            out="Your recording passed all checks.")
    # Everything added from here on is the grading itself. In a shadow grade it is
    # moved out of the student's view and out of the score (INV-CODE-4).
    graded_from = len(tests)

    # ---- extended-time accommodation (INV-PRIV-6, INV-ACCOM-1) ---------------
    # THE AUTOGRADER DOES NOT VERIFY THIS, ON PURPOSE.
    #
    # It used to: a roster of who holds a disability accommodation was built from
    # the instructor's records, bundled into the zip, and matched against the
    # claim here. It worked, and it was the wrong place to do it. That roster is
    # the most sensitive data this system touches, and verifying inside the
    # autograder meant shipping it into a container, into a build artifact, and
    # into every copy of that artifact — permanently, for a check that is needed
    # once per quiz at most and is perfectly good done afterwards.
    #
    # So the check moved OUT (tools/audit-accommodations.js, run offline against
    # downloaded submissions), and what remains here is a NOTE. It records that a
    # claim was made, so the audit has something to find and the instructor can
    # see it while marking. It is instructor-only, it is not a failure, and it
    # never touches the score: the claim is assumed correct at grading time, and
    # the audit is where a human decides otherwise.
    accom = cert.get("accommodation") or {}
    claimed = protocol.normalize_time_multiplier(accom.get("claimedMultiplier"))
    accom_source = accom.get("source") or "none"

    if claimed is None:
        # Signed by us, so this cannot have come from a student. It means a
        # Signer and an autograder are running different versions of the ladder.
        add("Extended time", False,
            f"Certificate carries an unrecognised time multiplier "
            f"{accom.get('claimedMultiplier')!r}. Signer and autograder disagree on the allowed "
            "values — check that both are on the same release.")
    elif claimed > 1:
        origin = ("an accommodation link you issued" if accom_source == "instructor-link"
                  else "selected by the student on the start screen")
        add(f"{claimed}x extended time claimed", True,
            f"{claimed}x extended time was applied to every question — {origin}.\n\n"
            f"NOT VERIFIED HERE, and not a problem: the claim is assumed correct and the score is "
            f"unaffected. This autograder deliberately carries no accommodation roster, so that no "
            f"record of who holds an accommodation is ever shipped into a container.\n\n"
            f"To check claims against your own records, download this assignment's submissions "
            f"from Gradescope and run:\n"
            f"    node tools/audit-accommodations.js --submissions <export.zip> \\\n"
            f"        --course courses/<id>/course.json --roster <email,multiplier.csv>\n"
            f"It reports only the claims your records do not support, and it never writes the "
            f"roster anywhere.")

    # ---- content grade -------------------------------------------------------
    # One grade per question, then the mean. Each question is graded ONLY on what
    # was said while it was on screen, so a strong first answer cannot carry a
    # missing second one — the whole point of asking several.
    # ONE model call for the whole submission, not one per question: a regrade of
    # a 200-student roster is 200 containers calling Purdue GenAI at once, and the
    # request count is the axis a rate limit counts. grade.py owns the batching,
    # the pre-call jitter, and the backoff-until-deadline retry.
    timing.stage("Grading preparation and speech model release")
    seg_texts = [segment_transcript(words, text, sg) for sg in segs]

    # Which grader, and calibrated how. Default LOCAL: the transcript then never
    # leaves the Gradescope container, which is the conservative choice to make
    # on an instructor's behalf (see TEACHER-GUIDE "Choosing a grader").
    # course.json is where an instructor sets this. ORALSCALE_GRADING_BACKEND is a
    # deliberate container-level OVERRIDE and wins — it is how the test suites ask
    # for keyword grading without a model installed, and how an instructor can
    # force a backend for one regrade without editing (and re-shipping) the course.
    grading_backend = str(env("ORALSCALE_GRADING_BACKEND")
                          or knob(course, acfg, "gradingBackend", "local")).lower()
    # Explicit profile pins survive default changes. Invalid pins fail visibly.
    timing.emit('BACKEND_SELECTED ' + (grading_backend if grading_backend in ('local', 'genai', 'heuristic') else 'unknown'))
    if grading_backend == 'local':
        import localmodel as _lm
        _selected = (acfg or {}).get('localModel') or (course.get('defaults') or {}).get('localModel')
        _lm.configure(_selected)
        timing.emit("MODEL_SELECTED " + _lm.local_model_name())
    cal = calib.load(os.path.dirname(os.path.abspath(
        env("ORALSCALE_COURSE", os.path.join(HERE, "course.json")))))

    # What each band is WORTH. The instructor owns this curve — it is a grading
    # policy, not an engineering constant — so it is a course/assignment knob and
    # not a code edit. A table the engine cannot use safely (unknown or missing
    # band names, non-numeric, out of range, or out of order) is rejected whole
    # by grader.resolve_bands and the documented default is used instead, so a
    # typo here degrades to the published scale rather than to an invented one.
    #
    # ORDER MATTERS WITH CALIBRATION. The band price is applied first and
    # calibration.py's affine map is applied LAST, on top of it. A course that
    # sets both is asking for its own curve and then a second transform of that
    # curve, which is almost never what the instructor meant. Calibration exists
    # to un-squash a grader whose numbers are compressed; re-pricing the bands
    # already sets the numbers by hand. Use one or the other.
    band_scores = knob(course, acfg, "bandScores", None)
    band_spec = knob(course, acfg, "bands", None)
    # BANDS OR POINTS (INV-GRADE-10). Absent means the band ladder, exactly as every
    # assignment before it was graded; see pointscore.py for the points policy.
    scoring = knob(course, acfg, "scoring", None)
    if (band_scores or band_spec) and cal:
        flag("this course sets BOTH bandScores and a calibration.json — calibration is "
             "applied AFTER the band prices, so the marks students receive are not the "
             "prices in course.json. Remove one of them.")

    # Transcription is finished — including any rescue pass — so give the speech
    # model's memory back before the grading model asks for its own. Peak usage is
    # then max(whisper, grader) rather than their sum, which is what keeps a 4 GB
    # local grader inside a 6 GB container with real headroom.
    try:
        stt.release()
    except Exception:
        pass

    # ONE GRADER, OR NONE (INV-GRADE-1). The course names a grader; if that
    # grader cannot run, the submission is NOT graded by a different one.
    #
    # Two students who said the same thing must not be measured by different
    # methods because one of them submitted during an outage. A weaker grader is
    # not a smaller version of the same measurement, and which one a student got
    # would come down to timing. Failing here is recoverable — the instructor
    # rebuilds and regrades everyone affected, together, with one grader.
    #
    # COME BACK BEFORE GRADESCOPE KILLS US. The grading ladder retries hard on
    # purpose (a throttled submission must not silently get a weaker grader), but
    # each rung had its own 25-minute deadline and there are up to 2 + questions
    # of them. Under sustained throttling that ran past the 40-minute container
    # timeout, and a killed container produces NOTHING: no score, no traceback, no
    # cause -- just "the autograder failed to respond in the expected amount of
    # time". Observed in the pilot, 2026-09-02, where the same recording graded fine
    # on the third upload.
    #
    # So the whole submission gets ONE budget, measured from container start so
    # that transcription's share is already counted, and sized to leave room to
    # write the result. Giving up on purpose says what happened; being killed
    # cannot say anything.
    budget = _f_env("ORALSCALE_GRADING_BUDGET_SEC", 1800) - (time.time() - _T0)
    grader.set_budget(max(60.0, budget))
    timing.stage("Answer grading (model readiness, all questions and retries)")
    try:
        graded = grader.grade_all([{"question": q, "transcript": t}
                                   for q, t in zip(questions, seg_texts)],
                                  backend=grading_backend, calibration=cal,
                                  bands=band_scores, bandSpec=band_spec, scoring=scoring)
    except grader.GraderUnavailable as e:
        timing.stage("Failure feedback and result preparation")
        support = str(knob(course, acfg, "supportChannel", "Piazza")).strip() or "Piazza"
        add("Grading backend (instructor only)", False,
            f"REGRADE REQUIRED — the '{e.backend}' grader could not grade this submission.\n\n"
            f"Reason: {e.reason}\n\n"
            f"NOTHING WAS GRADED and no score was produced. This is deliberate: grading it with "
            f"a different backend would measure this student by a method nobody else was measured "
            f"by, and which one they got would depend on when they happened to submit.\n\n"
            f"The recording itself is fine — every integrity check above passed. Fix the backend "
            f"(check the GenAI key and service, or rebuild the zip with a working local model), "
            f"then REGRADE all affected submissions together so the whole cohort is graded once, "
            f"by one grader."
            + (("\n\nWhat the grader actually did (in order):\n"
                + "\n".join("  - " + l for l in e.log)) if e.log else "")
            + ("\n\nIf the log above says TRUNCATED, the reply hit the token limit rather than "
               "the model ignoring the format: raise ORALSCALE_GENAI_MAX_TOKENS in the zip's "
               "secret.env (or ask fewer questions per attempt) and regrade."
               if any("TRUNCATED" in l for l in e.log) else "")
            # Throttling is the one cause here that is nobody's mistake and fixes
            # itself. Say so plainly, so it is not read as a broken key or a bad
            # zip — and so a whole-cohort regrade is not launched into the same
            # limit that just refused us.
            + ("\n\nTHIS WAS RATE LIMITING, not a misconfiguration. The key, the model and the "
               "zip are fine; Purdue GenAI refused us while we waited. Nothing needs fixing — "
               "regrade the affected submissions once the service is quiet, and stagger a "
               "whole-cohort regrade rather than launching it all at once. If it recurs, raise "
               "ORALSCALE_GRADING_BUDGET_SEC together with the Gradescope autograder timeout, "
               "keeping the budget comfortably under it."
               if "RATE LIMITED" in str(e.reason) else ""))
        if shadow:
            # It was scoring 0 anyway; the student message is the validation one, not
            # an outage they need not act on. The instructor sees both problems.
            return finish(0, shadow_log + f" Shadow grade NOT produced — grader "
                          f"'{e.backend}' unavailable: {e.reason}", student_top=shadow_top)
        return finish(
            0,
            f"NOT GRADED — grader '{e.backend}' unavailable: {e.reason}",
            student_top=(
                ("Your recording was received. Not every spoken code was heard (see below), but "
                 "that is not why it has no score.\n\n" if missing else
                 "Your recording was received and passed every check — this is not a problem with "
                 "your submission, and nothing you did caused it.\n\n")
                + "The grading service could not be reached, so your answer has not been scored "
                "yet. Your instructor has to fix that and regrade; you do not need to resubmit, "
                "and you will not be marked down for this.\n\n"
                f"If you do not see a score after a reasonable time, post on {support} so your "
                "instructor knows it affected you."))
    # `text` is what the student actually said while THIS question was on screen.
    # It is carried through so the feedback can show the student the words they
    # were graded on, next to the question and the mark — a score with no visible
    # evidence behind it is not something a student can learn from or dispute.
    timing.stage("Scoring, feedback and result preparation")
    per_q = [{"seg": sg, "q": q, "g": g, "words": len(t.split()), "text": t}
             for sg, q, g, t in zip(segs, questions, graded, seg_texts)]

    # The grading model is asked to report an injection attempt it noticed. That
    # signal can only ADD suspicion: it never clears the deterministic scan above,
    # because a model that had been successfully injected would report precisely
    # what the attacker wanted it to report.
    # Personal details removed before the transcript left the container
    # (INV-PRIV-4). Reported to BOTH: the instructor sees the kinds found so a
    # pattern is visible, and the student is told plainly, because the fix is
    # theirs to make on the next attempt and there is nothing punitive about it.
    pii_found = {}
    for p_ in per_q:
        for f in (p_["g"].get("pii") or []):
            pii_found[f["type"]] = pii_found.get(f["type"], 0) + f["count"]
    if pii_found:
        listed = ", ".join(f"{v} × {k}" for k, v in sorted(pii_found.items()))
        add("Personal details removed before grading", True,
            f"Removed from the copy sent to Purdue GenAI: {listed}.\n\n"
            "The FULL transcript is unchanged in this submission and in the "
            "transcription test above — Gradescope is the system of record and stays "
            "inside the FERPA boundary. Only the outbound grading copy was redacted "
            "(INV-PRIV-4). The matched text is deliberately NOT repeated here.")
        add("A note on your recording", True, visible=True,
            out="You mentioned some personal details in your answer (for example a name, "
                "an ID number, or contact details). They were removed before your answer "
                "was graded, and this did not affect your score.\n\n"
                "Next time, please just answer the question — nothing personal is needed, "
                "and keeping it out is the simplest way to keep it private.")
        flag(f"personal details in the transcript, redacted before grading: {listed}")

    model_flags = [(i, p["g"].get("modelInjectionEvidence", ""))
                   for i, p in enumerate(per_q, 1) if p["g"].get("modelInjectionSuspected")]
    if model_flags:
        add("Answer content (model-reported)", True,
            "The grading model reported a suspected injection attempt that the "
            "deterministic scan did not rate as high-severity:\n\n"
            + "\n".join(f"  Q{i}: {ev[:300]!r}" for i, ev in model_flags)
            + "\n\nAdvisory only — worth reading the transcript, but a model's own "
              "report is not evidence that can be relied on either way.")
        flag("grading model reported a suspected injection attempt (advisory)")

    # How several questions combine into one score (instructor knob, default mean).
    #   mean       - the obvious average
    #   min        - the weakest answer decides; for a course where every question
    #                is a competency that must be demonstrated
    #   dropLowest - mean of all but the worst; forgives one bad draw
    scores = [float(p["g"].get("score", 0.0)) for p in per_q]
    # Which question (if any) does not count toward the score. Tracked by INDEX,
    # not just by value, because the student is shown per-question marks and they
    # have to add up to the total they were given — "your best 4 of 5" is only
    # reassuring if the arithmetic on screen matches it.
    dropped_idx = None
    if aggregation == "min":
        content = min(scores)
    elif aggregation == "droplowest" and len(scores) > 1:
        dropped_idx = min(range(len(scores)), key=lambda i: scores[i])
        kept = [x for i, x in enumerate(scores) if i != dropped_idx]
        content = sum(kept) / len(kept)
    else:
        if aggregation not in ("mean", "min", "droplowest"):
            flag(f"unknown scoreAggregation {aggregation!r} in course.json — used mean")
        content = sum(scores) / len(scores)
    total = round(content * max_points, 2)

    # ---- per-assignment score adjustment (instructor remedy) -----------------
    # `scoreBonus` adds POINTS to every submission for one assignment. It exists
    # for the case an instructor actually has: something went wrong on OUR side —
    # a bad question, a grader swapped mid-term, an outage — and the fair remedy
    # is to give the whole cohort back a mark or two rather than to re-grade a
    # hundred recordings by hand.
    #
    # Deliberately uniform and deliberately visible. Uniform, because a remedy
    # that lands differently on different students re-creates the unfairness it
    # is meant to repair. Visible, because a student who sees 8.5 where the
    # feedback justifies 7 should be told why, and an instructor defending the
    # grade later needs it on the record.
    #
    # It is applied AFTER aggregation, so it is a flat adjustment to the final
    # mark and not a thumb on any individual question.
    bonus = float(knob(course, acfg, "scoreBonus", 0) or 0)
    if bonus:
        before = total
        cap = max_points if not knob(course, acfg, "scoreBonusAllowOverMax", False) else None
        total = round(before + bonus, 2)
        if cap is not None:
            total = min(total, cap)
        reason = str(knob(course, acfg, "scoreBonusReason", "") or "").strip()
        add("Score adjustment (instructor only)", True,
            f"scoreBonus {bonus:+g} applied to this assignment: {before} -> {total}"
            + (f" (capped at maxPoints {max_points})" if cap is not None and before + bonus > cap else "")
            + (f"\n\nReason on record: {reason}" if reason else
               "\n\nNo scoreBonusReason set in course.json. Set one — a bonus with no recorded "
               "reason is indefensible six weeks later."))
        add("Adjustment applied to this assignment", True, visible=True,
            out=(f"Your instructor applied a {bonus:+g} point adjustment to everyone's score on "
                 "this assignment.")
                + (f"\n\nReason: {reason}" if reason else "")
                + "\n\nThis is already included in the score shown.")
    # ---- late submission policy (gradingPolicy.late) -------------------------
    # Applied LAST, after aggregation and after any instructor remedy: a
    # scoreBonus is meant to repair the mark a student earned, so the lateness
    # deduction has to come off the repaired figure, not be repaired away.
    #
    # The due date used is the most specific one available (see
    # latepolicy.effective_due): an instructor-recorded extension first, then a
    # per-user date if the metadata carries one, then this submission's own
    # assignment due date. Only the last of those might be assignment-wide, and
    # a penalty computed from it is flagged for review — a student who was
    # GRANTED an extension must not be silently penalised for using it.
    # gradingPolicy sits at the TOP LEVEL of course.json, not inside `defaults`:
    # `defaults` holds per-question knobs (timing, question count), and a course
    # policy is a different kind of thing. An assignment may still override it,
    # for the week where the rule genuinely differs.
    late_policy = ((acfg.get("gradingPolicy") or course.get("gradingPolicy") or {}) or {}).get("late")
    late_sec = latepolicy.lateness_seconds(gs_submitted_at, gs_due_at)
    total, late_detail = latepolicy.apply_late_policy(total, max_points, late_sec, late_policy)

    if late_detail.get("warning"):
        flag(f"gradingPolicy.late: {late_detail['warning']}")
        add("Late policy (instructor only)", False,
            f"{late_detail['warning']}\n\nEverything was graded with NO late penalty. Fix the "
            f"policy in course.json — a misconfigured policy silently grading everything is the "
            f"safe failure, but it is still not what you asked for.")

    if late_detail.get("applied"):
        hrs = (late_detail["lateSec"] or 0) / 3600.0
        seen = latepolicy.find_due_dates(gs_meta_full)
        provenance = dict(latepolicy.DUE_SOURCES).get(gs_due_source, gs_due_source)
        caveat = ("" if gs_due_authoritative else
                  "\n⚠️ CHECK BEFORE FINALISING: this date came from the assignment's own "
                  "metadata, which may or may not carry a per-student extension. If this student "
                  "was GRANTED an extension, the deduction is wrong — override the score in "
                  "Gradescope. If this recurs, the metadata is not carrying the per-student "
                  "date the way it was measured to — worth re-running tools/metadata-probe.\n")
        add("Late submission (instructor only)", False,
            f"Submitted {hrs:.1f}h after the due date — {late_detail['reason']}.\n"
            f"Deducted {late_detail['deducted']:g} of {max_points:g} points.\n\n"
            f"Due:       {gs_due_at}\n"
            f"Submitted: {gs_submitted_at}\n"
            f"Source:    {provenance}\n"
            + caveat
            + "\nEvery date field this submission's metadata carried — compare them against an "
              "extension you have actually granted, and you will know once and for all whether "
              "Gradescope passes extensions through to the autograder:\n"
            + ("\n".join(f"  {k} = {v}" for k, v in sorted(seen.items()))
               or "  (none — the metadata carried no dates at all)"))
        add("Late submission", True, visible=True,
            out=f"This was submitted after the due date, so the late policy for this course was "
                f"applied: {late_detail['deducted']:g} of {max_points:g} points were deducted "
                f"({late_detail['reason']}).\n\n"
                f"If you had an approved extension, or you believe the due date shown in "
                f"Gradescope is wrong, contact your instructor — this deduction is automatic and "
                f"they can override it.")
        if not gs_due_authoritative:
            flag("late penalty applied from an assignment-level due date — confirm this student "
                 "did not have an extension before finalising")
    elif late_sec is not None and late_sec > 0:
        # Late but unpenalised (grace window, or no policy). Instructor-only:
        # telling an on-time-enough student they were "late" invites worry over
        # nothing.
        add("Late submission (instructor only)", True,
            f"Submitted {(late_sec / 3600.0):.1f}h after the due date. No deduction — "
            f"{late_detail['reason']}.")

    backends = sorted({p["g"].get("backend", "unknown") for p in per_q})
    notes = [p["g"]["genaiNote"] for p in per_q if p["g"].get("genaiNote")]
    retry_log = per_q[0]["g"].get("graderLog") if per_q else None
    if retry_log:
        # Not necessarily an error — a retry that succeeded did its job. But this
        # is where a grading-method drift shows up first, and a submission graded
        # by a different method than its neighbours is the unfairness worth
        # catching early.
        #
        # Deliberately verbose and machine-greppable ([diag]/[req]/[rungN]/
        # [result]): across a cohort the useful question is "how often did the
        # first ask fail", which is unanswerable unless the SUCCESSFUL requests
        # are logged too. It carries no student data — model reply values are
        # redacted to "<str:N>" and non-JSON replies are described, never echoed —
        # so this stays safe to paste into an issue.
        add("Grader log (instructor only)", True,
            f"Requested backend: {grading_backend}\n\n"
            + "\n".join("  " + l for l in retry_log)
            + "\n\nIf this shows up across many submissions: for GenAI retries, raise the "
              "Gradescope timeout and stagger the regrade; for local-model failures, check the "
              "container size and the build log.")
        if any("heuristic" in l for l in retry_log):
            flag("fell back to the keyword heuristic — this submission was graded by a WEAKER "
                 "method than its neighbours; check it by hand")

    # Calibration, if any was applied. Shown so a mark is traceable to how it was
    # produced rather than merely asserted.
    cal_rows = [(i, p["g"]) for i, p in enumerate(per_q, 1) if p["g"].get("calibration")]
    if cal_rows:
        c0 = cal_rows[0][1]["calibration"]
        add("Score calibration (instructor only)", True,
            f"Applied to this grader: score' = {c0['scale']} x raw + {c0['shift']}, clamped to "
            f"[0,1] (fitted {c0.get('fittedAt') or 'date unknown'}).\n\n"
            + "\n".join(f"  Q{i}: raw {g.get('rawScore'):.3f} -> {g.get('score'):.3f}"
                         for i, g in cal_rows)
            + "\n\nThis is a monotone affine map, so it can move a mark but can never reorder "
              "two answers. Re-fit with tools/calibrate-grader.py.")

    # ---- what the student sees, per question ---------------------------------
    # FOUR LABELLED PARTS, always in this order: the question as it was asked, the
    # words we heard them say, the mark, and why. They were previously run
    # together as prompt-then-feedback, which reads as one paragraph of prose and
    # leaves the two things a student most wants — what did I actually say, and
    # what did that earn — either absent or buried. A mark a student cannot trace
    # back to their own words is not something they can learn from or dispute.
    # A note the instructor wants under EVERY question's feedback (INV-USE-7) —
    # typically how the scale reads, so a student at 0.92 knows that is a
    # complete answer and not a near miss. Plain text from course.json, never
    # model output, so it says the same thing to every student; anything that
    # is not a non-empty string is ignored rather than printed.
    footer = knob(course, acfg, "feedbackFooter", None)
    footer = footer.strip() if isinstance(footer, str) else ""

    def question_block(p, points_line):
        return _question_block(p, points_line) + ("\n\n" + footer if footer else "")

    def _question_block(p, points_line):
        parts = [f"QUESTION\n{p['q'].get('prompt', '')}"]
        # Only if the instructor shows transcripts at all (showTranscript). And
        # only called YOUR ANSWER when it really is this question's answer: with
        # no word timestamps every question is graded against the whole recording
        # (see segment_transcript), and labelling that "your answer to Q3" would
        # be a claim the evidence does not support.
        if show_transcript:
            said = (p.get("text") or "").strip()
            if not said:
                parts.append("YOUR ANSWER (automatic transcript)\n"
                             "Nothing was heard while this question was on screen.")
            elif positional:
                parts.append(f"YOUR ANSWER (automatic transcript, {p['words']} words)\n{said}")
            else:
                parts.append("YOUR WHOLE RECORDING (automatic transcript)\n"
                             "Your answers could not be separated by question, so this question "
                             "was graded against everything you said:\n" + said)
        parts.append(points_line)
        parts.append(f"FEEDBACK\n{p['g'].get('feedback', 'Graded.')}")
        # POINTS MODE (INV-GRADE-10, instructor 2026-09-12): the student gets the
        # narrative FEEDBACK above and nothing else — no point list, no verdicts, no
        # arithmetic. A rubric laid out under the mark reads as a hidden answer key
        # to be guessed at; the narrative already says what was right, what to
        # revisit and what would have deepened the answer. The per-point record
        # stays in the instructor detail, where a dispute is settled.
        if p["g"].get("points"):
            return "\n\n".join(parts)
        # WHAT WOULD HAVE MADE IT STRONGER (INV-GRADE-9).
        #
        # The OPTIONAL points the student did not make. Deliberately its own
        # labelled section, after the mark and phrased as an opportunity, because
        # it is not a list of errors — an answer can be complete, correct and
        # top-of-the-required-band and still have every one of these unsaid.
        # Folding them into FEEDBACK would read as "here is what you got wrong",
        # which is both false and the fastest way to teach a student to pad.
        #
        # It is shown on EVERY answer, including full marks. That is the point:
        # the course wants students to explain what they mean and to be
        # comprehensive the way real work demands, so the student who scored well
        # is exactly the one who benefits from seeing how much further the answer
        # could have gone.
        stronger = [str(x) for x in (p["g"].get("strongerIf") or []) if str(x).strip()]
        if stronger:
            parts.append(
                "WHAT WOULD HAVE MADE THIS ANSWER STRONGER\n"
                "These were not required — you were not marked down for leaving them out. They "
                "are what would have shown a deeper understanding of the question:\n"
                + "\n".join("  - " + x for x in stronger))
        return "\n\n".join(parts)

    if n_q == 1:
        add("Feedback on your explanation", True, visible=True,
            out=question_block(per_q[0], f"POINTS\n{total} out of {max_points}"),
            score=total, mx=max_points)
    else:
        # Points per COUNTED question, so the visible marks sum to the total.
        n_counted = n_q - 1 if dropped_idx is not None else n_q
        per_max = round(max_points / n_counted, 2)
        for i, p in enumerate(per_q, 1):
            if dropped_idx is not None and i - 1 == dropped_idx:
                # Feedback still shown in full — it is the most useful feedback the
                # student gets, precisely because it is their weakest answer. It
                # simply does not count.
                #
                # The MARK is shown too, on the same scale as the counted questions
                # above so it can be compared with them, and labelled hard as not
                # counting. Withholding it left the student unable to tell a near
                # miss from a blank: both read as "dropped", and the feedback they
                # were being pointed at is exactly the feedback they had no way to
                # calibrate. `add(..., score=)` is deliberately NOT passed, so this
                # number is text and never reaches Gradescope's arithmetic.
                would = round(float(p["g"].get("score", 0.0)) * per_max, 2)
                add(f"Question {i} of {n_q} — {p['q'].get('topic', '')} (DROPPED, does not count)",
                    True, visible=True,
                    out=question_block(
                        p, f"POINTS\nNot counted — this was your lowest-scoring answer, so it was "
                           f"dropped from your score.\n\nFor comparison only, it was graded "
                           f"{would} out of {per_max}, the same scale as the questions that did "
                           f"count. That figure is NOT part of your total and nothing above or "
                           f"below includes it.")
                        + "\n\nThe feedback is here anyway — it is probably the most useful "
                          "feedback on this attempt, precisely because it is your weakest answer.")
            else:
                pts = round(float(p["g"].get("score", 0.0)) * per_max, 2)
                add(f"Question {i} of {n_q} — {p['q'].get('topic', '')}", True, visible=True,
                    out=question_block(p, f"POINTS\n{pts} out of {per_max}"),
                    score=pts, mx=per_max)

        # The heading names the rule, because the rule is the thing a student is
        # most likely to get wrong about their own grade. "Overall" next to a
        # number that is not the average of the marks above reads as an error.
        counted = [f"Q{i + 1}" for i in range(n_q) if i != dropped_idx]
        title, how = {
            "min": (f"Overall Score (lowest answer decides)",
                    f"Your score is your WEAKEST answer of the {n_q} — every question has to "
                    f"stand on its own."),
            "droplowest": (f"Overall Score (drop lowest)",
                           f"Your score is the average of your best {n_counted} of {n_q} answers, "
                           f"NOT the average of all {n_q}.\n\n"
                           + (f"Counted: {', '.join(counted)}. Dropped: Q{dropped_idx + 1}, your "
                              f"lowest-scoring answer.\n\n" if dropped_idx is not None else "")
                           + f"Each counted question is worth {per_max} of the {max_points}, and "
                             f"the marks on the {n_counted} counted questions above add up to this "
                             f"total. Dropping one means a single unlucky draw or one bad moment "
                             f"does not decide your grade."),
        }.get(aggregation,
              (f"Overall Score (average of all {n_q})",
               f"Your score is the average across all {n_q} questions — every question counts. "
               f"Each is worth {per_max} of the {max_points}, and the marks above add up to this "
               f"total."))
        add(title, True, visible=True, out=how, score=total, mx=max_points)

    # Instructor-facing: which grader, plus anything it said on the way.
    detail = (f"questions: {n_q}\nbackends: {', '.join(backends)}\n"
              f"per-question: {', '.join(f'{x:.3f}' for x in scores)}\n"
              + (f"dropped Q{dropped_idx + 1} ({scores[dropped_idx]:.3f})\n"
                 if dropped_idx is not None else "")
              + f"{aggregation} -> {content:.3f} -> {total}/{max_points}")
    if not positional and n_q > 1:
        detail += ("\n\n⚠ No word timestamps, so each question was graded against the WHOLE "
                   "transcript — answers cannot be attributed to their question. Check the "
                   "transcription backend: this inflates multi-question scores.")
    for note in notes:
        detail += f"\nNOTE: {note}"
    for i, p in enumerate(per_q, 1):
        detail += (f"\n\n--- Q{i} {p['q'].get('id', '')} ({p['words']} words heard) "
                   f"score {float(p['g'].get('score', 0.0)):.3f}\n"
                   + "covered:\n" + "\n".join("  + " + c for c in p["g"].get("covered", []))
                   + "\nmissed:\n" + "\n".join("  - " + m for m in p["g"].get("missed", [])))
        if p["g"].get("points"):
            detail += "\n" + pointscore.instructor_text(p["g"]["points"])
    add("Grading detail (instructor only)", True, detail)

    topics = ", ".join(f"{q.get('topic', '')} ({q.get('id', '')})" for q in questions)
    heard = f"{len(bounds) - len(missing)}/{len(bounds)} codes heard"
    if shadow:
        # INV-CODE-4: scored 0, but the grading is kept for the instructor. Each
        # graded item becomes instructor-only and loses its score, so nothing the
        # student sees and nothing Gradescope adds up includes it.
        for t in tests[graded_from:]:
            if t.get("visibility") == "visible":
                t["visibility"] = "hidden"
                t["name"] = "NOT COUNTED (scored 0) \u2014 " + t["name"]
                t.pop("score", None)
                t.pop("max_score", None)
        add("Would-have-been score (instructor only)", False,
            f"{total} out of {max_points}\n\n"
            "This is what the answers earned, with every course policy (aggregation, late "
            "policy, adjustments) applied. It was NOT given: the submission scored 0 because "
            + ("it failed validation (see \u2691 REVIEW at the top)" if not integrity_ok else
               f"only {n_heard} of {len(bounds)} spoken codes were heard")
            + ". The per-question feedback is kept above, marked NOT COUNTED.\n\n"
            + ("CAUTION: the grading model flagged a prompt-injection attempt in this answer, so "
               "this figure may itself have been manipulated. Read the transcript before using "
               "it.\n\n" if inj["severity"] == "high" else "")
            + "If the failure was benign \u2014 listen to the recording \u2014 override this "
              "submission's score in Gradescope with the figure above.")
        return finish(0,
                      f"{shadow_log} {heard}. {n_q} question(s): {topics}. "
                      f"Would have scored {total}/{max_points} [graded by: {', '.join(backends)}].",
                      student_top=shadow_top)
    if codes_partial:
        return finish(total,
                      f"Integrity: PASSED except spoken codes ({heard}); graded and flagged. "
                      f"{n_q} question(s): {topics}. "
                      f"Score: {total}/{max_points} [graded by: {', '.join(backends)}].",
                      student_top=f"Score: {total}/{max_points}. Not every spoken code was heard, so "
                                  f"this attempt is flagged for instructor review, which MAY AFFECT "
                                  f"YOUR FINAL GRADE. We encourage you to record a fresh attempt. "
                                  f"Gradescope grades your MOST RECENT upload, so if a retake scores "
                                  f"lower, re-activate the attempt you want from Submission History.")
    return finish(total,
                  f"Integrity: PASSED. {n_q} question(s): {topics}. "
                  f"Score: {total}/{max_points} [graded by: {', '.join(backends)}].",
                  student_top=f"Score: {total}/{max_points}. See the feedback below. "
                              f"You can retake for a fresh question. Gradescope grades your MOST "
                              f"RECENT upload, so if a retake scores lower than this one, "
                              f"re-activate this attempt from Submission History.")


if __name__ == "__main__":
    try:
        main()
        runtiming.current.emit("PYTHON_MAIN_RETURNED; interpreter cleanup follows")
    except BaseException as exc:
        runtiming.current.emit("PYTHON_FAILED exception_type=" + type(exc).__name__)
        raise
