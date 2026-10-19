#!/usr/bin/env node
'use strict';
/*
 * Refuse to let a course ship with the enrolment gate off.
 *
 *   node tools/check-course-safety.js          check every course.json on disk
 *
 * Run by the pre-commit hook and by CI, alongside tools/check-secrets.js.
 *
 * WHY
 * `requireAccessKey: false` is "open mode": the Signer serves a question to
 * anyone who supplies a well-formed opaque ref. The course link is PUBLIC — it
 * lives in the assignment description — so with the gate off, anyone holding it
 * can call /reveal in a loop until they have the whole Bank (INV-SEC-8). The
 * Bank is the one asset that must not leak before the quiz.
 *
 * It is a legitimate setting for exactly one thing: a public demo, where the
 * bank is generic, nothing is assessed, and there is nothing to protect. The
 * risk is that a demo config gets copied into a real course, because copying a
 * working example is what everyone does. So the allowance is granted by PATH,
 * to the demo course alone, and any other course that turns the gate off fails
 * the commit.
 *
 * The demo itself no longer runs open either — it uses one shared key — so this
 * check currently has nothing to allow. That is the point: the dangerous setting
 * should never be modelled as normal.
 */
const fs = require('fs');
const path = require('path');
const SECRETS = require('./lib/secrets.js');

const ROOT = path.join(__dirname, '..');

/* Courses permitted to run open, and why. Paths, never patterns. */
const ALLOWED = [
  ['courses/demo/', 'the public demo: generic bank, nothing assessed, nothing to protect'],
  ['courses/_shell-for-testsuite/', 'a test fixture that is never deployed'],
  ['courses/_testsuite/', 'the suites\' own fixtures — never deployed, never shown to anyone'],
  ['courses/_template/', 'a skeleton that is never deployed'],
];

function courseFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const own = path.join(dir, 'course.json');
  if (fs.existsSync(own)) { out.push(own); return out; }
  // Do not discover an extracted package or research snapshot as another course.
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) courseFiles(p, out);
    else if (e.name === 'course.json') out.push(p);
  }
  return out;
}

/* EVERY COURSE HAS ITS OWN SECRET, AND NO TWO SHARE ONE.
 *
 * Not a preference. Two courses on one Secret means either can forge the other's
 * certificates and mint the other's quiz keys, and a Secret compromised in one
 * ends every grade in both. It is also how a demo link came to be signed with
 * a real course's Secret: the resolver used to fall back to a shared file, so whichever
 * course wrote it last decided what everyone else signed with.
 *
 * The fallback is gone (tools/lib/secrets.js). This is the check that keeps it
 * gone, because "no course silently borrows another's Secret" is a property no
 * single build can see — it only shows up when you look at all of them at once.
 *
 * A placeholder courseId (the `_template` skeleton) is skipped: it is not a
 * course, and minting a Secret for `<your-course-id>` would be meaningless. */
function secretFindings() {
  const out = [];
  const a = SECRETS.audit(path.join(ROOT, 'courses'));
  for (const c of a.courses) {
    if (/[<>]/.test(c.courseId)) continue;          // placeholder skeleton
    if (!c.has) {
      out.push({ rel: c.rel, what: `has NO signing Secret of its own (secrets/${c.courseId}.json).\n`
        + `      Mint one:  node tools/make-config.js --course ${c.rel}` });
    }
  }
  for (const ids of a.shared) {
    out.push({ rel: ids.join(' + '), what: 'SHARE one signing Secret. Either can forge the other\'s '
      + 'certificates\n      and mint the other\'s quiz keys. Give each its own:\n'
      + ids.map((i) => `      node tools/make-config.js --course courses/${i}/course.json --force`).join('\n') });
  }
  return out;
}

function main() {
  const findings = secretFindings();
  // Kept apart from `findings`: a missing label is required and is NOT a gate,
  // and the two deserve different words. See the check itself, below.
  const labelFindings = [];
  for (const file of courseFiles(path.join(ROOT, 'courses'))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const allowed = ALLOWED.find(([prefix]) => rel.startsWith(prefix));
    let course;
    try { course = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { findings.push({ rel, what: `is not valid JSON (${e.message})` }); continue; }

    if (Object.prototype.hasOwnProperty.call(course, 'debugAutograder')) {
      findings.push({rel, what:'contains DEBUG package metadata; keep it out of source course configuration'});
    }
    const defaults = course.defaults || {};
    const open = [];
    for (const [aid, a] of Object.entries(course.assignments || {})) {
      const v = a.requireAccessKey !== undefined ? a.requireAccessKey : defaults.requireAccessKey;
      // Absent means the CODE default, which is true. Only an explicit false is open.
      if (v === false) open.push(aid);
    }
    if (open.length && !allowed) {
      findings.push({ rel, what: `runs OPEN (requireAccessKey:false) on: ${open.join(', ')}` });
    }

    /* The demo identity bypass (INV-DEMO-1). Same reasoning as open mode and the
     * same allow-list: it is legitimate for a public demo, catastrophic in a real
     * course, and the way it gets into a real course is by being copied out of a
     * working example. Read PER ASSIGNMENT only — it is deliberately not a course
     * default, so `defaults` setting it is itself a finding. */
    const noId = [];
    for (const [aid, a] of Object.entries(course.assignments || {})) {
      if (a.demoSkipIdentityCheck === true) noId.push(aid);
    }
    if (defaults.demoSkipIdentityCheck !== undefined) {
      findings.push({ rel, what: 'sets demoSkipIdentityCheck in "defaults" — it is per-assignment '
        + 'only, so a course default would silently disable identity for every future assignment' });
    }
    if (noId.length && !allowed) {
      findings.push({ rel, what: `DISABLES IDENTITY VERIFICATION (demoSkipIdentityCheck) on: ${noId.join(', ')}` });
    }

    /* EVERY ASSIGNMENT NAMES ITSELF (INV-USE-1).
     *
     * `shortTitle` is the short, topic-free label the app prints above the quiz and
     * the only assignment text stamped into a student's link. Without it the app
     * falls back to the assignment id — and ids name the week's subject
     * (`week-03-pca`, `quiz-02-methods-and-models`), so the fallback puts a
     * hint above the quiz and inside the link, readable before a question is served.
     *
     * NOT a gate, and reported separately from the gates for that reason: nothing
     * routes, grades or selects questions on it. Required anyway, and cheap to
     * require precisely because it is display only — backfilling a course cannot
     * change anybody's mark. No allow-list either: the demo and the fixtures are
     * where a real course gets copied from, so an unlabelled example is how the
     * omission spreads. */
    const unlabelled = Object.entries(course.assignments || {})
      .filter(([, a]) => !a.shortTitle).map(([aid]) => aid);
    if (unlabelled.length) {
      labelFindings.push({ rel, what: `assignment(s) with no "shortTitle": ${unlabelled.join(', ')}` });
    }
  }

  if (!findings.length && !labelFindings.length) {
    console.log('✅ every course requires a quiz key, verifies identity, holds its own signing '
      + 'Secret, and names each assignment without naming its topics.');
    return;
  }

  if (!findings.length) {
    // Labels only: a real problem, but not the gate emergency below, and printing
    // the gate emergency for it is how a load-bearing warning becomes noise.
    console.error('\n\x1b[31m╔══════════════════════════════════════════════════════════════════╗');
    console.error('║  COMMIT BLOCKED — an assignment does not name itself.            ║');
    console.error('╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n');
    for (const f of labelFindings) console.error(`  ${f.rel}\n      ${f.what}`);
    console.error('\n  "shortTitle" is the label the student app prints above the quiz, and the only');
    console.error('  assignment text carried in their link. Without it the app falls back to the');
    console.error('  assignment id — and an id names the topics, so the fallback tells a student');
    console.error('  what the quiz is about before they have seen a question (INV-USE-1).');
    console.error('\n  Fix: add a short, topic-free label to each assignment above:');
    console.error('\n       "shortTitle": "Oral Quiz 3"');
    console.error('\n  It is display only — nothing routes, grades or selects questions on it — so');
    console.error('  adding it to an existing course changes nothing anyone is graded on. Keep it');
    console.error('  true if the quiz is later re-scoped or becomes a review; matching the');
    console.error('  Gradescope assignment name is useful but not required.');
    console.error('');
    process.exit(1);
  }

  console.error('\n\x1b[31m╔══════════════════════════════════════════════════════════════════╗');
  console.error('║  COMMIT BLOCKED — a course has a safety gate turned OFF.         ║');
  console.error('╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n');
  for (const f of findings) console.error(`  ${f.rel}\n      ${f.what}`);
  for (const f of labelFindings) console.error(`  ${f.rel}\n      ${f.what} (INV-USE-1)`);
  console.error('\n  The course link is PUBLIC — it sits in the assignment description. With the');
  console.error('  gate off, anyone holding it can call /reveal in a loop until they have the');
  console.error('  whole question bank, before the quiz (INV-SEC-8).');
  console.error('\n  Fix: set "requireAccessKey": true, and hand out keys:');
  console.error('       node tools/gen-access-keys.js --course <course.json> --roster <export>');
  console.error('\n  And "demoSkipIdentityCheck" turns off the check that the certificate was');
  console.error('  issued to the student submitting it (INV-SEC-2). With it on, ONE recording');
  console.error('  can be uploaded by the whole class and every one of them is graded on it.');
  console.error('  Fix: delete the key from the assignment and rebuild the autograder zip.');
  console.error('\n  A course Secret is NEVER shared and NEVER inherited: there is no fallback, so a');
  console.error('  course without its own secrets/<courseId>.json cannot be built at all.');
  console.error('\n  The gate-off settings are allowed only for:');
  for (const [p, why] of ALLOWED) console.error(`       ${p.padEnd(32)} ${why}`);
  console.error('');
  process.exit(1);
}

main();
