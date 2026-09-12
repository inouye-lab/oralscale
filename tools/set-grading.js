#!/usr/bin/env node
'use strict';
/*
 * Change the grading backend or a score adjustment — for a
 * whole course or for ONE assignment — without editing JSON by hand.
 *
 *   node tools/set-grading.js --course courses/<your-course> --backend genai
 *   node tools/set-grading.js --course courses/<your-course> --assignment week-10-x --backend local
 *   node tools/set-grading.js --course courses/<your-course> --assignment week-04-topic \
 *        --bonus 1.5 --reason "Question w04-071 was ambiguous; adjustment for the whole class."
 *   node tools/set-grading.js --course courses/<your-course> --show
 *
 * WHY THIS EXISTS RATHER THAN "edit course.json"
 * ---------------------------------------------
 * Switching backends mid-term is a normal thing to need — GenAI for the first
 * weeks, local afterwards, or the reverse after an outage — and the edit itself
 * is one word. What is NOT obvious is everything that has to be true around it:
 * the zip must be rebuilt, the GenAI key must be present if any assignment still
 * needs it and absent if none does, and a changed grader wants re-calibrating
 * before students meet it. This prints that checklist every time, so the easy
 * edit does not quietly leave the hard parts undone.
 *
 * A per-ASSIGNMENT setting beats a per-assignment zip. The week is resolved from
 * the Gradescope assignment title, so one zip already serves every week; putting
 * the override in course.json keeps that true. Building a second zip for one week
 * means two artifacts to keep in step, and the one you forget is the one that
 * grades wrong.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const val = (n) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const has = (n) => args.includes('--' + n);

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const WARN = (s) => `\x1b[33m${s}\x1b[0m`;
const OK = (s) => `\x1b[32m${s}\x1b[0m`;

const BACKENDS = ['local', 'genai', 'heuristic'];

let courseArg = val('course');
if (!courseArg) {
  console.error('Usage: node tools/set-grading.js --course courses/<id> [--assignment <id>]');
  console.error('       [--backend local|genai|heuristic] [--bonus <points>]');
  console.error('       [--reason "..."] [--show]');
  process.exit(1);
}
const coursePath = courseArg.endsWith('.json') ? courseArg : path.join(courseArg, 'course.json');
if (!fs.existsSync(coursePath)) {
  console.error(`No such course.json: ${coursePath}`);
  process.exit(1);
}
const courseDir = path.dirname(coursePath);
const course = JSON.parse(fs.readFileSync(coursePath, 'utf8'));
course.defaults = course.defaults || {};
course.assignments = course.assignments || {};

const assignment = val('assignment');
if (assignment && !course.assignments[assignment]) {
  console.error(`No such assignment "${assignment}". Known: ${Object.keys(course.assignments).join(', ')}`);
  process.exit(1);
}
const target = assignment ? course.assignments[assignment] : course.defaults;
const scope = assignment ? `assignment ${assignment}` : 'course defaults';

const backendOf = (aid) => String(
  course.assignments[aid].gradingBackend ?? course.defaults.gradingBackend ?? 'local').toLowerCase();

function show() {
  console.log(`\n${B(course.courseId)} — grading configuration\n`);
  console.log(`  ${DIM('defaults')}  backend=${course.defaults.gradingBackend || 'local'}`
    + `  localModel=qwen2.5-3b ${DIM('(the only one)')}`
    + `  scoreBonus=${course.defaults.scoreBonus || 0}`);
  const rows = Object.keys(course.assignments).map((aid) => {
    const a = course.assignments[aid];
    const over = [];
    if (a.gradingBackend) over.push(`backend=${a.gradingBackend}`);
    if (a.localModel && a.localModel !== 'qwen2.5-3b') {
      over.push(`localModel=${a.localModel} ${WARN('(stale — ignored)')}`);
    }
    if (a.scoreBonus) over.push(`scoreBonus=${a.scoreBonus > 0 ? '+' : ''}${a.scoreBonus}`);
    return { aid, backend: backendOf(aid), over };
  });
  const byBackend = {};
  for (const r of rows) (byBackend[r.backend] = byBackend[r.backend] || []).push(r.aid);
  console.log();
  for (const [b, list] of Object.entries(byBackend)) {
    console.log(`  ${B(b)}: ${list.length} assignment(s)`);
  }
  const overridden = rows.filter((r) => r.over.length);
  if (overridden.length) {
    console.log(`\n  ${DIM('per-assignment overrides')}`);
    for (const r of overridden) console.log(`    ${r.aid}  ${r.over.join('  ')}`);
  }
  const calPath = path.join(courseDir, 'calibration.json');
  console.log();
  if (fs.existsSync(calPath)) {
    const cal = JSON.parse(fs.readFileSync(calPath, 'utf8'));
    console.log(`  calibration.json fitted ${cal.fittedAt || '?'} for: ${Object.keys(cal.backends || {}).join(', ')}`);
  } else {
    console.log(WARN('  no calibration.json — grading will use RAW model scores'));
  }
  console.log();
}

if (has('show') || (!val('backend') && !val('model') && val('bonus') === null)) {
  show();
  process.exit(0);
}

const changes = [];

const backend = val('backend');
if (backend) {
  if (!BACKENDS.includes(backend)) {
    console.error(`--backend must be one of: ${BACKENDS.join(', ')}`);
    process.exit(1);
  }
  changes.push(`gradingBackend: ${target.gradingBackend || '(inherited)'} -> ${backend}`);
  target.gradingBackend = backend;
}

const model = val('model');
if (model) {
  console.error('--model is gone: there is one bundled local model, qwen2.5-3b.');
  console.error('');
  console.error('  Eleven alternatives from 1.5B to 9B were measured against it and none won;');
  console.error('  bigger models grade WORSE here, because they are generous and that shows up');
  console.error('  as ties. See docs/reference/GRADER-BACKENDS.md.');
  console.error('');
  console.error('  If you want better grading than the local model gives, the real choice is');
  console.error('  the BACKEND, not the model:  --backend genai  (Purdue GenAI qwen3.6:27b,');
  console.error('  noticeably better at marking — but the transcript leaves the container).');
  process.exit(1);
}

const bonusRaw = val('bonus');
if (bonusRaw !== null) {
  const bonus = Number(bonusRaw);
  if (!Number.isFinite(bonus)) {
    console.error('--bonus must be a number of POINTS, e.g. 1.5');
    process.exit(1);
  }
  const reason = val('reason');
  if (bonus !== 0 && !reason && !target.scoreBonusReason) {
    // Refused rather than warned. A blanket adjustment with no recorded reason
    // is the thing an instructor cannot defend when a student asks in week 12,
    // and the reason costs one flag to supply.
    console.error(WARN('A non-zero bonus needs --reason "…". It is shown to students and kept'));
    console.error(WARN('in the instructor record; a bonus nobody wrote a reason for is'));
    console.error(WARN('indefensible six weeks later.'));
    process.exit(1);
  }
  changes.push(`scoreBonus: ${target.scoreBonus || 0} -> ${bonus}`);
  target.scoreBonus = bonus;
  if (reason) target.scoreBonusReason = reason;
  if (bonus === 0) delete target.scoreBonusReason;
}

fs.writeFileSync(coursePath, JSON.stringify(course, null, 2) + '\n');
console.log(`\n${OK('✓')} ${path.relative(process.cwd(), coursePath)} — ${scope}`);
for (const c of changes) console.log(`    ${c}`);

// ---- the checklist that makes the edit actually take effect ---------------
const anyGenai = Object.keys(course.assignments).some((a) => backendOf(a) === 'genai');
const allGenai = Object.keys(course.assignments).every((a) => backendOf(a) === 'genai');

console.log(`\n${B('Now:')}`);
console.log(`  1. Rebuild and re-upload the zip — nothing changes until you do:`);
console.log(`       node tools/build-autograder.js ${path.relative(process.cwd(), coursePath)} --zip`);
if (backend) {
  console.log(`  2. Re-calibrate — a different grader has a different scale:`);
  console.log(`       python3 tools/calibrate-grader.py --course ${path.relative(process.cwd(), courseDir)} --backend ${backend}`);
  console.log(`  3. Regrade the affected submissions in Gradescope if they were already graded.`);
}
if (anyGenai) {
  console.log(`\n  ${WARN('GENAI_STUDIO_API_KEY must be available at build time')} — ${allGenai ? 'every' : 'some'}`);
  console.log(`  assignment uses genai, so the key WILL be written into the zip in plaintext.`);
} else {
  console.log(`\n  ${OK('No assignment uses genai')}, so the build will now leave the GenAI key OUT`);
  console.log(`  of the zip entirely. Nothing else to do.`);
}
console.log();
