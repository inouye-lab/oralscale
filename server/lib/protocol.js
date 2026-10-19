'use strict';
/*
 * OralScale shared protocol / crypto helpers (Node, standard library only).
 *
 * Token wire format (language-agnostic, no canonical-JSON headaches):
 *
 *     token = base64url(payloadUtf8Json) + "." + base64url(HMAC_SHA256(secret, payloadUtf8Json))
 *
 * Verifiers split on ".", base64url-decode the FIRST part to recover the EXACT
 * bytes that were signed, recompute the HMAC over those bytes, compare in
 * constant time, and only then JSON.parse the payload for reading. Because we
 * never re-serialize before verifying, JS and Python agree bit-for-bit.
 */

const crypto = require('crypto');

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64urlDecodeToBuf(str) {
  return Buffer.from(str, 'base64url');
}

function hmac(secret, dataBuf) {
  return crypto.createHmac('sha256', secret).update(dataBuf).digest();
}

/** Sign an object -> compact token string. */
function signToken(secret, payloadObj) {
  const payloadStr = JSON.stringify(payloadObj);
  const payloadBuf = Buffer.from(payloadStr, 'utf8');
  const sig = hmac(secret, payloadBuf);
  return b64urlEncode(payloadBuf) + '.' + b64urlEncode(sig);
}

/**
 * Verify a token. Returns the parsed payload object.
 * Throws on malformed input or signature mismatch.
 */
function verifyToken(secret, token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) {
    throw new Error('malformed token');
  }
  const [payloadPart, sigPart] = token.split('.');
  const payloadBuf = b64urlDecodeToBuf(payloadPart);
  const expected = hmac(secret, payloadBuf);
  const given = b64urlDecodeToBuf(sigPart);
  if (expected.length !== given.length ||
      !crypto.timingSafeEqual(expected, given)) {
    throw new Error('bad signature');
  }
  return JSON.parse(payloadBuf.toString('utf8'));
}

/**
 * Deterministic, stateless question selection.
 * Same inputs always map to the same question index, so the server need not
 * remember what it served. `attemptSalt` (random per /start) makes retakes differ.
 */
function selectQuestionIndex(secret, { bankId, assignmentId, studentRef, attemptSalt }, n) {
  const material = [bankId, assignmentId, studentRef, attemptSalt].join('␟'); // unit separator
  const digest = crypto.createHmac('sha256', secret).update(material, 'utf8').digest();
  // Use the leading 6 bytes as an unsigned integer, then modulo N.
  const x = digest.readUIntBE(0, 6);
  return x % n;
}

/**
 * Pick `count` DISTINCT question indices for one attempt (multi-question flow).
 *
 * Each slot gets its own derived salt (`attemptSalt#j`), so the slots are
 * independent draws, and a collision simply advances to the next slot salt
 * rather than re-rolling the whole set — that keeps the mapping deterministic
 * (the Signer never remembers what it served) while guaranteeing a student is
 * never asked the same question twice in one recording.
 *
 * A bank smaller than `count` yields as many as it has; the caller decides
 * whether that is acceptable.
 */
function selectQuestionIndices(secret, sel, n, count, pools) {
  const want = Math.max(1, Math.min(Number(count) || 1, n));
  const picked = [];
  const seen = new Set();
  for (let j = 0; picked.length < want && j < want * 20 + 50; j++) {
    // `pools[slot]` (optional) restricts THIS slot to a subset of the bank — that
    // is how `difficultyMix` asks for e.g. intro, then core, then stretch. A slot
    // with no pool draws from the whole bank, which is the default and keeps the
    // sequence byte-identical to the unrestricted case.
    const pool = pools && pools[picked.length] && pools[picked.length].length
      ? pools[picked.length] : null;
    const raw = selectQuestionIndex(secret, { ...sel, attemptSalt: `${sel.attemptSalt}#${j}` },
      pool ? pool.length : n);
    const idx = pool ? pool[raw] : raw;
    if (seen.has(idx)) continue;
    seen.add(idx);
    picked.push(idx);
  }
  return picked;
}

// Speakable NATO-ish challenge nonce. Students must READ this aloud, so the
// audio content is provably created after the question was revealed.
const NONCE_WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
  'xray', 'yankee', 'zulu',
];

/** Generate a random spoken challenge like "tango-7-oscar-3". */
function generateNonce(nWords = 3) {
  return nonceFromBytes(crypto.randomBytes(nWords * 2), nWords);
}

/** Render nonce words/digits from a byte source (shared by random + derived). */
function nonceFromBytes(bytes, nWords) {
  const parts = [];
  for (let i = 0; i < nWords; i++) {
    parts.push(NONCE_WORDS[bytes[i * 2] % NONCE_WORDS.length]);
    parts.push(String(bytes[i * 2 + 1] % 10));
  }
  return parts.join('-');
}

/**
 * Deterministically DERIVE the k-th rolling nonce for an attempt.
 * nonce_k = words( HMAC(secret, `${attemptId}:${k}`) ). The Python autograder
 * reproduces this exactly to verify the whole-timeline liveness (INV-INTEGRITY-5).
 * Only a holder of the secret can compute future nonces -> unforgeable freshness.
 */
function deriveNonce(secret, attemptId, k, nWords = 2) {
  const dig = crypto.createHmac('sha256', secret).update(`${attemptId}:${k}`, 'utf8').digest();
  return nonceFromBytes(dig, nWords);
}

// ---------------------------------------------------------------------------
// Identity (v3): the Signer must never see a plaintext email (INV-PRIV-2).
//
// Two interchangeable opaque forms of `studentRef`, both meaningless to the
// Signer and both re-derivable by the autograder from the Gradescope-
// authenticated email:
//
//   "e:<32 hex>"        emailRef  - HMAC(pseudonymSalt, email), computed IN THE
//                       BROWSER. The student types their email; only this hash
//                       leaves the tab. The salt is public (it rides in the
//                       signed CourseToken), so this is PSEUDONYMIZATION, not
//                       anonymization: a party holding the salt can brute-force
//                       a known roster back to an email. It removes plaintext
//                       PII from the wire and from edge logs; it does not make
//                       re-identification impossible. See DESIGN-QUESTIONS B5.
//
//   "p:XXXX-XXXX-XXXX"  pseudonym - HMAC(SECRET, "pseudonym:"+email), minted by
//                       the autograder inside the FERPA boundary. The salt is
//                       the signing Secret, which the browser never has, so this
//                       form is NOT brute-forceable. For students who opt out of
//                       having any function of their email transmitted.
//
// A plaintext email is accepted as a studentRef ONLY when it arrived inside a
// server-signed QuizToken (accommodation links); never from client input.
// ---------------------------------------------------------------------------

/** Canonical email form. Both sides must normalize identically or refs differ. */
function normalizeEmail(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

/** emailRef: browser-computable, salted with the PUBLIC per-course salt. */
function studentRefFromEmail(pseudonymSalt, email) {
  const dig = crypto.createHmac('sha256', String(pseudonymSalt))
    .update(normalizeEmail(email), 'utf8').digest('hex');
  return 'e:' + dig.slice(0, 32);
}

// Crockford base32 without ambiguous glyphs (no I, L, O, U) - students read and
// retype these codes, so I/1 and O/0 confusion has to be designed out.
const PSEUDONYM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** pseudonym: secret-salted, so it cannot be brute-forced from a roster. */
function pseudonymForEmail(secret, email) {
  const dig = crypto.createHmac('sha256', secret)
    .update('pseudonym:' + normalizeEmail(email), 'utf8').digest();
  let out = '';
  for (let i = 0; i < 12; i++) out += PSEUDONYM_ALPHABET[dig[i] % 32];
  return 'p:' + out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12);
}

const EMAIL_REF_RE = /^e:[0-9a-f]{32}$/;
const PSEUDONYM_RE = /^p:[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
// "k:<sid>" — the key-only identity (v6). The Signer DERIVES this from a verified
// AccessKey; a client never supplies one, which is why it is absent from
// isValidStudentRef below. It is listed here so both sides share one definition.
const KEY_REF_RE = /^k:[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * Is this a well-formed CLIENT-SUPPLIED studentRef? (INV-SEC-6)
 * The Signer signs studentRef into the Certificate, so it must be validated to
 * an exact opaque shape before any crypto or bank work happens. Plaintext
 * emails deliberately FAIL here - they may only enter via a signed QuizToken.
 */
function isValidStudentRef(ref) {
  return typeof ref === 'string' && (EMAIL_REF_RE.test(ref) || PSEUDONYM_RE.test(ref));
}

/** Any ref shape the autograder may see in a Certificate, including server-derived ones. */
function isKnownStudentRef(ref) {
  return typeof ref === 'string' && (isValidStudentRef(ref) || KEY_REF_RE.test(ref));
}

/** Accept a pseudonym typed with spaces/lowercase/missing dashes. */
function normalizePseudonym(input) {
  const raw = String(input || '').toUpperCase().replace(/^P:/, '').replace(/[^0-9A-Z]/g, '');
  if (raw.length !== 12) return null;
  const ref = 'p:' + raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12);
  return PSEUDONYM_RE.test(ref) ? ref : null;
}

// ---------------------------------------------------------------------------
// Bookend challenge codes (v4). Two codes per attempt, not a rolling stream:
//
//   OPENING  spoken before the answer starts  -> content postdates the reveal
//   CLOSING  spoken after "I'm done"          -> the recording ran to the end
//
// Rolling mid-answer codes were removed deliberately. Interrupting a student
// four times mid-explanation degrades the very thing being graded (fluent
// unassisted reasoning), and they never stopped script-reading or playback-with-
// live-codes anyway. See DESIGN-QUESTIONS C2 for the full trade.
//
// Digits, not NATO words: ASR mangles "xray"/"juliet", but every engine
// transcribes digits, and a student reading "4 7 1 9 0 3" cannot mis-say a word
// they misread. Six digits is far more than the guessing threat needs -- the
// code is HMAC-derived and only revealed at its moment -- so the length is
// really there to leave room for the fuzzy match below.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CODE_DIGITS — how many digits a Student reads aloud at each boundary.
//
// FOUR, reduced from six on 2026-08-24. Every digit is a thing a nervous person
// has to read correctly on a recording, so the design pressure is downward: as
// short as it can be while the property still holds.
//
// THREE DOES NOT HOLD, and the reason is the error tolerance that was supposed
// to make it safe. `code_spoken_in` allows one Damerau-Levenshtein edit and
// slides windows of length L-1..L+1, so a 3-digit code is accepted by ANY TWO of
// its three digits appearing in order. Measured false-accept rate for a code the
// student never said, against digits that merely occur in their answer:
//
//   digits of noise in the window:      5      10      20      40
//     3 digits                      13.1%   26.7%   49.3%   74.0%
//     4 digits                       1.3%    3.4%    8.2%   18.8%
//     5 digits                       0.1%    0.2%    1.1%    2.6%
//     6 digits                       0.0%    0.1%    0.2%    0.3%
//
// In a course where students say numbers out loud while explaining, 3 digits
// fails open about a third of the time. That is not a weaker check; it is no
// check.
//
// Lowering the tolerance instead does not rescue it: at tolerance 0 an honest
// student whose transcript drops one digit fails 100% of the time, and Whisper
// dropping a digit is the exact failure the rescue pass (INV-INTEGRITY-9)
// exists for. The tolerance has to stay, so the length is the only lever.
//
// WHY FOUR IS ENOUGH. All N+1 boundaries must match, so an attack compounds.
// A pre-recorded answer reciting random digits to fish for a match, over a
// 5-question attempt (6 boundaries):
//
//   digits recited per boundary:      30      60     120
//     4 digits                    4.5e-06 5.1e-04 1.0e-02
//     6 digits                    5.6e-18 3.6e-16 2.1e-11
//
// 120 digits inside a 15-second window is eight digits a second — not a thing a
// mouth does, and audibly absurd to an instructor who plays the recording. At a
// plausible 30 the whole-attempt probability is about one in 200,000.
//
// The floor is 4 and `codeDigitsFor` clamps to [4, 8]. Do not lower it.
// ---------------------------------------------------------------------------
const CODE_DIGITS = 4;

// ---------------------------------------------------------------------------
// Extended-time accommodations (INV-ACCOM-1).
//
// Gradescope is the system of record for who is granted extended time. It does
// NOT expose that to an autograder -- submission_metadata.json carries no
// accommodation or extension field, and there is no public API -- so the
// Student SELECTS their own multiplier here and the claim is VERIFIED against
// the instructor's roster afterwards. The claim is therefore a claim, not an
// authorisation, and everything downstream treats it that way.
//
// The ladder matches what Gradescope's own extension UI offers.
// ---------------------------------------------------------------------------

const TIME_MULTIPLIERS = [1, 1.25, 1.5, 1.75, 2];
const MAX_TIME_MULTIPLIER = 2;

/* Normalise a claimed multiplier to one of the allowed rungs.
 * Returns null for anything not on the ladder -- including 3, 1.1, "2", NaN and
 * Infinity. Callers MUST reject on null rather than fall back to 1: silently
 * downgrading a bad value would hand a student less time than they asked for
 * without telling them, which is the one failure mode worse than refusing. */
function normalizeTimeMultiplier(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // Compare on a fixed grid: 1.75 is not exactly representable in binary.
  const hit = TIME_MULTIPLIERS.find((m) => Math.abs(m - value) < 1e-9);
  return hit === undefined ? null : hit;
}

/* Did this attempt stay inside the time a GRANTED multiplier would have allowed?
 *
 * This is the fairness rule, and it is the whole reason a mismatch is not
 * automatically a problem. A Student who selects 2x but answers within the 1.5x
 * they were actually granted has taken nothing they were not entitled to, so
 * there is nothing to review. Only a Student who claimed more AND used more has
 * done something the Instructor needs to look at.
 *
 * `segments` are the certificate's per-question segments; `baseLimitSec` is the
 * assignment's unmultiplied limit. Compared against the granted allowance plus
 * the same buffer the Signer would have granted, so a student is never faulted
 * for the "finish your sentence" slack they were legitimately given. */
function withinGrantedTime(segments, baseLimitSec, baseBufferSec, grantedMultiplier) {
  const allowed = (baseLimitSec * grantedMultiplier) + (baseBufferSec * grantedMultiplier);
  const over = [];
  for (const s of segments || []) {
    const used = Number(s.answerSec);
    if (Number.isFinite(used) && used > allowed + 0.5) {
      over.push({ questionId: s.questionId, usedSec: Math.round(used * 10) / 10 });
    }
  }
  return { ok: over.length === 0, allowedSec: Math.round(allowed * 10) / 10, over };
}


// ---------------------------------------------------------------------------
// CLIENT SPLIT MARKS (INV-GRADE-8) — the audio's own clock.
//
// The Signer's per-question offsets are measured from the moment it answered
// /reveal. The recording started before that — mic permission, stream setup, a
// round trip — so a server offset and the same instant in the audio differ by a
// second or two, variably, per student. The code windows are ±15 s wide and do
// not care. Cutting the file up by hand does.
//
// So the browser reports the moments only it can see, measured from the first
// byte of audio: the recorder starting, each code appearing, each question
// appearing, each "I'm done" tap, the finish. The Signer signs them into the
// Certificate so they are tamper-evident.
//
// SIGNED IS NOT TRUSTED. Everything that decides whether an attempt is genuine —
// the boundary-code windows, the deadline, the duration check — keeps running on
// the Signer's own clock, which the browser cannot touch. These marks only make a
// recording readable: they say where to cut, for a human who has to listen. A
// student has no motive to corrupt that and every motive to want it right, and
// the autograder never lets them move a window (INV-INTEGRITY-5).
//
// Validation is by ALLOW-LIST and FAILS SOFT: a malformed set is dropped and the
// attempt proceeds. This runs after a student has finished speaking, and refusing
// to certify a good recording over a cosmetic field would be the worse bug.
// ---------------------------------------------------------------------------
const MARK_EVENTS = ['recordingStart', 'code', 'question', 'done', 'deadline', 'finish'];
const MAX_MARKS = 64;

function normalizeClientMarks(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MARKS) return null;
  const out = [];
  for (const m of input) {
    if (!m || typeof m !== 'object') return null;
    // EXACTLY these keys, nothing else. Ignoring an unexpected field would be
    // enough to keep it out of the Certificate, but refusing the whole array is
    // the property worth having: a set we half-trust is worse than none, because
    // it would be printed to an instructor as if it had been measured.
    for (const k of Object.keys(m)) if (!['event', 'atSec', 'index'].includes(k)) return null;
    if (!MARK_EVENTS.includes(m.event)) return null;
    const at = Number(m.atSec);
    // 24 hours: absurdly generous, and finite. NaN and Infinity fail here.
    if (!Number.isFinite(at) || at < 0 || at > 86400) return null;
    const row = { event: m.event, atSec: Math.round(at * 1000) / 1000 };
    if (m.index !== undefined) {
      const i = Number(m.index);
      if (!Number.isInteger(i) || i < 0 || i > 999) return null;
      row.index = i;
    }
    out.push(row);
  }
  return out;
}

/**
 * Per-question split times ON THE AUDIO CLOCK, derived from the marks.
 *
 * One row per question: when its prompt appeared, and when the student ended it.
 * `endSec` is the "I'm done" tap (or the deadline firing), which is also when that
 * question's closing code was shown — so it doubles as where the code should be
 * heard. A question with no `question` mark is omitted rather than guessed at.
 */
function clientSegmentsFromMarks(marks, questionCount) {
  if (!Array.isArray(marks) || !marks.length) return null;
  const starts = new Map();
  const ends = new Map();
  const codes = new Map();
  for (const m of marks) {
    if (m.event === 'question' && m.index !== undefined && !starts.has(m.index)) starts.set(m.index, m.atSec);
    if ((m.event === 'done' || m.event === 'deadline') && m.index !== undefined && !ends.has(m.index)) {
      ends.set(m.index, m.atSec);
    }
    if (m.event === 'code' && m.index !== undefined && !codes.has(m.index)) codes.set(m.index, m.atSec);
  }
  const n = Math.max(1, Number(questionCount) || 1);
  const rows = [];
  for (let i = 0; i < n; i++) {
    if (!starts.has(i)) continue;
    const startSec = starts.get(i);
    const endSec = ends.has(i) ? ends.get(i) : (codes.has(i + 1) ? codes.get(i + 1) : null);
    rows.push({
      index: i,
      startSec,
      endSec,
      answerSec: endSec == null ? null : Math.round((endSec - startSec) * 1000) / 1000,
    });
  }
  return rows.length ? rows : null;
}

/** Derive an attempt's challenge code. `phase` is "open" or "close". */
function deriveCode(secret, attemptId, phase, nDigits = CODE_DIGITS) {
  const dig = crypto.createHmac('sha256', secret)
    .update(`${attemptId}:${phase}`, 'utf8').digest();
  let out = '';
  for (let i = 0; i < nDigits; i++) out += String(dig[i] % 10);
  return out;
}

/**
 * Default seconds allowed for reading ONE boundary code aloud.
 *
 * Measured rather than guessed: a person reading six digits at a natural,
 * unhurried pace takes about five seconds, so **one second per digit** is the
 * honest default — and, unlike a hard-coded 5, it stays honest when an
 * instructor changes `codeDigits`.
 *
 * This is deliberately NOT a knob an instructor is asked about during setup.
 * The number that matters to a teacher is `limitSec` (thinking time); the lead
 * is a mechanical consequence of how long the digits take to say, and every
 * second of it is time the student is not thinking about the question.
 */
function codeLeadDefault(codeDigits = CODE_DIGITS) {
  const n = Math.min(8, Math.max(4, Math.round(Number(codeDigits) || CODE_DIGITS)));
  return n;
}

/**
 * Default seconds between the FINAL code appearing and `/finish` — double the
 * lead.
 *
 * The last code is the one boundary with nothing after it to absorb a fumble.
 * Every other code is followed by a question and a two-minute answer, so a
 * student who starts slowly simply eats into their own thinking time; at the
 * end there is only the Finish tap, plus hashing the audio and one network
 * round trip. Doubling costs an honest student nothing (the live-demo attempt
 * used 6 s of a 12 s tail) and still bounds the unpinned tail tightly enough
 * for INV-INTEGRITY-5 — the tail is the one stretch of recording no later code
 * pins, so it must not become free unwatched airtime.
 */
function tailLimitDefault(codeDigits = CODE_DIGITS) {
  return 2 * codeLeadDefault(codeDigits);
}

/** Render for speech: "4 7 1 9 0 3" (read one digit at a time). */
function speakCode(code) {
  return String(code).split('').join(' ');
}

/**
 * Damerau-Levenshtein distance (optimal string alignment).
 *
 * The verifier already KNOWS the expected code -- it re-derives it -- so there is
 * nothing to error-CORRECT and no ECC or check digit is wanted here. What we need
 * is a tolerance for the one thing that actually goes wrong: the transcriber
 * dropping, adding, swapping, or mishearing a single digit. Distance <= 1 covers
 * exactly those four cases.
 */
function damerauLevenshtein(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);  // transposition
      }
    }
  }
  return d[m][n];
}

const DIGIT_WORDS_JS = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

/** Collapse spoken text to a bare digit string: "four seven one" -> "471". */
function digitsOnly(text) {
  let out = '';
  for (const tok of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!tok) continue;
    if (/^\d+$/.test(tok)) out += tok;                       // "471" or "4"
    else if (DIGIT_WORDS_JS[tok]) out += DIGIT_WORDS_JS[tok]; // "four"
  }
  return out;
}

/**
 * Does `text` contain `code`, allowing one transcription slip?
 * Slides a window of the code's length (and +/-1, so a dropped or added digit
 * still aligns) and keeps the best distance.
 */
function codeSpokenIn(text, code, tolerance = 1) {
  const hay = digitsOnly(text);
  const L = String(code).length;
  if (!hay) return false;
  for (let w = L - tolerance; w <= L + tolerance; w++) {
    if (w <= 0) continue;
    for (let i = 0; i + w <= hay.length; i++) {
      if (damerauLevenshtein(hay.slice(i, i + w), code) <= tolerance) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Segment boundary codes (v6) — the bookend generalised to N questions.
//
// One code per BOUNDARY, not two per question. A recording of N questions has
// N+1 boundaries:
//
//   b0 ─ Q1 ─ b1 ─ Q2 ─ b2 ─ … ─ Q(N) ─ bN
//
// so every interior code does double duty: it closes the question just answered
// AND opens the next one. The student reads six digits once between questions,
// not twice, and each code is still issued only at the moment it is needed —
// which is what makes it unpredictable, and therefore evidence of liveness.
//
// For N = 1 this is byte-identical to the v4 bookend ("open" and "close"), so
// single-question attempts, certificates, and tests are unchanged.
// ---------------------------------------------------------------------------

/** Phase string for boundary `k` of an attempt with `questionCount` questions. */
function boundaryPhase(k, questionCount) {
  if (k <= 0) return 'open';
  if (k >= questionCount) return 'close';
  return 'b' + k;
}

/** The boundary code a student must read at boundary `k`. */
function deriveBoundaryCode(secret, attemptId, k, questionCount, nDigits = CODE_DIGITS) {
  return deriveCode(secret, attemptId, boundaryPhase(k, questionCount), nDigits);
}

// ---------------------------------------------------------------------------
// Access keys (v6) — enrolment gate AND identity, in one 16-character string.
//
// The problem they solve: the CourseLink is public by design (INV-SEC-2 binds
// identity at submission, not at link time), so anyone could call /reveal in a
// loop and mine the whole Bank — the questions are the one asset that must not
// leak before the quiz.
//
// The key is SELF-AUTHENTICATING: it carries its own proof of enrolment.
//
//     key = sid ‖ tag                     rendered XXXX-XXXX-XXXX-XXXX
//     sid = base32( HMAC(Secret, "sid:v1:"‖courseId‖":"‖epoch‖":"‖email) )[0..5]
//     tag = base32( HMAC(Secret, "ktag:v1:"‖courseId‖":"‖sid) )[0..9]
//
// The Signer splits the key, recomputes `tag` from `sid`, and compares in
// constant time. A valid tag can only have been produced by a holder of the
// Secret, so it *is* proof of enrolment — with **no roster at the edge and
// nothing to keep in sync**. Adding a student mid-term is one command and a
// Brightspace post; the Signer never learns about it and never needs to.
//
// `sid` doubles as the Student's identity: `studentRef = "k:" + sid`, derived by
// the SIGNER from the key. The browser therefore sends **no email and nothing
// derived from an email** — which is why this is more private than the `e:` form
// it replaces: `e:` was salted with a PUBLIC salt and so was brute-forceable
// against a known roster, whereas `sid` is keyed by the Secret and is not
// invertible by anyone who does not already hold it. The autograder, which does
// hold it, re-derives `k:<sid>` from the Gradescope-authenticated email at
// submission time, so identity binding is unchanged (INV-SEC-2).
//
// Bit budget (16 chars ≈ 80 bits): 30 to the id, 50 to the tag. The tag is what
// an attacker must forge, and 2^50 guesses against a rate-limited edge is not a
// path anyone takes. The id is short because it is typed on a phone; a 30-bit id
// collides with probability ≈ 1e-4 across a 500-student roster, which
// gen-access-keys.js DETECTS at mint time (it has the whole roster) and fixes by
// bumping `accessKeyEpoch` in course.json.
//
// What a key is NOT: proof that the person holding it is the person it was minted
// for. Sharing it lets someone else OPEN questions as that student; it never lets
// them earn that student's grade, because the Certificate is checked against the
// authenticated submitter at upload.
// ---------------------------------------------------------------------------

const SID_CHARS = 6;
const TAG_CHARS = 10;
const ACCESS_KEY_CHARS = SID_CHARS + TAG_CHARS;   // 16

function b32(digest, n, offset = 0) {
  let out = '';
  for (let i = 0; i < n; i++) out += PSEUDONYM_ALPHABET[digest[offset + i] % 32];
  return out;
}
const groupKey = (raw) => raw.replace(/(.{4})(?=.)/g, '$1-');

/** The Student's stable per-course id, derived from their email. Needs the Secret. */
function studentIdFor(secret, courseId, email, epoch = 1) {
  const dig = crypto.createHmac('sha256', secret)
    .update(`sid:v1:${courseId}:${epoch}:${normalizeEmail(email)}`, 'utf8').digest();
  return b32(dig, SID_CHARS);
}

/** The MAC that makes a key self-authenticating. Needs the Secret. */
function accessKeyTag(secret, courseId, sid) {
  const dig = crypto.createHmac('sha256', secret)
    .update(`ktag:v1:${courseId}:${sid}`, 'utf8').digest();
  return b32(dig, TAG_CHARS);
}

/** Mint the access key for one (course, email). Requires the Secret. */
function accessKeyFor(secret, courseId, email, epoch = 1) {
  const sid = studentIdFor(secret, courseId, email, epoch);
  return groupKey(sid + accessKeyTag(secret, courseId, sid));
}

/** The opaque studentRef a key stands for. No Secret needed — it is the key's own id part. */
function studentRefFromAccessKey(key) {
  const norm = normalizeAccessKey(key);
  return norm ? 'k:' + norm.replace(/-/g, '').slice(0, SID_CHARS) : null;
}

/** The studentRef an email will present, for the autograder to compare (INV-SEC-2). */
function studentRefForEmail(secret, courseId, email, epoch = 1) {
  return 'k:' + studentIdFor(secret, courseId, email, epoch);
}

/** Accept a key typed with spaces, lowercase, or missing dashes. null if not 16 chars. */
function normalizeAccessKey(input) {
  const raw = String(input || '').toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    // Students retype these; fold the glyphs the alphabet deliberately excludes.
    .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  if (raw.length !== ACCESS_KEY_CHARS) return null;
  return groupKey(raw);
}

/**
 * Verify a key's own MAC. Returns {ok, studentRef} — no lookup, no database.
 * Constant-time: the key is attacker-supplied.
 */
function verifyAccessKey(secret, courseId, given) {
  const norm = normalizeAccessKey(given);
  if (!norm) return { ok: false, studentRef: null };
  const raw = norm.replace(/-/g, '');
  const sid = raw.slice(0, SID_CHARS);
  const expect = Buffer.from(accessKeyTag(secret, courseId, sid), 'utf8');
  const got = Buffer.from(raw.slice(SID_CHARS), 'utf8');
  const ok = expect.length === got.length && crypto.timingSafeEqual(expect, got);
  return { ok, studentRef: ok ? 'k:' + sid : null };
}

function newId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* ---------------------------------------------------------------------------
 * WHICH BANK IS ACTUALLY DEPLOYED (INV-DEPLOY-7)
 *
 * The course config and its banks are bundled into the Worker at deploy time, so
 * `/health` is the only statement of what students are really being served —
 * that is INV-DEPLOY-5's whole argument. But /health could only say WHICH
 * assignments existed, never WHICH QUESTIONS. That gap has teeth: a bank can be
 * revised while its `bankId` and its question ids stay put (q3-001…q3-100), the
 * Worker serves one revision, the Gradescope zip grades against another, and
 * nothing errors — the grader looks a submission's questions up BY ID and
 * happily marks an answer against a different question's rubric. Observed
 * across three same-day revisions of a live quiz, 2026-09-16.
 *
 * So the bundle carries a digest of the bank FILE (answers and all), and
 * /health publishes a KEYED TAG of it rather than the digest itself.
 *
 * WHY KEYED, NOT THE PLAIN DIGEST. /health is public and unauthenticated. A
 * plain digest would let anyone holding a copy of a bank confirm it is the
 * genuine article — turning a leak they could not be sure of into one they
 * could. The tag is HMAC(Secret, …), so it means everything to the instructor's
 * tooling, which has the Secret, and nothing to anybody else. Same reasoning as
 * the D1 schema's keyed tags (INV-PRIV-5): a hash of a guessable or obtainable
 * thing is not a one-way function in practice.
 *
 * The human-readable `revision` travels beside it in the clear, because "1.2" is
 * not a secret and is what an instructor actually reads.
 * ------------------------------------------------------------------------- */

/** sha256 of a bank file's bytes, as hex. Matches what validate-bank.js prints. */
function bankDigest(raw) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')).digest('hex');
}

/** Keyed, truncated tag for a bank digest — safe to publish on /health. */
function bankTag(secret, courseId, assignmentId, digest) {
  return hmac(secret, Buffer.from(`bank:v1:${courseId}:${assignmentId}:${digest}`, 'utf8'))
    .toString('hex').slice(0, 16);
}

module.exports = {
  bankDigest,
  bankTag,
  b64urlEncode,
  b64urlDecodeToBuf,
  signToken,
  verifyToken,
  selectQuestionIndex,
  selectQuestionIndices,
  generateNonce,
  nonceFromBytes,
  deriveNonce,
  deriveCode,
  normalizeClientMarks,
  clientSegmentsFromMarks,
  MARK_EVENTS,
  MAX_MARKS,
  TIME_MULTIPLIERS,
  MAX_TIME_MULTIPLIER,
  normalizeTimeMultiplier,
  withinGrantedTime,
  codeLeadDefault,
  tailLimitDefault,
  boundaryPhase,
  deriveBoundaryCode,
  accessKeyFor,
  normalizeAccessKey,
  verifyAccessKey,
  studentIdFor,
  studentRefFromAccessKey,
  studentRefForEmail,
  ACCESS_KEY_CHARS,
  SID_CHARS,
  speakCode,
  damerauLevenshtein,
  digitsOnly,
  codeSpokenIn,
  CODE_DIGITS,
  normalizeEmail,
  studentRefFromEmail,
  pseudonymForEmail,
  isValidStudentRef,
  isKnownStudentRef,
  normalizePseudonym,
  newId,
  sha256Hex,
  NONCE_WORDS,
};
