/*
 * OralScale Signer v6 — Cloudflare Worker (free tier). Mirrors server/signer.js.
 * Endpoints: POST /reveal /question /closing /finish, GET /health. Stateless; audio-free.
 * Optional D1 binding `DB` provides sliding-window rate limiting (the small DB).
 * Build data first:  node tools/build-worker.js  (writes bundle.json).
 */
import bundle from './bundle.json';

const COURSE = bundle.course;
const BANKS = bundle.banks; // assignmentId -> bank
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- base64url + HMAC via Web Crypto ----
function b64urlFromBytes(b) { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlToBytes(str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); str += '='.repeat((4 - (str.length % 4)) % 4); const bin = atob(str); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; }
async function hmacKey(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function signToken(secret, obj) { const p = JSON.stringify(obj); const k = await hmacKey(secret); const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(p))); return b64urlFromBytes(enc.encode(p)) + '.' + b64urlFromBytes(sig); }
async function verifyToken(secret, token) { if (typeof token !== 'string' || token.indexOf('.') < 0) throw new Error('malformed'); const [p, s] = token.split('.'); const pb = b64urlToBytes(p); const k = await hmacKey(secret); const ok = await crypto.subtle.verify('HMAC', k, b64urlToBytes(s), pb); if (!ok) throw new Error('bad signature'); return JSON.parse(dec.decode(pb)); }
/* Keyed tag for a bank digest (INV-DEPLOY-7). Must agree byte-for-byte with
 * bankTag() in server/lib/protocol.js — the Node tooling computes the same value
 * from the bank file on disk and compares. */
async function bankTag(secret, courseId, assignmentId, digest) {
  const b = await hmacBytes(secret, `bank:v1:${courseId}:${assignmentId}:${digest}`);
  let o = ''; for (let i = 0; i < 8; i++) o += b[i].toString(16).padStart(2, '0');
  return o;
}
async function hmacBytes(secret, str) { const k = await hmacKey(secret); return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(str))); }

// Bookend challenge codes (v4) — mirrors protocol.js deriveCode. Six digits, one at
// reveal and one at commit; no rolling stream (decision C2).
// FOUR since 2026-08-24, down from six. Must match server/lib/protocol.js and
// autograder/source/protocol.py — the reasoning, and the measurements showing
// why 3 fails open, are in protocol.js. The floor is 4; do not lower it.
const STALE_LINK_MSG =
  'This quiz link is for an assignment this course is not currently running. It is almost always an OLD LINK — ask your instructor for the current one. Nothing is wrong with your quiz key.';
const CODE_DIGITS = 4;
async function deriveCode(secret, attemptId, phase, n = CODE_DIGITS) { const b = await hmacBytes(secret, `${attemptId}:${phase}`); let o = ''; for (let i = 0; i < n; i++) o += String(b[i] % 10); return o; }
async function selectQuestionIndex(secret, m, n) { const d = await hmacBytes(secret, [m.bankId, m.assignmentId, m.studentRef, m.attemptSalt].join('␟')); let x = 0; for (let i = 0; i < 6; i++) x = x * 256 + d[i]; return x % n; }
/* Multi-question selection (v6) — mirrors protocol.js selectQuestionIndices.
   One derived salt per slot, collisions skipped, so a student never draws the
   same question twice inside one recording. */
async function selectQuestionIndices(secret, m, n, count, pools) {
  const want = Math.max(1, Math.min(Number(count) || 1, n));
  const picked = []; const seen = new Set();
  for (let j = 0; picked.length < want && j < want * 20 + 50; j++) {
    const pool = pools && pools[picked.length] && pools[picked.length].length ? pools[picked.length] : null;
    const raw = await selectQuestionIndex(secret, { ...m, attemptSalt: `${m.attemptSalt}#${j}` }, pool ? pool.length : n);
    const idx = pool ? pool[raw] : raw;
    if (seen.has(idx)) continue;
    seen.add(idx); picked.push(idx);
  }
  return picked;
}
/* Segment boundary codes (v6) — N questions have N+1 boundaries, and every
   interior code both closes the answer just given and opens the next question.
   For N = 1 the phases are "open"/"close", byte-identical to v4. */
/* CLIENT SPLIT MARKS (INV-GRADE-8) — mirrors normalizeClientMarks in
   server/lib/protocol.js; see that file for why these exist and why signing them
   is not trusting them. Allow-list, and FAILS SOFT: a malformed set is dropped
   and the attempt is still certified, because this runs after the student has
   finished speaking and a cosmetic field must never cost a good recording. */
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
function boundaryPhase(k, questionCount) { return k <= 0 ? 'open' : (k >= questionCount ? 'close' : 'b' + k); }
const deriveBoundaryCode = (secret, attemptId, k, questionCount, n = CODE_DIGITS) => deriveCode(secret, attemptId, boundaryPhase(k, questionCount), n);
/* Timings DERIVED from the code length, mirroring server/lib/protocol.js: one
   second per digit to read a boundary code aloud, doubled at the final code
   where nothing follows it to absorb a fumble. Instructors do not configure
   these; an explicit codeLeadSec / tailLimitSec in course.json still wins. */
const codeLeadDefault = (n = CODE_DIGITS) => Math.min(8, Math.max(4, Math.round(Number(n) || CODE_DIGITS)));
const tailLimitDefault = (n = CODE_DIGITS) => 2 * codeLeadDefault(n);
// Extended-time accommodations (INV-ACCOM-1). MUST match server/lib/protocol.js
// and autograder/source/protocol.py exactly — a student's countdown and the
// grader's verification have to agree on what "1.75x" means.
const TIME_MULTIPLIERS = [1, 1.25, 1.5, 1.75, 2];
function normalizeTimeMultiplier(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const hit = TIME_MULTIPLIERS.find((m) => Math.abs(m - value) < 1e-9);
  return hit === undefined ? null : hit;
}

/* Access keys (INV-SEC-8) — mirrors protocol.js exactly. See that file for the
   full rationale; the short version: the key is SELF-AUTHENTICATING —

       key = sid ‖ tag
       sid = base32(HMAC(Secret, "sid:v1:"‖courseId‖":"‖epoch‖":"‖email))[0..5]
       tag = base32(HMAC(Secret, "ktag:v1:"‖courseId‖":"‖sid))[0..9]

   so the Worker verifies enrolment by recomputing the tag: no roster at the edge,
   no D1 lookup, nothing to keep in sync. `sid` doubles as the identity, so the
   browser sends no email and nothing derived from one (INV-PRIV-2). */
const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SID_CHARS = 6;
const TAG_CHARS = 10;
const ACCESS_KEY_CHARS = SID_CHARS + TAG_CHARS;
function b32(d, n) { let o = ''; for (let i = 0; i < n; i++) o += KEY_ALPHABET[d[i] % 32]; return o; }
async function accessKeyTag(secret, courseId, sid) {
  return b32(await hmacBytes(secret, `ktag:v1:${courseId}:${sid}`), TAG_CHARS);
}
function normalizeAccessKey(input) {
  const raw = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  return raw.length === ACCESS_KEY_CHARS ? raw.replace(/(.{4})(?=.)/g, '$1-') : null;
}
async function verifyAccessKey(secret, courseId, given) {
  const norm = normalizeAccessKey(given);
  if (!norm) return { ok: false, studentRef: null };
  const raw = norm.replace(/-/g, '');
  const sid = raw.slice(0, SID_CHARS);
  const expect = await accessKeyTag(secret, courseId, sid);
  const got = raw.slice(SID_CHARS);
  // Constant-time over equal-length ASCII: the key is attacker-supplied.
  if (expect.length !== got.length) return { ok: false, studentRef: null };
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0 ? { ok: true, studentRef: 'k:' + sid } : { ok: false, studentRef: null };
}
// Identity ref validation — mirrors protocol.js isValidStudentRef (INV-SEC-6).
const EMAIL_REF_RE = /^e:[0-9a-f]{32}$/;
const PSEUDONYM_RE = /^p:[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
function isValidStudentRef(r) { return typeof r === 'string' && (EMAIL_REF_RE.test(r) || PSEUDONYM_RE.test(r)); }
function hex(b) { return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function newId(n = 12) { return hex(crypto.getRandomValues(new Uint8Array(n))); }
/* KEYED, not plain. Everything this Worker writes to D1 is a hash of something
   drawn from a TINY domain: an IPv4 address is 32 bits and a studentRef is a
   30-bit id, so a plain SHA-256 truncated to 64 bits is invertible by anyone
   with the table and an afternoon — enumerate the domain, hash, compare. That
   made the schema's "no PII at the edge" claim untrue in exactly the case it was
   written for: someone who has obtained the database.

   HMAC under the signing Secret closes it. The Secret never leaves the Signer
   env (INV-SEC-4), so the rows are opaque to anyone holding only the database,
   while the Worker can still recompute a key to look one up. Found in the
   2026-08-21 edge-database audit (models/06, finding F-2). */
async function tag16(secret, str) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(str)))).slice(0, 16);
}
const now = () => Math.floor(Date.now() / 1000);

function json(status, obj, origin) {
  return new Response(JSON.stringify(obj), { status, headers: {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Cache-Control': 'no-store' } });
}

// ---- D1 sliding-window rate limit (optional; INV-SEC-5) ----
// The per-IP allowance is deliberately generous: a 200-student lecture hall sits
// behind ONE campus NAT address, so a tight per-address limit throttles the class
// rather than an attacker. Per-IDENTITY buckets bound the individual.
const IP_LIMIT_PER_MIN = 600;
async function rateOk(env, key, limitPerMin) {
  if (!env.DB) return true; // no DB bound -> rely on edge + short-circuit only
  const t = now();
  try {
    await env.DB.prepare('DELETE FROM rl WHERE ts < ?').bind(t - 60).run();
    const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM rl WHERE k = ?').bind(key).first();
    if (r && r.c >= limitPerMin) return false;
    await env.DB.prepare('INSERT INTO rl (k, ts) VALUES (?, ?)').bind(key, t).run();
    return true;
  } catch { return true; } // never let the limiter take down the service
}

/* Retake cooldown (INV-SEC-7) — bounds question shopping. See server/signer.js for the
   full rationale. An attempt that was FINISHED clears the cooldown at once, so only
   someone who bails on a question they just saw has to wait. */
function knob(assignmentId, name, dflt) {
  const a = (COURSE.assignments || {})[assignmentId] || {};
  const v = a[name] != null ? a[name] : (COURSE.defaults || {})[name];
  return v != null ? Number(v) : dflt;
}
function flagKnob(assignmentId, name, dflt) {
  const a = (COURSE.assignments || {})[assignmentId] || {};
  const v = a[name] != null ? a[name] : (COURSE.defaults || {})[name];
  return v != null ? !!v : dflt;
}
// Fails CLOSED: an assignment that says nothing about the gate gets the gate.
const requireKeyFor = (id) => flagKnob(id, 'requireAccessKey', true);
const questionsFor = (id) => Math.max(1, Math.round(knob(id, 'questionsPerAttempt', 1)));
/* Buffer = seconds a student may keep talking after the visible countdown hits
   0:00. Separate from limitSec (the promise made to the student) and from
   graceSec (clock skew) on purpose — see server/signer.js. */
const bufferFor = (id) => Math.max(0, knob(id, 'bufferSec', 20));
const codeDigitsFor = (id) => Math.min(8, Math.max(4, Math.round(knob(id, 'codeDigits', CODE_DIGITS))));
/* Per-slot difficulty pools for `difficultyMix`. A slot whose difficulty is absent
   from this bank falls back to the whole bank — a mis-set mix must never cost a
   student their quiz. */
/* WHAT THE STUDENT'S BROWSER RECEIVES (INV-COURSE-5, INV-PRIV-7).
 *
 * tools/build-worker.js has already reduced each bundled question to
 * id/difficulty/prompt (+ topic/principle where the assignment opted in), so on a
 * freshly built bundle this is a copy. It is written as an allow-list ANYWAY
 * because a Worker can be running a bundle built by an older tool, and the one
 * thing that must not depend on build hygiene is whether the answer key reaches
 * the wire. */
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
    const pool = byDiff.get(String(mix[slot % mix.length]));
    pools.push(pool && pool.length ? pool : null);
  }
  return pools;
}
const cooldownFor = (id) => knob(id, 'retakeCooldownSec', 300);
// Real elapsed time required before an attempt clears the cooldown -- without it,
// reveal -> /closing -> /finish takes under a second and the cooldown is a no-op.
const clearsAfterFor = (id) => Math.min(knob(id, 'cooldownClearsAfterSec', 60), knob(id, 'limitSec', 180));
async function cooldownRemaining(env, key, assignmentId) {
  const secs = cooldownFor(assignmentId);
  if (!secs || !env.DB) return null;
  try {
    const r = await env.DB.prepare('SELECT t_reveal, finished FROM attempt WHERE k = ?').bind(key).first();
    if (!r || r.finished) return null;
    const left = r.t_reveal + secs - now();
    return left > 0 ? left : null;
  } catch { return null; }              // never let the limiter take down the service
}
async function noteReveal(env, key, attemptId, tReveal) {
  if (!env.DB) return;
  try {
    await env.DB.prepare('INSERT INTO attempt (k, attempt_id, t_reveal, finished) VALUES (?, ?, ?, 0) '
      + 'ON CONFLICT(k) DO UPDATE SET attempt_id = excluded.attempt_id, t_reveal = excluded.t_reveal, finished = 0')
      .bind(key, attemptId, tReveal).run();
    /* A cooldown row is useful for minutes; keeping it for a term would leave a
       permanent record that this pseudonymous student opened this assignment at
       this time, which the cooldown does not need (INV-PRIV-5). Swept here
       rather than on a schedule because a Worker has no cron of its own and this
       is the only write path. */
    await env.DB.prepare('DELETE FROM attempt WHERE t_reveal < ?').bind(now() - 86400).run();
  } catch { /* hardening only */ }
}
async function noteAttemptEnd(env, key, assignmentId, attemptId, tReveal, tEnd) {
  if (!env.DB) return;
  if (tEnd - tReveal < clearsAfterFor(assignmentId)) return;   // too short to be a real attempt
  try { await env.DB.prepare('UPDATE attempt SET finished = 1 WHERE k = ? AND attempt_id = ?').bind(key, attemptId).run(); }
  catch { /* hardening only */ }
}

/* Access-attempt log (INV-SEC-9) + key-guessing lockout.
   A blocked bank-mining attempt should also be a VISIBLE one: a burst of
   KEY_INVALID rows from one address is the signature of someone guessing keys.
   Rows carry a hashed opaque ref and a hashed IP — never an address, never PII. */
const KEY_FAIL_LIMIT = 10;
const KEY_FAIL_WINDOW_SEC = 900;
async function logAccess(env, row) {
  if (!env.DB) return;
  try {
    await env.DB.prepare('INSERT INTO access_log (ts, event, reason, ref_hash, ip_hash, assignment) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(now(), row.event, row.reason, row.refHash, row.ipHash, row.assignmentId).run();
    await env.DB.prepare('DELETE FROM access_log WHERE ts < ?').bind(now() - 7 * 86400).run();
  } catch { /* logging must never break an attempt */ }
}
/* A forged key names nobody — there is no identity to attach a lockout to until
   the key verifies — so this one IS keyed on the source address. That cuts the
   other way from the campus-NAT argument in models/06 T18, so the threshold is
   deliberately loose (10 invalid keys in 15 min from one address) and the window
   is short: a whole lecture hall fumbling their own keys ten times in a quarter
   of an hour is possible but recoverable, while an unbounded forgery loop is not
   something to leave open. Honest students never see it — their key is pasted
   from Brightspace and either works or does not. */
async function keyLockedOut(env, ipHash) {
  if (!env.DB) return false;
  try {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM access_log WHERE reason = 'KEY_INVALID' AND ts > ? AND ip_hash = ?")
      .bind(now() - KEY_FAIL_WINDOW_SEC, ipHash).first();
    return !!(r && r.c >= KEY_FAIL_LIMIT);
  } catch { return false; }
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || '*';
    const grace = Number(env.GRACE_SEC || 20);
    const secret = env.ORALSCALE_SECRET;
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') || 'ip';
    /* The address is turned into a keyed tag ONCE, here, and the raw value never
       reaches the database — not as a rate-limit key, not as a log column. It
       used to be the literal `rl.k` value, which quietly made the edge store
       plaintext addresses (audit finding F-1, 2026-08-21). */
    const ipHash = secret ? await tag16(secret, 'ip\u241F' + ip) : 'ip';

    // 204 is a null-body status: `new Response(body, {status:204})` THROWS in
    // Workers, which surfaced as a 500 on every CORS preflight — i.e. no browser
    // could talk to the Signer at all, while curl (no preflight) worked fine.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      } });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      // cooldownEnforced tells the instructor the truth: INV-SEC-7 needs D1, and
      // without the binding the retake cooldown silently does nothing.
      const ids = Object.keys(COURSE.assignments || {});
      const wantsCooldown = ids.some((id) => cooldownFor(id) > 0);
      const warnings = [];
      if (wantsCooldown && !env.DB) warnings.push('retakeCooldownSec is configured but no D1 binding is present — the cooldown is NOT enforced (INV-SEC-7). Bind DB in wrangler.toml.');
      // The access gate itself is pure crypto and works without D1 — but the log
      // and the guessing lockout do not, so say so rather than let it look fine.
      if (ids.some((id) => requireKeyFor(id)) && !env.DB) warnings.push('access keys are required but no D1 binding is present — key checks still work, but failed attempts are NOT logged and the guessing lockout is NOT enforced (INV-SEC-9).');
      if (ids.some((id) => !requireKeyFor(id))) warnings.push('some assignments have requireAccessKey=false — anyone can open questions under an invented identity and mine that bank (INV-SEC-8): ' + ids.filter((id) => !requireKeyFor(id)).join(', '));
      return json(200, { ok: true, courseId: COURSE.courseId,
        assignments: ids,
        db: !!env.DB,
        // Tri-state, deliberately. `cooldownEnforced:false` used to mean two
        // completely different things -- "the D1 binding failed, students can
        // reroll freely" and "this course set retakeCooldownSec:0 on purpose" --
        // and the deploy gate printed the same alarming warning for both. An
        // instructor whose ungraded practice quiz trips a scary warning on every
        // deploy learns to ignore the one line the guide tells them to check.
        cooldownConfigured: wantsCooldown,
        cooldownEnforced: !!env.DB && wantsCooldown,
        accessKeyRequired: Object.fromEntries(ids.map((id) => [id, requireKeyFor(id)])),
        accessLogEnabled: !!env.DB,
        questionsPerAttempt: Object.fromEntries(ids.map((id) => [id, questionsFor(id)])),
        /* WHICH BANK IS ACTUALLY DEPLOYED (INV-DEPLOY-7).
         *
         * `assignments` above says which assignments exist; these say which
         * QUESTIONS are behind them. Without that, a bank revised in place —
         * same bankId, same question ids — is invisible from outside, and a
         * Worker and a Gradescope zip built from different revisions mis-grade
         * silently instead of failing, because the grader resolves a
         * submission's questions BY ID.
         *
         * `bankRevision` is the human-readable string an instructor reads.
         * `bankTag` is HMAC(Secret, digest-of-the-bank-file), NOT the digest:
         * this endpoint is public, and a plain digest would let anyone holding a
         * leaked bank confirm it is the real one. The tag verifies against
         * tools/verify-deployment.js, which has the Secret, and tells everybody
         * else nothing. Absent when the Worker has no Secret configured. */
        bankRevision: Object.fromEntries(ids.map((id) => [id, (BANKS[id] || {}).revision])),
        bankTag: secret ? Object.fromEntries(await Promise.all(ids.map(async (id) =>
          [id, (BANKS[id] || {}).bankDigest
            ? await bankTag(secret, COURSE.courseId, id, BANKS[id].bankDigest) : undefined]))) : undefined,
        warning: warnings.length ? warnings.join(' ') : undefined }, origin);
    }
    if (!secret) return json(500, { error: 'signer misconfigured: no secret' }, origin);

    try {
      if (request.method === 'POST' && url.pathname === '/reveal') {
        if (!(await rateOk(env, 'ip:' + ipHash, IP_LIMIT_PER_MIN))) return json(429, { error: 'rate limited' }, origin);
        // v3: one PUBLIC course link + an opaque client-supplied studentRef.
        // v2 quizToken still accepted for accommodation links (timeMultiplier).
        const body = await request.json();
        const { courseToken, studentRef, quizToken, accessKey } = body;
        // Student-selected extended time. A CLAIM, not an authorisation — it is
        // verified against the instructor's roster at grading time. Refuse
        // anything off the ladder rather than clamping: silently granting less
        // time than asked for surfaces as a countdown dying mid-sentence.
        const claimedMult = normalizeTimeMultiplier(
          body.timeMultiplier === undefined ? undefined : Number(body.timeMultiplier));
        if (claimedMult === null) return json(400, { code: 'BAD_MULTIPLIER', error: `timeMultiplier must be one of ${TIME_MULTIPLIERS.join(', ')}` }, origin);
        // A burst of forged keys names nobody, so it can only be bounded by source.
        if (await keyLockedOut(env, ipHash)) {
          await logAccess(env, { assignmentId: '-', refHash: '-', ipHash, event: 'denied', reason: 'KEY_LOCKED' });
          return json(429, { code: 'KEY_LOCKED', error: 'Too many invalid quiz keys from this connection. Wait 15 minutes and try again with the key from Brightspace — or ask your instructor to resend it.' }, origin);
        }
        let quiz;
        if (courseToken) {
          let c; try { c = await verifyToken(secret, courseToken); } catch { return json(401, { error: 'invalid course token' }, origin); }
          if (c.kind !== 'course') return json(400, { error: 'not a course token' }, origin);
          if (c.exp && now() > c.exp) return json(403, { error: 'this quiz link has expired — ask your instructor for the current link' }, origin);
          /* THE ASSIGNMENT MUST STILL EXIST — checked before any identity branch.
           *
           * A link outlives the assignment it names. Without this, an old link
           * fell through to whichever branch the MISSING config happened to
           * imply: requireKeyFor() reads a knob off an assignment that is not
           * there, gets undefined, and takes the open-mode path — so a student
           * holding a perfectly good key was told "studentRef must be an opaque
           * emailRef", which is true of nothing they did and fixes nothing.
           * Observed on the public demo after `try` became `demo-quiz`. */
          if (!(COURSE.assignments || {})[c.assignmentId]) {
            return json(404, { code: 'ASSIGNMENT_GONE',
              error: 'This quiz link is out of date — it points at an assignment that no longer '
                   + 'exists. Get the current link from your assignment in Gradescope. '
                   + '(Your quiz key is fine and does not change.)' }, origin);
          }
          if (requireKeyFor(c.assignmentId)) {
            // KEY-ONLY MODE: the key proves enrolment AND names the Student, so no
            // email or email-derived value is ever sent. Any client-supplied
            // studentRef is ignored — identity comes only from the Secret.
            const logRow = { assignmentId: c.assignmentId, ipHash, refHash: '-' };
            if (!accessKey) {
              await logAccess(env, { ...logRow, event: 'denied', reason: 'KEY_REQUIRED' });
              return json(401, { code: 'KEY_REQUIRED', error: 'This quiz needs your personal quiz key — it is the only thing you have to enter. It was posted for you in Brightspace, and it is also in your Gradescope feedback if you submit this assignment without a recording. It looks like ABCD-EFGH-JKMN-PQRS.' }, origin);
            }
            const check = await verifyAccessKey(secret, COURSE.courseId, accessKey);
            if (!check.ok) {
              await logAccess(env, { ...logRow, event: 'denied', reason: 'KEY_INVALID' });
              return json(403, { code: 'KEY_INVALID', error: "That is not a valid quiz key for this course. Check for a mistyped character — your key is in Brightspace (and in your Gradescope feedback if you submit with no recording). Keys are per course, so last term's will not work." }, origin);
            }
            quiz = { assignmentId: c.assignmentId, studentRef: check.studentRef, timeMultiplier: claimedMult, accommodationSource: claimedMult > 1 ? 'student-selected' : 'none', keyChecked: 'accessKey' };
          } else {
            // OPEN MODE (requireAccessKey:false). INV-SEC-6: validate the
            // client-supplied ref BEFORE any crypto/bank work.
            if (!isValidStudentRef(studentRef)) return json(400, { error: 'studentRef must be an opaque emailRef or private code' }, origin);
            quiz = { assignmentId: c.assignmentId, studentRef, timeMultiplier: claimedMult, accommodationSource: claimedMult > 1 ? 'student-selected' : 'none', keyChecked: 'not-required' };
          }
        } else if (quizToken) {
          let q; try { q = await verifyToken(secret, quizToken); } catch { return json(401, { error: 'invalid quiz token' }, origin); }
          if (q.kind !== 'quiz') return json(400, { error: 'not a quiz token' }, origin);
          if (q.exp && now() > q.exp) return json(403, { error: 'this quiz link has expired — get a fresh link from Gradescope' }, origin);
          const mintedMult = normalizeTimeMultiplier(Number(q.timeMultiplier || 1)) || 1;
          quiz = { assignmentId: q.assignmentId, studentRef: q.studentRef, timeMultiplier: mintedMult, accommodationSource: mintedMult > 1 ? 'instructor-link' : 'none', keyChecked: 'quizToken' };
        } else {
          return json(400, { error: 'courseToken + your quiz key (or a legacy quizToken) required' }, origin);
        }
        const keyChecked = quiz.keyChecked;
        await logAccess(env, { assignmentId: quiz.assignmentId, ipHash, refHash: await tag16(secret, quiz.studentRef), event: 'granted', reason: keyChecked });
        // The course link is shared class-wide, so rate-limit per identity, not per token.
        if (!(await rateOk(env, 'sref:' + (await tag16(secret, quiz.studentRef)), 30))) return json(429, { error: 'rate limited' }, origin);
        const aKey = 'att:' + (await tag16(secret, quiz.studentRef + '␟' + quiz.assignmentId));
        const wait = await cooldownRemaining(env, aKey, quiz.assignmentId);
        if (wait != null) return json(429, { code: 'COOLDOWN', retryAfterSec: wait,
          error: `You opened a question and did not finish it. You can start a new one in ${Math.ceil(wait / 60)} min — or finish an attempt and retake right away.` }, origin);
        const a = COURSE.assignments[quiz.assignmentId]; const bank = BANKS[quiz.assignmentId];
        // Tell a student what to do, not what our data model calls it. This is
        // the failure a stale link produces after a course is re-bundled.
        if (!a || !bank) return json(409, { code: 'UNKNOWN_ASSIGNMENT', error: STALE_LINK_MSG }, origin);

        const timeMult = quiz.timeMultiplier;
        const limitSec = Math.round(knob(quiz.assignmentId, 'limitSec', 180) * timeMult);
        const bufferSec = Math.round(bufferFor(quiz.assignmentId) * timeMult);
        const codeDigits = codeDigitsFor(quiz.assignmentId);
        const codeLeadSec = Math.max(0, knob(quiz.assignmentId, 'codeLeadSec', codeLeadDefault(codeDigits)));
        const attemptSalt = newId(8); const attemptId = newId(12);
        // All the attempt's questions are chosen NOW, so the set is fixed before
        // the first word is spoken — a student cannot reroll question 2 by
        // replaying the middle of the flow.
        const questionCount = Math.min(questionsFor(quiz.assignmentId), bank.questions.length);
        const idxs = await selectQuestionIndices(secret, { bankId: bank.bankId, assignmentId: quiz.assignmentId, studentRef: quiz.studentRef, attemptSalt }, bank.questions.length, questionCount, difficultyPools(quiz.assignmentId, bank.questions, questionCount));
        const questionIds = idxs.map((i) => bank.questions[i].id);
        const tReveal = now();
        const TAIL = Math.max(5, knob(quiz.assignmentId, 'tailLimitSec',
          env.TAIL_LIMIT_SEC != null ? Number(env.TAIL_LIMIT_SEC) : tailLimitDefault(codeDigits)));
        // The question is chosen now but WITHHELD — /question hands it over once
        // codeLeadSec has passed, so the opening code cannot be skipped and the
        // question cannot be read early from this response.
        const revealToken = await signToken(secret, { v: 6, kind: 'reveal', courseId: COURSE.courseId, assignmentId: quiz.assignmentId, studentRef: quiz.studentRef, attemptId, attemptSalt, questionIds, questionCount, qIndex: 0, questionId: questionIds[0], tStart: tReveal, tReveal, segments: [], keyChecked, codeLeadSec, limitSec, bufferSec, codeDigits, tailLimitSec: TAIL, timeMultiplier: timeMult, accommodationSource: quiz.accommodationSource || 'none', baseLimitSec: knob(quiz.assignmentId, 'limitSec', 180), baseBufferSec: bufferFor(quiz.assignmentId) });
        await noteReveal(env, aKey, attemptId, tReveal);
        const code0 = await deriveBoundaryCode(secret, attemptId, 0, questionCount, codeDigits);
        return json(200, { revealToken, attemptId, tReveal, codeLeadSec, limitSec, bufferSec, tailLimitSec: TAIL,
          questionCount, qIndex: 0, qNumber: 1, code: code0, openingCode: code0 }, origin);
      }

      if (request.method === 'POST' && url.pathname === '/question') {
        const { revealToken } = await request.json();
        if (!revealToken) return json(400, { error: 'revealToken required' }, origin);
        let r; try { r = await verifyToken(secret, revealToken); } catch { return json(401, { error: 'invalid reveal token' }, origin); }
        if (r.kind !== 'reveal') return json(400, { error: 'not a reveal token' }, origin);
        const readyAt = r.tReveal + r.codeLeadSec;
        if (now() < readyAt) return json(200, { ready: false, availableInSec: readyAt - now() }, origin);
        const bank2 = BANKS[r.assignmentId];
        if (!bank2) return json(409, { code: 'UNKNOWN_ASSIGNMENT', error: STALE_LINK_MSG }, origin);
        const q2 = bank2.questions.find((x) => x.id === r.questionId);
        if (!q2) return json(409, { error: 'question not in bank' }, origin);
        const tQuestion = now();
        const buffer = Number(r.bufferSec || 0);
        const deadline = tQuestion + r.limitSec + buffer + grace;
        return json(200, { ready: true, tQuestion, deadline, limitSec: r.limitSec, bufferSec: buffer,
          qIndex: r.qIndex, qNumber: (r.qIndex || 0) + 1, questionCount: r.questionCount,
          questionToken: await signToken(secret, { ...r, kind: 'question', tQuestion, deadline }),
          question: servedQuestion(q2, r.assignmentId) }, origin);
      }

      if (request.method === 'POST' && url.pathname === '/closing') {
        const { questionToken } = await request.json();
        if (!questionToken) return json(400, { error: 'questionToken required' }, origin);
        let r; try { r = await verifyToken(secret, questionToken); } catch { return json(401, { error: 'invalid question token' }, origin); }
        if (r.kind !== 'question') return json(400, { error: 'get the question before finishing' }, origin);
        const tClosing = now();
        if (tClosing > r.deadline) return json(403, { code: 'DEADLINE_EXCEEDED', tReveal: r.tReveal, deadline: r.deadline,
          error: 'time limit exceeded — the recording window closed before you finished' }, origin);
        const TAIL = Number(r.tailLimitSec || tailLimitDefault(r.codeDigits || CODE_DIGITS));
        const tStart = r.tStart != null ? r.tStart : r.tReveal;
        await noteAttemptEnd(env, 'att:' + (await tag16(secret, r.studentRef + '␟' + r.assignmentId)), r.assignmentId, r.attemptId, tStart, tClosing);
        // Record the segment just answered. `segments` accumulates inside the signed
        // token, so the Signer still remembers nothing between requests.
        const segments = (r.segments || []).concat([{ index: r.qIndex, questionId: r.questionId, tReveal: r.tReveal, tQuestion: r.tQuestion, tClosing, limitSec: r.limitSec, bufferSec: Number(r.bufferSec || 0) }]);
        const boundary = (r.qIndex || 0) + 1;
        const more = boundary < r.questionCount;
        const code = await deriveBoundaryCode(secret, r.attemptId, boundary, r.questionCount, r.codeDigits || CODE_DIGITS);
        const out = { closingToken: await signToken(secret, { ...r, kind: 'closing', tClosing, segments }), tClosing,
          code, closingCode: code, tailLimitSec: TAIL, more, qIndex: r.qIndex, questionCount: r.questionCount, answered: boundary };
        if (more) {
          // The SAME code opens the next question: one reading, two jobs.
          out.nextRevealToken = await signToken(secret, { ...r, kind: 'reveal', qIndex: boundary, questionId: r.questionIds[boundary], tReveal: tClosing, segments, tQuestion: undefined, deadline: undefined });
          out.nextQNumber = boundary + 1;
        }
        return json(200, out, origin);
      }

      if (request.method === 'POST' && url.pathname === '/finish') {
        if (!(await rateOk(env, 'ip:' + ipHash, IP_LIMIT_PER_MIN))) return json(429, { error: 'rate limited' }, origin);
        const { closingToken, audioSHA256, durationSec, clientMarks } = await request.json();
        if (!closingToken || !audioSHA256) return json(400, { error: 'closingToken and audioSHA256 required' }, origin);
        if (!/^[0-9a-f]{64}$/.test(String(audioSHA256))) return json(400, { error: 'bad audioSHA256' }, origin);
        let r; try { r = await verifyToken(secret, closingToken); } catch { return json(401, { error: 'invalid closing token' }, origin); }
        // A RevealToken must not work here — that would let a client skip the closing code (INV-INTEGRITY-5).
        if (r.kind !== 'closing') return json(400, { error: 'call /closing before /finish' }, origin);
        // …and a mid-attempt ClosingToken must not certify either: on a multi-question
        // attempt that would bank the questions already seen and drop the rest.
        const segs = r.segments || [];
        if (segs.length < r.questionCount) return json(400, { code: 'QUESTIONS_REMAINING', answered: segs.length, questionCount: r.questionCount, error: `answer all ${r.questionCount} questions before finishing (${segs.length} done)` }, origin);
        const tFinish = now();
        const tStart = r.tStart != null ? r.tStart : r.tReveal;
        const TAIL = Number(r.tailLimitSec || tailLimitDefault(r.codeDigits || CODE_DIGITS));
        if (tFinish > r.tClosing + TAIL) {
          await noteAttemptEnd(env, 'att:' + (await tag16(secret, r.studentRef + '␟' + r.assignmentId)), r.assignmentId, r.attemptId, tStart, tFinish);
          return json(403, { error: 'took too long after the closing code — retake for a fresh question', code: 'TAIL_EXCEEDED', tClosing: r.tClosing, tFinish }, origin);
        }
        if (tFinish > r.deadline + TAIL) return json(403, { error: 'time limit exceeded — recording finished after the deadline', code: 'DEADLINE_EXCEEDED', tReveal: r.tReveal, deadline: r.deadline, tFinish }, origin);
        const elapsedSec = tFinish - tStart;
        // Offsets are measured from tStart — when recording and the first code began —
        // so they line up with word timestamps in the transcript.
        const segOut = segs.map((sg) => ({ index: sg.index, questionId: sg.questionId, limitSec: sg.limitSec, bufferSec: sg.bufferSec, tReveal: sg.tReveal, tQuestion: sg.tQuestion, tClosing: sg.tClosing, revealOffsetSec: sg.tReveal - tStart, questionOffsetSec: sg.tQuestion - tStart, closingOffsetSec: sg.tClosing - tStart, answerSec: sg.tClosing - sg.tQuestion }));
        const firstSeg = segOut[0]; const lastSeg = segOut[segOut.length - 1];
        const certificate = { v: 6, kind: 'certificate', courseId: r.courseId, assignmentId: r.assignmentId, studentRef: r.studentRef, attemptId: r.attemptId,
          accessKeyVerified: r.keyChecked === 'accessKey' || r.keyChecked === 'quizToken', keyChecked: r.keyChecked || 'not-required',
          questionCount: r.questionCount, questionIds: r.questionIds, segments: segOut,
          tStart, tFinish, elapsedSec, deadline: r.deadline, codeLeadSec: r.codeLeadSec, codeDigits: r.codeDigits || CODE_DIGITS, boundaryCount: r.questionCount + 1,
          limitSecPerQuestion: r.limitSec, bufferSec: Number(r.bufferSec || 0), tailLimitSec: TAIL,
          // single-question mirrors (v5 field names) — a one-question attempt is byte-compatible
          questionId: firstSeg.questionId, tReveal: tStart, tQuestion: firstSeg.tQuestion, tClosing: lastSeg.tClosing,
          questionOffsetSec: firstSeg.questionOffsetSec, closingOffsetSec: lastSeg.closingOffsetSec,
          answerSec: segOut.reduce((a, sg) => a + sg.answerSec, 0), limitSec: r.limitSec,
          audioSHA256: String(audioSHA256), clientDurationSec: durationSec != null ? Number(durationSec) : null,
          // CLIENT-ASSERTED (INV-GRADE-8). Signed so it is tamper-evident, never
          // consulted by any integrity check. Absent when the browser sent none or
          // sent something malformed.
          clientMarks: normalizeClientMarks(clientMarks) || undefined,
          // Extended-time accommodation (INV-ACCOM-1) — signed, so the claim is
          // tamper-evident and checkable against Gradescope without asking the student.
          accommodation: { claimedMultiplier: Number(r.timeMultiplier || 1), source: r.accommodationSource || 'none', baseLimitSec: Number(r.baseLimitSec != null ? r.baseLimitSec : r.limitSec), baseBufferSec: Number(r.baseBufferSec != null ? r.baseBufferSec : (r.bufferSec || 0)) } };
        await noteAttemptEnd(env, 'att:' + (await tag16(secret, r.studentRef + '␟' + r.assignmentId)), r.assignmentId, r.attemptId, tStart, tFinish);
        return json(200, { certificate, certificateToken: await signToken(secret, certificate) }, origin);
      }
      return json(404, { error: 'not found' }, origin);
    } catch (e) { return json(400, { error: e.message || 'bad request' }, origin); }
  },
};
