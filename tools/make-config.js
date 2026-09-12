#!/usr/bin/env node
'use strict';
/*
 * Create server/config.json with a fresh random signing secret.
 * Run once per deployment. Keep the secret out of version control.
 *
 *   node tools/make-config.js            create it (refuses to clobber)
 *   node tools/make-config.js --force    replace it (invalidates old certificates)
 *   node tools/make-config.js --print    print the current secret to stdout
 *
 * --print exists because the secret has to be pasted into exactly two places --
 * `wrangler secret put ORALSCALE_SECRET` and the autograder's secret.env -- and
 * they must match or every certificate fails to verify.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const S = require('./lib/secrets.js');
const GUARDS = require('./lib/course-guards.js');
const out = path.join(__dirname, '..', 'server', 'config.json');

/* ---- per-course secrets -------------------------------------------------
 * One Secret per course: a compromise in one course does not touch another, a
 * course can change hands without re-keying everything else, and a course can be
 * retired on its own at the end of term.
 *
 *   node tools/make-config.js --course courses/<id>/course.json
 *   node tools/make-config.js --course … --print
 *   node tools/make-config.js --course … --force     ROTATES. Read the warning.
 */
const courseArgIdx = process.argv.indexOf('--course');
if (courseArgIdx >= 0 && process.argv[courseArgIdx + 1]) {
  const coursePath = process.argv[courseArgIdx + 1];
  if (!fs.existsSync(coursePath)) {
    console.error(`No such course.json: ${coursePath}`);
    process.exit(1);
  }
  const course = JSON.parse(fs.readFileSync(coursePath, 'utf8'));
  const courseId = course.courseId;
  const courseDir = path.dirname(path.resolve(coursePath));
  const target = S.envPath(courseDir);
  const rel2 = path.relative(path.join(__dirname, '..'), target);

  if (process.argv.includes('--print')) {
    const r = S.resolve(courseDir, courseId);
    if (!r) { console.error(`No secret for "${courseId}". Run without --print to create one.`); process.exit(1); }
    process.stdout.write(r.secret + '\n');
    process.exit(0);
  }

  const existing = S.resolve(courseDir, courseId);
  const rotatingRequested = !!existing && process.argv.includes('--force');
  if (existing && !process.argv.includes('--force')) {
    console.log(`"${courseId}" already has a Secret: ${existing.source}`);
    console.log('Nothing changed. --force ROTATES it, which invalidates every quiz key, every');
    console.log('live link and every unsubmitted certificate in this course.');
    process.exit(0);
  }

  /* A BUILT-IN COURSE IS NOT YOURS TO RE-KEY.
   *
   * The tempting way out of a Secret clash is to rotate whichever course the
   * error names — and when a new course was started by copying `_template`, the
   * demo or a fixture, the error names the SHIPPED one. Rotating it makes the
   * message go away and leaves the real problem exactly where it was: a course
   * signing with a Secret someone else's copy also holds. The fixtures also back
   * the test suite, so re-keying one turns a configuration mistake into a red
   * test run nobody connects to it.
   *
   * Refused rather than warned. There is no flag; edit courses/<id>/.env by hand
   * if you are the maintainer and genuinely mean it. */
  if (rotatingRequested && S.isBuiltIn(courseDir)) {
    console.error('');
    console.error('\x1b[31m╔══════════════════════════════════════════════════════════════════╗\x1b[0m');
    console.error('\x1b[31m║  REFUSED — "' + courseId + '" ships with OralScale.' + ' '.repeat(Math.max(0, 27 - courseId.length)) + '║\x1b[0m');
    console.error('\x1b[31m╚══════════════════════════════════════════════════════════════════╝\x1b[0m');
    console.error('');
    console.error('  Built-in courses — _template, the demo and the test fixtures — keep the');
    console.error('  Secrets they ship with. This is almost always the wrong lever:');
    console.error('');
    console.error('  If you hit a CLASH, the course to change is YOURS, not this one. A clash');
    console.error('  means your course folder was copied from a built-in and brought .env with');
    console.error('  it. Re-keying the built-in hides that and leaves your course signing with a');
    console.error('  Secret every other copy also has.');
    console.error('');
    console.error('      node tools/make-config.js --course courses/<your-course>/course.json --force');
    console.error('');
    console.error('  _template deliberately has NO Secret at all: one there would be a Secret');
    console.error('  shared by every course ever copied from it.');
    console.error('');
    process.exit(1);
  }

  /* GUARDS FIRST, always — before a Secret exists in the folder, not after. */
  GUARDS.ensure(courseDir, { log: (m) => console.log(m) });

  /* Never mint a value another course already holds. Astronomically unlikely by
   * chance; entirely likely by copying a course folder, which is the documented
   * way to start a new course. Retried rather than reported, then refused if
   * something is deeply wrong. */
  let secret = null;
  for (let i = 0; i < 5 && !secret; i++) {
    const candidate = S.mint();
    if (!S.clashes(candidate, courseId).length) secret = candidate;
  }
  if (!secret) {
    console.error('Could not mint a Secret unused by every other course. Something is wrong.');
    process.exit(1);
  }

  const rotating = !!existing;
  /* A rotation REPLACES .env rather than editing one line.
   *
   * The reason to rotate is almost always that this .env was copied from another
   * course — which means every OTHER line in it was copied too: that course's
   * GenAI key, its settings. Keeping them would leave this course quietly using
   * another course's credentials, which is the same class of bug one layer down.
   * So the file is rewritten to the Secret alone, and the user is told exactly
   * what went, so they can put back what is genuinely theirs. */
  const dropped = rotating ? S.otherKeys(courseDir) : [];
  S.write(courseDir, secret, { replaceFile: rotating });

  if (rotating) {
    console.log(`\n\x1b[31mROTATED\x1b[0m the Secret for "${courseId}" -> ${rel2}`);
    console.log('\nEvery quiz key, every live link and every unsubmitted certificate in this');
    console.log('course is now invalid. To finish the rotation you must do ALL of:');
    console.log(`  1. re-mint keys      node tools/gen-access-keys.js --course ${coursePath} --roster <export>`);
    console.log('  2. redistribute them (Brightspace import)');
    console.log(`  3. re-issue the link node tools/gen-url.js --course ${coursePath} --assignment <id>`);
    console.log('  4. redeploy the Signer (wrangler secret put ORALSCALE_SECRET)');
    console.log(`  5. rebuild the zips  node tools/build-autograder.js ${coursePath} --zip`);
    console.log('');
    if (dropped.length) {
      console.log(`\x1b[33m  ${rel2} was REWRITTEN to the new Secret alone.\x1b[0m`);
      console.log(`  These other entries were REMOVED: ${dropped.join(', ')}`);
      console.log('');
      console.log('  Deliberate. A rotation is usually needed because this .env was copied from');
      console.log('  another course — so those values were copied too, and keeping them would');
      console.log('  leave this course using another course\'s credentials. Add back by hand only');
      console.log('  what genuinely belongs to THIS course.');
    } else {
      console.log(`  ${rel2} now contains the new Secret and nothing else.`);
    }
    console.log('');
  } else {
    console.log(`\nCreated a Secret for "${courseId}" -> ${rel2}`);
    console.log('');
    console.log('It lives INSIDE the course folder on purpose: that folder is the whole course,');
    console.log('so copying or cloning it brings everything needed with it. Nothing outside it');
    console.log('belongs to this course, and nothing this course needs lives anywhere else.');
  }
  console.log('\nIt must reach the Signer and the autograder zip, or certificates will not verify:');
  console.log('  cd server/worker && npx wrangler secret put ORALSCALE_SECRET   # paste --print output');
  console.log(`  node tools/build-autograder.js ${coursePath} --zip             # does it for you`);
  console.log(`\nNever commit it. ${path.relative(path.join(__dirname, '..'), path.join(courseDir, '.gitignore'))} ignores it and a pre-commit guard blocks the accident.\n`);
  process.exit(0);
}

if (process.argv.includes('--print')) {
  if (!fs.existsSync(out)) {
    console.error('No server/config.json yet. Run: node tools/make-config.js');
    process.exit(1);
  }
  process.stdout.write(JSON.parse(fs.readFileSync(out, 'utf8')).secret + '\n');
  process.exit(0);
}

if (fs.existsSync(out) && !process.argv.includes('--force')) {
  console.error(`Refusing to overwrite ${out} (pass --force to replace).`);
  process.exit(1);
}
const cfg = {
  secret: crypto.randomBytes(32).toString('hex'),
  port: 8787,
  allowOrigin: '*',
  graceSec: 20,
};
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n');
console.log(`Wrote ${out}`);
console.log('Signing secret generated. Do NOT commit server/config.json (it is gitignored).');
