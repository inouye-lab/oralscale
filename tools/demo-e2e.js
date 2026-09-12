#!/usr/bin/env node
'use strict';
/*
 * OralScale full-system E2E + ATTACK suite (no browser).
 * Exercises the real Signer (reveal/pulse/finish) and the real Python autograder
 * over crafted submissions, asserting the invariants in models/07-test-model.md:
 *   - honest submission PASSES and scores > 0
 *   - every attack FAILS to earn credit
 *   - identity is bound at submission time (v3 public link + typed email / private code)
 *
 *   node tools/demo-e2e.js
 * Exit code 0 only if every expectation holds.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const P = require('../server/lib/protocol');
const SECRETS = require('./lib/secrets.js');
const { writeWav } = require('./lib/wav');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.demo');
const PORT = Number(process.env.PORT || 8791);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIGIT = ['zero','one','two','three','four','five','six','seven','eight','nine'];

let secret;
/* THE FIXTURE COURSE'S OWN SECRET, not the legacy shared one.
 *
 * This read server/config.json, which stopped being the right answer when the
 * shared-secret fallback was removed: the autograder zip is built from the
 * fixture course and carries secrets/testsuite.json, so the suite was signing
 * tokens with one Secret and grading them with another. Every certificate
 * failed to verify, which surfaced as an undefined certificate three frames
 * away from the cause. */
function ensureSecret() {
  let r = SECRETS.resolve(COURSE_PATH, COURSE_ID);
  if (!r) {
    spawnSync('node', [path.join(ROOT, 'tools', 'make-config.js'), '--course', COURSE_PATH],
      { stdio: 'inherit' });
    r = SECRETS.resolve(COURSE_PATH, COURSE_ID);
  }
  if (!r) throw new Error(`no signing Secret for the fixture course "${COURSE_ID}"`);
  return r.secret;
}
async function waitHealth(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('signer never healthy');
}
const post = async (path_, body) => {
  // 'connection: close' on purpose: transcription can take ~30s, and a pooled
  // socket idling across that would be closed by the server and then reused,
  // surfacing as a spurious ECONNRESET mid-suite.
  const r = await fetch(BASE + path_, { method: 'POST',
    headers: { 'Content-Type': 'application/json', connection: 'close' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
// The FIXTURE course, not the public demo. The demo now holds exactly one
// assignment so it can never mis-route (INV-DEPLOY-3); everything this suite
// drives — a one-second deadline, an open assignment, a keyed one — lives in
// courses/_testsuite/ so those shapes cannot leak into what an instructor sees.
const COURSE_PATH = path.join(ROOT, 'courses', '_testsuite', 'course.json');
const COURSE = JSON.parse(fs.readFileSync(COURSE_PATH, 'utf8'));
const COURSE_ID = COURSE.courseId;
function courseToken(assignmentId, days = 120) {
  return P.signToken(secret, { v: 3, kind: 'course', courseId: COURSE_ID, assignmentId,
    pseudonymSalt: COURSE.pseudonymSalt, exp: Math.floor(Date.now() / 1000) + days * 86400 });
}
function quizToken(assignmentId, studentRef, minutes = 20) {
  return P.signToken(secret, { v: 2, kind: 'quiz', courseId: COURSE_ID, assignmentId, studentRef, timeMultiplier: 1, exp: Math.floor(Date.now() / 1000) + minutes * 60 });
}

/**
 * Build a words.json for an attempt: every BOUNDARY code spoken at its moment,
 * with each question's answer in the segment between the codes that bracket it.
 *
 * An attempt with N questions has N+1 codes:  b0 Q1 b1 Q2 b2 … Q(N) bN.
 *
 *   skipCodes: [k]   -> a boundary code never spoken (attack cases)
 *   garble: n        -> flip n digits of every code, to probe the fuzzy tolerance
 *   answerOnly: [i]  -> speak the answer to only these questions (attribution test)
 */
function buildWords(attemptId, cert, byId, { skipCodes = [], garble = 0, answerOnly = null } = {}) {
  const words = [];
  const push = (word, t) => words.push({ word, start: +t.toFixed(2), end: +(t + 0.02).toFixed(2) });
  const sayCode = (code, t0, flips) => {
    const digits = String(code).split('');
    for (let i = 0; i < flips && i < digits.length; i++) digits[i] = String((+digits[i] + 5) % 10);
    digits.forEach((d, i) => push(DIGIT[+d], t0 + i * 0.05));
  };
  const segs = cert.segments && cert.segments.length ? cert.segments : [{
    index: 0, questionId: cert.questionId,
    questionOffsetSec: cert.questionOffsetSec != null ? cert.questionOffsetSec : 0,
    closingOffsetSec: cert.closingOffsetSec != null ? cert.closingOffsetSec : cert.elapsedSec,
  }];
  const n = segs.length;
  for (let k = 0; k <= n; k++) {
    if (!skipCodes.includes(k)) {
      const t0 = k === 0 ? 0.05 : Number(segs[k - 1].closingOffsetSec) + 0.05;
      sayCode(P.deriveBoundaryCode(secret, attemptId, k, n), t0, garble);
    }
    if (k === n) break;
    if (answerOnly && !answerOnly.includes(k)) continue;
    // The answer must land INSIDE its own segment: the grader slices the transcript
    // by these timestamps, so a word that drifts past closingOffsetSec is credited
    // to the wrong question (or to none).
    const q = byId[segs[k].questionId];
    const ans = (q.keyPoints || []).join(' ').split(/\s+/).filter(Boolean);
    const t0 = Number(segs[k].questionOffsetSec) + 0.4;
    const span = Math.max(0.2, Number(segs[k].closingOffsetSec) - t0 - 0.3);
    const step = Math.min(0.05, span / Math.max(1, ans.length));
    ans.forEach((w, i) => push(w.replace(/[^a-zA-Z]/g, ''), t0 + i * step));
  }
  return words.sort((a, b) => a.start - b.start);
}

function writeSubmission(dir, { wavSeconds, cert, certToken, words, metaEmail }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeWav(path.join(dir, 'answer.wav'), wavSeconds);
  fs.writeFileSync(path.join(dir, 'certificate.json'), JSON.stringify({ ...cert, certificateToken: certToken, audioFile: 'answer.wav' }, null, 2));
  if (words) fs.writeFileSync(path.join(dir, 'words.json'), JSON.stringify(words));
  fs.writeFileSync(path.join(dir, '..', 'submission_metadata.json'), JSON.stringify({ users: [{ email: metaEmail || cert.studentRef, name: 'Test Student', id: 1 }] }));
  return dir;
}

function runAutograder(assignmentId, subDir, extra = {}) {
  const metaPath = path.join(subDir, '..', 'submission_metadata.json');
  const resPath = path.join(subDir, '..', 'results.json');
  const env = { ...process.env, ORALSCALE_SECRET: secret, ORALSCALE_ASSIGNMENT: assignmentId,
    // Tests hand the grader a words.json instead of running Whisper. That is a
    // TEST-ONLY affordance and must be opted into explicitly (INV-INTEGRITY-8).
    ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR: '1',
    // Keyword grading, CHOSEN rather than fallen back to. The suite feeds
    // synthetic audio and fixed transcripts, so it must not depend on a model
    // being installed — and an explicit choice is not flagged as a degradation,
    // which an unintended fallback correctly is (INV-GRADE-1).
    ORALSCALE_GRADING_BACKEND: 'heuristic',
    ORALSCALE_COURSE: path.join(ROOT, 'autograder', 'source', 'course.json'),
    ORALSCALE_SUBMISSION: subDir, ORALSCALE_RESULTS: resPath, ORALSCALE_METADATA: metaPath,
    ORALSCALE_WEBAPP_URL: 'https://quiz.example/web/', ORALSCALE_MAX_POINTS: '10', ...extra };
  // Do NOT inherit GenAI creds -> deterministic heuristic grading for the gate.
  delete env.GENAI_STUDIO_API_KEY;
  const r = spawnSync('python3', [path.join(ROOT, 'autograder', 'source', 'run_autograder.py')], { env, encoding: 'utf8' });
  if (r.status !== 0 && r.stderr) console.error('[py]', r.stderr.slice(0, 500));
  return JSON.parse(fs.readFileSync(resPath, 'utf8'));
}

// Full honest attempt: reveal -> (answer -> boundary code)*N -> finish.
async function honestAttempt(assignmentId, studentRef, { waitSec = 3, wavSeconds, hashOfWav, v3, accessKey } = {}) {
  // v3 = public course link + opaque studentRef; otherwise the legacy per-student link.
  // Key-only mode sends the key and NOTHING else — the Signer derives the identity
  // from it. Open mode (requireAccessKey:false) still sends the opaque ref.
  const revealBody = accessKey ? { courseToken: courseToken(assignmentId), accessKey }
    : v3 ? { courseToken: courseToken(assignmentId), studentRef }
      : { quizToken: quizToken(assignmentId, studentRef) };
  const rev = (await post('/reveal', revealBody)).data;
  let revealToken = rev.revealToken;
  let qn, clo;
  const asked = [];
  for (;;) {
    // The boundary code comes first; the question is withheld until codeLeadSec passes.
    if (rev.codeLeadSec) await sleep((rev.codeLeadSec + 0.3) * 1000);
    qn = (await post('/question', { revealToken })).data;
    asked.push(qn.question);
    await sleep(waitSec * 1000);
    // "I'm done with this question" -> the next boundary code is issued only now.
    clo = (await post('/closing', { questionToken: qn.questionToken })).data;
    if (!clo.more) break;
    revealToken = clo.nextRevealToken;
  }
  const wsec = wavSeconds != null ? wavSeconds : Math.max(1, waitSec);
  const tmpWav = path.join(SCRATCH, 'tmp_' + P.newId(4) + '.wav');
  fs.mkdirSync(SCRATCH, { recursive: true });
  writeWav(tmpWav, wsec);
  const sha = hashOfWav || P.sha256Hex(fs.readFileSync(tmpWav));
  const fin = (await post('/finish', { closingToken: clo.closingToken, audioSHA256: sha, durationSec: wsec })).data;
  return { rev, qn, clo, asked, wsec, tmpWav, sha, fin };
}

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

(async () => {
  secret = ensureSecret();
  // ensure autograder bundle exists
  spawnSync('node', [path.join(ROOT, 'tools', 'build-autograder.js'), COURSE_PATH], { stdio: 'ignore' });
  fs.rmSync(SCRATCH, { recursive: true, force: true }); fs.mkdirSync(SCRATCH, { recursive: true });

  const srv = spawn('node', [path.join(ROOT, 'server', 'signer.js')], { env: { ...process.env, PORT: String(PORT), ORALSCALE_GRACE_SEC: '0',
      // The Signer defaults to courses/demo, which is now a ONE-assignment public
      // demo. Every fixture this suite drives lives in the test-suite course.
      ORALSCALE_COURSE: COURSE_PATH,
      // Explicitly, so the Signer cannot pick up a different course's Secret
      // from server/config.json.
      ORALSCALE_SECRET: secret,
      // Lower than the shipped default of 10 so the lockout can be provoked without
      // tripping the rate limiter first, and a 3s window (vs 15 min) so the suite can
      // also assert that it EXPIRES rather than stranding the source.
      ORALSCALE_KEY_FAIL_LIMIT: '5', ORALSCALE_KEY_FAIL_WINDOW_SEC: '3' }, stdio: ['ignore', 'inherit', 'inherit'] });
  const killSrv = () => { try { srv.kill(); } catch {} };
  process.on('exit', killSrv);
  process.on('SIGINT', () => { killSrv(); process.exit(1); });
  process.on('SIGTERM', () => { killSrv(); process.exit(1); });
  try {
    await waitHealth();
    const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'bank', 'bank.json'), 'utf8'));
    const byId = Object.fromEntries(bank.questions.map((q) => [q.id, q]));

    console.log('\n── HONEST SUBMISSION (demo-fast) ──');
    {
      const { rev, qn, wsec, sha, fin } = await honestAttempt('demo-fast', 'pete@purdue.edu', { waitSec: 3 });
      const words = buildWords(rev.attemptId, fin.certificate, byId);
      const dir = writeSubmission(path.join(SCRATCH, 'honest', 'submission'), { wavSeconds: wsec, cert: fin.certificate, certToken: fin.certificateToken, words, metaEmail: 'pete@purdue.edu' });
      const res = runAutograder('demo-fast', dir);
      // The instructor detail moved to hidden tests, so assert on those: the student
      // sees a passing "Validation checks" and there is no REVIEW flag raised.
      const t = (n) => (res.tests || []).find((x) => x.name === n);
      const validation = t('Validation checks');
      const reviewed = (res.tests || []).some((x) => /REVIEW/.test(x.name));
      record('honest scores > 0 and validation passes',
        res.score > 0 && validation && validation.status === 'passed' && !reviewed,
        `score=${res.score} validation=${validation && validation.status} flagged=${reviewed}`);
    }

    console.log('\n── BROWSER REACHABILITY (CORS preflight) ──');
    {
      // The browser sends OPTIONS before any JSON POST. This shipped broken: the
      // Worker built a 204 WITH a body, which throws (204 is a null-body status),
      // so every preflight 500'd and no browser could reach the Signer at all —
      // while curl, which sends no preflight, worked perfectly.
      const r = await fetch(BASE + '/reveal', { method: 'OPTIONS', headers: {
        Origin: 'https://example.pages.dev',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type' } });
      const acao = r.headers.get('access-control-allow-origin');
      const acah = (r.headers.get('access-control-allow-headers') || '').toLowerCase();
      record('CORS preflight succeeds with the right headers',
        (r.status === 204 || r.status === 200) && !!acao && acah.includes('content-type'),
        `status=${r.status} allow-origin=${acao} allow-headers=${acah}`);
    }

    console.log('\n── ATTACKS (each must earn 0) ──');
    // A) tampered audio (hash mismatch)
    {
      const { rev, qn, wsec, fin } = await honestAttempt('demo-fast', 'pete@purdue.edu', { waitSec: 2 });
      const words = buildWords(rev.attemptId, fin.certificate, byId);
      const dir = writeSubmission(path.join(SCRATCH, 'tamper', 'submission'), { wavSeconds: wsec, cert: fin.certificate, certToken: fin.certificateToken, words, metaEmail: 'pete@purdue.edu' });
      fs.appendFileSync(path.join(dir, 'answer.wav'), Buffer.from('EXTRA-BYTES')); // change bytes after cert
      const res = runAutograder('demo-fast', dir);
      record('A. tampered audio rejected', res.score === 0);
    }
    // B) forged certificate signature
    {
      const { rev, qn, wsec, fin } = await honestAttempt('demo-fast', 'pete@purdue.edu', { waitSec: 2 });
      const words = buildWords(rev.attemptId, fin.certificate, byId);
      const badToken = fin.certificateToken.slice(0, -3) + (fin.certificateToken.slice(-3) === 'AAA' ? 'BBB' : 'AAA');
      const dir = writeSubmission(path.join(SCRATCH, 'forge', 'submission'), { wavSeconds: wsec, cert: fin.certificate, certToken: badToken, words, metaEmail: 'pete@purdue.edu' });
      const res = runAutograder('demo-fast', dir);
      record('B. forged certificate rejected', res.score === 0);
    }
    // C) pre-recorded long audio (duration >> window). Finish immediately with the long file's hash.
    {
      const longWav = path.join(SCRATCH, 'long.wav');
      writeWav(longWav, 120);
      const longSha = P.sha256Hex(fs.readFileSync(longWav));
      const rev = (await post('/reveal', { quizToken: quizToken('demo-fast', 'pete@purdue.edu') })).data;
      const qn = (await post('/question', { revealToken: rev.revealToken })).data;
      const clo = (await post('/closing', { questionToken: qn.questionToken })).data;
      const fin = (await post('/finish', { closingToken: clo.closingToken, audioSHA256: longSha, durationSec: 120 })).data;
      const words = buildWords(rev.attemptId, fin.certificate, byId);
      const dir = path.join(SCRATCH, 'long', 'submission');
      fs.rmSync(path.join(SCRATCH, 'long'), { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(longWav, path.join(dir, 'answer.wav'));
      fs.writeFileSync(path.join(dir, 'certificate.json'), JSON.stringify({ ...fin.certificate, certificateToken: fin.certificateToken }));
      fs.writeFileSync(path.join(dir, 'words.json'), JSON.stringify(words));
      fs.writeFileSync(path.join(SCRATCH, 'long', 'submission_metadata.json'), JSON.stringify({ users: [{ email: 'pete@purdue.edu' }] }));
      const res = runAutograder('demo-fast', dir);
      record('C. pre-recorded long audio rejected (duration > window)', res.score === 0);
    }
    // D) late submission -> server refuses to certify (demo-tiny, limit 1, grace 0)
    {
      const rev = (await post('/reveal', { quizToken: quizToken('demo-tiny', 'pete@purdue.edu') })).data;
      const qn = (await post('/question', { revealToken: rev.revealToken })).data;
      await sleep(2500); // past deadline (1s + 0 grace)
      const clo = await post('/closing', { questionToken: qn.questionToken });
      record('D. late finish refused by server (no certificate)', clo.status === 403 && clo.data.code === 'DEADLINE_EXCEEDED');
    }
    // E) opening code never spoken
    {
      const { rev, qn, wsec, fin } = await honestAttempt('demo-fast', 'pete@purdue.edu', { waitSec: 3 });
      const words = buildWords(rev.attemptId, fin.certificate, byId, { skipCodes: [0] });
      const dir = writeSubmission(path.join(SCRATCH, 'noopen', 'submission'), { wavSeconds: wsec, cert: fin.certificate, certToken: fin.certificateToken, words, metaEmail: 'pete@purdue.edu' });
      const res = runAutograder('demo-fast', dir);
      record('E. missing OPENING code rejected (INV-INTEGRITY-4)', res.score === 0);
    }
    // E2) closing code never spoken — the tail of the recording is unpinned
    {
      const { rev, qn, wsec, fin } = await honestAttempt('demo-fast', 'pete@purdue.edu', { waitSec: 3 });
      const words = buildWords(rev.attemptId, fin.certificate, byId, { skipCodes: [1] });
      const dir = writeSubmission(path.join(SCRATCH, 'noclose', 'submission'), { wavSeconds: wsec, cert: fin.certificate, certToken: fin.certificateToken, words, metaEmail: 'pete@purdue.edu' });
      const res = runAutograder('demo-fast', dir);
      record('E2. missing CLOSING code rejected (INV-INTEGRITY-5)', res.score === 0);
    }
    // E3) skipping /closing entirely: a RevealToken must not certify
    {
      const rev = (await post('/reveal', { quizToken: quizToken('demo-fast', 'skipper@purdue.edu') })).data;
      const wav = path.join(SCRATCH, 'skip.wav'); writeWav(wav, 2);
      const fin = await post('/finish', { closingToken: rev.revealToken, audioSHA256: P.sha256Hex(fs.readFileSync(wav)), durationSec: 2 });
      record('E3. /finish refuses a RevealToken (closing step not skippable)', fin.status === 400, `status=${fin.status}`);
      const skipQ = await post('/closing', { questionToken: rev.revealToken });
      record('E4. /closing refuses a RevealToken (question step not skippable)', skipQ.status === 400, `status=${skipQ.status}`);
    }
    // F) identity mismatch (link shared with another student)
    {
      const { rev, qn, wsec, fin } = await honestAttempt('demo-fast', 'pete@purdue.edu', { waitSec: 2 });
      const words = buildWords(rev.attemptId, fin.certificate, byId);
      const dir = writeSubmission(path.join(SCRATCH, 'identity', 'submission'), { wavSeconds: wsec, cert: fin.certificate, certToken: fin.certificateToken, words, metaEmail: 'someone.else@purdue.edu' });
      const res = runAutograder('demo-fast', dir);
      record('F. shared-link identity mismatch rejected', res.score === 0);
    }
    // G) oversized DoS body -> server rejects
    {
      const big = 'x'.repeat(200 * 1024);
      let status;
      try { const r = await fetch(BASE + '/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quizToken: big }) }); status = r.status; }
      catch { status = 'conn-reset'; }
      record('G. oversized request rejected', status === 400 || status === 413 || status === 'conn-reset', `status=${status}`);
    }

    console.log('\n── v3 IDENTITY (public link, identity bound at submission) ──');
    {
      // t_url_identity (INV-SEC-2): honest student types their own email; only the
      // salted hash ever reaches the Signer.
      const email = 'maya@purdue.edu';
      const ref = P.studentRefFromEmail(COURSE.pseudonymSalt, email);
      const a = await honestAttempt('demo-fast', ref, { waitSec: 3, v3: true });
      const wordsA = buildWords(a.rev.attemptId, a.fin.certificate, byId);
      const dirA = writeSubmission(path.join(SCRATCH, 'v3ok', 'submission'),
        { wavSeconds: a.wsec, cert: a.fin.certificate, certToken: a.fin.certificateToken, words: wordsA, metaEmail: email });
      const resA = runAutograder('demo-fast', dirA);
      record('H. public link + typed email grades under the right student', resA.score > 0, `score=${resA.score}`);

      // Certificate resale: same recording, different submitter -> must not grade.
      const dirB = writeSubmission(path.join(SCRATCH, 'v3resale', 'submission'),
        { wavSeconds: a.wsec, cert: a.fin.certificate, certToken: a.fin.certificateToken, words: wordsA, metaEmail: 'someone.else@purdue.edu' });
      const resB = runAutograder('demo-fast', dirB);
      record('I. resold certificate rejected for a different submitter', resB.score === 0, `score=${resB.score}`);

      // Opt-out private code: nothing derived from an email leaves the browser.
      const quiet = 'quiet@purdue.edu';
      const code = P.pseudonymForEmail(secret, quiet);
      const c = await honestAttempt('demo-fast', code, { waitSec: 3, v3: true });
      const wordsC = buildWords(c.rev.attemptId, c.fin.certificate, byId);
      const dirC = writeSubmission(path.join(SCRATCH, 'v3code', 'submission'),
        { wavSeconds: c.wsec, cert: c.fin.certificate, certToken: c.fin.certificateToken, words: wordsC, metaEmail: quiet });
      const resC = runAutograder('demo-fast', dirC);
      record('J. private code grades under the right student', resC.score > 0, `score=${resC.score}`);

      // INV-SEC-6: a plaintext email must never be accepted as a client studentRef.
      const bad = await post('/reveal', { courseToken: courseToken('demo-fast'), studentRef: email });
      record('K. plaintext email rejected as client studentRef', bad.status === 400, `status=${bad.status}`);
    }

    console.log('\n── STUDENT-SUPPLIED TRANSCRIPT (INV-INTEGRITY-8) ──');
    {
      // The sidecar lives in the .zip the STUDENT uploads. If the grader honoured
      // it, a text file would satisfy the spoken codes and the rubric while the
      // real audio was never transcribed at all. Found by driving a real browser
      // recording through the real grader; must stay dead.
      const a = await honestAttempt('demo-fast', 'forger@purdue.edu', { waitSec: 3 });
      const perfect = buildWords(a.rev.attemptId, a.fin.certificate, byId); // codes + full key points
      const dir = writeSubmission(path.join(SCRATCH, 'forgedtx', 'submission'),
        { wavSeconds: a.wsec, cert: a.fin.certificate, certToken: a.fin.certificateToken,
          words: perfect, metaEmail: 'forger@purdue.edu' });
      // Production mode: the flag the harness normally sets is REMOVED.
      const res = runAutograder('demo-fast', dir, { ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR: '' });
      record('Q. student-supplied transcript ignored without Whisper', res.score === 0, `score=${res.score}`);
      // Sanity: the very same submission grades when the grader is told to trust it.
      const res2 = runAutograder('demo-fast', dir);
      record('Q2. same submission grades in explicit test mode', res2.score > 0, `score=${res2.score}`);
    }

    console.log('\n── FUZZY CODE TOLERANCE (INV-INTEGRITY-4/5) ──');
    {
      // One mis-transcribed digit in BOTH codes must still pass: the tolerance
      // exists so ASR slips don't fail honest students.
      const a = await honestAttempt('demo-fast', 'fuzzy@purdue.edu', { waitSec: 3 });
      const dir = writeSubmission(path.join(SCRATCH, 'fuzzy1', 'submission'),
        { wavSeconds: a.wsec, cert: a.fin.certificate, certToken: a.fin.certificateToken,
          words: buildWords(a.rev.attemptId, a.fin.certificate, byId, { garble: 1 }), metaEmail: 'fuzzy@purdue.edu' });
      const res = runAutograder('demo-fast', dir);
      record('L. one mis-heard digit still accepted', res.score > 0, `score=${res.score}`);

      // Three wrong digits is not a transcription slip — it is a different code.
      const b = await honestAttempt('demo-fast', 'fuzzy2@purdue.edu', { waitSec: 3 });
      const dir2 = writeSubmission(path.join(SCRATCH, 'fuzzy3', 'submission'),
        { wavSeconds: b.wsec, cert: b.fin.certificate, certToken: b.fin.certificateToken,
          words: buildWords(b.rev.attemptId, b.fin.certificate, byId, { garble: 3 }), metaEmail: 'fuzzy2@purdue.edu' });
      const res2 = runAutograder('demo-fast', dir2);
      record('M. three wrong digits rejected', res2.score === 0, `score=${res2.score}`);
    }

    console.log('\n── RETAKE COOLDOWN (INV-SEC-7) ──');
    {
      // demo-oral has retakeCooldownSec 300. Abandoning a question must not let
      // a student immediately reroll for an easier one.
      const ref = P.studentRefFromEmail(COURSE.pseudonymSalt, 'shopper@purdue.edu');
      const first = await post('/reveal', { courseToken: courseToken('demo-oral'), studentRef: ref });
      const second = await post('/reveal', { courseToken: courseToken('demo-oral'), studentRef: ref });
      record('N. reroll without finishing is blocked',
        first.status === 200 && second.status === 429 && second.data.code === 'COOLDOWN',
        `first=${first.status} second=${second.status} retryAfter=${second.data.retryAfterSec}s`);

      // Finishing a REAL attempt clears it at once — answering is never penalised.
      // demo-oral sets cooldownClearsAfterSec: 5, so the 2s lead alone is not enough —
      // waitSec 6 makes this a genuinely-spent attempt.
      const done = await honestAttempt('demo-oral', P.studentRefFromEmail(COURSE.pseudonymSalt, 'diligent@purdue.edu'),
        { waitSec: 6, v3: true });
      const again = await post('/reveal', { courseToken: courseToken('demo-oral'),
        studentRef: P.studentRefFromEmail(COURSE.pseudonymSalt, 'diligent@purdue.edu') });
      record('O. retake after a REAL attempt is allowed',
        !!done.fin.certificate && again.status === 200, `status=${again.status}`);

      // The bypass that shipped in the first cut of INV-SEC-7: reveal -> /closing ->
      // /finish with a junk hash took under a second and cleared the cooldown, so a
      // shopper could reroll freely. An attempt must cost real time to count.
      const rusher = P.studentRefFromEmail(COURSE.pseudonymSalt, 'rusher@purdue.edu');
      const r1 = await post('/reveal', { courseToken: courseToken('demo-oral'), studentRef: rusher });
      await sleep((r1.data.codeLeadSec + 0.3) * 1000);
      const q1 = await post('/question', { revealToken: r1.data.revealToken });
      const c1 = await post('/closing', { questionToken: q1.data.questionToken });
      const f1 = await post('/finish', { closingToken: c1.data.closingToken, audioSHA256: '0'.repeat(64), durationSec: 0 });
      const r2 = await post('/reveal', { courseToken: courseToken('demo-oral'), studentRef: rusher });
      record('O2. instant reveal→closing→finish does NOT clear the cooldown',
        r2.status === 429 && r2.data.code === 'COOLDOWN',
        `finish=${f1.status} reroll=${r2.status}`);

      // An honest student who answers fully but fumbles the last step (tail exceeded)
      // must NOT be locked out — they were not shopping.
      const fumbler = P.studentRefFromEmail(COURSE.pseudonymSalt, 'fumbler@purdue.edu');
      const r3 = await post('/reveal', { courseToken: courseToken('demo-oral'), studentRef: fumbler });
      await sleep(6000);                 // real engagement, past both the lead and clearsAfter
      const q3 = await post('/question', { revealToken: r3.data.revealToken });
      const c3 = await post('/closing', { questionToken: q3.data.questionToken });
      const r4 = await post('/reveal', { courseToken: courseToken('demo-oral'), studentRef: fumbler });
      record('O3. a real attempt that dies after /closing still clears the cooldown',
        c3.status === 200 && r4.status === 200, `closing=${c3.status} retake=${r4.status}`);

      // The cooldown is per student: one student's reroll cannot block another.
      const other = await post('/reveal', { courseToken: courseToken('demo-oral'),
        studentRef: P.studentRefFromEmail(COURSE.pseudonymSalt, 'bystander@purdue.edu') });
      record('P. cooldown is per-student, not global', other.status === 200, `status=${other.status}`);
    }

    console.log('\n── ACCESS KEYS (INV-SEC-8: enrolment gate AND identity, no email typed) ──');
    {
      // demo-keyed sets requireAccessKey. The key is self-authenticating: it carries
      // a MAC only the Secret can produce, so the Signer verifies enrolment by
      // recomputing it — no roster at the edge — and derives the identity from it.
      const email = 'keyed@purdue.edu';
      const key = P.accessKeyFor(secret, COURSE_ID, email);
      const expectRef = P.studentRefForEmail(secret, COURSE_ID, email);

      const noKey = await post('/reveal', { courseToken: courseToken('demo-keyed') });
      record('R. no key -> no question', noKey.status === 401 && noKey.data.code === 'KEY_REQUIRED'
        && !noKey.data.revealToken, `status=${noKey.status} code=${noKey.data.code}`);

      const forged = await post('/reveal', { courseToken: courseToken('demo-keyed'),
        accessKey: 'ABCD-EFGH-JKMN-PQRS' });
      record('R2. forged key -> no question', forged.status === 403
        && forged.data.code === 'KEY_INVALID' && !forged.data.revealToken,
        `status=${forged.status} code=${forged.data.code}`);

      // Right length, right shape, but the MAC does not match the id it carries —
      // i.e. someone kept the id and guessed the tag.
      const tampered = key.slice(0, 5) + (key[5] === 'Z' ? 'Y' : 'Z') + key.slice(6);
      const t2 = await post('/reveal', { courseToken: courseToken('demo-keyed'), accessKey: tampered });
      record('R3. a key with a tampered tag is rejected', t2.status === 403, `status=${t2.status}`);

      // A key minted for a DIFFERENT course must not work here (courseId is in the
      // MAC), so one leaked handout cannot travel between courses.
      const foreign = P.accessKeyFor(secret, 'some-other-course', email);
      const xcourse = await post('/reveal', { courseToken: courseToken('demo-keyed'), accessKey: foreign });
      record('R4. key from another course rejected', xcourse.status === 403, `status=${xcourse.status}`);

      // Typed sloppily — lowercase, spaces, no dashes — must still work, and the
      // Signer must derive the SAME identity the autograder will expect.
      const good = await post('/reveal', { courseToken: courseToken('demo-keyed'),
        accessKey: key.toLowerCase().replace(/-/g, ' ') });
      const derivedRef = good.data.revealToken
        ? P.verifyToken(secret, good.data.revealToken).studentRef : null;
      record('R5. the real key opens a question and names the student',
        good.status === 200 && derivedRef === expectRef, `status=${good.status} ref=${derivedRef}`);

      // NO EMAIL ON THE WIRE: the request body carries the key and nothing else.
      record('R5b. the request carries no email and no email-derived value',
        JSON.stringify({ courseToken: courseToken('demo-keyed'), accessKey: key }).indexOf('@') < 0
        && !/e:[0-9a-f]{32}/.test(JSON.stringify(good.data)),
        'body = {courseToken, accessKey}');

      // BANK MINING: invented keys, each well-formed and each useless.
      let mined = 0;
      for (let i = 0; i < 6; i++) {
        const fake = P.accessKeyFor(secret + 'wrong', COURSE_ID, 'dummy' + i + '@purdue.edu');
        const r = await post('/reveal', { courseToken: courseToken('demo-keyed'), accessKey: fake });
        if (r.status === 200) mined++;
      }
      record('R6. invented keys cannot mine the bank', mined === 0, `${mined}/6 got a question`);

      // …and a burst of invalid keys locks the SOURCE out. A forged key names nobody,
      // so unlike the retake cooldown there is no identity to attach this to.
      let locked = { status: 0, data: {} };
      for (let i = 0; i < 3; i++) {
        locked = await post('/reveal', { courseToken: courseToken('demo-keyed'),
          accessKey: 'ABCD-EFGH-JKMN-PQR' + i });
      }
      record('R7. a burst of invalid keys locks the source out',
        locked.status === 429 && locked.data.code === 'KEY_LOCKED',
        `status=${locked.status} code=${locked.data.code}`);

      // …and it lets go on its own. A lockout that had to be cleared by hand would
      // turn one fumbling student on the lecture-hall wifi into a support ticket
      // (the harness shortens the window to 3s; production is 15 min).
      await sleep(3300);
      const after = await post('/reveal', { courseToken: courseToken('demo-keyed'), accessKey: key });
      record('R7b. the lockout expires on its own', after.status === 200, `status=${after.status}`);
    }

    console.log('\n── KEY-ONLY IDENTITY, END TO END (INV-SEC-2 + INV-PRIV-2) ──');
    {
      // A fresh signer process, so the lockout from R7 does not bleed into this.
      const email = 'keyonly@purdue.edu';
      const key = P.accessKeyFor(secret, COURSE_ID, email);
      const a = await honestAttempt('demo-keyed', null, { waitSec: 3, accessKey: key });
      const dir = writeSubmission(path.join(SCRATCH, 'keyed', 'submission'),
        { wavSeconds: a.wsec, cert: a.fin.certificate, certToken: a.fin.certificateToken,
          words: buildWords(a.rev.attemptId, a.fin.certificate, byId), metaEmail: email });
      const res = runAutograder('demo-keyed', dir);
      record('R8. a key-only attempt grades under the right student',
        res.score > 0 && a.fin.certificate.accessKeyVerified === true
        && a.fin.certificate.studentRef === P.studentRefForEmail(secret, COURSE_ID, email),
        `score=${res.score} ref=${a.fin.certificate.studentRef}`);

      // Someone else's key: the certificate names ITS owner, not the submitter, so
      // the identity check at upload still catches it (INV-SEC-2 is unchanged by
      // key-only mode — a key is a door, not an identity claim).
      const dirB = writeSubmission(path.join(SCRATCH, 'keyresale', 'submission'),
        { wavSeconds: a.wsec, cert: a.fin.certificate, certToken: a.fin.certificateToken,
          words: buildWords(a.rev.attemptId, a.fin.certificate, byId), metaEmail: 'someone.else@purdue.edu' });
      const resB = runAutograder('demo-keyed', dirB);
      record('R9. a recording made with another student\'s key earns them nothing',
        resB.score === 0, `score=${resB.score}`);

      // A certificate minted WITHOUT the gate must not grade on a keyed assignment —
      // otherwise a Signer accidentally deployed with requireAccessKey off silently
      // undoes the whole invariant.
      const ungated = { ...a.fin.certificate, accessKeyVerified: false, keyChecked: 'not-required' };
      const dirC = writeSubmission(path.join(SCRATCH, 'ungated', 'submission'),
        { wavSeconds: a.wsec, cert: ungated, certToken: P.signToken(secret, ungated),
          words: buildWords(a.rev.attemptId, a.fin.certificate, byId), metaEmail: email });
      const resC = runAutograder('demo-keyed', dirC);
      record('R10. ungated certificate rejected by the grader', resC.score === 0, `score=${resC.score}`);
    }

    console.log('\n── MULTIPLE QUESTIONS (one recording, N questions) ──');
    {
      const email = 'multi@purdue.edu';
      const ref = P.studentRefFromEmail(COURSE.pseudonymSalt, email);
      const a = await honestAttempt('demo-multi', ref, { waitSec: 3, v3: true });
      const cert = a.fin.certificate;

      record('S. three questions asked in one continuous recording',
        a.asked.length === 3 && cert.questionCount === 3 && cert.segments.length === 3,
        `asked=${a.asked.length} segments=${cert.segments && cert.segments.length}`);
      record('S2. the three questions are distinct',
        new Set(a.asked.map((q) => q.id)).size === 3, a.asked.map((q) => q.id).join(', '));

      const dir = writeSubmission(path.join(SCRATCH, 'multi', 'submission'),
        { wavSeconds: a.wsec, cert, certToken: a.fin.certificateToken,
          words: buildWords(a.rev.attemptId, cert, byId), metaEmail: email });
      const res = runAutograder('demo-multi', dir);
      const perQ = (res.tests || []).filter((t) => /^Question \d+ of 3/.test(t.name));
      record('S3. all three answered -> full marks, graded question by question',
        res.score > 9 && perQ.length === 3, `score=${res.score} perQuestionTests=${perQ.length}`);

      // WHAT THE STUDENT IS SHOWN, not just what they are scored. Four labelled
      // parts in a fixed order — the question as asked, the words we heard, the
      // mark, and why. A mark a student cannot trace back to their own words is
      // not something they can learn from or dispute, and the parts ran together
      // as one paragraph until 2026-09-01.
      const ORDER = ['QUESTION', 'YOUR ANSWER', 'POINTS', 'FEEDBACK'];
      // Each label starts its own line and may carry a parenthetical after it
      // ("YOUR ANSWER (automatic transcript, 60 words)"), so match at a line
      // start rather than as a whole line.
      const inOrder = (out) => {
        let at = -1;
        return ORDER.every((lbl) => {
          const m = new RegExp('^' + lbl, 'm').exec(out.slice(at + 1));
          if (!m) return false;
          at = at + 1 + m.index;
          return true;
        });
      };
      record('S3a. each question shows question, answer, points and feedback, in that order',
        perQ.length === 3 && perQ.every((t) => inOrder(t.output)),
        perQ.map((t) => ORDER.filter((l) => t.output.includes(l)).length + '/4').join(' '));

      // The student's own transcribed words are quoted back under YOUR ANSWER.
      // Checked against the ACTUAL text rather than the label, because a label
      // with nothing under it is the failure this is meant to catch.
      const q1Words = (byId[a.asked[0].id].keyPoints || []).join(' ')
        .split(/\s+/).filter((w) => w.length > 5).slice(0, 3)
        .map((w) => w.replace(/[^a-zA-Z]/g, ''));
      record('S3b. the answer quoted back is the student\'s own words',
        q1Words.length > 0 && q1Words.every((w) => perQ[0].output.includes(w)),
        q1Words.join(', '));

      const overall = (res.tests || []).find((t) => /^Overall Score/.test(t.name));
      record('S3c. the Overall heading names the aggregation rule',
        !!overall && /average of all 3/.test(overall.name),
        overall ? overall.name : '(no Overall Score test)');

      // Attribution: answer only the FIRST question. A strong first answer must not
      // carry the other two — that is the entire point of asking several.
      const b = await honestAttempt('demo-multi', P.studentRefFromEmail(COURSE.pseudonymSalt, 'lazy@purdue.edu'),
        { waitSec: 3, v3: true });
      const dirB = writeSubmission(path.join(SCRATCH, 'multi1', 'submission'),
        { wavSeconds: b.wsec, cert: b.fin.certificate, certToken: b.fin.certificateToken,
          words: buildWords(b.rev.attemptId, b.fin.certificate, byId, { answerOnly: [0] }),
          metaEmail: 'lazy@purdue.edu' });
      const resB = runAutograder('demo-multi', dirB);
      record('S4. answering only question 1 scores about a third',
        resB.score > 0 && resB.score < 5, `score=${resB.score}`);

      // dropLowest, on an assignment identical to demo-multi except for the
      // aggregation. The SCORE part of dropLowest has been covered since v6; what
      // is new here is what the student is TOLD, which is where they can be
      // misled: an "Overall" heading over a number that is not the average of the
      // marks above reads as an arithmetic error, and the dropped question has to
      // say plainly that it did not count.
      const dl = await honestAttempt('demo-drop', P.studentRefFromEmail(COURSE.pseudonymSalt, 'drop@purdue.edu'),
        { waitSec: 3, v3: true });
      const dirDL = writeSubmission(path.join(SCRATCH, 'drop', 'submission'),
        { wavSeconds: dl.wsec, cert: dl.fin.certificate, certToken: dl.fin.certificateToken,
          words: buildWords(dl.rev.attemptId, dl.fin.certificate, byId, { answerOnly: [0, 1] }),
          metaEmail: 'drop@purdue.edu' });
      const resDL = runAutograder('demo-drop', dirDL);
      const overallDL = (resDL.tests || []).find((t) => /^Overall Score/.test(t.name));
      record('S4a. dropLowest names itself in the heading, not just "Overall"',
        !!overallDL && /drop lowest/i.test(overallDL.name),
        overallDL ? overallDL.name : '(no Overall Score test)');
      record('S4b. the student is told which questions counted and which was dropped',
        !!overallDL && /Counted: /.test(overallDL.output) && /Dropped: Q/.test(overallDL.output)
          && /NOT the average of all 3/.test(overallDL.output),
        overallDL ? overallDL.output.split('\n')[0] : '');
      const droppedQ = (resDL.tests || []).find((t) => /DROPPED, does not count/.test(t.name));
      record('S4c. the dropped question says it did not count, and still shows its feedback',
        !!droppedQ && /Not counted —/.test(droppedQ.output) && /FEEDBACK/.test(droppedQ.output)
          && droppedQ.score === undefined,
        droppedQ ? droppedQ.name : '(no dropped question shown)');
      // …and says what it WOULD have been worth. Without a mark the student cannot
      // tell a near miss from a blank, on the one answer they are told carries the
      // most useful feedback. It is shown on the counted questions' scale so the
      // two can be compared, and must never be scored into the total.
      record('S4c2. the dropped question shows the mark it would have earned',
        !!droppedQ && /For comparison only/.test(droppedQ.output)
          && /out of /.test(droppedQ.output) && /NOT part of your total/.test(droppedQ.output)
          && droppedQ.score === undefined && droppedQ.max_score === undefined,
        droppedQ ? (droppedQ.output.match(/graded [^,]+, the same scale/) || ['(no mark shown)'])[0] : '');
      // The visible marks must ADD UP to the total, or the student is right to
      // think the arithmetic is wrong.
      const countedDL = (resDL.tests || []).filter((t) => /^Question \d+ of 3/.test(t.name)
                                                        && typeof t.score === 'number');
      const sumDL = countedDL.reduce((n, t) => n + t.score, 0);
      record('S4d. the counted per-question marks sum to the total shown',
        countedDL.length === 2 && Math.abs(sumDL - resDL.score) < 0.02,
        `counted=${countedDL.length} sum=${sumDL.toFixed(2)} total=${resDL.score}`);

      // An INTERIOR boundary code is as load-bearing as the bookends: skipping it
      // leaves the middle of the recording unpinned.
      const c = await honestAttempt('demo-multi', P.studentRefFromEmail(COURSE.pseudonymSalt, 'skip@purdue.edu'),
        { waitSec: 3, v3: true });
      const dirC = writeSubmission(path.join(SCRATCH, 'multiskip', 'submission'),
        { wavSeconds: c.wsec, cert: c.fin.certificate, certToken: c.fin.certificateToken,
          words: buildWords(c.rev.attemptId, c.fin.certificate, byId, { skipCodes: [2] }),
          metaEmail: 'skip@purdue.edu' });
      const resC = runAutograder('demo-multi', dirC);
      record('S5. a missing INTERIOR code rejects the attempt', resC.score === 0, `score=${resC.score}`);

      // Finishing early would bank the questions already seen and drop the rest —
      // and would leak two questions per attempt to a shopper.
      const d = (await post('/reveal', { courseToken: courseToken('demo-multi'),
        studentRef: P.studentRefFromEmail(COURSE.pseudonymSalt, 'quitter@purdue.edu') })).data;
      const dq = (await post('/question', { revealToken: d.revealToken })).data;
      const dc = (await post('/closing', { questionToken: dq.questionToken })).data;
      const df = await post('/finish', { closingToken: dc.closingToken, audioSHA256: '0'.repeat(64), durationSec: 1 });
      record('S6. finishing before every question is answered is refused',
        df.status === 400 && df.data.code === 'QUESTIONS_REMAINING',
        `status=${df.status} code=${df.data.code} answered=${df.data.answered}/${df.data.questionCount}`);
    }

    console.log('\n── DEMO IDENTITY BYPASS (INV-DEMO-1: demo only, loud, and contained) ──');
    {
      // Exactly the R9 scenario -- a certificate uploaded by someone it was not
      // issued to -- run against the assignment that opts out. R9 must stay 0 and
      // this must not; if they ever agree, one of the two is broken.
      const email = 'demokey.holder@purdue.edu';
      const key = P.accessKeyFor(secret, COURSE_ID, email);
      // This fixture draws from the general-STEM bank, not the bank the rest of
      // the suite uses, so its questions need their own lookup.
      const fxBank = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'courses', '_testsuite', 'banks', 'general-stem.json'), 'utf8'));
      const tryById = Object.fromEntries(fxBank.questions.map((q) => [q.id, q]));
      const a = await honestAttempt('fx-demo-bypass', null, { waitSec: 3, accessKey: key });
      const dir = writeSubmission(path.join(SCRATCH, 'demobypass', 'submission'),
        { wavSeconds: a.wsec, cert: a.fin.certificate, certToken: a.fin.certificateToken,
          words: buildWords(a.rev.attemptId, a.fin.certificate, tryById),
          metaEmail: 'a.totally.different.instructor@example.edu' });
      const res = runAutograder('fx-demo-bypass', dir);
      const names = (res.tests || []).map((t) => t.name);
      const warn = (res.tests || []).find((t) => /DEMO MODE/.test(t.name));

      record('U1. a mismatched submitter still grades on the demo assignment',
        res.score > 0, `score=${res.score}`);
      // The warning is worth as much as the bypass is dangerous, so assert all of
      // it: visible to the student, failed (so Gradescope renders it in red), and
      // saying the two things that matter.
      record('U2. the student SEES a DEMO MODE warning, marked failed so it shows in red',
        !!warn && warn.visibility === 'visible' && warn.status === 'failed',
        warn ? `visibility=${warn.visibility} status=${warn.status}` : 'no warning test emitted');
      record('U3. the warning says identity was not checked AND not to use it for real work',
        !!warn && /identity verification is turned off/i.test(warn.output)
        && /never use this setting for real coursework/i.test(warn.output));
      record('U4. the instructor gets a review flag, and the would-be result recorded',
        names.some((n) => /REVIEW/.test(n))
        && (res.tests || []).some((t) => /demo mode — not checked/i.test(t.name)
             && /MISMATCH/.test(t.output)));
      // The bypass must be scoped to the assignment that asked for it. Same
      // certificate, an assignment that did not opt out, and it is worth nothing.
      const dirB = writeSubmission(path.join(SCRATCH, 'demobypass2', 'submission'),
        { wavSeconds: a.wsec, cert: a.fin.certificate, certToken: a.fin.certificateToken,
          words: buildWords(a.rev.attemptId, a.fin.certificate, tryById),
          metaEmail: 'a.totally.different.instructor@example.edu' });
      const resB = runAutograder('demo-keyed', dirB);
      record('U5. the bypass does NOT leak to another assignment in the same course',
        resB.score === 0, `score=${resB.score}`);
    }

    console.log('\n── EXTENDED-TIME ACCOMMODATIONS (INV-ACCOM-1/2) ──');
    {
      const ref = () => P.studentRefFromEmail(COURSE.pseudonymSalt, `drc${Math.random()}@purdue.edu`);

      // T1. No claim is the baseline every other case is measured against.
      const plain = (await post('/reveal', { courseToken: courseToken('demo-fast'), studentRef: ref() })).data;
      const base = plain.limitSec;
      record('T1. no accommodation claimed -> unmultiplied countdown', base > 0, `limitSec=${base}`);

      // T2. Every rung on the ladder actually scales the student's countdown.
      const scaled = [];
      for (const m of [1.25, 1.5, 1.75, 2]) {
        const r = (await post('/reveal', { courseToken: courseToken('demo-fast'), studentRef: ref(),
          timeMultiplier: m })).data;
        scaled.push(r.limitSec === Math.round(base * m));
      }
      record('T2. each rung scales the countdown (1.25/1.5/1.75/2x)', scaled.every(Boolean),
        `base=${base}s`);

      // T3. Off-ladder claims are REFUSED, not clamped. A student who asked for
      // more time and silently got less would find out when the countdown died.
      const bad = [];
      for (const v of [3, 1.1, 0.5, -1, 'lots']) {
        const r = await post('/reveal', { courseToken: courseToken('demo-fast'), studentRef: ref(),
          timeMultiplier: v });
        bad.push(r.status === 400 && r.data.code === 'BAD_MULTIPLIER');
      }
      record('T3. an off-ladder claim is refused, never clamped', bad.every(Boolean));

      // T4. The claim reaches the SIGNED certificate, so it is tamper-evident
      // and an instructor can check it without asking the student anything.
      const r4 = (await post('/reveal', { courseToken: courseToken('demo-fast'), studentRef: ref(),
        timeMultiplier: 1.5 })).data;
      const q4 = (await post('/question', { revealToken: r4.revealToken })).data;
      const c4 = (await post('/closing', { questionToken: q4.questionToken })).data;
      const f4 = (await post('/finish', { closingToken: c4.closingToken,
        audioSHA256: '0'.repeat(64), durationSec: 3 })).data;
      const a4 = (f4.certificate || {}).accommodation || {};
      record('T4. the claim is recorded in the certificate, with its source',
        a4.claimedMultiplier === 1.5 && a4.source === 'student-selected',
        JSON.stringify(a4));

      // T5. It survives verification of the signature — a student editing the
      // JSON to hide an over-claim invalidates the whole certificate.
      let signedOk = false;
      try {
        const v = P.verifyToken(secret, f4.certificateToken);
        signedOk = v.accommodation.claimedMultiplier === 1.5;
      } catch { signedOk = false; }
      record('T5. the claim is inside the signature, not merely alongside it', signedOk);

      // T6. The certificate carries the UNMULTIPLIED knobs, so a verifier can
      // recompute what any OTHER granted multiplier would have allowed. Without
      // these the fairness rule (INV-ACCOM-2) could not be evaluated at all.
      record('T6. the unmultiplied base knobs travel with it',
        a4.baseLimitSec === base && typeof a4.baseBufferSec === 'number',
        `base=${a4.baseLimitSec} buffer=${a4.baseBufferSec}`);

      // T7. THE FAIRNESS RULE. Over-claiming is only a fault if the time was
      // actually taken. Evaluated with the same helper the autograder uses.
      const seg = (used) => [{ questionId: 'q1', answerSec: used }];
      const within = P.withinGrantedTime(seg(200), 120, 20, 1.5);
      const beyond = P.withinGrantedTime(seg(235), 120, 20, 1.5);
      record('T7. claimed>granted but within granted time is NOT a fault',
        within.ok === true && beyond.ok === false,
        `allowed=${within.allowedSec}s`);
    }

    console.log('\n── NO-RECORDING BRANCH (private code handout) ──');
    {
      const dir = path.join(SCRATCH, 'mint', 'submission');
      fs.rmSync(path.join(SCRATCH, 'mint'), { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'placeholder.txt'), 'requesting a link');
      fs.writeFileSync(path.join(SCRATCH, 'mint', 'submission_metadata.json'), JSON.stringify({ users: [{ email: 'newstudent@purdue.edu' }] }));
      const res = runAutograder('demo-oral', dir);
      const linkTest = (res.tests || []).find((t) => t.name === 'Submission');
      const expected = P.pseudonymForEmail(secret, 'newstudent@purdue.edu').replace('p:', '');
      record('no-recording branch hands back the correct private code',
        !!(linkTest && linkTest.output.includes(expected)));
    }

    const passed = results.filter((r) => r.pass).length;
    const ok = passed === results.length;
    console.log(`\n${ok ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed}/${results.length}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    srv.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
