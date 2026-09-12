#!/usr/bin/env node
'use strict';
/*
 * Functional test of the CLOUDFLARE WORKER itself — not the Node dev Signer.
 *
 *   node tools/test-worker.js
 *
 * Why this exists: `tools/demo-e2e.js` drives server/signer.js on localhost, so the
 * Worker was only ever syntax-checked. It drifted from the Node Signer twice, and
 * both times the whole suite stayed green while production was broken:
 *
 *   1. token versions diverged (worker v4 / node v2) after a patch silently no-op'd;
 *   2. /finish still destructured `revealToken` while using `closingToken` — an
 *      undefined variable — so every student hit "revealToken and audioSHA256
 *      required" at the very last step, after recording their whole answer.
 *
 * The Worker is a plain ES module over Web APIs that Node 18+ already has (fetch,
 * Request/Response, crypto.subtle), so it can be imported and driven directly. The
 * only thing needing help is `import bundle from './bundle.json'`, which we inline.
 *
 * No wrangler, no network, no Cloudflare account.
 */
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const path = require('path');
const P = require('../server/lib/protocol');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function loadWorker() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'worker', 'signer-worker.js'), 'utf8');

  // REBUILD FIRST, from the FIXTURE course this test actually drives — the
  // public demo now holds one assignment and none of the shapes asserted below
  // (keyed, multi-question) live there any more.
  //
  // bundle.json is a single shared build artifact: whichever course was packaged
  // last wins. Reading whatever happened to be there meant this suite tested a
  // bundle for a different course — and failed with an opaque 401, because the
  // token it signs names assignments that bundle does not contain. Rebuilding
  // makes the suite independent of what anyone last deployed.
  //
  // NO LONGER A SIDE EFFECT. This used to rebuild the SHARED artifact
  // (server/worker/bundle.json) and carried a comment telling you to rebuild your
  // own course's bundle afterwards. A comment is not a control: on 2026-09-08 a
  // deploy ran between a test run and that rebuild, and the live pilot Worker
  // served the testsuite bundle — every student on Quiz 1 got ASSIGNMENT_GONE
  // until it was put back. The suite now builds to its own temp file, so what
  // `wrangler deploy` would upload is never touched by running tests.
  const tmpBundle = path.join(os.tmpdir(), `oralscale-testbundle-${process.pid}.json`);
  {
    const built = spawnSync('node', [path.join(ROOT, 'tools', 'build-worker.js'),
      path.join(ROOT, 'courses', '_testsuite', 'course.json'), '--out', tmpBundle],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (built.status !== 0) {
      console.error('could not build the test bundle:\n' + (built.stderr || built.stdout));
      process.exit(1);
    }
  }
  if (!fs.existsSync(tmpBundle)) {
    console.error('the test bundle was not written — check tools/build-worker.js --out');
    process.exit(1);
  }
  const bundle = fs.readFileSync(tmpBundle, 'utf8');
  const inlined = src.replace(/^import bundle from '\.\/bundle\.json';$/m,
    `const bundle = ${bundle};`);
  const tmp = path.join(os.tmpdir(), `oralscale-worker-${process.pid}.mjs`);
  fs.writeFileSync(tmp, inlined);
  const mod = await import('file://' + tmp);
  fs.unlinkSync(tmp);
  try { fs.unlinkSync(tmpBundle); } catch { /* already gone */ }
  // Hand the caller the exact bundle this worker was built from, so nothing
  // downstream has to go looking for it on disk.
  return Object.assign(Object.create(mod.default), { __bundleJson: bundle });
}

(async () => {
  console.log('── Cloudflare Worker functional tests ──');
  const worker = await loadWorker();
  const secret = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'config.json'), 'utf8')).secret;
  const env = { ORALSCALE_SECRET: secret, ALLOW_ORIGIN: '*', GRACE_SEC: '20', TAIL_LIMIT_SEC: '45' };
  const call = (method, pathname, body, headers = {}) => worker.fetch(
    new Request('https://signer.test' + pathname, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env);

  // Which course got bundled? Use its first assignment.
  const bundle = JSON.parse(worker.__bundleJson);
  const courseId = bundle.course.courseId;
  // Prefer an assignment with no code lead so the test does not sit waiting for it.
  const entries = Object.entries(bundle.course.assignments);
  const assignmentId = (entries.find(([, a]) => Number(a.codeLeadSec) === 0) || entries[0])[0];
  const salt = bundle.course.pseudonymSalt;

  // 1) health
  {
    const r = await call('GET', '/health');
    const d = await r.json();
    check('health responds with the bundled course', r.status === 200 && d.courseId === courseId,
      `${r.status} ${d.courseId}`);
  }

  // 2) CORS preflight — a 204 may not carry a body; building one throws in Workers.
  {
    const r = await call('OPTIONS', '/reveal', null, {
      Origin: 'https://x.pages.dev',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    });
    check('CORS preflight is 204 with the right headers',
      r.status === 204 && !!r.headers.get('access-control-allow-origin')
        && /content-type/i.test(r.headers.get('access-control-allow-headers') || ''),
      `status=${r.status}`);
  }

  // 3) the FULL student path, exactly as the browser drives it
  const studentRef = P.studentRefFromEmail(salt, 'worker-test@purdue.edu');
  const courseToken = P.signToken(secret, {
    v: 3, kind: 'course', courseId, assignmentId, pseudonymSalt: salt,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  let reveal, question, closing;
  {
    const r = await call('POST', '/reveal', { courseToken, studentRef });
    reveal = await r.json();
    check('/reveal returns an opening code and NO question',
      r.status === 200 && new RegExp(`^\\d{${P.CODE_DIGITS}}$`).test(reveal.openingCode || '') && !reveal.question,
      `status=${r.status} code=${reveal.openingCode} question=${reveal.question ? 'LEAKED' : 'withheld'}`);
  }
  {
    // The question is withheld until codeLeadSec has passed on the SERVER clock, so
    // honour whatever the deployment configures rather than assuming zero.
    let r = await call('POST', '/question', { revealToken: reveal.revealToken });
    question = await r.json();
    if (question.ready === false) {
      check('/question refuses before the code lead elapses', true,
        `waiting ${question.availableInSec}s`);
      await new Promise((res) => setTimeout(res, (question.availableInSec + 0.5) * 1000));
      r = await call('POST', '/question', { revealToken: reveal.revealToken });
      question = await r.json();
    }
    check('/question hands over the question and starts the clock',
      r.status === 200 && question.ready && !!question.question && !!question.questionToken
        && Number.isInteger(question.deadline),
      `status=${r.status} q=${question.question && question.question.id}`);
  }
  {
    const r = await call('POST', '/closing', { questionToken: question.questionToken });
    closing = await r.json();
    check('/closing returns a closing code and a closing token',
      r.status === 200 && new RegExp(`^\\d{${P.CODE_DIGITS}}$`).test(closing.closingCode || '') && !!closing.closingToken,
      `status=${r.status} code=${closing.closingCode}`);
    check('opening and closing codes differ', closing.closingCode !== reveal.openingCode);
  }
  {
    const sha = P.sha256Hex(Buffer.from('pretend audio'));
    const r = await call('POST', '/finish',
      { closingToken: closing.closingToken, audioSHA256: sha, durationSec: 3 });
    const d = await r.json();
    let certOk = false;
    try {
      const back = P.verifyToken(secret, d.certificateToken);
      certOk = back.kind === 'certificate' && back.audioSHA256 === sha
        && back.studentRef === studentRef && back.assignmentId === assignmentId;
    } catch { /* leave false */ }
    check('/finish accepts closingToken and issues a verifiable certificate',
      r.status === 200 && certOk, `status=${r.status} error=${d.error || '-'}`);
    check('certificate carries the whole timeline',
      !!d.certificate && ['tReveal', 'tQuestion', 'tClosing', 'tFinish', 'questionOffsetSec',
        'closingOffsetSec', 'answerSec', 'codeLeadSec'].every((k) => d.certificate[k] !== undefined),
      d.certificate ? `answerSec=${d.certificate.answerSec} lead=${d.certificate.codeLeadSec}` : 'none');
  }

  // 4) the closing step must not be skippable (INV-INTEGRITY-5)
  {
    const r = await call('POST', '/reveal', { courseToken, studentRef: P.studentRefFromEmail(salt, 'skip@purdue.edu') });
    const rev = await r.json();
    const f = await call('POST', '/finish',
      { closingToken: rev.revealToken, audioSHA256: 'a'.repeat(64), durationSec: 1 });
    check('/finish refuses a RevealToken (closing not skippable)', f.status === 400, `status=${f.status}`);
    const c = await call('POST', '/closing', { questionToken: rev.revealToken });
    check('/closing refuses a RevealToken (question step not skippable)', c.status === 400, `status=${c.status}`);
  }

  // 5) a plaintext email must never be accepted as a client studentRef (INV-SEC-6)
  {
    const r = await call('POST', '/reveal', { courseToken, studentRef: 'someone@purdue.edu' });
    check('/reveal rejects a plaintext email as studentRef', r.status === 400, `status=${r.status}`);
  }

  // 6) the access gate (INV-SEC-8) — pure crypto, so it must hold with NO D1 bound.
  //    That matters: the cooldown silently degrades without D1, and the gate must not.
  if (bundle.course.assignments['demo-keyed']) {
    const keyedToken = P.signToken(secret, {
      v: 3, kind: 'course', courseId, assignmentId: 'demo-keyed', pseudonymSalt: salt,
      requireKey: true, exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const email = 'worker-keyed@purdue.edu';
    const key = P.accessKeyFor(secret, courseId, email);
    const noKey = await (await call('POST', '/reveal', { courseToken: keyedToken })).json();
    const bad = await call('POST', '/reveal', { courseToken: keyedToken, accessKey: 'ABCD-EFGH-JKMN-PQRS' });
    const good = await call('POST', '/reveal', { courseToken: keyedToken, accessKey: key });
    const gd = await good.json();
    const derived = gd.revealToken ? P.verifyToken(secret, gd.revealToken).studentRef : null;
    check('worker: no key -> no question (INV-SEC-8, without D1)',
      noKey.code === 'KEY_REQUIRED' && !noKey.revealToken && bad.status === 403,
      `noKey=${noKey.code} forgedKey=${bad.status}`);
    check('worker: the key opens a question AND names the student, exactly as Node does',
      good.status === 200 && derived === P.studentRefForEmail(secret, courseId, email)
        && P.verifyToken(secret, gd.revealToken).keyChecked === 'accessKey',
      `status=${good.status} ref=${derived}`);
  }

  // 7) multiple questions in one recording — the Worker must walk the same
  //    reveal -> question -> closing(next) -> … -> finish chain as the Node Signer.
  if (bundle.course.assignments['demo-multi']) {
    const multiToken = P.signToken(secret, {
      v: 3, kind: 'course', courseId, assignmentId: 'demo-multi', pseudonymSalt: salt,
      requireKey: false, exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const ref = P.studentRefFromEmail(salt, 'worker-multi@purdue.edu');
    const rev = await (await call('POST', '/reveal', { courseToken: multiToken, studentRef: ref })).json();
    let token = rev.revealToken;
    const asked = [];
    const codes = [rev.code];
    let clo;
    for (;;) {
      const qn = await (await call('POST', '/question', { revealToken: token })).json();
      asked.push(qn.question.id);
      clo = await (await call('POST', '/closing', { questionToken: qn.questionToken })).json();
      codes.push(clo.code);
      if (!clo.more) break;
      token = clo.nextRevealToken;
    }
    const fin = await call('POST', '/finish',
      { closingToken: clo.closingToken, audioSHA256: 'b'.repeat(64), durationSec: 5 });
    const fd = await fin.json();
    check('worker: three questions, four boundary codes, one certificate',
      rev.questionCount === 3 && asked.length === 3 && new Set(asked).size === 3
        && codes.length === 4 && new Set(codes).size === 4
        && fin.status === 200 && fd.certificate.segments.length === 3,
      `asked=${asked.length} codes=${codes.length} status=${fin.status}`);
    check('worker: the boundary codes are the ones the autograder will re-derive',
      codes.every((c, k) => c === P.deriveBoundaryCode(secret, rev.attemptId, k, 3)),
      codes.join(' '));

    // Finishing early would bank the questions already seen and drop the rest.
    const r2 = await (await call('POST', '/reveal', { courseToken: multiToken,
      studentRef: P.studentRefFromEmail(salt, 'worker-quit@purdue.edu') })).json();
    const q2 = await (await call('POST', '/question', { revealToken: r2.revealToken })).json();
    const c2 = await (await call('POST', '/closing', { questionToken: q2.questionToken })).json();
    const f2 = await call('POST', '/finish', { closingToken: c2.closingToken, audioSHA256: 'c'.repeat(64), durationSec: 1 });
    check('worker: /finish refuses a mid-attempt closing token', f2.status === 400, `status=${f2.status}`);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed === results.length ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
