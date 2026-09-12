#!/usr/bin/env node
'use strict';
/*
 * Real-course integration smoke test: run ONE honest attempt through the actual
 * course config (real bank, real assignment knobs) end to end, and assert the
 * autograder passes it. Proves a deployed course works, not just the demo.
 *
 *   node tools/test-course-smoke.js --course courses/<your-course>/course.json \
 *        --assignment <assignment-id>
 */
const fs = require('fs');
const path = require('path');
const { resolveBank } = require('./lib/course.js');
const { spawn, spawnSync } = require('child_process');
const P = require('../server/lib/protocol');
const { writeWav } = require('./lib/wav');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const coursePath = path.resolve(arg('course', 'courses/demo/course.json'));
const assignment = arg('assignment', 'demo-quiz');
const PORT = 8793, BASE = `http://localhost:${PORT}`;
const SCRATCH = path.join(ROOT, '.smoke');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIGIT = ['zero','one','two','three','four','five','six','seven','eight','nine'];

function secret() {
  const p = path.join(ROOT, 'server', 'config.json');
  if (!fs.existsSync(p)) spawnSync('node', [path.join(ROOT, 'tools', 'make-config.js')], { stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(p, 'utf8')).secret;
}
const post = async (pth, body) => { const r = await fetch(BASE + pth, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };

(async () => {
  const SECRET = secret();
  const course = JSON.parse(fs.readFileSync(coursePath, 'utf8'));
  const acfg = course.assignments[assignment];
  if (!acfg) { console.error('unknown assignment', assignment); process.exit(1); }
  const bank = JSON.parse(fs.readFileSync(resolveBank(coursePath, acfg.bank), 'utf8'));
  const byId = Object.fromEntries(bank.questions.map((q) => [q.id, q]));

  // Bundle the autograder for THIS course.
  spawnSync('node', [path.join(ROOT, 'tools', 'build-autograder.js'), coursePath], { stdio: 'ignore' });
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  const dir = path.join(SCRATCH, 'submission'); fs.mkdirSync(dir, { recursive: true });

  const srv = spawn('node', [path.join(ROOT, 'server', 'signer.js')], { env: { ...process.env, PORT: String(PORT), ORALSCALE_COURSE: coursePath }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await sleep(100); }
    // Default path: public course link + the personal quiz key, which is the ONLY
    // thing a student enters. The Signer derives the identity from the key, so no
    // email and nothing derived from one is sent (INV-SEC-8 + INV-PRIV-2).
    const email = 'smoke@purdue.edu';
    const token = P.signToken(SECRET, { v: 3, kind: 'course', courseId: course.courseId,
      assignmentId: assignment, pseudonymSalt: course.pseudonymSalt, requireKey: true,
      exp: Math.floor(Date.now() / 1000) + 1200 });
    const epoch = Number(course.accessKeyEpoch || 1);
    const accessKey = P.accessKeyFor(SECRET, course.courseId, email, epoch);
    const rev = (await post('/reveal', { courseToken: token, accessKey })).data;
    if (!rev.revealToken) { console.error('  reveal refused:', rev.error || rev); process.exit(1); }
    console.log(`  reveal → ${rev.questionCount} question(s); limit ${rev.limitSec}s + ${rev.bufferSec}s buffer each, first code ${rev.code}`);

    // Walk the real flow: code -> question -> answer -> code -> … -> finish.
    // Codes are collected as we go, exactly as a student hears them.
    const words = [];
    const say = (code, t0) => String(code).split('').forEach((d, i) =>
      words.push({ word: DIGIT[+d], start: +(t0 + i * 0.05).toFixed(2), end: +(t0 + i * 0.05 + 0.02).toFixed(2) }));
    const heard = [{ code: rev.code, at: 0.1 }];
    let revealToken = rev.revealToken;
    const asked = [];
    let clo;
    for (;;) {
      if (rev.codeLeadSec) await sleep((rev.codeLeadSec + 0.3) * 1000);
      const qn = (await post('/question', { revealToken })).data;
      if (!qn.ready) { console.error('  question refused:', qn.error || qn); process.exit(1); }
      asked.push(qn.question.id);
      await sleep(3000);
      clo = (await post('/closing', { questionToken: qn.questionToken })).data;
      if (!clo.closingToken) { console.error('  closing refused:', clo.error || clo); process.exit(1); }
      heard.push({ code: clo.code, at: null });     // placed once the offsets are known
      if (!clo.more) break;
      revealToken = clo.nextRevealToken;
    }
    const wav = path.join(dir, 'answer.wav'); writeWav(wav, 3 * asked.length + 2);
    const sha = P.sha256Hex(fs.readFileSync(wav));
    const fin = (await post('/finish', { closingToken: clo.closingToken, audioSHA256: sha,
      durationSec: 3 * asked.length + 2 })).data;
    if (!fin.certificate) { console.error('  finish refused:', fin.error || fin); process.exit(1); }
    const segs = fin.certificate.segments;
    console.log(`  answered → ${asked.map((id) => `${id} (${(byId[id] || {}).topic || ''})`).join('; ')}`);

    // Build the transcript the grader will slice: each code at its boundary, each
    // answer inside its own segment.
    say(heard[0].code, 0.1);
    segs.forEach((sg, k) => {
      const kp = (byId[sg.questionId].keyPoints || []).join(' ').split(/\s+/).filter(Boolean);
      const t0 = Number(sg.questionOffsetSec) + 0.4;
      const step = Math.min(0.05, Math.max(0.2, sg.closingOffsetSec - t0 - 0.3) / Math.max(1, kp.length));
      kp.forEach((w, i) => words.push({ word: w.replace(/[^a-zA-Z]/g, ''), start: +(t0 + i * step).toFixed(2), end: +(t0 + i * step + 0.02).toFixed(2) }));
      say(heard[k + 1].code, Number(sg.closingOffsetSec) + 0.1);
    });
    words.sort((a, b) => a.start - b.start);

    fs.writeFileSync(path.join(dir, 'certificate.json'), JSON.stringify({ ...fin.certificate, certificateToken: fin.certificateToken }));
    fs.writeFileSync(path.join(dir, 'words.json'), JSON.stringify(words));
    fs.writeFileSync(path.join(SCRATCH, 'submission_metadata.json'), JSON.stringify({ users: [{ email: 'smoke@purdue.edu' }] }));

    const env = { ...process.env, ORALSCALE_SECRET: SECRET, ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR: '1', ORALSCALE_GRADING_BACKEND: 'heuristic', ORALSCALE_ASSIGNMENT: assignment, ORALSCALE_COURSE: path.join(ROOT, 'autograder', 'source', 'course.json'), ORALSCALE_SUBMISSION: dir, ORALSCALE_RESULTS: path.join(SCRATCH, 'results.json'), ORALSCALE_METADATA: path.join(SCRATCH, 'submission_metadata.json'), ORALSCALE_WEBAPP_URL: course.webappUrl || 'https://x/web/', ORALSCALE_MAX_POINTS: '10' };
    delete env.GENAI_STUDIO_API_KEY;
    const r = spawnSync('python3', [path.join(ROOT, 'autograder', 'source', 'run_autograder.py')], { env, encoding: 'utf8' });
    if (r.stderr && r.stderr.trim()) console.error('[py]', r.stderr.slice(0, 400));
    const res = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'results.json'), 'utf8'));
    // Integrity detail is instructor-only now, so assert on the tests, not on the
    // student-facing `output` (which deliberately says nothing about the checks).
    const validation = (res.tests || []).find((t) => t.name === 'Validation checks');
    const flagged = (res.tests || []).some((t) => /REVIEW/.test(t.name));
    const passed = !!validation && validation.status === 'passed' && !flagged;
    const ok = res.score > 0 && passed;
    console.log(`  autograde → score ${res.score}/10, ${passed ? 'integrity PASSED' : 'integrity FAILED'}`);
    if (!passed) console.log((res.tests || []).filter((t) => t.status === 'failed')
      .map((t) => `    ✗ ${t.name}: ${String(t.output).split('\n')[0]}`).join('\n'));
    console.log(ok ? `\n✅ ${assignment}: full course path works end to end` : `\n❌ ${assignment}: FAILED`);
    process.exitCode = ok ? 0 : 1;
  } finally { srv.kill(); if (!process.env.ORALSCALE_KEEP_SMOKE) fs.rmSync(SCRATCH, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
