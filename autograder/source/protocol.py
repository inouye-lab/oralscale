"""OralScale token verification (Python side).

Mirrors server/lib/protocol.js exactly:

    token = b64url(payloadUtf8Json) + "." + b64url(HMAC_SHA256(secret, payloadUtf8Json))

We verify over the EXACT decoded payload bytes and only then json.loads, so JS
and Python never disagree on serialization.
"""
import base64
import hashlib
import hmac
import json
import re


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def sign_token(secret: str, payload: dict) -> str:
    """Mirror protocol.js signToken exactly (compact, url-safe, unpadded)."""
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    return _b64url_encode(payload_bytes) + "." + _b64url_encode(sig)


def verify_token(secret: str, token: str) -> dict:
    """Return the parsed payload, or raise ValueError on any failure."""
    if not isinstance(token, str) or "." not in token:
        raise ValueError("malformed token")
    payload_part, sig_part = token.split(".", 1)
    payload_bytes = _b64url_decode(payload_part)
    expected = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    given = _b64url_decode(sig_part)
    if not hmac.compare_digest(expected, given):
        raise ValueError("bad signature")
    return json.loads(payload_bytes.decode("utf-8"))


NONCE_WORDS = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
    "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
    "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey",
    "xray", "yankee", "zulu",
]


def derive_nonce(secret: str, attempt_id: str, k: int, n_words: int = 2) -> str:
    """Reproduce the Signer's k-th rolling nonce EXACTLY (see protocol.js deriveNonce).

    nonce_k = words( HMAC(secret, f"{attempt_id}:{k}") ). Must match JS byte-for-byte.
    """
    dig = hmac.new(secret.encode("utf-8"),
                   f"{attempt_id}:{k}".encode("utf-8"), hashlib.sha256).digest()
    parts = []
    for i in range(n_words):
        parts.append(NONCE_WORDS[dig[i * 2] % 26])
        parts.append(str(dig[i * 2 + 1] % 10))
    return "-".join(parts)


def sha256_hex_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_hex_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Identity (v3) — mirrors server/lib/protocol.js exactly. See that file for the
# full rationale; the short version:
#
#   "e:<32 hex>"       emailRef  = HMAC(pseudonym_salt, email), computed in the
#                      BROWSER so no plaintext email reaches the Signer. The salt
#                      is public, so this is pseudonymization, not anonymization.
#   "p:XXXX-XXXX-XXXX" pseudonym = HMAC(SECRET, "pseudonym:"+email), minted here
#                      inside the FERPA boundary. Not brute-forceable.
#
# The autograder re-derives BOTH from the Gradescope-authenticated email and
# accepts a certificate whose studentRef matches either (INV-SEC-2).
# ---------------------------------------------------------------------------

PSEUDONYM_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def normalize_email(email: str) -> str:
    """Must match protocol.js normalizeEmail or the refs will not agree."""
    return (email or "").strip().lower()


def student_ref_from_email(pseudonym_salt: str, email: str) -> str:
    dig = hmac.new(str(pseudonym_salt).encode("utf-8"),
                   normalize_email(email).encode("utf-8"), hashlib.sha256).hexdigest()
    return "e:" + dig[:32]


def pseudonym_for_email(secret: str, email: str) -> str:
    dig = hmac.new(secret.encode("utf-8"),
                   ("pseudonym:" + normalize_email(email)).encode("utf-8"),
                   hashlib.sha256).digest()
    out = "".join(PSEUDONYM_ALPHABET[dig[i] % 32] for i in range(12))
    return "p:" + out[0:4] + "-" + out[4:8] + "-" + out[8:12]


def student_ref_matches(secret: str, pseudonym_salt: str, cert_ref: str, email: str,
                        course_id: str = "", epoch: int = 1) -> bool:
    """True if `cert_ref` is any accepted identity form for `email`.

    Four forms, all re-derived here from the Gradescope-authenticated address:
      k:<sid>  key-only (the default) — the Signer derived it from the quiz key
      e:<hex>  browser-hashed email, for courses running without keys
      p:XXXX…  the private-code opt-out
      email    legacy accommodation links, which the Signer itself minted

    Constant-time comparisons: cert_ref is attacker-supplied.
    """
    ref = (cert_ref or "").strip()
    candidates = [student_ref_from_email(pseudonym_salt, email),
                  pseudonym_for_email(secret, email),
                  normalize_email(email)]
    if course_id:
        candidates.insert(0, student_ref_for_email(secret, course_id, email, epoch))
    return any(hmac.compare_digest(ref.lower(), c.lower()) for c in candidates)


# ---------------------------------------------------------------------------
# Bookend challenge codes (v4) — mirrors server/lib/protocol.js exactly.
#
#   OPENING code, spoken before the answer  -> content postdates the reveal
#   CLOSING code, spoken after "I'm done"   -> the recording ran to the end
#
# Digits rather than NATO words: every ASR engine transcribes digits reliably.
# The verifier re-derives the expected code, so there is nothing to error-CORRECT
# — what is needed is a TOLERANCE for one transcription slip, which is exactly
# what Damerau-Levenshtein distance <= 1 gives (drop / add / substitute / swap).
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# CODE_DIGITS — how many digits a Student reads aloud at each boundary.
#
# FOUR, reduced from six on 2026-08-24. Must match server/lib/protocol.js.
#
# THREE DOES NOT HOLD. `code_spoken_in` allows one Damerau-Levenshtein edit and
# slides windows of length L-1..L+1, so a 3-digit code is accepted by ANY TWO of
# its three digits appearing in order. Measured false-accept against digits that
# merely occur in a student's answer: 26.7% with ten digits of noise in the
# window, 49.3% with twenty. In a course where students say numbers aloud while
# explaining, that is not a weaker check but no check.
#
# Lowering the tolerance does not rescue it: at tolerance 0 an honest student
# whose transcript drops a digit fails 100% of the time, and that is the exact
# failure the rescue pass (INV-INTEGRITY-9) exists to catch. Length is the only
# lever. The floor is 4; the reasoning is in full in protocol.js.
# ---------------------------------------------------------------------------
CODE_DIGITS = 4

# ---------------------------------------------------------------------------
# Extended-time accommodations (INV-ACCOM-1).
#
# Must stay byte-compatible with server/lib/protocol.js. Gradescope is the
# system of record for extended time but does not expose it to an autograder
# (submission_metadata.json has no accommodation or extension field, and there
# is no public API), so the Student SELECTS a multiplier and it is VERIFIED
# here against the Instructor's roster. A claim is a claim, never an
# authorisation.
# ---------------------------------------------------------------------------

TIME_MULTIPLIERS = [1, 1.25, 1.5, 1.75, 2]
MAX_TIME_MULTIPLIER = 2


def normalize_time_multiplier(value):
    """One of the allowed rungs, or None for anything else.

    None must be REJECTED by the caller, never quietly treated as 1.0 -- giving
    a student less time than they asked for without saying so is worse than
    refusing the request outright.
    """
    if value is None or value == "":
        return 1
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    for m in TIME_MULTIPLIERS:
        if abs(m - v) < 1e-9:
            return m
    return None


def within_granted_time(segments, base_limit_sec, base_buffer_sec, granted_multiplier):
    """Did the attempt stay inside what the GRANTED multiplier would have allowed?

    This is the fairness rule. A Student who selects 2x but answers within the
    1.5x they were actually granted took nothing they were not entitled to, so
    there is nothing for the Instructor to review. Only claiming more AND using
    more is worth a flag.

    The granted buffer is included, so a student is never faulted for the
    "finish your sentence" slack they were legitimately given.
    """
    allowed = (base_limit_sec * granted_multiplier) + (base_buffer_sec * granted_multiplier)
    over = []
    for s in (segments or []):
        try:
            used = float(s.get("answerSec"))
        except (TypeError, ValueError):
            continue
        if used > allowed + 0.5:
            over.append({"questionId": s.get("questionId"), "usedSec": round(used, 1)})
    return {"ok": not over, "allowedSec": round(allowed, 1), "over": over}

_DIGIT_WORDS = {"zero": "0", "oh": "0", "one": "1", "two": "2", "three": "3",
                "four": "4", "five": "5", "six": "6", "seven": "7",
                "eight": "8", "nine": "9"}


def derive_code(secret: str, attempt_id: str, phase: str, n_digits: int = CODE_DIGITS) -> str:
    """phase is "open" or "close". Must match protocol.js deriveCode byte-for-byte."""
    dig = hmac.new(secret.encode("utf-8"),
                   f"{attempt_id}:{phase}".encode("utf-8"), hashlib.sha256).digest()
    return "".join(str(dig[i] % 10) for i in range(n_digits))


def code_lead_default(code_digits: int = CODE_DIGITS) -> int:
    """Seconds allowed to read ONE boundary code aloud — one second per digit.

    Mirrors codeLeadDefault() in server/lib/protocol.js. Only used here as a
    fallback for certificates that predate the field; the Signer stamps the real
    value into every Certificate it issues.
    """
    n = int(code_digits or CODE_DIGITS)
    return min(8, max(4, n))


def tail_limit_default(code_digits: int = CODE_DIGITS) -> int:
    """Seconds between the FINAL code and /finish — double the lead.

    Mirrors tailLimitDefault() in server/lib/protocol.js.
    """
    return 2 * code_lead_default(code_digits)


def speak_code(code: str) -> str:
    return " ".join(str(code))


def damerau_levenshtein(a: str, b: str) -> int:
    a, b = str(a), str(b)
    m, n = len(a), len(b)
    d = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        d[i][0] = i
    for j in range(n + 1):
        d[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)  # transposition
    return d[m][n]


def digits_only(text: str) -> str:
    """Collapse spoken text to bare digits: "four seven one" -> "471"."""
    out = []
    for tok in re.split(r"[^a-zA-Z0-9]+", (text or "").lower()):
        if not tok:
            continue
        if tok.isdigit():
            out.append(tok)
        elif tok in _DIGIT_WORDS:
            out.append(_DIGIT_WORDS[tok])
    return "".join(out)


def code_spoken_in(text: str, code: str, tolerance: int = 1) -> bool:
    """True if `code` appears in `text` allowing one transcription slip."""
    hay = digits_only(text)
    if not hay:
        return False
    L = len(str(code))
    for w in range(max(1, L - tolerance), L + tolerance + 1):
        for i in range(0, len(hay) - w + 1):
            if damerau_levenshtein(hay[i:i + w], code) <= tolerance:
                return True
    return False


# ---------------------------------------------------------------------------
# Segment boundary codes (v6) — the bookend generalised to N questions.
#
# A recording of N questions has N+1 boundaries:
#
#     b0 ─ Q1 ─ b1 ─ Q2 ─ b2 ─ … ─ Q(N) ─ bN
#
# and every interior code does double duty: it closes the answer just given and
# opens the next question. The student reads six digits once per boundary, and
# each code is issued only at the moment it is needed, so it is still evidence
# that the recording was live at that point in its timeline.
#
# For N = 1 the phases are "open" and "close" — byte-identical to v4, so old
# certificates verify unchanged.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# CLIENT SPLIT MARKS (INV-GRADE-8) — the audio's own clock.
#
# The certificate's per-question offsets are measured from the moment the Signer
# answered /reveal. The recording started earlier — microphone permission, stream
# setup, a round trip — so the same instant sits a second or two apart in the two
# clocks, by a margin that varies per student and per network. The boundary-code
# windows are +/-15 s wide and absorb it. Cutting the audio into per-question
# pieces does not.
#
# So the browser also reports what only it can see, measured from the first byte
# of audio, and the Signer signs it into the certificate.
#
# SIGNED IS NOT TRUSTED, and nothing here may be used to decide whether an attempt
# is genuine. The boundary windows, the deadline and the duration check all run on
# server timestamps that the browser cannot influence. These marks answer a
# different question — "where in this file is the answer to question 3?" — for a
# human who has to listen, which is exactly the situation when a code is missing
# and the automatic split cannot be relied on. Mirrors clientSegmentsFromMarks in
# server/lib/protocol.js.
# ---------------------------------------------------------------------------
MARK_EVENTS = ("recordingStart", "code", "question", "done", "deadline", "finish")


def client_marks(cert) -> list:
    """The certificate's client marks, or [] — shape-checked, never trusted."""
    raw = (cert or {}).get("clientMarks")
    if not isinstance(raw, list):
        return []
    out = []
    for m in raw:
        if not isinstance(m, dict) or m.get("event") not in MARK_EVENTS:
            continue
        try:
            at = float(m.get("atSec"))
        except (TypeError, ValueError):
            continue
        if not (0 <= at <= 86400):
            continue
        row = {"event": m["event"], "atSec": at}
        idx = m.get("index")
        if isinstance(idx, int) and 0 <= idx <= 999:
            row["index"] = idx
        out.append(row)
    return out


def client_segments_from_marks(marks, question_count):
    """Per-question [startSec, endSec] on the AUDIO clock. [] when unavailable.

    `endSec` is the "I'm done" tap (or the deadline firing), which is also the
    instant that question's closing code appeared — so it doubles as where that
    code should be heard. A question with no `question` mark is omitted rather
    than guessed at: a wrong split is worse than a missing one.
    """
    if not marks:
        return []
    starts, ends, codes = {}, {}, {}
    for m in marks:
        i = m.get("index")
        if i is None:
            continue
        if m["event"] == "question":
            starts.setdefault(i, m["atSec"])
        elif m["event"] in ("done", "deadline"):
            ends.setdefault(i, m["atSec"])
        elif m["event"] == "code":
            codes.setdefault(i, m["atSec"])
    rows = []
    for i in range(max(1, int(question_count or 1))):
        if i not in starts:
            continue
        end = ends.get(i, codes.get(i + 1))
        rows.append({"index": i, "startSec": starts[i], "endSec": end,
                     "answerSec": None if end is None else round(end - starts[i], 3)})
    return rows


def boundary_phase(k: int, question_count: int) -> str:
    if k <= 0:
        return "open"
    if k >= question_count:
        return "close"
    return "b%d" % k


def derive_boundary_code(secret: str, attempt_id: str, k: int, question_count: int,
                         n_digits: int = CODE_DIGITS) -> str:
    return derive_code(secret, attempt_id, boundary_phase(k, question_count), n_digits)


# ---------------------------------------------------------------------------
# Access keys (v6) — mirrors server/lib/protocol.js exactly.
#
# The key is SELF-AUTHENTICATING and doubles as the Student's identity:
#
#     key = sid ‖ tag
#     sid = base32( HMAC(Secret, "sid:v1:"‖courseId‖":"‖epoch‖":"‖email) )[0..5]
#     tag = base32( HMAC(Secret, "ktag:v1:"‖courseId‖":"‖sid) )[0..9]
#
# The Signer verifies enrolment by recomputing `tag`, so there is no roster at the
# edge, and it derives `studentRef = "k:"+sid` from the key — which is why the
# Student types no email and nothing derived from one is ever transmitted.
#
# THIS side closes the loop: from the Gradescope-authenticated email we recompute
# the same `k:<sid>` and require the Certificate to carry it (INV-SEC-2), and we
# can hand a student their own key back if they lose it — all without anyone
# storing a table of credentials anywhere.
# ---------------------------------------------------------------------------

SID_CHARS = 6
TAG_CHARS = 10
ACCESS_KEY_CHARS = SID_CHARS + TAG_CHARS


def _b32(digest: bytes, n: int) -> str:
    return "".join(PSEUDONYM_ALPHABET[digest[i] % 32] for i in range(n))


def _group_key(raw: str) -> str:
    return "-".join(raw[i:i + 4] for i in range(0, len(raw), 4))


def student_id_for(secret: str, course_id: str, email: str, epoch: int = 1) -> str:
    dig = hmac.new(secret.encode("utf-8"),
                   ("sid:v1:%s:%s:%s" % (course_id, epoch, normalize_email(email))).encode("utf-8"),
                   hashlib.sha256).digest()
    return _b32(dig, SID_CHARS)


def access_key_tag(secret: str, course_id: str, sid: str) -> str:
    dig = hmac.new(secret.encode("utf-8"),
                   ("ktag:v1:%s:%s" % (course_id, sid)).encode("utf-8"),
                   hashlib.sha256).digest()
    return _b32(dig, TAG_CHARS)


def access_key_for(secret: str, course_id: str, email: str, epoch: int = 1) -> str:
    sid = student_id_for(secret, course_id, email, epoch)
    return _group_key(sid + access_key_tag(secret, course_id, sid))


def student_ref_for_email(secret: str, course_id: str, email: str, epoch: int = 1) -> str:
    """The `k:<sid>` a key-mode Certificate must carry for this student."""
    return "k:" + student_id_for(secret, course_id, email, epoch)


def normalize_access_key(raw: str):
    """Accept a key typed with spaces, lowercase, or missing dashes.

    Folds the glyphs the alphabet deliberately excludes (O/0, I/L/1, U/V) —
    students retype these from a Brightspace announcement.
    """
    s = re.sub(r"[^0-9A-Z]", "", (raw or "").upper())
    s = s.replace("O", "0").replace("I", "1").replace("L", "1").replace("U", "V")
    if len(s) != ACCESS_KEY_CHARS:
        return None
    return _group_key(s)


def verify_access_key(secret: str, course_id: str, given: str):
    """(ok, student_ref) — verified by recomputing the key's own MAC. No lookup."""
    norm = normalize_access_key(given)
    if not norm:
        return False, None
    raw = norm.replace("-", "")
    sid = raw[:SID_CHARS]
    ok = hmac.compare_digest(access_key_tag(secret, course_id, sid), raw[SID_CHARS:])
    return ok, ("k:" + sid if ok else None)
