#!/usr/bin/env node
'use strict';
/**
 * Prove that the deployed Worker, the banks on this disk, and the built
 * autograder zips are all the SAME revision (INV-DEPLOY-7).
 *
 *   node tools/verify-deployment.js --course courses/<id>/course.json
 *   node tools/verify-deployment.js --course … --assignment quiz-03
 *
 * WHY THIS EXISTS
 * ---------------
 * The course config and its banks are bundled into the Worker at deploy time, so
 * `/health` is the only statement of what students are actually served — that is
 * INV-DEPLOY-5's argument, and it is right. But /health could only say which
 * ASSIGNMENTS existed, never which QUESTIONS, and the gap is not academic:
 *
 *   - a bank can be revised in place while its `bankId` and its question ids
 *     stay exactly as they were (q3-001…q3-100);
 *   - the autograder resolves a submission's questions BY ID
 *     (autograder/source/run_autograder.py);
 *   - so a Worker serving revision 1.2 and a Gradescope zip built from 1.0 do
 *     not error. They mark a student's answer against a different question's
 *     rubric, and the mark looks perfectly ordinary.
 *
 * Observed over three same-day revisions of a live quiz (2026-09-16), where the
 * only way to check was to compare a local file's mtime against a deploy log.
 *
 * WHAT IT COMPARES, AND WHY YOU CAN TRUST IT
 * ------------------------------------------
 * The bundle carries a sha256 of each bank FILE. /health publishes
 * HMAC(Secret, digest) rather than the digest, because /health is public and a
 * plain digest would let anyone holding a leaked bank confirm it is genuine.
 * This tool has the Secret, so it recomputes the tag from the bank on disk and
 * from the bank inside each zip, and compares. A match is cryptographic, not
 * circumstantial: the Worker is serving the bytes in front of you.
 *
 * NOTHING IS LEAKED. It reads the bank locally, sends nothing, and prints
 * revisions, short tags and a verdict — never a question, an answer or a key.
 */
const fs = require('fs');
const path = require('path');
const P = require('../server/lib/protocol');
const SECRETS = require('./lib/secrets.js');

const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const coursePath = path.resolve(arg('course', ''));
if (!coursePath || !fs.existsSync(coursePath)) {
  console.error('usage: node tools/verify-deployment.js --course courses/<id>/course.json [--assignment <id>]');
  process.exit(2);
}
const course = JSON.parse(fs.readFileSync(coursePath, 'utf8'));
const courseDir = path.dirname(coursePath);
const only = arg('assignment', '');
const resolved = SECRETS.resolve(coursePath, course.courseId);
if (!resolved) {
  console.error(`No signing Secret for "${course.courseId}" — it lives in ${rel(SECRETS.envPath(coursePath))}.`);
  console.error('Without it the keyed tag cannot be recomputed, so nothing can be verified.');
  process.exit(2);
}
const secret = resolved.secret;

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', OFF = '\x1b[0m';
const ok = (s) => `${GREEN}✅ ${s}${OFF}`;
const no = (s) => `${RED}❌ ${s}${OFF}`;

/** The bank file an assignment points at, as raw bytes. */
function localBank(a) {
  const p = path.resolve(courseDir, a.bank);
  return fs.existsSync(p) ? { path: p, raw: fs.readFileSync(p) } : null;
}

/** The bank inside the built autograder zip, if one exists, without unzipping to disk. */
function zippedBank(assignmentId) {
  const dir = path.join(courseDir, 'autograders');
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.zip')
    && f.includes(`${course.courseId}-${assignmentId}-`));
  if (!names.length) return null;
  // Prefer the plain released zip over a regrade variant when both exist.
  names.sort((a, b) => a.length - b.length);
  const zipPath = path.join(dir, names[0]);
  let raw;
  try {
    raw = require('child_process').execFileSync('unzip', ['-p', zipPath, 'banks/*.json'],
      { maxBuffer: 64 * 1024 * 1024 });
  } catch { return { path: zipPath, raw: null }; }
  return { path: zipPath, raw };
}

async function health(signer) {
  const url = signer.replace(/\/+$/, '') + '/health';
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.json();
}

(async () => {
  const signer = course.signerUrl;
  if (!signer || /[<>]/.test(signer)) {
    console.error(`${rel(coursePath)} has no real "signerUrl" — nothing is deployed to verify against.`);
    process.exit(2);
  }
  console.log(`\nVerifying ${course.courseId} against ${signer}\n`);
  let h;
  try { h = await health(signer); } catch (e) {
    console.error(no(`could not reach the Worker — ${e.message}`));
    console.error('\nUnreachable is not verified. Deploy, or fix connectivity, then re-run.\n');
    process.exit(1);
  }

  let bad = 0;
  const ids = Object.keys(course.assignments || {}).filter((id) => !only || id === only);
  if (!ids.length) { console.error(`No such assignment "${only}" in ${rel(coursePath)}.`); process.exit(2); }

  for (const id of ids) {
    const a = course.assignments[id];
    console.log(`${id}`);
    if (!h.assignments.includes(id)) {
      console.log('  ' + no('the deployed Worker does not serve this assignment at all (INV-DEPLOY-5)'));
      bad++; console.log(''); continue;
    }
    const local = localBank(a);
    if (!local) { console.log('  ' + no(`bank not found on disk: ${a.bank}`)); bad++; console.log(''); continue; }
    const localRev = JSON.parse(local.raw.toString('utf8')).revision;
    const localDigest = P.bankDigest(local.raw);
    const want = P.bankTag(secret, course.courseId, id, localDigest);
    const got = (h.bankTag || {})[id];
    const gotRev = (h.bankRevision || {})[id];

    console.log(`  ${DIM}bank${OFF}       ${rel(local.path)}  rev ${localRev || '(none)'}  sha ${localDigest.slice(0, 16)}`);
    if (got === undefined) {
      console.log('  ' + no('the Worker reports no bankTag — it predates INV-DEPLOY-7. Redeploy to close the gap.'));
      bad++;
    } else if (got === want) {
      console.log('  ' + ok(`Worker serves this exact bank  ${DIM}(rev ${gotRev || '(none)'}, tag ${got})${OFF}`));
    } else {
      console.log('  ' + no(`Worker serves a DIFFERENT bank  (it says rev ${gotRev || '(none)'}, tag ${got}; this disk computes ${want})`));
      console.log(`     Students are being served questions that are not the ones in ${rel(local.path)}.`);
      console.log(`     Fix: npm run deploy -- ${rel(coursePath)}`);
      bad++;
    }

    const z = zippedBank(id);
    if (!z) {
      console.log(`  ${DIM}zip${OFF}        none built yet — nothing to compare`);
    } else if (!z.raw) {
      console.log('  ' + no(`could not read a bank out of ${rel(z.path)}`));
      bad++;
    } else {
      const zRev = JSON.parse(z.raw.toString('utf8')).revision;
      const zDigest = P.bankDigest(z.raw);
      if (zDigest === localDigest) {
        console.log('  ' + ok(`autograder zip grades this exact bank  ${DIM}(rev ${zRev || '(none)'})${OFF}`));
      } else {
        console.log('  ' + no(`autograder zip holds a DIFFERENT bank (rev ${zRev || '(none)'}, sha ${zDigest.slice(0, 16)})`));
        console.log('     Question ids are stable across revisions and the grader resolves them BY ID,');
        console.log('     so this zip would mis-grade silently rather than fail. Rebuild and re-upload:');
        console.log(`     npm run package -- ${rel(coursePath)} --assignment ${id}`);
        bad++;
      }
    }
    console.log('');
  }

  if (bad) {
    console.log(no(`${bad} problem(s). The deployment does not match this disk.\n`));
    process.exit(1);
  }
  console.log(ok('Worker, banks on disk and built zips all agree.\n'));
})();
