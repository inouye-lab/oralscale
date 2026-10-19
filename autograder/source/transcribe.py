"""Pluggable speech-to-text returning (text, words).

`words` is a list of {"word": str, "start": float, "end": float} or None when
positions are unavailable. Positions let us verify WHERE the boundary codes fall
(INV-INTEGRITY-4/5); without them we fall back to presence-only.

Resolution order (first available wins):
  1. `words.json` / `transcript.txt` sidecar — ONLY if ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR=1.
  2. faster-whisper / openai-whisper if installed — local, private, WITH word timestamps.
  3. none -> ("", None), caller flags for manual review.

Local Whisper keeps audio inside the Gradescope container (INV-PRIV-3).

SECURITY (INV-INTEGRITY-8): the sidecars live in the SUBMISSION directory, which is
student-controlled — it is literally the .zip they uploaded. Honouring them in
production would let a student ship a fabricated transcript that satisfies the spoken
codes and the rubric while the real audio is never transcribed at all. They are
therefore gated behind ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR=1, which the test harnesses
set and a Gradescope container must NEVER set. Inside the flag the sidecar deliberately
wins, so the suite stays deterministic on synthetic audio and does not require a Whisper
install; with the flag unset — i.e. always, in production — the submission's own files are
never read at all.

WHY THE DECODE OPTIONS BELOW ARE NOT WHISPER'S DEFAULTS (INV-INTEGRITY-9)
------------------------------------------------------------------------
A live attempt (2026-08-21) failed integrity because the final spoken code was
"not heard" — yet the audio plainly contained it, and re-running the same file
locally transcribed the closing code and dropped the OPENING one instead. The
codes are the one part of the recording Whisper is worst at: a bare digit string,
a second of silence on either side, no linguistic context to predict it from.
Whisper decodes in 30-second windows and will happily emit a window that skips a
leading or trailing run it scores as non-speech, so which of the two codes
survives is close to a coin flip. That is a *transcription* failure being
reported to a student as a *compliance* failure, which is the worst possible
confusion for a system whose whole claim is that it does not falsely accuse.

Three independent changes, each verified on that recording:

  1. `vad_filter=True` — the single decisive fix. Stripping the silence around
     the digits makes them the start of a speech region instead of a run at the
     ragged edge of a decode window. Every model tested went from 50 % to 100 %
     on both codes. faster-whisper maps timestamps back to the original
     timeline, so the word positions the boundary windows rely on stay valid.
  2. `small` rather than `base` as the default model. `small` recovered both
     codes under *every* option set tried, including the unpatched ones; `base`
     and `tiny` needed VAD, and `distil-small.en` failed the closing code in
     five of six. It is also markedly better on accented and non-native English,
     which is most of the class (decision E2). Belt and braces: the model is the
     reason the fix holds when the options are not enough.
  3. `language="en"` and `condition_on_previous_text=False`. Pinning the
     language removes a per-window language guess that a digit string is
     especially likely to get wrong; dropping the conditioning stops one bad
     window from steering the rest, which is where mid-recording truncation
     comes from.

And a fourth, in `rescue_window()` below: when a code is *still* missing, we go
back to the audio and re-transcribe that boundary's window as short overlapping
chunks. See there.
"""
from __future__ import annotations
import json
import os
import subprocess
import tempfile
import wave

# Default model. `small` int8 needs roughly 1.1 GB of container RAM and runs at
# about 0.25x real time on two cores — comfortably inside a 2 CPU / 3 GB
# Gradescope container, and the reason TEACHER-GUIDE tells instructors to pick
# that size rather than the 0.5 CPU / 0.75 GB default (which cannot even load
# it). Override with ORALSCALE_WHISPER_MODEL: "medium" or "large-v3" are better
# still on heavy accents and want 4 CPU / 6 GB.
DEFAULT_MODEL = "small"

# Options for the MAIN pass over the whole recording. See the module docstring.
MAIN_OPTS = dict(
    language="en",
    vad_filter=True,
    condition_on_previous_text=False,
    beam_size=5,
    word_timestamps=True,
)

# Options for the RESCUE pass over one boundary window. Deliberately different:
# the slice is a handful of seconds that we already believe contains spoken
# digits, so every threshold whose job is to discard "probably not speech" is
# turned off rather than trusted, and VAD is left OFF — on a clip this short it
# can swallow the whole thing. No word timestamps: the caller already knows
# where in the timeline this text came from, because it chose the window.
RESCUE_OPTS = dict(
    language="en",
    condition_on_previous_text=False,
    beam_size=5,
    vad_filter=False,
    no_speech_threshold=1.0,          # never discard a window as non-speech
    compression_ratio_threshold=None,  # a repeated digit is not a hallucination
    log_prob_threshold=None,           # do not re-roll on low confidence
    initial_prompt="The speaker reads a numeric code aloud, one digit at a time.",
)

_MODEL_CACHE = {}


def model_name() -> str:
    return os.environ.get("ORALSCALE_WHISPER_MODEL", DEFAULT_MODEL)


def whisper_available() -> bool:
    """Is a real speech-to-text backend importable in this container?

    Used to distinguish "this student's audio produced no transcript" from
    "this autograder cannot transcribe anything at all", which are very
    different messages to put in front of a student.
    """
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        pass
    try:
        import whisper  # noqa: F401
        return True
    except Exception:
        return False


def sidecars_allowed() -> bool:
    """Student-supplied transcripts are a TEST affordance, never a production one."""
    return os.environ.get("ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR") == "1"


def _read_sidecars(submission_dir: str):
    words_path = os.path.join(submission_dir, "words.json")
    if os.path.exists(words_path):
        with open(words_path, "r", encoding="utf-8") as f:
            words = json.load(f)
        text = " ".join(w.get("word", "") for w in words)
        return text, words, "words-sidecar"

    sidecar = os.path.join(submission_dir, "transcript.txt")
    if os.path.exists(sidecar):
        with open(sidecar, "r", encoding="utf-8", errors="replace") as f:
            return f.read(), None, "transcript-sidecar"
    return None


def _faster_whisper_model():
    """Load (once per process) the faster-whisper model, or return None."""
    name = model_name()
    if name in _MODEL_CACHE:
        return _MODEL_CACHE[name]
    from faster_whisper import WhisperModel  # type: ignore
    threads = int(os.environ.get("ORALSCALE_WHISPER_THREADS", "4") or 4)
    kw = {"device": "cpu", "compute_type": "int8"}
    if threads > 0:
        kw["cpu_threads"] = threads
    m = WhisperModel(name, **kw)
    _MODEL_CACHE[name] = m
    return m


def release():
    """Drop the cached speech model so its memory goes back to the container.

    Transcription — including any rescue pass — is completely finished before
    grading starts, so the two models never need to be resident at the same
    time. Releasing here makes the container's peak `max(whisper, grader)`
    instead of `whisper + grader`, which is the difference between a local
    grading model fitting Gradescope's 6 GB container with real headroom and
    only just fitting it.
    """
    _MODEL_CACHE.clear()
    try:
        import gc
        gc.collect()
    except Exception:
        pass


def transcribe(audio_path: str, submission_dir: str):
    # A sidecar is honoured ONLY behind the explicit test flag. Inside that flag it
    # takes precedence deliberately: the test suite feeds synthetic tones, so it
    # must not depend on Whisper being installed or on model accuracy. Production
    # never sets the flag, so this branch simply does not exist there.
    if sidecars_allowed():
        got = _read_sidecars(submission_dir)
        if got:
            return got

    try:
        model = _faster_whisper_model()
        segments, _ = model.transcribe(audio_path, **MAIN_OPTS)
        words, texts = [], []
        for seg in segments:
            texts.append(seg.text)
            for w in (seg.words or []):
                words.append({"word": w.word.strip(), "start": w.start, "end": w.end})
        return " ".join(texts).strip(), (words or None), "faster-whisper:" + model_name()
    except Exception:
        pass
    try:
        import whisper  # type: ignore
        model = whisper.load_model(model_name())
        r = model.transcribe(audio_path, language="en", word_timestamps=True,
                             condition_on_previous_text=False)
        words = [{"word": w["word"].strip(), "start": w["start"], "end": w["end"]}
                 for seg in r.get("segments", []) for w in seg.get("words", [])]
        return r.get("text", "").strip(), (words or None), "openai-whisper:" + model_name()
    except Exception:
        pass

    return "", None, "none"


# A rescue slice is decoded as SHORT overlapping chunks, not as one clip. That is
# not an optimisation — it is the fix. Whisper drops runs of digits that sit at
# the ragged edge of a decode window, so handing it a 20-second slice with the
# code in the last three seconds reproduces the very failure we are trying to
# undo (observed: a 30–51 s slice of the live-demo recording returned the prose
# and dropped the closing code again, while a 40–60 s slice returned it). Chunks
# short enough that the code is never far from an edge, overlapping enough that
# it lands mid-chunk in at least one of them, removes the dependence on luck.
RESCUE_CHUNK_SEC = 12.0
RESCUE_HOP_SEC = 6.0
RESCUE_MAX_CHUNKS = 12


def _cut(audio_path: str, lo: float, hi: float, dest: str) -> bool:
    """Decode [lo, hi] of the audio to 16 kHz mono WAV. False if that failed."""
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{lo:.3f}", "-to", f"{hi:.3f}",
                        "-i", audio_path, "-ac", "1", "-ar", "16000", dest],
                       check=True, capture_output=True, timeout=120)
        return os.path.getsize(dest) > 1024
    except Exception:
        return False


def rescue_window(audio_path: str, lo: float, hi: float):
    """Re-transcribe ONE boundary window of the audio, for a code we did not hear.

    Returns a LIST of transcripts, one per overlapping chunk of the window, or
    None if nothing could be decoded. A list rather than one joined string on
    purpose: the caller tests each chunk separately, so two adjacent chunks can
    never be spliced into digits that were never spoken as a run.

    Why this exists. The main pass reads the whole recording in 30-second
    windows, and a bare run of digits at the edge of one of those windows is the
    single thing Whisper most reliably drops (see the module docstring). Cutting
    the seconds we already know should contain the code and decoding *that*
    removes the problem at its root: the digits are no longer at an edge, there
    is no surrounding prose the decoder prefers, and the thresholds whose job is
    to discard quiet windows are switched off rather than trusted.

    On the recording that motivated all of this, the main pass at the old
    settings missed the opening code entirely; a rescue chunk over 0–12 s
    returned "Six, five, zero, four, four, two." — the exact code, from the same
    bytes, with nothing new supplied by anyone.

    This is a SECOND OPINION on audio the grader already holds. Nothing here
    comes from the student, so it cannot weaken INV-INTEGRITY-8: the code being
    searched for is still re-derived from the Secret, and the window is still
    taken from the signed Certificate. It can only turn a false "code not heard"
    into a true one — never the reverse.
    """
    try:
        lo = max(0.0, float(lo))
        hi = float(hi)
    except (TypeError, ValueError):
        return None
    if not (hi > lo):
        return None
    # A window wider than a couple of minutes is not a boundary any more, it is
    # the whole answer; chunking all of it would cost more than it can buy.
    hi = min(hi, lo + 120.0)

    starts = [lo]
    if hi - lo > RESCUE_CHUNK_SEC:
        t, starts = lo, []
        while t < hi and len(starts) < RESCUE_MAX_CHUNKS:
            starts.append(t)
            t += RESCUE_HOP_SEC
        # Always include a chunk that ENDS at the window's end, so a code spoken
        # in the last seconds is never left split across two chunk boundaries.
        tail_start = max(lo, hi - RESCUE_CHUNK_SEC)
        if tail_start not in starts:
            starts.append(tail_start)

    try:
        model = _faster_whisper_model()
    except Exception:
        return None

    out = []
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        for start in starts:
            end = min(hi, start + RESCUE_CHUNK_SEC)
            if end - start < 1.0:
                continue
            if not _cut(audio_path, start, end, tmp.name):
                continue
            try:
                segments, _ = model.transcribe(tmp.name, **RESCUE_OPTS)
                text = " ".join(s.text for s in segments).strip()
            except Exception:
                continue
            if text:
                out.append(text)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    return out or None


def audio_duration_sec(audio_path: str, words):
    """True audio duration in seconds, or None.

    Order: container header -> decoded packet timestamps -> last word end.

    The header step usually FAILS here on purpose-built evidence: MediaRecorder
    writes live WebM/Matroska with no duration in the header, which is exactly
    what every honest submission is. Falling straight through to word timestamps
    would understate the length (they stop at the last spoken word), so decode
    the packet timeline before giving up — that is the number INV-INTEGRITY-3
    actually needs to catch an over-long pre-recording.
    """
    def _run(args):
        try:
            out = subprocess.run(args, capture_output=True, text=True, timeout=120)
            return out.stdout.strip()
        except Exception:
            return ""

    # 0) WAV has a stdlib parser. Using it avoids making a valid, simple format
    # depend on the host ffprobe binary (and keeps the package gate useful on a
    # development machine whose ffmpeg linkage is temporarily broken).
    if str(audio_path).lower().endswith('.wav'):
        try:
            with wave.open(audio_path, 'rb') as w:
                rate = w.getframerate()
                if rate:
                    return w.getnframes() / float(rate)
        except (wave.Error, OSError):
            pass

    # 1) container header (cheap; absent on MediaRecorder output)
    v = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
              "-of", "default=noprint_wrappers=1:nokey=1", audio_path])
    try:
        if v and v.upper() != "N/A":
            return float(v)
    except ValueError:
        pass

    # 2) decoded packet timeline (authoritative for live-recorded WebM)
    pts = _run(["ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "packet=pts_time", "-of", "csv=p=0", audio_path])
    if pts:
        for line in reversed(pts.splitlines()):
            line = line.strip().rstrip(",")
            try:
                return float(line)
            except ValueError:
                continue

    # 3) last transcribed word — a floor, not the true length; only used when
    #    ffprobe is unavailable entirely.
    if words:
        try:
            return max(float(w["end"]) for w in words)
        except Exception:
            pass
    return None
