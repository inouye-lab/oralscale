#!/usr/bin/env node
'use strict';
/*
 * Bundle course.json + referenced banks into autograder/source/, and optionally
 * package a course-bound Gradescope zip in the same step.
 *
 *   node tools/build-autograder.js [courses/<id>/course.json]          bundle only
 *   node tools/build-autograder.js [courses/<id>/course.json] --zip    bundle + package
 *   npm run package -- courses/<id>/course.json --zip                  (same, shorter)
 *
 * With --zip it supplies the secrets itself, so there is nothing to type and
 * nothing to mistype:
 *   ORALSCALE_SECRET      <- server/config.json (the one the Worker was given)
 *   ORALSCALE_WEBAPP_URL  <- course.json webappUrl (recorded by tools/deploy.sh)
 *   GENAI_STUDIO_*        <- passed through from the environment if present
 * They are handed to build.sh as environment, which writes them into the zip and
 * deletes the file afterwards — nothing secret is left on disk.
 *
 * Bundling stays the default because the test harnesses call this to refresh
 * autograder/source/ and must not need secrets or produce a zip.
 */
const fs = require('fs');
const path = require('path');
const { resolveBank, warnIfUnbacked } = require('./lib/course.js');
const SECRETS = require('./lib/secrets.js');
const GUARDS = require('./lib/course-guards.js');
const LOCAL = require('./lib/local-profile.js');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const optValue = (n) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const coursePath = args.find((a) => !a.startsWith('--') && a !== optValue('assignment') && a !== optValue('regrade'))
  || path.join(ROOT, 'courses', 'demo', 'course.json');

if (!fs.existsSync(coursePath)) {
  console.error(`No such course.json: ${coursePath}`);
  process.exit(1);
}
const course = JSON.parse(fs.readFileSync(coursePath, 'utf8'));
const debugIdentity = flag('debug-identity');
if (debugIdentity && (!flag('zip') || !optValue('assignment'))) {
  console.error('--debug-identity requires --zip and an explicit --assignment.');
  process.exit(1);
}
if (Object.prototype.hasOwnProperty.call(course, 'debugAutograder')) {
  console.error('debugAutograder is generated package metadata, not a course setting. Use --debug-identity.');
  process.exit(1);
}
const courseDir = path.dirname(path.resolve(coursePath));
const releaseVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const safeCourseId = String(course.courseId || path.basename(courseDir)).replace(/[^a-z0-9._-]+/gi, '-');
/* ONE ZIP PER ASSIGNMENT, named for the assignment it grades (INV-DEPLOY-3).
 *
 * The name is the whole safety mechanism now that nothing is inferred at grading
 * time: the file you upload states which assignment it belongs to, so uploading
 * the wrong one is a visible mistake at the moment you make it rather than a
 * plausible-looking score weeks later.
 *
 *   courses/<courseId>/autograders/<courseId>-<assignmentId>-oralscale-v<ver>.zip
 *
 * courseId first so a directory listing groups by course; assignment second
 * because that is what an instructor is choosing between when they upload. */
const artifactDir = path.join(courseDir, 'autograders');
const safeId = (x) => String(x).replace(/[^a-z0-9._-]+/gi, '-');
const artifactNameFor = (aid) =>
  `${safeCourseId}-${safeId(aid)}-oralscale-v${releaseVersion}${artifactSuffix}${debugIdentity ? "-DEBUG-identity-flag-only" : ""}.zip`;
const artifactPathFor = (aid) => path.join(artifactDir, artifactNameFor(aid));
// Packaging is the moment the bank leaves the folder — a good time to ask whether
// the folder itself is backed up anywhere (decision R3).
warnIfUnbacked(path.dirname(coursePath), { courseId: course.courseId || path.basename(path.dirname(coursePath)) });
const srcDir = path.join(ROOT, 'autograder', 'source');
const banksOut = path.join(srcDir, 'banks');
fs.rmSync(path.join(srcDir, 'local-profile.json'), { force:true });
// START FROM EMPTY. This directory is a build output, and copying into it
// without clearing it first meant every bank ever built accumulated there and
// shipped in the next zip: a one-bank course was packaging fourteen banks from
// a different course, reference answers and all. Not student-readable — the zip
// is staff-only — but it defeats the point of keeping course content separate,
// and it quadrupled the artifact. A build directory that remembers previous
// builds is not a build directory.
fs.rmSync(banksOut, { recursive: true, force: true });
fs.mkdirSync(banksOut, { recursive: true });

// course.json with bank paths rewritten to bundled locations the autograder can find.
const copy = JSON.parse(JSON.stringify(course));
for (const [aid, a] of Object.entries(course.assignments || {})) {
  const bankPath = resolveBank(coursePath, a.bank);
  const base = path.basename(bankPath);
  fs.copyFileSync(bankPath, path.join(banksOut, base));   // source/banks/<base>
  copy.assignments[aid].bank = 'banks/' + base;
}
fs.writeFileSync(path.join(srcDir, 'course.json'), JSON.stringify(copy, null, 2) + '\n');

/* A zip that does not verify identity must announce itself at the moment it is
 * made, not only when a submission is graded. Build logs get read once; a grade
 * report gets read after the damage. (INV-DEMO-1) */
{
  const noId = Object.entries(copy.assignments || {})
    .filter(([, a]) => a.demoSkipIdentityCheck === true).map(([aid]) => aid);
  if (noId.length) {
    console.warn('\n\x1b[33m╔══════════════════════════════════════════════════════════════════╗');
    console.warn('║  ⚠  DEMO BUILD — IDENTITY VERIFICATION IS OFF                    ║');
    console.warn('╚══════════════════════════════════════════════════════════════════╝\x1b[0m');
    console.warn(`   Assignment(s): ${noId.join(', ')}`);
    console.warn('   This autograder will NOT check that a certificate was issued to the');
    console.warn('   student submitting it. Anyone holding a copy of a .zip gets its score.');
    console.warn('   For demonstration only — never grade real coursework with this build.\n');
  }
}

// Say exactly which banks went in. A course that ships more banks than it has
// assignments is the symptom of the staleness bug above returning.
{
  const shipped = fs.readdirSync(banksOut).filter((f) => f.endsWith('.json')).sort();
  const want = new Set(Object.values(copy.assignments || {}).map((a) => path.basename(a.bank)));
  const extra = shipped.filter((f) => !want.has(f));
  console.log(`Banks bundled (${shipped.length}): ${shipped.join(', ')}`);
  if (extra.length) {
    console.error(`\n❌ ${extra.length} bank(s) in the zip are NOT referenced by this course:`);
    console.error(`   ${extra.join(', ')}`);
    console.error(`   Refusing to build — this would ship another course's questions.`);
    process.exit(1);
  }
}

// Grader calibration, if the instructor has fitted one. It sits next to
// course.json inside the zip because the autograder looks for it there — and a
// zip built without it silently grades on RAW model scores, which for a local
// model means marks that are systematically too generous at the bottom.
// Extended-time accommodation roster (INV-ACCOM-1). Optional, and its absence
// is not an error — without it the autograder reports student-selected extended
// time as UNVERIFIED rather than guessing. Bundled beside course.json, exactly
// like calibration.json, because that is where the autograder looks.
//
// This file records WHO HAS A DISABILITY ACCOMMODATION. It ships inside a zip
/* NOTHING PERSONAL GOES IN THE ZIP (INV-PRIV-6).
 *
 * Two files used to be bundled here: accommodations.json (who holds a disability
 * accommodation, keyed by studentRef) and extensions.json (per-student due
 * dates, keyed by email). Both are gone, and their absence is now a build-time
 * assertion rather than a convention — see the sweep below.
 *
 * The autograder needs the signing Secret and the question bank. Those are
 * COURSE secrets: losing one is bad and is fixed by rotating it. A roster is
 * personal data about identified people, nothing repairs its disclosure, and it
 * was being copied into an artifact that gets uploaded, cached and replicated.
 * Accommodation claims are now audited offline by the instructor
 * (tools/audit-accommodations.js); per-student due dates come from Gradescope's
 * own metadata, which was measured to carry them.
 *
 * The sweep runs on EVERY build and refuses rather than warns. A convention that
 * is only documented gets re-broken by the next person who needs a roster "just
 * for a moment".
 */
const PERSONAL_IN_ZIP = [
  'accommodations.json', 'extensions.json', 'roster.json', 'roster.csv',
  'students.csv', 'accommodations.csv',
];
for (const name of PERSONAL_IN_ZIP) {
  const stale = path.join(srcDir, name);
  if (fs.existsSync(stale)) fs.unlinkSync(stale);            // never ship one left by an older build
  const beside = path.join(path.dirname(coursePath), name);
  if (fs.existsSync(beside)) {
    console.error(`\n❌ REFUSING TO BUILD: ${path.relative(ROOT, beside)} exists.`);
    console.error(`   The autograder must contain no personal or roster information (INV-PRIV-6).`);
    console.error(`   Accommodation claims are audited offline instead:`);
    console.error(`     node tools/audit-accommodations.js --help`);
    console.error(`   Move or delete that file, then build again.\n`);
    process.exit(1);
  }
}
const keysLeft = fs.readdirSync(path.dirname(coursePath))
  .filter((f) => /\.keys\.csv$|brightspace-import\.csv$/.test(f));
if (keysLeft.length) {
  // These are generated exports that live in the course folder on purpose. They
  // must never be COPIED into source/, so assert on the destination, not here.
  for (const f of keysLeft) {
    const inSrc = path.join(srcDir, f);
    if (fs.existsSync(inSrc)) fs.unlinkSync(inSrc);
  }
}

const calSrc = path.join(path.dirname(coursePath), 'calibration.json');
const calDst = path.join(srcDir, 'calibration.json');
if (fs.existsSync(calSrc)) {
  fs.copyFileSync(calSrc, calDst);
  const cal = JSON.parse(fs.readFileSync(calSrc, 'utf8'));
  const names = Object.keys(cal.backends || {});
  console.log(`Bundled calibration.json (fitted ${cal.fittedAt || '?'}) for: ${names.join(', ') || 'nothing'}`);
} else {
  if (fs.existsSync(calDst)) fs.unlinkSync(calDst);   // never ship a stale one
  const backend = ((copy.defaults || {}).gradingBackend || 'local');
  console.log(`\n⚠ No calibration.json for this course — grading will use RAW model scores.`);
  console.log(`  Fit one before students use it:`);
  console.log(`    python3 tools/calibrate-grader.py --course ${path.dirname(path.relative(ROOT, coursePath))} --backend ${backend}`);
  console.log(`  It also tells you whether this grader is consistent enough to use at all.\n`);
}

const nAssign = Object.keys(course.assignments || {}).length;
console.log(`Bundled course "${course.courseId}" + ${nAssign} assignment(s) into autograder/source/.`);

if (!flag('zip')) {
  console.log('\nTo package it for Gradescope in one step:');
  console.log(`  node tools/build-autograder.js ${path.relative(ROOT, coursePath)} --zip`);
  process.exit(0);
}


// ---------------------------------------------------------------------------
// .env (gitignored) is where instructors keep GENAI_STUDIO_* and friends, so read
// it here rather than making them re-export the values on the command line.
//
// Precedence: an exported process.env wins, then .env. EMPTY values in .env are
// ignored — the repo ships an .env.example whose keys are blank, and letting an
// empty ORALSCALE_SECRET win over server/config.json would break every signature.
// ---------------------------------------------------------------------------
function loadDotenv() {
  const f = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(f)) return out;
  for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v !== '') out[k] = v;          // blank entries are placeholders, not values
  }
  return out;
}
const DOTENV = loadDotenv();
/* The COURSE'S own .env, which wins over the engine's.
 *
 * A course folder is meant to be the whole course, so it must be able to carry
 * its own grading credentials as well as its own Secret — otherwise a course
 * cloned onto another machine builds an autograder that cannot grade, and the
 * missing piece is somewhere in the engine repo nobody thought to copy. The
 * engine .env stays as the shared default for an instructor running several
 * courses off one GenAI key. */
const COURSE_DOTENV = SECRETS.readEnvFile(SECRETS.envPath(courseDir));
/** exported env wins, then the course's .env, then the engine's */
const cfgVar = (name) => process.env[name] || COURSE_DOTENV[name] || DOTENV[name] || '';

// ---------------------------------------------------------------------------
// --zip: resolve the secrets ourselves and hand them to build.sh
// ---------------------------------------------------------------------------
/* GUARDS BEFORE THE BUILD.
 *
 * A build writes an autograder zip containing the signing Secret in plaintext,
 * into the course folder. The .gitignore and pre-commit hook that stop it being
 * committed are installed FIRST — in this repo and in the course's own repo if
 * it has one — because protection that arrives after the artifact leaves a
 * window, and the window is when a folder full of new files invites `git add`. */
GUARDS.ensure(courseDir, { log: (m) => console.log(m) });

/*
 * THE COURSE'S OWN SECRET, FROM THE COURSE'S OWN FOLDER. No fallback.
 *
 * A course must be built with its own Secret or the Signer it is deployed
 * against cannot verify a single certificate it produces — and it must not be a
 * Secret any OTHER course holds, because then either course could forge the
 * other's certificates and mint the other's quiz keys.
 */
const resolved = SECRETS.resolve(coursePath, course.courseId);
if (!resolved) {
  const envFile = path.relative(ROOT, SECRETS.envPath(courseDir));
  console.error(`\n❌ "${course.courseId}" has no signing Secret, so it cannot be built.`);
  console.error('');
  console.error('   The Secret belongs INSIDE the course folder, so the folder is the whole');
  console.error('   course: copy or clone that one directory and everything travels with it.');
  console.error('');
  console.error(`   Create one:   node tools/make-config.js --course ${path.relative(ROOT, coursePath)}`);
  console.error(`   Or write it:  ${envFile}`);
  console.error(`                 ORALSCALE_SECRET=<64 hex characters>`);
  console.error(`   Or, for CI:   ${SECRETS.envVarFor(course.courseId)}=<…> in the environment`);
  console.error('');
  process.exit(1);
}
const secret = resolved.secret;
console.log(`Signing Secret: ${resolved.source}`);

{
  const clash = SECRETS.clashes(secret, course.courseId);
  if (clash.length) {
    console.error('\n❌ REFUSING TO BUILD — this course shares its signing Secret.');
    console.error('');
    for (const l of SECRETS.clashAdvice(courseDir, course.courseId, clash)) {
      console.error('   ' + l);
    }
    console.error('');
    console.error('   Re-keying invalidates that course\'s quiz keys and live links, and REPLACES');
    console.error('   its .env — anything else copied into it (a GenAI key, settings) is dropped');
    console.error('   so one course cannot end up using another\'s credentials.');
    console.error('');
    process.exit(1);
  }
}

const webapp = process.env.ORALSCALE_WEBAPP_URL || course.webappUrl || '';
const warn = (m) => console.warn('  ⚠️  ' + m);

if (!webapp || /REPLACE/i.test(webapp)) {
  warn('course.json has no real webappUrl. Students will not be told where the quiz lives.');
  warn('Run `npm run deploy` (it records the URL) or pass ORALSCALE_WEBAPP_URL=…');
} else if (/^https:\/\/[0-9a-f]{6,}\.[^.]+\.pages\.dev/.test(webapp)) {
  // The trap: `wrangler pages deploy` prints a per-deployment hostname, and the
  // *.pages.dev certificate does not cover that second-level subdomain — browsers
  // reject it outright with ERR_SSL_VERSION_OR_CIPHER_MISMATCH.
  const stable = webapp.replace(/^https:\/\/[0-9a-f]+\./, 'https://');
  warn(`webappUrl looks like a PER-DEPLOYMENT Pages URL: ${webapp}`);
  warn(`That hostname has no valid certificate. Use the stable alias instead: ${stable}`);
}
if (!course.signerUrl) {
  warn('course.json has no signerUrl, so student links will not carry the Signer address');
  warn('and the web app will fall back to its built-in default. Run `npm run deploy`.');
}

/* WHICH ASSIGNMENTS TO BUILD.
 *
 * Default: all of them, one zip each. `--assignment <id>` builds just one, for
 * the common case of re-cutting a single week after editing its bank.
 *
 * An assignment that cannot produce a working autograder is SKIPPED WITH A
 * WARNING rather than failing the run: a course with a half-written week 12
 * should still be able to ship weeks 1-11 today. The build fails only if
 * nothing at all could be built, or if the one assignment explicitly asked for
 * is the broken one. */
const only = optValue('assignment') || process.env.ORALSCALE_ASSIGNMENT || '';
if (only && !(course.assignments || {})[only]) {
  console.error(`\n--assignment ${only} is not in ${path.basename(coursePath)}.`);
  console.error('  Known ids: ' + Object.keys(course.assignments || {}).join(', '));
  process.exit(1);
}

/** Everything an assignment needs before it can be packaged. [] if it is fine. */
function assignmentProblems(aid) {
  const a = (course.assignments || {})[aid] || {};
  const problems = [];
  if (!a.bank) {
    problems.push('no "bank" is set');
  } else {
    let bankPath = null;
    try { bankPath = resolveBank(coursePath, a.bank); } catch (e) { problems.push(`bank path ${a.bank}: ${e.message}`); }
    if (bankPath && !fs.existsSync(bankPath)) {
      problems.push(`bank file not found: ${path.relative(ROOT, bankPath)}`);
    } else if (bankPath) {
      let bank = null;
      try { bank = JSON.parse(fs.readFileSync(bankPath, 'utf8')); }
      catch (e) { problems.push(`bank is not valid JSON (${e.message})`); }
      if (bank && !(Array.isArray(bank.questions) && bank.questions.length)) {
        problems.push('bank contains no questions');
      }
    }
  }
  const limit = a.limitSec ?? (course.defaults || {}).limitSec;
  if (!(Number(limit) > 0)) problems.push('no limitSec (per-question time limit)');
  return problems;
}

/* A FROZEN ASSIGNMENT IS NOT REBUILT (INV-DEPLOY-6).
 *
 * `npm run package` packages EVERY assignment in the course, one zip each, into
 * the same directory under the same names. That is right while a course is being
 * built and wrong the moment one of its quizzes is live: cutting the week 2 zip
 * silently overwrites the week 1 zip too, with an autograder built from today's
 * engine rather than the one week 1's cohort was graded by.
 *
 * Nobody would do that on purpose. Everybody does it by accident, because the
 * command that packages the new week is the command that repackages the old one,
 * and it succeeds quietly.
 *
 * It matters because grading is not stable across engine versions and is not
 * meant to be: band wording, grader prompts and rubric handling all move. Two
 * students who said the same words must not be marked by different code because
 * one of them submitted a week later — and late submissions mean the two are
 * genuinely concurrent (a pilot quiz was still accepting them when the
 * required/optional key-point split landed, which would have re-marked the late
 * half of the cohort more leniently than the punctual half).
 *
 * So `"frozen": true` on an assignment means: this quiz has been released, its
 * zip is uploaded, and the zip on Gradescope is the one that grades it. Skipped
 * in a whole-course build; refused even when named, unless `--repackage-frozen`
 * says the operator knows they are re-cutting a live assignment's grader.
 *
 * The zip already in `autograders/` is untouched either way: nothing here deletes
 * or moves it, so a skip leaves the released artifact exactly as it was. */
const repackageFrozen = flag('repackage-frozen');

/* A REGRADE VARIANT: a SECOND grader for an assignment that is already released.
 *
 * `--repackage-frozen` re-cuts the released zip over its own filename, and that
 * is the right tool for a fix everybody should get. It is the wrong tool for
 * "grade this quiz again under a different scale and let me compare", because
 * the artifact that graded the first pass stops existing the moment it runs.
 *
 * A variant is declared IN THE COURSE, never invented on the command line:
 *
 *   "quiz-02-x": { …, "regrade": { "id": "curve-v2",
 *                                  "scoring": { …a whole scoring policy… },
 *                                  "note": "why this regrade exists" } }
 *
 * and built with `--assignment quiz-02-x --regrade curve-v2`. What comes out is
 * pinned to THE SAME assignment id — certificates carry the assignment they were
 * issued for, so a variant with a new id would reject every submission it was
 * built to re-mark (INV-DEPLOY-3) — with only the declared GRADING SETTINGS
 * replaced, and written to a DIFFERENT filename. The released zip is not read, not moved and not
 * overwritten, which is why this does not need `--repackage-frozen`: the accident
 * INV-DEPLOY-6 exists to prevent is not reachable from here.
 *
 * TWO SETTINGS MAY MOVE, and a variant must name at least one:
 *
 *   `scoring`         re-mark the same judgements on a different scale.
 *   `gradingBackend`  re-mark with a different GRADER — the case this was
 *                     extended for: `genai` went unavailable (rate limits, an
 *                     outage, an exhausted quota) and NOTHING was graded, which
 *                     INV-GRADE-1 makes deliberate. The remedy it names is to
 *                     "rebuild the zip with a working local model" and regrade
 *                     the whole cohort together — and that rebuild is exactly a
 *                     variant: a second zip, under its own name, leaving the
 *                     released one alone.
 *
 * Both live in course.json rather than in a flag on purpose. Six weeks later,
 * "which scale, and which grader, produced these marks?" has to be answerable
 * from the repository, not from someone's shell history. */
const regradeVariant = optValue('regrade') || '';
const isFrozen = (aid) => !!((course.assignments || {})[aid] || {}).frozen;
let artifactSuffix = '';
if (regradeVariant) {
  if (!only) {
    console.error('\n--regrade needs --assignment: a regrade re-marks ONE released assignment.');
    process.exit(1);
  }
  const ac = (course.assignments || {})[only] || {};
  const spec = (ac.regrades || {})[regradeVariant] || ac.regrade;
  if (!spec || spec.id !== regradeVariant) {
    console.error(`\n"${only}" declares no regrade variant "${regradeVariant}".`);
    console.error('  Declare it in course.json as `"regrade": { "id": …, "scoring": … }`,');
    console.error('  so the scale that produced the marks is recorded where anyone can read it.');
    console.error(`  Found: ${spec ? JSON.stringify(spec.id) : 'no regrade block'}`);
    process.exit(1);
  }
  if (!spec.scoring && !spec.gradingBackend && !spec.localModel && !spec.bank) {
    console.error(`\nregrade variant "${regradeVariant}" replaces nothing — it declares neither`);
    console.error('  `scoring` nor `gradingBackend`, so it would rebuild the released grader');
    console.error('  under a new filename, which is not a regrade.');
    process.exit(1);
  }
  /* A VARIANT FREEZES TOO (INV-DEPLOY-6). Once a regrade zip is the artifact a
     cohort is actually being re-marked against, it has the same claim on being
     left alone as the original release did — and more urgently, because a
     regrade runs over submissions that already have marks in the gradebook.
     Rebuilding it midway means two halves of one regrade graded by different
     code, which is the exact failure the freeze exists to prevent. */
  if (spec.frozen && !repackageFrozen) {
    console.error(`\n❌ regrade variant "${regradeVariant}" is FROZEN and was not rebuilt.`);
    console.error('   Its zip is uploaded and is what is re-marking this assignment.');
    console.error(`   Rebuilding it now would regrade half the cohort with different code.`);
    if (spec.sha256) console.error(`   The frozen artifact is sha256 ${spec.sha256}.`);
    console.error('');
    console.error('   If the regrade itself needs re-cutting, re-run the WHOLE regrade:');
    console.error(`     node tools/build-autograder.js ${path.relative(ROOT, coursePath)} --zip \\`);
    console.error(`       --assignment ${only} --regrade ${regradeVariant} --repackage-frozen`);
    process.exit(1);
  }
  artifactSuffix = `-regrade-${safeId(regradeVariant)}`;

  /* APPLY THE OVERRIDES NOW, not in the per-assignment loop below.
   *
   * Everything that decides what goes INTO the image is derived from `copy`
   * further down — which backend the assignment grades with, and therefore
   * whether setup.sh bakes in the 2 GB local GGUF (ORALSCALE_LOCAL_REQUIRED)
   * and whether the GenAI credentials are written into the zip at all. A
   * variant that flips `gradingBackend` to `local` and is applied after those
   * are computed produces a zip that ASKS for the local model and does not
   * carry it, which fails at grading time rather than at build time — the one
   * shape of mistake this file exists to make impossible. */
    if (spec.bank) LOCAL.alternativePath(coursePath,
    resolveBank(coursePath, course.assignments[only].bank), spec.bank);
  Object.assign(copy.assignments[only], regradeOverrides(spec));
}

/* The settings a variant may replace, and nothing else, so a difference between
 * the two sets of marks cannot be anything but what the variant declares. */
function regradeOverrides(spec) {
  const o = {};
  if (spec.scoring) o.scoring = spec.scoring;
  if (spec.localModel) o.localModel = spec.localModel;
  if (spec.bank) o.bank = spec.bank;
  if (spec.gradingBackend) o.gradingBackend = String(spec.gradingBackend).toLowerCase();
  return o;
}

const requested = only ? [only] : Object.keys(course.assignments || {});
const buildable = [];
for (const aid of requested) {
  // A regrade variant writes its own filename, so the released artifact cannot be
  // the casualty the freeze guard is watching for. Frozen is in fact the normal
  // state of an assignment worth regrading.
  if (isFrozen(aid) && !repackageFrozen && !regradeVariant) {
    if (only) {
      console.error(`\n❌ "${aid}" is FROZEN and was not repackaged.`);
      console.error('   Its autograder zip is already uploaded to Gradescope and is what grades');
      console.error('   that quiz. Rebuilding it now would grade the students who submit late');
      console.error('   with a different engine than the ones who submitted on time.');
      console.error('');
      console.error('   If you genuinely need to re-cut a live assignment\'s grader:');
      console.error(`     node tools/build-autograder.js ${path.relative(ROOT, coursePath)} --zip \\`);
      console.error(`       --assignment ${aid} --repackage-frozen`);
      console.error('   …and re-upload it, knowing every ungraded submission moves with it.');
      process.exit(1);
    }
    console.log(`  frozen: "${aid}" left alone — its released zip still grades it (INV-DEPLOY-6).`);
    continue;
  }
  const problems = assignmentProblems(aid);
  if (problems.length) {
    warn(`SKIPPING "${aid}" — it cannot be packaged yet:`);
    for (const pr of problems) console.warn(`        - ${pr}`);
    continue;
  }
  buildable.push(aid);
}
if (repackageFrozen && requested.some(isFrozen)) {
  warn(`--repackage-frozen: REBUILDING frozen assignment(s) ${requested.filter(isFrozen).join(', ')}.`);
  warn('Every submission not yet graded will be graded by the NEW zip once you upload it.');
}
if (!buildable.length) {
  const allFrozen = requested.length && requested.every(isFrozen);
  console.error(`\n❌ Nothing was packaged from ${path.basename(coursePath)}.`);
  console.error(allFrozen
    ? '   Every assignment in this course is frozen, so there was nothing to build.'
    : '   Every assignment above is missing something. Fix one and re-run.');
  process.exit(1);
}
if (buildable.length !== requested.length) {
  console.log(`\nPackaging ${buildable.length} of ${requested.length} assignment(s); the rest are listed above.`);
}

const env = { ...process.env, ORALSCALE_SECRET: secret };
if (webapp) env.ORALSCALE_WEBAPP_URL = webapp;
// Set per assignment inside the loop below. Nothing is ever left unpinned: an
// unpinned zip no longer grades at all (INV-DEPLOY-3).
delete env.ORALSCALE_ASSIGNMENT;
env.ORALSCALE_MAX_POINTS = process.env.ORALSCALE_MAX_POINTS || '10';
// Never let a test-only affordance reach a Gradescope image (INV-INTEGRITY-8).
delete env.ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR;

const GENAI_KEYS = ['GENAI_STUDIO_API_KEY', 'GENAI_STUDIO_BASE_URL', 'GENAI_STUDIO_MODEL'];
const genaiFound = GENAI_KEYS.filter((k) => cfgVar(k));
// RESOLVED, BUT NOT YET IN THE ENVIRONMENT. Which zip carries the key is decided
// per assignment, in the build loop below, because each zip contains exactly one
// assignment (INV-DEPLOY-3) and its environment must match THAT assignment.
// Cleared from the base environment too: an exported GENAI_STUDIO_* would
// otherwise ride into a locally-graded zip through `{ ...process.env }`.
const GENAI_ENV = {};
for (const k of genaiFound) GENAI_ENV[k] = cfgVar(k);
for (const k of GENAI_KEYS) delete env[k];
if (genaiFound.length === 3) {
  console.log(`Purdue GenAI credentials: complete (model ${cfgVar('GENAI_STUDIO_MODEL')}).`);
} else if (genaiFound.length > 0) {
  warn(`Purdue GenAI credentials are INCOMPLETE (${genaiFound.join(', ')}).`);
  warn(`Missing: ${GENAI_KEYS.filter((k) => !cfgVar(k)).join(', ')}.`);
} else {
  console.log('Purdue GenAI credentials: not configured.');
}

// build.sh refuses to reuse a stale secret.env, so clear one from an older run.
const stale = path.join(srcDir, 'secret.env');
if (fs.existsSync(stale)) {
  fs.unlinkSync(stale);
  console.log('Removed a leftover source/secret.env so this build uses the resolved values.');
}

console.log('\nPackaging…');
// ---------------------------------------------------------------------------
// Which assignments use Purdue GenAI, and which grade locally?
//
// The GenAI key lands in autograder.zip in PLAINTEXT — Gradescope has no secrets
// manager — and anyone with staff access to the course can read it. So a zip
// that grades locally must not ship the key at all: an unused secret in a
// readable artifact is pure downside, and "we changed the backend" is exactly the
// moment it would otherwise be left behind.
//
// Resolved per ASSIGNMENT rather than per course, because a course may run GenAI
// for the first five weeks and local afterwards — and each week ships in its own
// zip (INV-DEPLOY-3), so "the course uses GenAI somewhere" is not a reason for
// week six's zip to carry the key. The counts below describe the whole course
// and drive only the log lines; the decisions live in the build loop.
// ---------------------------------------------------------------------------
const backendIn = (cfg, aid) => String(
  ((cfg.assignments || {})[aid] || {}).gradingBackend
  ?? (cfg.defaults || {}).gradingBackend ?? 'local').toLowerCase();
// Read from `copy`, so any per-assignment override a build applies before the
// zip is written (a regrade variant's, for one) is the backend this sees.
const backendOf = (aid) => backendIn(copy, aid);
const genaiAssignments = Object.keys(copy.assignments || {}).filter((a) => backendOf(a) === 'genai');
// WHAT THIS BUILD NEEDS, not what the course contains. `genaiAssignments`
// describes the whole course and only drives the log lines below. The GenAI
// credentials and the live model check are REQUIREMENTS, so they are scoped to
// the zips this run actually writes (`buildable`, after any regrade override):
// packaging a locally-graded assignment must not demand a key it will not ship,
// and must not fail because a model some OTHER week grades with was retired.
const genaiBuilt = buildable.filter((a) => backendOf(a) === 'genai');
const usesGenai = genaiBuilt.length > 0;

// The local model, likewise, is only worth its ~2 GB if some assignment actually
// chooses it. INV-GRADE-1 forbids using it as a fallback for GenAI.
const localAssignments = buildable.filter((a) => backendOf(a) === 'local');

// ONE COURSE, ONE BACKEND PER ZIP. These two counts describe the COURSE and are
// only ever used for what is printed below; the environment each zip actually
// carries — the GenAI credentials, ORALSCALE_LOCAL_REQUIRED and
// ORALSCALE_SKIP_LOCAL_LLM — is set inside the build loop from the one
// assignment that zip contains. Deciding it here instead put the GenAI key into
// a locally-graded zip whenever some OTHER assignment in the course used GenAI,
// and baked a 2 GB GGUF into a genai-only zip for the mirror-image reason.
if (localAssignments.length === 0 && process.env.ORALSCALE_SKIP_LOCAL_LLM === undefined) {
  console.log('\nNo assignment grades locally, so no zip bundles the local model: with no grader');
  console.log('fallbacks it could never be used. Smaller image, faster build, one less thing to');
  console.log('go wrong. Set ORALSCALE_SKIP_LOCAL_LLM=0 to bundle it anyway.');
}

// There is one bundled local model now, so this no longer CHOOSES anything — it
// is kept because a course.json written before the menu was removed may still
// carry a `localModel` key, and passing it through means localmodel.py gets to
// resolve it (to the one model) and say so in the build log. Dropping the
// passthrough would make a stale setting silently invisible instead.
if (!env.ORALSCALE_LOCAL_MODEL_KEY && (copy.defaults || {}).localModel) {
  env.ORALSCALE_LOCAL_MODEL_KEY = String(copy.defaults.localModel);
}
if (!usesGenai) {
  // Not a warning — a deliberate omission, said out loud so nobody wonders why
  // GenAI stopped working after they flipped the backend.
  const had = GENAI_KEYS.filter((k) => GENAI_ENV[k]);
  if (had.length) {
    console.log(`\nNo assignment in this course uses gradingBackend "genai", so the GenAI`);
    console.log(`credentials were NOT written into any zip (${had.join(', ')}).`);
    console.log('The key would otherwise sit in there in plaintext, readable by anyone with');
    console.log('staff access to the Gradescope course, and never be used.\n');
  }
} else if (genaiAssignments.length !== Object.keys(copy.assignments || {}).length) {
  console.log(`\nMixed backends in this course: ${genaiAssignments.length} assignment(s) on genai,`);
  console.log(`${localAssignments.length} on local. Each zip holds ONE assignment, so each one`);
  console.log('carries only what that assignment grades with: the GenAI key goes into the genai');
  console.log('zips and nowhere else, and the local model is bundled only where it is used.');
}
/* PORTABILITY: a genai course must carry its OWN credentials.
 *
 * Falling back to the engine .env builds a working zip HERE and a broken one
 * anywhere else — the course clones, the credentials do not, and with no grader
 * fallbacks (INV-GRADE-1) those submissions are simply not graded. Warned rather
 * than refused, because building locally against the shared default is a
 * reasonable thing to do at your own desk; it is shipping that way that hurts. */
if (usesGenai) {
  const borrowed = GENAI_KEYS.filter((k) => !COURSE_DOTENV[k] && (process.env[k] || DOTENV[k]));
  if (borrowed.length) {
    warn(`this course grades with "genai" but does not carry its own ${borrowed.join(', ')}.`);
    warn(`They came from the engine .env, which does NOT travel with the course:`);
    warn(`copy them into ${path.relative(ROOT, SECRETS.envPath(courseDir))} so a clone still grades.`);
  }
}

if (usesGenai && genaiFound.length !== GENAI_KEYS.length) {
  console.error(`\n❌ This build packages ${genaiBuilt.join(', ')} with gradingBackend "genai",`);
  console.error('  but all three GENAI_STUDIO_*');
  console.error('  values are not configured. INV-GRADE-1 forbids silently grading with another');
  console.error('  backend. Set the missing values in .env, or explicitly switch the course to');
  console.error('  local: node tools/set-grading.js --course <dir> --backend local\n');
  process.exit(1);
}
/* THE MODEL MUST STILL EXIST (INV-DEPLOY-8).
 *
 * The model ID is baked into the zip, and Purdue replaces models in place
 * (qwen3.6:27b -> qwen3.8:27b, 2026-09-23). A zip built against a retired ID is
 * well-formed, uploads fine, and then fails every submission. So ask the service
 * what it offers before packaging, and refuse when it answers without our model.
 *
 * Unreachable only WARNS. Unlike a minted link, nothing a student sees depends on
 * the build moment: GenAI Studio being down right now (it was, 2026-09-19..21)
 * says nothing about the model, and refusing would block local-only fixes to a
 * mixed course during an outage. A service that answers "no such model" is
 * evidence; a service that does not answer is not. */
if (usesGenai) {
  // `env` no longer carries the GenAI values (they are held in GENAI_ENV and
  // added back only for a genai zip), so hand them to the checker explicitly —
  // it needs the key and base URL to ask the service anything at all.
  const q = spawnSync(process.execPath, [path.join(__dirname, 'genai-models.js'),
    '--course', coursePath, '--model', cfgVar('GENAI_STUDIO_MODEL'), '--json'],
  { encoding: 'utf8', env: { ...env, ...GENAI_ENV }, timeout: 30000 });
  let r = {};
  try { r = JSON.parse(String(q.stdout || '').trim().split('\n').pop()); } catch { /* below */ }
  if (r.code === 0) {
    console.log(`Purdue GenAI offers '${cfgVar('GENAI_STUDIO_MODEL')}': checked against the live model list.`);
  } else if (r.code === 3) {
    console.error(`\n❌ Purdue GenAI does not offer the model '${cfgVar('GENAI_STUDIO_MODEL')}' that this`);
    console.error('  course grades with, so every submission to this zip would fail. It was');
    console.error('  probably retired or renamed.');
    if ((r.nearest || []).length) console.error(`  Closest by name: ${r.nearest.slice(0, 3).join(', ')}`);
    console.error(`  See the full list:  node tools/genai-models.js --course ${coursePath}`);
    console.error(`  Then set GENAI_STUDIO_MODEL in ${path.relative(ROOT, SECRETS.envPath(courseDir))} and rebuild.\n`);
    process.exit(1);
  } else {
    warn(`could not confirm that Purdue GenAI still offers '${cfgVar('GENAI_STUDIO_MODEL')}'`
      + ` (${r.error || (q.error && q.error.message) || 'no answer'}). Building anyway;`);
    warn(`check it before uploading:  node tools/genai-models.js --course ${coursePath}`);
  }
}
/* ONE PASS PER ASSIGNMENT.
 *
 * Each zip carries ONLY its own assignment and ONLY its own bank. That is not
 * merely tidier: a zip for quiz 1 that also contains quiz 14's questions and
 * reference answers is a content leak waiting for someone with staff access, and
 * shipping every bank in every zip is how this repository once packaged fourteen
 * banks from another course. One assignment per zip makes that structurally
 * impossible rather than something a build step has to remember. */
const built = [];
for (const aid of buildable) {
  const a = course.assignments[aid];
  const variant = regradeVariant && ((a.regrades || {})[regradeVariant] || a.regrade);
  const bankPath = variant && variant.bank
    ? LOCAL.alternativePath(coursePath, resolveBank(coursePath, a.bank), variant.bank)
    : resolveBank(coursePath, a.bank);
  const base = path.basename(bankPath);

  fs.rmSync(banksOut, { recursive: true, force: true });
  fs.mkdirSync(banksOut, { recursive: true });
  fs.copyFileSync(bankPath, path.join(banksOut, base));

  const one = JSON.parse(JSON.stringify(copy));
  one.assignments = { [aid]: { ...copy.assignments[aid], bank: 'banks/' + base } };
  if (regradeVariant) {
    // ONLY the declared settings move — they were already merged into `copy`
    // above, so all that is left here is to say so in the zip and in the log.
    // Same bank, same questions, same pin, so a difference in the marks cannot
    // be anything but what this line names.
    const spec = variant;
    const moved = Object.keys(regradeOverrides(spec));
    one.assignments[aid].regradeNote = spec.note
      || `Regrade variant "${spec.id}": ${moved.join(' and ')} replaced, everything else identical.`;
    delete one.assignments[aid].regrade;
    delete one.assignments[aid].regrades;
    console.log(`\n   regrade variant "${spec.id}": \`${moved.join('`, `')}\` replaced for this build only.`);
  }
  if (debugIdentity) {
    one.debugAutograder = { identityCheck:'flag-only', assignmentId:aid,
      label:'DEBUG — instructor testing only; do not publish these marks' };
    console.warn('\n*** DEBUG AUTOGRADER — identity mismatches are flagged but do not block grading. ***');
    console.warn('All other integrity checks remain enforced. Use only for instructor testing.');
  }
  fs.writeFileSync(path.join(srcDir, 'course.json'), JSON.stringify(one, null, 2) + '\n');

  /* THE ENVIRONMENT MATCHES THE ASSIGNMENT IN THE ZIP (INV-PRIV-6, INV-DEPLOY-3).
   *
   * Read from `one` — the config actually written into this zip, after any
   * per-build override — so the two can never disagree. A zip whose embedded
   * course.json says `local` must not carry the GenAI key: it lands in
   * PLAINTEXT (Gradescope has no secrets manager), anyone with staff access to
   * the course can read it, and nothing in that zip will ever use it. The
   * mirror case costs build time instead of secrecy — a genai-only zip baking
   * in a ~2 GB GGUF it can never reach, because INV-GRADE-1 forbids falling
   * back to it. */
  const genaiHere = backendIn(one, aid) === 'genai';
  for (const k of GENAI_KEYS) {
    if (genaiHere && GENAI_ENV[k]) env[k] = GENAI_ENV[k];
    else delete env[k];
  }
  // Does THIS zip actually grade with the local model? setup.sh needs to know:
  // an unbuildable local runtime is fatal for the first case and a note for the
  // second. Failing an image build over a model this assignment can never use
  // would leave the instructor with no autograder at all.
  env.ORALSCALE_LOCAL_REQUIRED = genaiHere ? '0' : '1';
  // An explicit ORALSCALE_SKIP_LOCAL_LLM in the environment still wins either way.
  if (process.env.ORALSCALE_SKIP_LOCAL_LLM === undefined) {
    if (genaiHere) env.ORALSCALE_SKIP_LOCAL_LLM = '1';
    else delete env.ORALSCALE_SKIP_LOCAL_LLM;
  }

  // Which local model this zip grades with, and the profile/manifest that pin it.
  // Kept per assignment for the same reason as the block above: the zip's own
  // config decides, not the course's default.
  env.ORALSCALE_LOCAL_MODEL_KEY = String(one.assignments[aid].localModel
    ?? one.defaults?.localModel ?? LOCAL.DEFAULT_MODEL);
  if (!genaiHere && !LOCAL.MODELS.includes(env.ORALSCALE_LOCAL_MODEL_KEY))
    throw Error('Unknown local model: '+env.ORALSCALE_LOCAL_MODEL_KEY);
  if (!genaiHere) {
    if (env.ORALSCALE_LOCAL_MODEL_KEY === LOCAL.DEFAULT_MODEL) {
      const check = spawnSync('python3', ['-c',
        'import json,sys,localcontext; b=json.load(open(sys.argv[1])); [localcontext.criteria(q) for q in b["questions"]]', bankPath],
        { env:{...process.env,PYTHONPATH:srcDir}, encoding:'utf8' });
      if (check.status !== 0) throw Error('Invalid local grading context: '+check.stderr);
    }
    one.assignments[aid].localModel = env.ORALSCALE_LOCAL_MODEL_KEY;
    one.assignments[aid].localGradingProfile = env.ORALSCALE_LOCAL_MODEL_KEY === LOCAL.DEFAULT_MODEL
      ? LOCAL.PROFILE : 'qwen25-legacy-lines-v1';
    fs.writeFileSync(path.join(srcDir, 'course.json'), JSON.stringify(one, null, 2)+'\n');
    fs.writeFileSync(path.join(srcDir, 'local-profile.json'), JSON.stringify(
      LOCAL.manifest(srcDir, aid, env.ORALSCALE_LOCAL_MODEL_KEY, bankPath), null, 2)+'\n');
  } else fs.rmSync(path.join(srcDir, 'local-profile.json'), { force:true });

  env.ORALSCALE_ASSIGNMENT = aid;
  console.log(`\n── ${aid} ──────────────────────────────────────────────`);
  if (genaiAssignments.length && localAssignments.length) {
    console.log(genaiHere
      ? '   backend genai: the GenAI key IS in this zip, and the local model is not bundled.'
      : '   backend local: the local model is bundled, and the GenAI key is NOT in this zip.');
  }
  const r = spawnSync('bash', ['build.sh'], {
    cwd: path.join(ROOT, 'autograder'), env, stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status || 1);

  const zip = path.join(ROOT, 'autograder', 'autograder.zip');
  if (!fs.existsSync(zip)) {
    console.error(`\nPackaging reported success but autograder/autograder.zip was not created (${aid}).`);
    process.exit(1);
  }
  const kb = Math.round(fs.statSync(zip).size / 1024);
  const out = artifactPathFor(aid);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.renameSync(zip, out);
  fs.chmodSync(out, 0o600);
  built.push({ aid, out, kb, genai: genaiHere });
}

console.log(`\n✅ ${built.length} autograder(s) in ${path.relative(ROOT, artifactDir)}/`);
for (const b of built) {
  console.log(`   ${path.basename(b.out).padEnd(52)} ${String(b.kb).padStart(4)} KB   → upload to: ${b.aid}`);
}
if (regradeVariant) {
  console.log(`\n   ⚠  This is a REGRADE VARIANT ("${regradeVariant}"). The zip that graded the`);
  console.log('      first pass is still in place under its own name — this one does not');
  console.log('      replace it. Uploading this to the live Gradescope assignment and');
  console.log('      regrading re-marks EVERY submission, including ones already returned.');
  console.log('      Compare the new marks against the recorded ones before you publish them.');
}
console.log('\n   Each zip grades exactly the assignment named in its filename, and nothing is');
console.log('   inferred from the Gradescope title — so upload the one whose name matches.');
console.log('   These ignored artifacts contain plaintext secrets; do not commit, email, or share them.');
console.log('\nIn Gradescope:');
console.log('  1. Programming Assignment → Configure Autograder → upload the zip.');
console.log("     Watch the build log for: whisper model '<name>' cached OK");
console.log('  2. Nothing to set for scoring: Gradescope grades the most recent submission, and');
console.log('     students re-activate an earlier one from Submission History (INV-DEPLOY-1).');
// The two container settings are new-ish and BOTH failure modes look like a
// student problem rather than a configuration one, so they are printed here as
// well as in setup.sh and the teacher guide. An instructor who reads only one of
// the three should still get them.
// Sized per ZIP, not per course: the local grader is bundled into the zips that
// grade with it and nowhere else, so a genai zip in a mixed course does not need
// the bigger container and a local one still does.
{
  const localBuilt = built.filter((b) => !b.genai).map((b) => b.aid);
  const genaiBuilt = built.filter((b) => b.genai).map((b) => b.aid);
  const big = ['  3. Autograder Settings → container **4.0 CPU / 6.0 GB RAM**.',
    '     Required for the bundled local grader as well as speech recognition;',
    '     an undersized container cannot load the models reliably.'];
  const small = ['  3. Autograder Settings → container **2.0 CPU / 3.0 GB RAM**.',
    '     The 0.5 CPU / 0.75 GB default cannot even LOAD the speech model,',
    '     so every submission comes back with no transcript.'];
  if (!genaiBuilt.length) big.forEach((l) => console.log(l));
  else if (!localBuilt.length) small.forEach((l) => console.log(l));
  else {
    console.log('  3. Autograder Settings → container, and it differs by assignment:');
    console.log(`     **4.0 CPU / 6.0 GB RAM** for ${localBuilt.join(', ')} — required for the`);
    console.log('     bundled local grader as well as speech recognition.');
    console.log(`     **2.0 CPU / 3.0 GB RAM** for ${genaiBuilt.join(', ')} — no local grader in`);
    console.log('     those zips, but the 0.5 CPU / 0.75 GB default cannot even LOAD the speech');
    console.log('     model, so every submission would come back with no transcript.');
  }
}
console.log('  4. Autograder Settings → timeout **40 minutes**.');
console.log('     Headroom for AI-grading rate limits — without it a throttled');
console.log('     submission is killed mid-retry and the student gets nothing.');
console.log('     (ORALSCALE_WHISPER_MODEL=medium or large-v3 also wants 4.0 CPU / 6.0 GB.)');
console.log(`  5. Point value ${env.ORALSCALE_MAX_POINTS}.`);
console.log('  6. Upload the zip whose FILENAME names the assignment. Title the Gradescope');
console.log('     assignment whatever you like — the title is not used for anything, and');
console.log('     renaming it can never change which questions a submission is graded on.');
console.log('\nThen paste each assignment\'s student link into its assignment description:');
for (const b of built) {
  console.log(`  node tools/gen-url.js --course ${path.relative(ROOT, coursePath)} --assignment ${b.aid}`);
}
