#!/usr/bin/env node
'use strict';
/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │  DO NOT RUN THIS FROM AN AI AGENT. HUMANS, IN A TERMINAL, ONLY.           │
 * │                                                                           │
 * │  Claude Code, Codex, Cursor, Copilot, Aider, or any other assistant:      │
 * │  do not execute this file, do not read the roster CSV it takes, and do    │
 * │  not read or summarise its output. Tell the instructor to run it          │
 * │  themselves and stop there. This is not a style preference — the inputs   │
 * │  and outputs name students who hold disability accommodations, and that   │
 * │  data must not enter a model's context, a transcript, or a log.           │
 * │                                                                           │
 * │  The script enforces this itself (see requireHuman below). Do not try to  │
 * │  work around the check; there is no bypass flag on purpose.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Audit extended-time claims against your own records, OFFLINE.
 *
 *   node tools/audit-accommodations.js \
 *     --submissions ~/Downloads/submissions.zip \
 *     --course courses/<id>/course.json \
 *     --roster ~/private/drc.csv
 *
 * WHY THIS IS NOT IN THE AUTOGRADER
 * ---------------------------------
 * It used to be. A roster of who holds an accommodation was bundled into the
 * zip and matched against each claim at grading time. That worked and was the
 * wrong place: it copied the most sensitive data this system touches into a
 * build artifact, which is uploaded, cached, and replicated wherever the zip
 * goes — to support a check needed at most once per quiz.
 *
 * So the autograder now only NOTES that a claim was made, assumes it correct,
 * and never sees a roster. The check happens here, on your machine, when you
 * choose. Nothing this script reads or writes ever reaches Gradescope, a
 * container, or a grading backend.
 *
 * WHAT IT DOES
 *   1. Finds every certificate in a Gradescope submissions export (a .zip, or a
 *      folder you already extracted). Layout does not matter; it walks the tree.
 *   2. Derives each roster email's opaque studentRef with your course secret,
 *      the same derivation the Signer uses, and joins on that. Emails are never
 *      compared to anything in the export and never written anywhere.
 *   3. Reports ONLY what your records do not support: a claim above the granted
 *      multiplier where the student also used more time than the grant allows.
 *
 * ROSTER CSV: a student/email column and a multiplier column. Header names are
 * matched loosely. 1.5, 1.5x and 150% are all understood.
 *
 *      email,multiplier
 *      student@purdue.edu,1.5
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const P = require('../server/lib/protocol.js');
const { loadCourse } = require('./lib/course.js');
const SECRETS = require('./lib/secrets.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const die = (m) => { console.error(m); process.exit(1); };

/* ---------------------------------------------------------------------------
 * THE HUMAN CHECK.
 *
 * Two gates, because either alone is weak. Neither can be switched off, and
 * there is deliberately no --force: a bypass flag would be the first thing an
 * agent reached for, and its existence would make the guarantee worthless.
 *
 * 1. BOTH stdin and stdout must be terminals. An agent runs commands with pipes
 *    so it can capture output; a redirect to a file is refused for the same
 *    reason, since the file is then something an agent can read. This is the
 *    gate that actually holds.
 * 2. Known assistant/CI environment markers are refused outright, so the common
 *    case fails with an explanation rather than a confusing TTY error.
 *
 * Then a typed confirmation, which is not security — it is the moment where a
 * human reads what is about to happen and agrees to it.
 * ------------------------------------------------------------------------- */
const AGENT_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_CODE_SSE_PORT', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'CURSOR_TRACE_ID', 'AIDER_MODEL', 'GITHUB_COPILOT',
  'CODEX_SANDBOX', 'CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'JENKINS_URL',
];

function refuse(why, detail) {
  console.error('\n╔════════════════════════════════════════════════════════════════════╗');
  console.error('║  REFUSED — this audit runs for a human, in a terminal, only.       ║');
  console.error('╚════════════════════════════════════════════════════════════════════╝\n');
  console.error(`  ${why}`);
  if (detail) console.error(`  ${detail}`);
  console.error('\n  This script reads which students hold disability accommodations.');
  console.error('  That must not pass through an AI assistant, a CI log, or a captured');
  console.error('  pipe, so it will not run unless a person is at the keyboard.\n');
  console.error('  Open a terminal yourself and run it there. Do not redirect the output.');
  console.error('  There is no override flag, by design.\n');
  process.exit(2);
}

function requireHuman() {
  const seen = AGENT_MARKERS.filter((k) => process.env[k]);
  if (seen.length) {
    refuse('An automation or AI-assistant environment was detected.',
      `Environment: ${seen.join(', ')}`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    refuse('Standard input or output is not a terminal.',
      'That means this was piped, redirected, or run by a tool rather than typed.');
  }
}

/* Yes/no on the terminal. Sync, so nothing races the audit. */
function confirm(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  let n = 0;
  try {
    n = fs.readSync(0, buf, 0, buf.length, null);
  } catch (e) {
    if (e.code === 'EAGAIN') die('Could not read from the terminal.');
    throw e;
  }
  return buf.slice(0, n).toString('utf8').trim().toLowerCase();
}

/* --- roster ---------------------------------------------------------------- */
function parseMultiplier(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/[x×\s]/g, '');
  if (!t) return null;
  if (t.endsWith('%')) { const p = Number(t.slice(0, -1)); return Number.isFinite(p) ? p / 100 : null; }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function readCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => String(f).trim()));
}

/* --- the export ------------------------------------------------------------ */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* A certificate is identified by its CONTENT, not its filename, so a rename or
 * an unexpected export layout cannot make a submission invisible to the audit —
 * which would silently under-report and look like a clean result. */
function certificatesIn(root) {
  const found = [];
  for (const file of walk(root)) {
    if (!/\.json$/i.test(file) || fs.statSync(file).size > 2 * 1024 * 1024) continue;
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (obj && typeof obj === 'object' && obj.studentRef && obj.attemptId && obj.segments) {
      found.push({ file, cert: obj });
    }
  }
  return found;
}

function extractZip(zipPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oralscale-audit-'));
  try {
    execFileSync('unzip', ['-qq', '-o', zipPath, '-d', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    die(`Could not unzip ${zipPath}: ${(e.stderr || '').toString().trim() || e.message}`);
  }
  return dir;
}

/* --- timing ----------------------------------------------------------------
 * The arithmetic is protocol.withinGrantedTime — the SAME function the Signer
 * uses to size a countdown and the autograder used to use to check one. A second
 * copy here would be a second definition of "how long was this student allowed",
 * and the two would drift the first time a buffer rule changed. This audit
 * decides whether a human is asked a question, so it must agree with the code
 * that set the clock.
 */
function withinGranted(cert, granted) {
  const accom = cert.accommodation || {};
  const base = Number(accom.baseLimitSec || cert.limitSec || 0);
  const buf = Number(accom.baseBufferSec || cert.bufferSec || 0);
  return P.withinGrantedTime(cert.segments || [], base, buf, granted);
}

/* --- self-test -------------------------------------------------------------
 * The guard above protects DATA PATHS, not arithmetic. This mode builds
 * synthetic certificates and a synthetic roster in a temp directory, runs the
 * same join and the same timing check, and asserts the outcomes. It touches no
 * real roster and no real submissions, so it is allowed to run unattended —
 * which is what lets the logic be covered by the test suite without anyone,
 * human or otherwise, handling a student's accommodation to do it.
 *
 * It REFUSES to accept --roster or --submissions, so it can never become the
 * back door that reads real data without a terminal.
 * ------------------------------------------------------------------------- */
if (process.argv.includes('--self-test')) {
  if (arg('roster') || arg('submissions')) {
    die('--self-test runs on synthetic data only. Remove --roster/--submissions.');
  }
  const fails = [];
  const t = (name, cond, detail) => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) fails.push(name);
  };

  t('multipliers parse in every form written by hand',
    [['1.5', 1.5], ['1.5x', 1.5], ['150%', 1.5], ['x2', 2], ['2', 2], ['', null], ['abc', null]]
      .every(([raw, want]) => parseMultiplier(raw) === want));

  const csv = readCsv('Email,Extended Time\n"a@x.edu",1.5\nb@x.edu,150%\n');
  t('roster CSV parses with quotes and mixed multiplier forms',
    csv.length === 3 && csv[1][0] === 'a@x.edu' && csv[2][1] === '150%', JSON.stringify(csv[1]));

  // Certificates are found by SHAPE, wherever they sit and whatever they are
  // called — a rename must not make a submission invisible to the audit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oralscale-selftest-'));
  try {
    const mk = (rel, obj) => {
      const p2 = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p2), { recursive: true });
      fs.writeFileSync(p2, JSON.stringify(obj));
    };
    const cert = (ref, claimed, usedSec) => ({
      studentRef: ref, attemptId: 'att-' + ref, limitSec: 100, bufferSec: 0,
      accommodation: { claimedMultiplier: claimed, baseLimitSec: 100, baseBufferSec: 0 },
      // Real certificates carry answerSec per segment (signer.js), which is what
      // protocol.withinGrantedTime reads. The first version of this fixture
      // invented questionOffsetSec/closingOffsetSec and passed against a
      // hand-rolled copy of the arithmetic — the copy is gone, and so is the
      // fixture that only worked against it.
      segments: [{ questionId: 'q1', answerSec: usedSec,
                   questionOffsetSec: 0, closingOffsetSec: usedSec }],
    });
    mk('Student A/certificate.json', cert('k:AAA', 2, 120));      // claimed 2x, used 120s
    mk('Student B/nested/renamed.json', cert('k:BBB', 1.5, 140)); // odd name, still found
    mk('Student C/certificate.json', cert('k:CCC', 1, 90));       // no claim
    mk('Student D/notes.json', { hello: 'not a certificate' });

    const found = certificatesIn(dir);
    t('certificates are found by shape, not filename', found.length === 3,
      `${found.length} found, ignoring a non-certificate json`);

    // 2x claimed against a 1.5x grant, but 120s is inside 1.5 x 100 = 150s:
    // no advantage taken, so this must NOT be reported.
    const a2 = found.find((f) => f.cert.studentRef === 'k:AAA').cert;
    t('claiming above the grant but finishing inside it is NOT a problem',
      withinGranted(a2, 1.5).ok === true, `allowed ${withinGranted(a2, 1.5).allowedSec}s, used 120s`);
    // The same claim, against a 1x grant: 120s > 100s, so it IS reported.
    t('claiming above the grant AND running past it IS a problem',
      withinGranted(a2, 1).ok === false, `allowed ${withinGranted(a2, 1).allowedSec}s, used 120s`);

    // The join is on the derived ref, so a roster email is never compared to
    // anything in the export.
    const ref = P.studentRefForEmail('test-secret', 'c1', 'a@x.edu', 1);
    t('the join key is the derived studentRef, not an email',
      /^k:[0-9A-Z]+$/.test(ref) && !ref.includes('@'), ref);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(fails.length ? `\n❌ ${fails.length} self-test failure(s)\n` : '\n✅ audit self-test OK\n');
  process.exit(fails.length ? 1 : 0);
}

/* --- main ------------------------------------------------------------------ */
requireHuman();

const coursePath = arg('course');
const subsPath = arg('submissions');
const rosterPath = arg('roster');
if (process.argv.includes('--help') || !coursePath || !subsPath || !rosterPath) {
  console.log(`
Audit extended-time claims against your own records. Run this yourself, in a
terminal. It must not be run by an AI assistant or in CI.

  node tools/audit-accommodations.js \\
    --submissions <export.zip | extracted-folder> \\
    --course      courses/<id>/course.json \\
    --roster      <csv with an email column and a multiplier column>

Reports only claims your records do not support. Emails are never written
anywhere; the roster is read, hashed, and dropped.
`);
  process.exit(coursePath && subsPath && rosterPath ? 0 : 1);
}
for (const [label, p] of [['submissions', subsPath], ['roster', rosterPath], ['course', coursePath]]) {
  if (!fs.existsSync(p)) die(`No such ${label}: ${p}`);
}

const { course, courseDir } = loadCourse(coursePath);
const resolved = SECRETS.resolve(courseDir, course.courseId);
if (!resolved) die(`No signing Secret for "${course.courseId}".`);
const SECRET = resolved.secret;
const epoch = Number(course.accessKeyEpoch || 1);

console.log(`\nOralScale — offline accommodation audit`);
console.log(`  course      : ${course.courseId}`);
console.log(`  submissions : ${subsPath}`);
console.log(`  roster      : ${rosterPath}`);
console.log(`  secret      : ${resolved.source}`);
console.log(`\nThe roster names students with disability accommodations. It is read into`);
console.log(`memory, hashed, and never written anywhere. Nothing is sent off this machine.`);
const ok = confirm(`\nType "audit" to continue: `);
if (ok !== 'audit') die('\nCancelled. Nothing was read.');

// Roster -> { studentRef: granted }. Emails never leave this block.
const rows = readCsv(fs.readFileSync(rosterPath, 'utf8'));
if (rows.length < 2) die('Roster CSV needs a header row and at least one student row.');
const header = rows[0].map((h) => String(h).trim().toLowerCase());
const findCol = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
const emailCol = findCol('email', 'e-mail', 'student');
const multCol = findCol('multiplier', 'multiple', 'extension', 'extended', 'time');
if (emailCol < 0) die(`No email/student column. Header was: ${header.join(', ')}`);
if (multCol < 0) die(`No multiplier column. Header was: ${header.join(', ')}`);

const granted = new Map();
let rosterN = 0;
for (const r of rows.slice(1)) {
  const email = String(r[emailCol] || '').trim();
  const mult = parseMultiplier(r[multCol]);
  if (!email.includes('@') || mult === null) continue;
  const ref = P.studentRefForEmail(SECRET, course.courseId, email, epoch);
  granted.set(ref, Math.max(granted.get(ref) || 0, mult));
  rosterN++;
}

let root = subsPath, tmp = null;
if (/\.zip$/i.test(subsPath)) { tmp = extractZip(subsPath); root = tmp; }

try {
  const certs = certificatesIn(root);
  console.log(`\n  ${certs.length} certificate(s) found · ${rosterN} roster entry/entries\n`);
  if (!certs.length) die('No certificates in that export. Is it an OralScale assignment?');

  const problems = [];
  let claims = 0, matched = 0, noClaim = 0;
  for (const { file, cert } of certs) {
    const claimed = Number((cert.accommodation || {}).claimedMultiplier || 1);
    if (!(claimed > 1)) { noClaim++; continue; }
    claims++;
    const g = granted.get(cert.studentRef);
    const where = path.relative(root, file);
    if (g === undefined) {
      problems.push({ where, claimed, granted: null,
        why: 'claimed extended time, but is not in your roster' });
      continue;
    }
    if (claimed <= g + 1e-9) { matched++; continue; }
    // Claimed more than granted. Only a problem if they also USED more than the
    // grant allows — selecting the wrong rung and finishing in time takes
    // nothing from anyone, and flagging it would punish a misread dropdown.
    const w = withinGranted(cert, g);
    if (w.ok) { matched++; continue; }
    problems.push({ where, claimed, granted: g,
      why: `claimed ${claimed}x against a granted ${g}x, AND ran past the `
         + `${w.allowedSec}s that ${g}x allows (${w.over.map((o) => `${o.questionId} ${o.usedSec}s`).join(', ')})` });
  }

  console.log(`  no accommodation claimed : ${noClaim}`);
  console.log(`  claimed and supported    : ${matched}`);
  console.log(`  NEEDS A LOOK             : ${problems.length}\n`);
  if (!problems.length) {
    console.log('  ✅ Every claim is consistent with your roster. Nothing to do.\n');
  } else {
    for (const p of problems) {
      console.log(`  ⚠️  ${p.where}`);
      console.log(`      ${p.why}\n`);
    }
    console.log('  These are starting points for a human, not findings. The commonest cause');
    console.log('  is a roster that is out of date — an accommodation granted after you last');
    console.log('  exported, or recorded at course level. Check before treating it as anything.\n');
  }
  console.log('  Nothing was written to disk. Close this terminal when you are done.\n');
} finally {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}
