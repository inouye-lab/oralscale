'use strict';
/*
 * OralScale Signer v6 (local-dev Node server; the Cloudflare Worker mirrors it).
 *
 * Endpoints (see models/05-protocol-flows.md):
 *   POST /reveal   {courseToken, studentRef, accessKey}  -> boundary code 0 (no question yet)
 *                  {quizToken}                           -> legacy per-student link (accommodations)
 *   POST /question {revealToken}                   -> the question, after codeLeadSec; starts the clock
 *   POST /closing  {questionToken}                 -> boundary code k+1 (+ the NEXT question's
 *                                                     RevealToken while questions remain)
 *   POST /finish  {closingToken, audioSHA256, ...} -> Certificate (server-clock window)
 *   GET  /health
 *
 * Logically STATELESS: all attempt memory travels in the signed RevealToken. The only
 * server state is the rate limiter, the retake cooldown, and the access-attempt log
 * (the Worker uses D1 for all three). Never sees audio.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { resolveBank } = require('../tools/lib/course.js');
const crypto = require('crypto');
const P = require('./lib/protocol');

// --------------------------------------------------------------------------
// Config + course/assignment/bank loading
// --------------------------------------------------------------------------
function loadConfig() {
  const cfgPath = path.join(__dirname, 'config.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const secret = process.env.ORALSCALE_SECRET || cfg.secret;
  if (!secret) {
    console.error('FATAL: no signing secret. Run: node tools/make-config.js');
    process.exit(1);
  }
  const coursePath = process.env.ORALSCALE_COURSE || cfg.coursePath ||
    path.join(__dirname, '..', 'courses', 'demo', 'course.json');
  return {
    secret,
    port: Number(process.env.PORT || cfg.port || 8787),
    allowOrigin: process.env.ORALSCALE_ALLOW_ORIGIN || cfg.allowOrigin || '*',
    graceSec: process.env.ORALSCALE_GRACE_SEC != null ? Number(process.env.ORALSCALE_GRACE_SEC)
      : (cfg.graceSec != null ? cfg.graceSec : 20),
    // Where the access-attempt log is appended (INV-SEC-9). Empty = memory only.
    attemptLogPath: process.env.ORALSCALE_ATTEMPT_LOG || '',
    coursePath,
  };
}

const CFG = loadConfig();
const COURSE = JSON.parse(fs.readFileSync(CFG.coursePath, 'utf8'));
const COURSE_DIR = path.dirname(CFG.coursePath);
const BANKS = {}; // assignmentId -> {config, bank}

function loadAssignment(assignmentId) {
  const a = COURSE.assignments && COURSE.assignments[assignmentId];
  if (!a) return null;
  if (!BANKS[assignmentId]) {
    const bankPath = resolveBank(CFG.coursePath, a.bank);
    const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
    BANKS[assignmentId] = { config: a, bank };
  }
  return BANKS[assignmentId];
}

// --------------------------------------------------------------------------
// Tiny in-memory rate limiter (token bucket per key). Worker uses D1 instead.
// --------------------------------------------------------------------------
//
// The per-IP allowance is deliberately generous. A 200-student lecture hall sits
// behind ONE campus NAT address, so a tight per-address limit throttles the class
// rather than an attacker. Per-IDENTITY buckets are what actually bound an
// individual; the address bucket is only a crude DoS backstop.
const IP_RATE_PER_MIN = Number(process.env.ORALSCALE_IP_RATE_PER_MIN || 600);
const IP_BURST = Number(process.env.ORALSCALE_IP_BURST || 120);
const buckets = new Map();
function rateOk(key, ratePerMin, burst) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: burst, last: now }; buckets.set(key, b); }
  b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 60000) * ratePerMin);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => { if (buckets.size > 5000) buckets.clear(); }, 60000).unref();

// --------------------------------------------------------------------------
// HTTP helpers
// --------------------------------------------------------------------------
function sendJson(res, status, obj) {
  if (!res || res.destroyed || res.writableEnded) return;
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': CFG.allowOrigin,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  } catch {
    /* socket destroyed or closed */
  }
}
function readBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
const now = () => Math.floor(Date.now() / 1000);
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?')
  .toString().split(',')[0].trim();
/* KEYED, not plain — the Worker does the same, and for the same reason. An IPv4
   address is 32 bits and a studentRef is a 30-bit id, so a plain SHA-256 over
   either is invertible by enumeration in seconds. HMAC under the Secret (which
   never leaves this process, INV-SEC-4) makes the stored tags opaque to anyone
   holding only the log or the database. Audit finding F-2, 2026-08-21. */
const shortHash = (s) => crypto.createHmac('sha256', CFG.secret)
  .update(String(s), 'utf8').digest('hex').slice(0, 16);

function knob(assignmentId, name, dflt) {
  const a = (COURSE.assignments || {})[assignmentId] || {};
  const v = a[name] != null ? a[name] : (COURSE.defaults || {})[name];
  return v != null ? Number(v) : dflt;
}
/** Boolean knob. Defaults FAIL CLOSED for the access gate: absent means required. */
function flagKnob(assignmentId, name, dflt) {
  const a = (COURSE.assignments || {})[assignmentId] || {};
  const v = a[name] != null ? a[name] : (COURSE.defaults || {})[name];
  return v != null ? !!v : dflt;
}
const requireKeyFor = (id) => flagKnob(id, 'requireAccessKey', true);
const questionsFor = (id) => Math.max(1, Math.round(knob(id, 'questionsPerAttempt', 1)));
// Buffer: seconds the Student may keep talking AFTER the visible countdown hits
// 0:00 before the question closes itself. It is separate from `limitSec` on
// purpose — `limitSec` is the promise made to the student ("you have two
// minutes"), the buffer is the humane slack for finishing a sentence, and an
// instructor should be able to tune the two independently. Clock skew is a THIRD
// thing (`graceSec`, server-wide) and is not conflated with either.
const bufferFor = (id) => Math.max(0, knob(id, 'bufferSec', 20));
// 4–8 digits. Six is plenty; shorter is easier to read aloud, longer is stricter.
// Clamped to [4, 8]. The FLOOR IS NOT ARBITRARY: at 3 digits the one-edit
// tolerance in code_spoken_in accepts any two of the three digits in order, and
// a code the student never said matches innocent numbers in their answer about
// a quarter of the time. See CODE_DIGITS in lib/protocol.js for the numbers.
const codeDigitsFor = (id) => Math.min(8, Math.max(4, Math.round(knob(id, 'codeDigits', P.CODE_DIGITS))));
/**
 * WHAT THE STUDENT'S BROWSER RECEIVES (INV-COURSE-5, INV-PRIV-7).
 *
 * The dev Signer reads banks straight off disk, so unlike the Worker it holds the
 * WHOLE question — rubric, keyPoints, referenceAnswer, scoringBands, evidence.
 * None of that may reach the tab, so the response is built by allow-list.
 *
 * `topic` and `principle` are the meta line: withheld unless the assignment sets
 * `showQuestionMeta`, because `principle` names the durable idea the question is
 * testing and printing it above the prompt gives away much of the answer.
 * Default OFF; a pilot quiz opts in because it was live when this changed.
 *
 * Kept in step with the same function in server/worker/signer-worker.js and with
 * the allow-list in tools/build-worker.js.
 */
function servedQuestion(q, assignmentId) {
  // `difficulty` is NOT here. The bundle keeps it because difficultyPools selects
  // on it, but that is a SERVER-SIDE use: the browser has no use for it and it is
  // part of the same meta line (INV-COURSE-5). On its own it renders as a lone
  // "CORE" above the prompt, which tells a student how worried to be and nothing
  // they can act on. Observed on a live pilot quiz, 2026-09-08.
  const out = { id: q.id, prompt: q.prompt };
  if (flagKnob(assignmentId, 'showQuestionMeta', false)) {
    if (q.difficulty !== undefined) out.difficulty = q.difficulty;
    if (q.topic !== undefined) out.topic = q.topic;
    if (q.principle !== undefined) out.principle = q.principle;
  }
  return out;
}
/**
 * Per-slot difficulty pools for `difficultyMix` (e.g. ["intro","core","stretch"]).
 * A slot whose difficulty has no questions in this bank falls back to the whole
 * bank rather than failing the attempt — a mis-set mix must never cost a student
 * their quiz.
 */
function difficultyPools(assignmentId, questions, count) {
  const a = (COURSE.assignments || {})[assignmentId] || {};
  const mix = a.difficultyMix != null ? a.difficultyMix : (COURSE.defaults || {}).difficultyMix;
  if (!Array.isArray(mix) || !mix.length) return null;
  const byDiff = new Map();
  questions.forEach((q, i) => {
    const d = String(q.difficulty || 'unset');
    if (!byDiff.has(d)) byDiff.set(d, []);
    byDiff.get(d).push(i);
  });
  const pools = [];
  for (let slot = 0; slot < count; slot++) {
    const want = String(mix[slot % mix.length]);
    const pool = byDiff.get(want);
    pools.push(pool && pool.length ? pool : null);
  }
  return pools;
}

// --------------------------------------------------------------------------
// Access gate (INV-SEC-8) — the enrolment check that protects the Bank.
//
// The CourseLink is public and `studentRef` is client-supplied, so without this a
// script could invent refs and call /reveal in a loop until it had mined every
// question in the week's Bank. The AccessKey is minted from the Secret against
// the ref (see protocol.js), so the Signer re-derives and compares it here —
// statelessly, with no roster and therefore still no PII at the edge.
//
// Order matters: shape validation, then key check, then anything expensive.
// A request that fails the gate never reaches question selection, so a wrong key
// leaks nothing about the Bank — not even how many questions it holds.
// --------------------------------------------------------------------------
//
// A forged key names nobody — there is no identity to attach a lockout to until
// the key verifies — so the guessing limit IS keyed on the source address. That
// cuts against the campus-NAT argument (models/06 T18), so the threshold is
// deliberately loose and the window short: ten INVALID keys from one address in
// 15 minutes. A whole lecture hall would have to fumble ten keys in a quarter of
// an hour to trip it, and that recovers on its own; an unbounded forgery loop
// against a 50-bit tag is not something to leave open. Honest students never see
// it — their key is pasted from Brightspace and either works or does not.
const KEY_FAIL_LIMIT = Number(process.env.ORALSCALE_KEY_FAIL_LIMIT || 10);
const KEY_FAIL_WINDOW_SEC = Number(process.env.ORALSCALE_KEY_FAIL_WINDOW_SEC || 900);
const keyFails = new Map();     // hashed source address -> [unix seconds]

function noteKeyFailure(key) {
  const t = now();
  const list = (keyFails.get(key) || []).filter((x) => x > t - KEY_FAIL_WINDOW_SEC);
  list.push(t);
  keyFails.set(key, list);
  return list.length;
}
function keyLockedOut(key) {
  const t = now();
  const list = (keyFails.get(key) || []).filter((x) => x > t - KEY_FAIL_WINDOW_SEC);
  return list.length >= KEY_FAIL_LIMIT;
}

// --------------------------------------------------------------------------
// Access-attempt log (INV-SEC-9). Every /reveal decision is recorded so a
// bank-mining attempt is *visible* rather than merely blocked: a burst of
// KEY_INVALID rows from one address is the signature of someone guessing keys.
//
// No PII, by construction: the identity is already opaque (INV-PRIV-2) and is
// hashed again here, and the IP is stored only as a salted hash.
// --------------------------------------------------------------------------
const accessLog = [];           // most recent first; capped
const LOG_CAP = 5000;
function logAccess(rec) {
  const row = { ts: now(), ...rec };
  accessLog.unshift(row);
  if (accessLog.length > LOG_CAP) accessLog.length = LOG_CAP;
  if (CFG.attemptLogPath) {
    try { fs.appendFileSync(CFG.attemptLogPath, JSON.stringify(row) + '\n'); }
    catch { /* logging must never break an attempt */ }
  }
  return row;
}
function accessStats() {
  const t = now() - 3600;
  const recent = accessLog.filter((r) => r.ts >= t);
  return {
    lastHour: recent.length,
    granted: recent.filter((r) => r.event === 'granted').length,
    denied: recent.filter((r) => r.event === 'denied').length,
  };
}

// --------------------------------------------------------------------------
// Retake cooldown (INV-SEC-7) — bounds question shopping.
//
// Unlimited retakes are policy and stay policy. What we refuse is REROLLING:
// open a question, dislike it, abandon, open another, until an easy one turns
// up. So the cooldown sits on /reveal, where the shopping happens.
//
// The rule that keeps it from punishing honest students: an attempt that was
// actually FINISHED satisfies the cooldown immediately. Answering takes ~3
// minutes anyway, so a student who does the work is never blocked; only someone
// who bails on a question they just saw has to wait.
//
// A mic failure costs nothing either — capture starts BEFORE /reveal
// (INV-INTEGRITY-6), so a denied or broken mic never consumes an attempt.
//
// This is the one piece of genuinely correctness-relevant state. It is still a
// hardening layer: losing it degrades shopping resistance, not integrity.
// --------------------------------------------------------------------------
// Deployment-wide override only. Normally BOTH the code lead and the tail are
// DERIVED from `codeDigits` (protocol.js: one second per digit, doubled at the
// end), so an instructor never configures them — see FR-7 "advanced knobs".
const TAIL_LIMIT_SEC = process.env.ORALSCALE_TAIL_LIMIT_SEC != null
  ? Number(process.env.ORALSCALE_TAIL_LIMIT_SEC) : null;
const attempts = new Map(); // key -> { attemptId, tReveal, finished }
const attemptKey = (studentRef, assignmentId) => shortHash(studentRef + '␟' + assignmentId);

const cooldownFor = (id) => knob(id, 'retakeCooldownSec', 300);

// How much of the window must actually elapse before an attempt counts as
// "really taken" and clears the cooldown.
//
// Without this the cooldown is trivially bypassable: reveal -> /closing ->
// /finish with a junk hash takes under a second and clears it, so a shopper
// rerolls freely. Requiring real elapsed time makes each reroll cost that time,
// which is the whole point. Honest students speak for minutes and never notice.
const clearsAfterFor = (id) => Math.min(knob(id, 'cooldownClearsAfterSec', 60), knob(id, 'limitSec', 180));

/** null if allowed, else seconds the student must wait. */
function cooldownRemaining(studentRef, assignmentId) {
  const secs = cooldownFor(assignmentId);
  if (!secs) return null;
  const rec = attempts.get(attemptKey(studentRef, assignmentId));
  if (!rec || rec.finished) return null;       // first attempt, or last one completed
  const left = rec.tReveal + secs - now();
  return left > 0 ? left : null;
}

function noteReveal(studentRef, assignmentId, attemptId, tReveal) {
  attempts.set(attemptKey(studentRef, assignmentId), { attemptId, tReveal, finished: false });
}

/**
 * Clear the cooldown iff the Student actually spent time on the attempt.
 *
 * Called from BOTH /closing and /finish, and on the failure paths too: someone
 * who answered for two minutes and then fumbled the last step has not been
 * shopping, and should not be locked out for it.
 */
function noteAttemptEnd(studentRef, assignmentId, attemptId, tStart, tEnd) {
  if (tEnd - tStart < clearsAfterFor(assignmentId)) return false;
  const rec = attempts.get(attemptKey(studentRef, assignmentId));
  if (rec && rec.attemptId === attemptId) rec.finished = true;
  return true;
}

setInterval(() => {
  const cutoff = now() - 3600;
  for (const [k, v] of attempts) if (v.tReveal < cutoff) attempts.delete(k);
}, 300000).unref();

// --------------------------------------------------------------------------
// Handlers
// --------------------------------------------------------------------------
/**
 * Resolve the attempt's assignment + identity from either link style.
 *
 *   v3 (default)  {courseToken, studentRef, accessKey} - one PUBLIC link for the
 *                 whole class. studentRef is an opaque client-supplied ref that the
 *                 autograder re-derives from the Gradescope identity at submission
 *                 time; accessKey proves the ref belongs to an enrolled student.
 *   v2 (legacy)   {quizToken} - per-student link minted by the autograder. Still
 *                 supported because accommodation links carry timeMultiplier, and
 *                 because the Signer itself minted it, it needs no AccessKey.
 *
 * Returns {assignmentId, studentRef, timeMultiplier, serverMinted} or {error, status}.
 */
function resolveAttempt(body) {
  const { courseToken, studentRef, quizToken, accessKey } = body;

  // Extended-time accommodation, SELECTED BY THE STUDENT (INV-ACCOM-1).
  //
  // Gradescope holds the real grant and will not tell us, so this is a claim.
  // Validate the shape here, before any crypto or bank work (INV-SEC-5), and
  // REFUSE anything off the ladder rather than silently clamping — a student
  // who asked for 2x and quietly got 1x would discover it as a countdown that
  // ran out mid-sentence, which is the worst possible way to find out.
  const claimed = P.normalizeTimeMultiplier(
    body.timeMultiplier === undefined ? undefined : Number(body.timeMultiplier));
  if (claimed === null) {
    return { status: 400, code: 'BAD_MULTIPLIER',
             error: `timeMultiplier must be one of ${P.TIME_MULTIPLIERS.join(', ')}` };
  }

  if (courseToken) {
    let course;
    try { course = P.verifyToken(CFG.secret, courseToken); }
    catch { return { status: 401, error: 'invalid course token' }; }
    if (course.kind !== 'course') return { status: 400, error: 'not a course token' };
    if (course.exp && now() > course.exp) {
      return { status: 403, error: 'this quiz link has expired — ask your instructor for the current link' };
    }

    /* THE ASSIGNMENT MUST STILL EXIST, and this is checked before anything else
     * the token asks for.
     *
     * A link outlives the assignment it names: an assignment gets renamed or
     * retired and the old link keeps circulating. Without this, such a link fell
     * through to whichever identity branch the MISSING config happened to imply
     * — `requireKeyFor()` reads a knob off an assignment that is not there, gets
     * undefined, and takes the open-mode path — so a student holding a valid key
     * for a renamed assignment was told "studentRef must be an opaque emailRef",
     * which is true of nothing they did and points at nothing they can fix.
     * Observed on the public demo after `try` was renamed to `demo-quiz`. */
    if (!(COURSE.assignments || {})[course.assignmentId]) {
      return { status: 404, code: 'ASSIGNMENT_GONE',
               error: 'This quiz link is out of date — it points at an assignment that no longer '
                    + 'exists. Get the current link from your assignment in Gradescope. '
                    + '(Your quiz key is fine and does not change.)' };
    }

    // KEY-ONLY MODE (the default). The Student types one thing: their quiz key.
    // The key proves enrolment AND names the Student, so nothing derived from an
    // email is ever sent — the Signer cannot learn who this is even in principle
    // (INV-PRIV-2). Any `studentRef` the client also sent is IGNORED: identity
    // here comes from a value only the Secret can mint, never from client input.
    if (requireKeyFor(course.assignmentId)) {
      if (!accessKey) {
        return { status: 401, code: 'KEY_REQUIRED', error: KEY_REQUIRED_MSG, gateFailed: true,
                 assignmentId: course.assignmentId };
      }
      const check = P.verifyAccessKey(CFG.secret, COURSE.courseId, accessKey);
      if (!check.ok) {
        return { status: 403, code: 'KEY_INVALID', error: KEY_INVALID_MSG, gateFailed: true,
                 assignmentId: course.assignmentId };
      }
      return { assignmentId: course.assignmentId, studentRef: check.studentRef,
               timeMultiplier: claimed,
               accommodationSource: claimed > 1 ? 'student-selected' : 'none',
               keyChecked: 'accessKey' };
    }

    // OPEN MODE (requireAccessKey:false — demos and open courses). Identity is the
    // client-supplied opaque ref of v3.
    // INV-SEC-6: it gets signed into the Certificate, so validate its exact shape
    // BEFORE any crypto or bank work. A plaintext email fails by design — it may
    // only arrive inside a server-signed QuizToken.
    if (!P.isValidStudentRef(studentRef)) {
      return { status: 400, error: 'studentRef must be an opaque emailRef or private code' };
    }
    return { assignmentId: course.assignmentId, studentRef, timeMultiplier: claimed,
             accommodationSource: claimed > 1 ? 'student-selected' : 'none',
             keyChecked: 'not-required' };
  }

  if (quizToken) {
    let quiz;
    try { quiz = P.verifyToken(CFG.secret, quizToken); }
    catch { return { status: 401, error: 'invalid quiz token' }; }
    if (quiz.kind !== 'quiz') return { status: 400, error: 'not a quiz token' };
    if (quiz.exp && now() > quiz.exp) {
      return { status: 403, error: 'this quiz link has expired — get a fresh link from Gradescope' };
    }
    // studentRef here came from the SIGNER's own token, so a plaintext email is
    // legitimate (accommodation links). Never trust one from the client.
    // This multiplier came from a link the SIGNER minted, so it is an
    // authorisation and not a claim. It wins over anything the client sent:
    // an instructor-issued accommodation is already verified.
    const minted = P.normalizeTimeMultiplier(Number(quiz.timeMultiplier || 1)) || 1;
    return { assignmentId: quiz.assignmentId, studentRef: quiz.studentRef,
             timeMultiplier: minted,
             accommodationSource: minted > 1 ? 'instructor-link' : 'none',
             keyChecked: 'quizToken' };
  }

  return { status: 400, error: 'courseToken + studentRef (or a legacy quizToken) required' };
}

const STALE_LINK_MSG =
  'This quiz link is for an assignment this course is not currently running. It is almost always an OLD LINK — ask your instructor for the current one. Nothing is wrong with your quiz key.';

const KEY_REQUIRED_MSG =
  'This quiz needs your personal quiz key — it is the only thing you have to enter. '
  + 'It was posted for you in Brightspace, and it is also in your Gradescope feedback if you '
  + 'submit this assignment without a recording. It looks like ABCD-EFGH-JKMN-PQRS.';
const KEY_INVALID_MSG =
  'That is not a valid quiz key for this course. Check for a mistyped character — '
  + 'your key is in Brightspace (and in your Gradescope feedback if you submit with no '
  + 'recording). Keys are per course, so last term\'s will not work.';

/**
 * Log the outcome of the gate (INV-SEC-9) and apply the guessing lockout.
 *
 * The gate ITSELF now lives in resolveAttempt, because in key-only mode the key
 * is what produces the identity — there is nothing to check it against until it
 * has been verified. This function records what happened and decides whether the
 * source has been guessing.
 *
 * The lockout keys on the identity when we have one and on the address only for
 * failures that never produced an identity (a bad key names nobody). It is
 * therefore a *soft* limit: see models/06 T18 for why an IP lockout would be
 * worse than the attack it prevents.
 */
function noteAccess(quiz, ipHash) {
  const base = { assignmentId: quiz.assignmentId, ipHash,
                 refHash: quiz.studentRef ? shortHash(quiz.studentRef) : '-' };
  if (quiz.gateFailed) {
    if (quiz.code === 'KEY_INVALID') noteKeyFailure(ipHash);
    logAccess({ ...base, event: 'denied', reason: quiz.code });
    return;
  }
  logAccess({ ...base, event: 'granted', reason: quiz.keyChecked });
}

async function handleReveal(req, res) {
  if (!rateOk('ip:' + shortHash('ip\u241F' + clientIp(req)), IP_RATE_PER_MIN, IP_BURST)) return sendJson(res, 429, { error: 'rate limited' });
  const body = await readBody(req);

  const ipHash = shortHash('ip\u241F' + clientIp(req));
  // A burst of forged keys names nobody, so it can only be bounded by source.
  if (keyLockedOut(ipHash)) {
    logAccess({ assignmentId: '-', refHash: '-', ipHash, event: 'denied', reason: 'KEY_LOCKED' });
    return sendJson(res, 429, { code: 'KEY_LOCKED',
      error: 'Too many invalid quiz keys from this connection. Wait 15 minutes and try again with '
        + 'the key from Brightspace — or ask your instructor to resend it.' });
  }

  // INV-SEC-8: the key both proves enrolment and names the Student. A request that
  // fails here never reaches question selection, so it learns nothing about the Bank.
  const quiz = resolveAttempt(body);
  if (quiz.error) {
    if (quiz.assignmentId) noteAccess(quiz, ipHash);
    return sendJson(res, quiz.status, { error: quiz.error, code: quiz.code });
  }
  noteAccess(quiz, ipHash);

  // The course link is shared by the whole class, so the per-token bucket of the
  // v2 flow no longer isolates students. Key the bucket on the identity instead.
  if (!rateOk('sref:' + shortHash(quiz.studentRef), 30, 10)) {
    return sendJson(res, 429, { error: 'rate limited' });
  }

  const wait = cooldownRemaining(quiz.studentRef, quiz.assignmentId);
  if (wait != null) {
    return sendJson(res, 429, {
      error: `You opened a question ${Math.round((cooldownFor(quiz.assignmentId) - wait) / 60 * 10) / 10} min ago and did not finish it. `
        + `You can start a new one in ${Math.ceil(wait / 60)} min — or finish an attempt and retake right away.`,
      code: 'COOLDOWN', retryAfterSec: wait,
    });
  }

  const A = loadAssignment(quiz.assignmentId);
  // A student who follows a stale link should be told what to DO about it. The
  // old wording ("unknown assignment") described our data model, which is no
  // help to someone staring at it two minutes before a quiz — and this is the
  // one failure a link that used to work produces after a course is re-bundled.
  if (!A) return sendJson(res, 409, { code: 'UNKNOWN_ASSIGNMENT', error: STALE_LINK_MSG });
  const cfg = A.config;
  const questions = A.bank.questions;

  const timeMult = quiz.timeMultiplier;
  const limitSec = Math.round(knob(quiz.assignmentId, 'limitSec', 180) * timeMult);
  // The buffer scales with the accommodation multiplier too — a student who gets
  // 1.5x thinking time should get 1.5x of the "finish your sentence" slack.
  const bufferSec = Math.round(bufferFor(quiz.assignmentId) * timeMult);
  const codeDigits = codeDigitsFor(quiz.assignmentId);
  // Derived from the code length, not configured: one second per digit to read
  // the digits aloud, double that at the end where nothing follows to absorb a
  // fumble. An explicit `codeLeadSec` / `tailLimitSec` in course.json still wins
  // (advanced knob), and the demo fixtures use that to force degenerate values.
  const codeLeadSec = Math.max(0, knob(quiz.assignmentId, 'codeLeadSec', P.codeLeadDefault(codeDigits)));
  const tailLimitSec = Math.max(5, knob(quiz.assignmentId, 'tailLimitSec',
    TAIL_LIMIT_SEC != null ? TAIL_LIMIT_SEC : P.tailLimitDefault(codeDigits)));
  const attemptSalt = P.newId(8);
  const attemptId = P.newId(12);
  // One attempt can now carry several questions (decision A1, reopened). They are
  // ALL chosen here, so the set is fixed before the first word is spoken and a
  // student cannot reroll question 2 by replaying the middle of the flow.
  const questionCount = Math.min(questionsFor(quiz.assignmentId), questions.length);
  const idxs = P.selectQuestionIndices(CFG.secret,
    { bankId: A.bank.bankId, assignmentId: quiz.assignmentId, studentRef: quiz.studentRef, attemptSalt },
    questions.length, questionCount,
    difficultyPools(quiz.assignmentId, questions, questionCount));
  const questionIds = idxs.map((i) => questions[i].id);
  const tReveal = now();

  // The question is CHOSEN now but NOT disclosed: the student reads the opening code
  // first, and only then does /question hand it over. Withholding it server-side is
  // the point — hiding it in the client would still ship it in this response, and a
  // student watching the network tab would read it early.
  const revealToken = P.signToken(CFG.secret, {
    v: 6, kind: 'reveal',
    courseId: COURSE.courseId, assignmentId: quiz.assignmentId, studentRef: quiz.studentRef,
    attemptId, attemptSalt,
    questionIds, questionCount, qIndex: 0,
    questionId: questionIds[0],               // the segment currently in play
    tStart: tReveal, tReveal, segments: [],
    keyChecked: quiz.keyChecked,
    codeLeadSec, limitSec, bufferSec, codeDigits, tailLimitSec,
    // Rides in the SIGNED token, so the certificate records what the timings
    // were actually computed from — not whatever the client claims later.
    timeMultiplier: timeMult,
    accommodationSource: quiz.accommodationSource || 'none',
    baseLimitSec: knob(quiz.assignmentId, 'limitSec', 180),
    baseBufferSec: bufferFor(quiz.assignmentId),
  });

  noteReveal(quiz.studentRef, quiz.assignmentId, attemptId, tReveal);

  const code0 = P.deriveBoundaryCode(CFG.secret, attemptId, 0, questionCount, codeDigits);
  sendJson(res, 200, {
    revealToken, attemptId, tReveal, codeLeadSec, limitSec, bufferSec, tailLimitSec,
    questionCount, qIndex: 0, qNumber: 1,
    // Boundary 0 of N+1. For a single-question attempt this IS the old opening code.
    code: code0,
    openingCode: code0,  // v5 name
  });
}

/**
 * The boundary code has been on screen for codeLeadSec; hand over the question and
 * START THE CLOCK for this segment. The answer window is measured from here, so the
 * seconds spent reading the code aloud are not taken out of the student's thinking
 * time — and that holds for every question, not only the first.
 */
async function handleQuestion(req, res) {
  const { revealToken } = await readBody(req);
  if (!revealToken) return sendJson(res, 400, { error: 'revealToken required' });
  let r;
  try { r = P.verifyToken(CFG.secret, revealToken); }
  catch { return sendJson(res, 401, { error: 'invalid reveal token' }); }
  if (r.kind !== 'reveal') return sendJson(res, 400, { error: 'not a reveal token' });

  const readyAt = r.tReveal + r.codeLeadSec;
  if (now() < readyAt) {
    return sendJson(res, 200, { ready: false, availableInSec: readyAt - now() });
  }

  const A = loadAssignment(r.assignmentId);
  // A student who follows a stale link should be told what to DO about it. The
  // old wording ("unknown assignment") described our data model, which is no
  // help to someone staring at it two minutes before a quiz — and this is the
  // one failure a link that used to work produces after a course is re-bundled.
  if (!A) return sendJson(res, 409, { code: 'UNKNOWN_ASSIGNMENT', error: STALE_LINK_MSG });
  const q = A.bank.questions.find((x) => x.id === r.questionId);
  if (!q) return sendJson(res, 409, { error: 'question not in bank' });

  const tQuestion = now();
  // limitSec is what the countdown shows; bufferSec is the extra "finish your
  // sentence" slack; graceSec is pure clock skew and is deliberately not part of
  // either number the student is told about.
  const buffer = Number(r.bufferSec || 0);
  const deadline = tQuestion + r.limitSec + buffer + CFG.graceSec;
  const questionToken = P.signToken(CFG.secret, { ...r, kind: 'question', tQuestion, deadline });

  sendJson(res, 200, {
    ready: true, questionToken, tQuestion, deadline, limitSec: r.limitSec, bufferSec: buffer,
    qIndex: r.qIndex, qNumber: r.qIndex + 1, questionCount: r.questionCount,
    question: servedQuestion(q, r.assignmentId),
  });
}

/**
 * "I'm done with this question." Issues the NEXT boundary code — which closes the
 * segment just answered and, when questions remain, opens the following one. The
 * student reads six digits once per boundary, not twice.
 */
async function handleClosing(req, res) {
  const { questionToken } = await readBody(req);
  if (!questionToken) return sendJson(res, 400, { error: 'questionToken required' });
  let r;
  try { r = P.verifyToken(CFG.secret, questionToken); }
  catch { return sendJson(res, 401, { error: 'invalid question token' }); }
  if (r.kind !== 'question') return sendJson(res, 400, { error: 'get the question before finishing' });

  const tClosing = now();
  if (tClosing > r.deadline) {
    return sendJson(res, 403, {
      error: 'time limit exceeded — the recording window closed before you finished',
      code: 'DEADLINE_EXCEEDED', tReveal: r.tReveal, deadline: r.deadline,
    });
  }
  const tStart = r.tStart != null ? r.tStart : r.tReveal;
  noteAttemptEnd(r.studentRef, r.assignmentId, r.attemptId, tStart, tClosing);

  // Record the segment just completed. `segments` accumulates inside the signed
  // token, so the Signer still remembers nothing between requests.
  const segments = (r.segments || []).concat([{
    index: r.qIndex, questionId: r.questionId,
    tReveal: r.tReveal, tQuestion: r.tQuestion, tClosing, limitSec: r.limitSec,
    bufferSec: Number(r.bufferSec || 0),
  }]);
  const boundary = r.qIndex + 1;
  const more = boundary < r.questionCount;
  const code = P.deriveBoundaryCode(CFG.secret, r.attemptId, boundary, r.questionCount, r.codeDigits || P.CODE_DIGITS);

  const closingToken = P.signToken(CFG.secret, { ...r, kind: 'closing', tClosing, segments });

  const out = {
    closingToken, tClosing, code,
    closingCode: code,                       // v5 name, kept for older clients
    tailLimitSec: r.tailLimitSec || P.tailLimitDefault(r.codeDigits || P.CODE_DIGITS),
    more, qIndex: r.qIndex, questionCount: r.questionCount,
    answered: boundary,
  };
  if (more) {
    // The SAME code opens the next question: one reading, two jobs. The next
    // segment's clock starts at tClosing, so the lead is honoured again.
    out.nextRevealToken = P.signToken(CFG.secret, {
      ...r, kind: 'reveal',
      qIndex: boundary, questionId: r.questionIds[boundary],
      tReveal: tClosing, segments,
      tQuestion: undefined, deadline: undefined,
    });
    out.nextQNumber = boundary + 1;
  }
  sendJson(res, 200, out);
}

async function handleFinish(req, res) {
  if (!rateOk('ip:' + shortHash('ip\u241F' + clientIp(req)), IP_RATE_PER_MIN, IP_BURST)) return sendJson(res, 429, { error: 'rate limited' });
  const { closingToken, audioSHA256, durationSec, clientMarks } = await readBody(req);
  if (!closingToken || !audioSHA256) return sendJson(res, 400, { error: 'closingToken and audioSHA256 required' });
  if (!/^[0-9a-f]{64}$/.test(String(audioSHA256))) return sendJson(res, 400, { error: 'bad audioSHA256' });

  let r;
  try { r = P.verifyToken(CFG.secret, closingToken); }
  catch { return sendJson(res, 401, { error: 'invalid closing token' }); }
  // A RevealToken must not be usable here: that would let a client skip the
  // closing code entirely and still be certified (INV-INTEGRITY-5).
  if (r.kind !== 'closing') return sendJson(res, 400, { error: 'call /closing before /finish' });
  // …and a mid-attempt ClosingToken must not certify either: on a multi-question
  // attempt that would bank the questions already seen and drop the rest.
  const segments = r.segments || [];
  if (segments.length < r.questionCount) {
    return sendJson(res, 400, {
      error: `answer all ${r.questionCount} questions before finishing (${segments.length} done)`,
      code: 'QUESTIONS_REMAINING', answered: segments.length, questionCount: r.questionCount,
    });
  }

  const tFinish = now();
  const tStart = r.tStart != null ? r.tStart : r.tReveal;
  // The tail exists only to read ~6 digits aloud. Bounding it stops a student
  // from using the closing step as extra unpinned recording time.
  const tail = Number(r.tailLimitSec || P.tailLimitDefault(r.codeDigits || P.CODE_DIGITS));
  if (tFinish > r.tClosing + tail) {
    noteAttemptEnd(r.studentRef, r.assignmentId, r.attemptId, tStart, tFinish);
    return sendJson(res, 403, {
      error: 'took too long after the closing code — retake for a fresh question',
      code: 'TAIL_EXCEEDED', tClosing: r.tClosing, tFinish,
    });
  }
  if (tFinish > r.deadline + tail) {
    return sendJson(res, 403, {
      error: 'time limit exceeded — recording finished after the deadline',
      code: 'DEADLINE_EXCEEDED', tReveal: r.tReveal, deadline: r.deadline, tFinish,
    });
  }
  const elapsedSec = tFinish - tStart;   // whole recording, code lead included

  // Offsets are measured from tStart — the moment recording and the first code
  // began — so they line up with word timestamps in the transcript.
  const segOut = segments.map((s) => ({
    index: s.index, questionId: s.questionId, limitSec: s.limitSec, bufferSec: s.bufferSec,
    tReveal: s.tReveal, tQuestion: s.tQuestion, tClosing: s.tClosing,
    revealOffsetSec: s.tReveal - tStart,
    questionOffsetSec: s.tQuestion - tStart,
    closingOffsetSec: s.tClosing - tStart,
    answerSec: s.tClosing - s.tQuestion,
  }));
  const first = segOut[0];
  const last = segOut[segOut.length - 1];

  const certificate = {
    v: 6, kind: 'certificate',
    courseId: r.courseId, assignmentId: r.assignmentId, studentRef: r.studentRef,
    attemptId: r.attemptId,
    // INV-SEC-8: the autograder refuses a certificate that was not gated, so a
    // Signer running with the gate off cannot quietly produce gradeable work.
    accessKeyVerified: r.keyChecked === 'accessKey' || r.keyChecked === 'quizToken',
    keyChecked: r.keyChecked || 'not-required',
    questionCount: r.questionCount, questionIds: r.questionIds, segments: segOut,
    tStart, tFinish, elapsedSec, deadline: r.deadline,
    codeLeadSec: r.codeLeadSec, codeDigits: r.codeDigits || P.CODE_DIGITS,
    limitSecPerQuestion: r.limitSec, bufferSec: Number(r.bufferSec || 0), tailLimitSec: tail,
    boundaryCount: r.questionCount + 1,
    // ---- single-question mirrors (v5 field names) -------------------------
    // A one-question attempt produces byte-compatible values here, so older
    // graders and every existing test keep working unchanged.
    questionId: first.questionId,
    tReveal: tStart, tQuestion: first.tQuestion, tClosing: last.tClosing,
    questionOffsetSec: first.questionOffsetSec,
    closingOffsetSec: last.closingOffsetSec,
    answerSec: segOut.reduce((a, s) => a + s.answerSec, 0),
    limitSec: r.limitSec,
    audioSHA256: String(audioSHA256),
    clientDurationSec: durationSec != null ? Number(durationSec) : null,
    // CLIENT-ASSERTED split times on the audio clock (INV-GRADE-8). Signed so it
    // is tamper-evident; never consulted by an integrity check. Omitted when the
    // browser sent none, or sent something that did not validate.
    clientMarks: P.normalizeClientMarks(clientMarks) || undefined,
    // ---- extended-time accommodation (INV-ACCOM-1) ------------------------
    // Recorded in the SIGNED certificate so the claim is tamper-evident and the
    // Instructor can check it against Gradescope without asking the Student
    // anything. `claimedMultiplier` is a CLAIM when the Student selected it and
    // an AUTHORISATION when the Signer minted the link; `source` says which, so
    // nothing downstream has to guess. baseLimitSec/baseBufferSec are the
    // UNMULTIPLIED knobs, so a verifier can recompute what any other granted
    // multiplier would have allowed.
    accommodation: {
      claimedMultiplier: Number(r.timeMultiplier || 1),
      source: r.accommodationSource || 'none',
      baseLimitSec: Number(r.baseLimitSec != null ? r.baseLimitSec : r.limitSec),
      baseBufferSec: Number(r.baseBufferSec != null ? r.baseBufferSec : (r.bufferSec || 0)),
    },
  };
  noteAttemptEnd(r.studentRef, r.assignmentId, r.attemptId, tStart, tFinish);
  sendJson(res, 200, { certificate, certificateToken: P.signToken(CFG.secret, certificate) });
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  res.on('error', () => {});
  try {
    if (req.method === 'OPTIONS') {
      // Bodyless, mirroring the Worker (204 may not carry one).
      res.writeHead(204, {
        'Access-Control-Allow-Origin': CFG.allowOrigin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/health') {
      const ids = Object.keys(COURSE.assignments || {});
      return sendJson(res, 200, { ok: true, courseId: COURSE.courseId,
        assignments: ids,
        db: 'in-memory', cooldownEnforced: true,
        // Make the gate's state visible before students arrive: an assignment
        // configured open is a bank-mining hole, and silence about it is worse.
        accessKeyRequired: Object.fromEntries(ids.map((id) => [id, requireKeyFor(id)])),
        questionsPerAttempt: Object.fromEntries(ids.map((id) => [id, questionsFor(id)])),
        accessLog: accessStats() });
    }
    if (req.method === 'POST' && req.url === '/reveal') return await handleReveal(req, res);
    if (req.method === 'POST' && req.url === '/question') return await handleQuestion(req, res);
    if (req.method === 'POST' && req.url === '/closing') return await handleClosing(req, res);
    if (req.method === 'POST' && req.url === '/finish') return await handleFinish(req, res);
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message || 'bad request' });
  }
});

server.on('clientError', (err, socket) => {
  if (socket.destroyed) return;
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// An attempt is minutes long with big gaps between /reveal, /closing and
// /finish. Node's 5s default would drop idle keep-alive sockets in between;
// browsers reconnect transparently, but local tooling reusing a pooled socket
// would hit ECONNRESET. (Production is a Worker, where this does not apply.)
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

if (require.main === module) {
  server.listen(CFG.port, () => {
    console.log(`OralScale Signer v6 on :${CFG.port} — course "${COURSE.courseId}", assignments: ${Object.keys(COURSE.assignments || {}).join(', ')}`);
  });
}
module.exports = { server, CFG, COURSE, loadAssignment, accessLog };
