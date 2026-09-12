#!/usr/bin/env node
'use strict';
/*
 * One command from a course folder to "ready for Gradescope".
 *
 *   npm run launch -- courses/<id>/course.json
 *
 * It runs the two commands you would otherwise run in order, and they remain
 * available on their own:
 *
 *   npm run deploy  -- <course.json>     the Signer + the student page
 *   npm run package -- <course.json>     one autograder zip per assignment
 *
 * WHY WRAP THEM. They are always run together, always in this order, and getting
 * the order wrong is silent: package a zip before deploying and it carries no
 * webappUrl, so the student who submits with no recording is told nothing about
 * where the quiz lives. Wrapping is not there to save typing — it is there so the
 * ordering cannot be got wrong.
 *
 * WHY NOT MORE. It stops before anything that needs the instructor's account or
 * judgement: no Gradescope, no key distribution, no `wrangler login`. Those are
 * printed as a checklist instead. A launch command that half-did the human steps
 * would be worse than none.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const OK = (s) => `\x1b[32m${s}\x1b[0m`;

const args = process.argv.slice(2);
const coursePath = args.find((a) => !a.startsWith('--'));
if (!coursePath || !fs.existsSync(coursePath)) {
  console.error('\nWhich course?  npm run launch -- courses/<id>/course.json\n');
  const dir = path.join(ROOT, 'courses');
  if (fs.existsSync(dir)) {
    console.error('Available:');
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'course.json'))) {
        console.error(`  courses/${e.name}/course.json`);
      }
    }
    console.error('');
  }
  process.exit(1);
}

const step = (n, what) => console.log(`\n${B(`${n}/2  ${what}`)}`);

step(1, 'Deploying the Signer and the student page');
let r = spawnSync('bash', [path.join(ROOT, 'tools', 'deploy.sh'), coursePath],
  { stdio: 'inherit', cwd: ROOT });
if (r.status !== 0) {
  console.error('\n❌ Deploy failed. Nothing was packaged — fix the above and re-run.');
  console.error('   Not logged in?  npx wrangler login\n');
  process.exit(r.status || 1);
}

// AFTER the deploy, on purpose: deploy.sh writes signerUrl and webappUrl back
// into course.json, and the zip has to carry them.
step(2, 'Building one autograder per assignment');
r = spawnSync('node', [path.join(ROOT, 'tools', 'build-autograder.js'), coursePath, '--zip'],
  { stdio: 'inherit', cwd: ROOT });
if (r.status !== 0) process.exit(r.status || 1);

const course = JSON.parse(fs.readFileSync(coursePath, 'utf8'));
const ids = Object.keys(course.assignments || {});
const first = ids.includes('demo-quiz') ? 'demo-quiz' : ids[0];

console.log(`\n${OK('Deployed and packaged.')} What is left needs your Gradescope account:\n`);
console.log(`  1. Create a Programming Assignment for ${B(first)}.`);
console.log('     Upload the zip whose FILENAME names it, from');
console.log(`       ${path.join(path.dirname(coursePath), 'autograders')}/`);
console.log('     Settings: the container size and 40-minute timeout printed above.');
console.log(DIM('     (Gradescope grades the most recent submission; students re-activate an'));
console.log(DIM('      earlier one from Submission History. There is no "highest score" option.)'));
console.log('');
console.log('  2. Paste the student link into that assignment description:');
console.log(DIM(`       node tools/gen-url.js --course ${coursePath} --assignment ${first}`));
console.log('');
console.log('  3. Mint yourself a key and take it, end to end, including the upload:');
console.log(DIM(`       node tools/gen-access-keys.js --course ${coursePath} --student you@your.edu`));
console.log('');
console.log(`     ${B('Do not skip this.')} That single run is the only thing that proves your`);
console.log('     Signer and your autograder hold the same Secret — the failure that otherwise');
console.log('     shows up as an entire cohort scoring zero.\n');
