#!/usr/bin/env node
'use strict';
/*
 * Rehearse autograder.zip the way GRADESCOPE actually unpacks it.
 *
 *   node tools/test-package.js
 *
 * Gradescope extracts the uploaded zip INTO /autograder/source/, then runs
 * /autograder/run_autograder. That detail matters and was got wrong: the zip
 * shipped its own source/ directory, so the python files ended up at
 * /autograder/source/source/ and every submission died with
 *
 *     python3: can't open file '/autograder/source/run_autograder.py'
 *
 * An earlier "rehearsal" unzipped the archive flat, which accidentally
 * reproduced the OLD layout and passed. This one builds the real thing:
 *
 *     <root>/source/      <- zip contents, exactly as Gradescope extracts them
 *     <root>/run_autograder   <- copied up, exactly as Gradescope invokes it
 *     <root>/submission/  <root>/results/
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../server/lib/protocol');
const { writeWav } = require('./lib/wav');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const shellCoursePath = path.join(ROOT, 'courses', '_shell-for-testsuite', 'course.json');
const shellCourse = JSON.parse(fs.readFileSync(shellCoursePath, 'utf8'));
const releaseVersion = require('../package.json').version;
// One zip PER ASSIGNMENT now (INV-DEPLOY-3), so the test rehearses a specific
// one and builds only that. The name is the contract an instructor reads to know
// which zip to upload, so the test asserts the real filename rather than a glob.
const SHELL_ASSIGNMENT = Object.keys(shellCourse.assignments || {})[0];
const ZIP = path.join(path.dirname(shellCoursePath), 'autograders',
  `${shellCourse.courseId}-${SHELL_ASSIGNMENT}-oralscale-v${releaseVersion}.zip`);

// REBUILD FIRST. This test exists to rehearse the artifact Gradescope will run,
// which is worth nothing if it rehearses a stale one. It used to extract
// whatever autograder.zip happened to be lying around — on 2026-08-24 that was a
// five-day-old build whose bundled protocol.py still had the previous
// CODE_DIGITS, so the suite was validating code that no longer existed. A gate
// that can pass against last week's artifact is not a gate.
// DELETE FIRST. A rebuild that leaves a previous artifact in place lets the test
// pass against it if the build silently stops producing one — which is how a
// rename slipped through here once, the suite happily validating a zip from
// before the change. The gate must fail when the build does.
fs.rmSync(path.dirname(ZIP), { recursive: true, force: true });
{
  // ⚠️ SIDE EFFECT, and it is worth knowing about: this overwrites
// autograder/source/ with a build of the test shell. Course artifacts themselves
// no longer collide: every zip lands under that course's ignored autograders/ directory.
const built = spawnSync('node', [path.join(ROOT, 'tools', 'build-autograder.js'),
    // Built from the test-suite shell, not the demo course: this test drives the
    // assignment-resolution path with a Gradescope title like "Quiz 1", which
    // needs a course that actually has weekly assignments. That is exactly what
    // courses/_shell-for-testsuite is for.
    shellCoursePath, '--zip', '--assignment', SHELL_ASSIGNMENT],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (built.status !== 0) {
    console.error('could not rebuild autograder.zip:\n' + (built.stderr || built.stdout));
    process.exit(1);
  }
}
if (!fs.existsSync(ZIP)) {
  console.error(`${ZIP} missing even after a rebuild — check tools/build-autograder.js --zip`);
  process.exit(1);
}
check('course-bound zip exists and the ambiguous generic zip is absent',
  fs.existsSync(ZIP) && !fs.existsSync(path.join(ROOT, 'autograder', 'autograder.zip')),
  path.relative(ROOT, ZIP));

console.log('── autograder package (Gradescope layout) ──');
const sim = process.env.ORALSCALE_KEEP_SIM || fs.mkdtempSync(path.join(os.tmpdir(), 'oralscale-gs-'));
const srcDir = path.join(sim, 'source');
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(path.join(sim, 'results'), { recursive: true });
fs.mkdirSync(path.join(sim, 'submission'), { recursive: true });

// Exactly what Gradescope does: unzip INTO source/, then lift run_autograder up.
spawnSync('unzip', ['-q', ZIP, '-d', srcDir], { stdio: 'inherit' });
check('zip extracts the python entry point to source/run_autograder.py',
  fs.existsSync(path.join(srcDir, 'run_autograder.py')),
  fs.existsSync(path.join(srcDir, 'source')) ? 'found a nested source/ — wrong layout' : '');
check('zip does NOT nest a second source/ directory', !fs.existsSync(path.join(srcDir, 'source')));

/* t_no_weights_in_zip (INV-DEPLOY-4) — the upload carries CODE, never weights.
 *
 * setup.sh downloads the GGUF and the Whisper weights at IMAGE BUILD time, into
 * source/models/. A developer who runs the grader locally ends up with the same
 * 1.9 GB file in the same place, and `zip -r source` then shipped it: the model
 * travelled twice, and the upload went from ~95 KB to ~1.9 GB. Gradescope's
 * upload does not fail loudly on that — it just takes twenty minutes or dies on
 * a poor connection, with nothing to point at the cause.
 *
 * Asserted on the extracted tree rather than on the build, so it holds whatever
 * the developer happens to have lying around in source/. */
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const shipped = walk(srcDir);
const weights = shipped.filter((f) => /\.(gguf|bin|safetensors|pt)$/i.test(f)
  || /(^|\/)models\//.test(path.relative(srcDir, f)));
check('t_no_weights_in_zip — no model weights are packaged; setup.sh fetches them into the image',
  weights.length === 0, weights.map((f) => path.relative(srcDir, f)).join(', '));

/* t_no_personal_data_in_zip (INV-PRIV-6) — the upload carries a Secret and a
 * bank, never a person.
 *
 * A signing Secret and a question bank are COURSE secrets: disclosure is bad and
 * is repaired by rotating one or retiring the other. A roster is data about
 * identified people, nothing repairs its disclosure, and this artifact is
 * uploaded to Gradescope, baked into an image, and copied wherever it goes.
 * accommodations.json used to ride along so claims could be verified in the
 * container; it worked, and it meant every container held a record of who has a
 * disability accommodation. The check moved offline instead.
 *
 * Asserted on the EXTRACTED tree, and by content as well as by name — a roster
 * renamed to something innocuous is the way this comes back. */
const PERSONAL_NAMES = /accommodation|roster|extension|student|email|enroll|drc/i;
const personalByName = shipped.filter((f) =>
  PERSONAL_NAMES.test(path.basename(f)) && !/course\.json$/.test(f));
check('t_no_personal_data_in_zip — no roster, accommodation or student file is packaged',
  personalByName.length === 0, personalByName.map((f) => path.relative(srcDir, f)).join(', '));

/* By content: anything that looks like an address, or a map of studentRefs to
 * numbers, in any file that ships. The bank and course.json are prose and
 * config; neither should contain either shape. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const REF_MAP = /"k:[0-9A-Z]{4,}"\s*:\s*[0-9.]/;
const leaks = [];
for (const f of shipped) {
  if (!/\.(json|env|csv|txt|py|js)$/i.test(f)) continue;
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const rel = path.relative(srcDir, f);
  // Addresses that are obviously ours, or a documented example, are not a leak.
  const m = text.match(EMAIL);
  if (m && !/example\.com|purdue\.edu\/|@example|noreply|your\.edu/i.test(m[0])) {
    leaks.push(`${rel}: address-shaped ${JSON.stringify(m[0])}`);
  }
  if (REF_MAP.test(text)) leaks.push(`${rel}: studentRef -> number map`);
}
check('t_no_personal_data_in_zip — nothing that ships contains an address or a studentRef map',
  leaks.length === 0, leaks.slice(0, 4).join(' | '));

const zipBytes = fs.statSync(ZIP).size;
check('t_no_weights_in_zip — the upload stays small enough to actually upload (< 100 MB)',
  zipBytes < 100 * 1024 * 1024, `${(zipBytes / 1024).toFixed(0)} KB`);

check('t_no_weights_in_zip — setup.sh is what downloads the GGUF, at image build time',
  /hf_hub_download/.test(fs.readFileSync(path.join(ROOT, 'autograder', 'setup.sh'), 'utf8')));

const entry = path.join(srcDir, 'run_autograder');
check('zip ships the run_autograder entry script', fs.existsSync(entry));
if (fs.existsSync(entry)) {
  fs.copyFileSync(entry, path.join(sim, 'run_autograder'));
  fs.chmodSync(path.join(sim, 'run_autograder'), 0o755);
}
check('zip ships setup.sh', fs.existsSync(path.join(srcDir, 'setup.sh')));

// Build a submission the packaged grader should accept. The certificate must be
// signed with the SAME secret the zip carries, so read it back out of the zip.
const secretEnv = fs.readFileSync(path.join(srcDir, 'secret.env'), 'utf8');
const secret = (secretEnv.match(/^ORALSCALE_SECRET=(.*)$/m) || [])[1];
const course = JSON.parse(fs.readFileSync(path.join(srcDir, 'course.json'), 'utf8'));
const assignmentId = Object.keys(course.assignments)[0];
const bank = JSON.parse(fs.readFileSync(path.join(srcDir, course.assignments[assignmentId].bank), 'utf8'));
const q = bank.questions[0];

const attemptId = P.newId(12);
const email = 'package-test@purdue.edu';
const studentRef = P.studentRefFromEmail(course.pseudonymSalt, email);
const sub = path.join(sim, 'submission');
writeWav(path.join(sub, 'answer.wav'), 6);
const audioSHA256 = P.sha256Hex(fs.readFileSync(path.join(sub, 'answer.wav')));
const now = Math.floor(Date.now() / 1000);
const lead = Number(course.assignments[assignmentId].codeLeadSec
  ?? course.defaults?.codeLeadSec ?? 5);
const cert = {
  v: 5, kind: 'certificate', courseId: course.courseId, assignmentId, studentRef,
  attemptId, questionId: q.id,
  tReveal: now - 26, tQuestion: now - 26 + lead, tClosing: now - 3, tFinish: now,
  elapsedSec: 26, deadline: now + 200,
  codeLeadSec: lead, questionOffsetSec: lead, closingOffsetSec: 23,
  answerSec: 23 - lead, limitSec: 180, tailLimitSec: 20,
  codeDigits: P.CODE_DIGITS, audioSHA256, clientDurationSec: 26,
  // The course this zip is built from gates on a quiz key (INV-SEC-8), as every
  // real course does. A certificate the Signer actually issued carries proof it
  // was gated, so the fixture must too — without it the autograder is right to
  // refuse, and the packaging check would be rehearsing an impossible submission.
  accessKeyVerified: true, keyChecked: 'accessKey',
};
fs.writeFileSync(path.join(sub, 'certificate.json'),
  JSON.stringify({ ...cert, certificateToken: P.signToken(secret, cert) }, null, 2));

const DIG = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const words = [];
const say = (text, t0, step) => String(text).split(' ')
  .forEach((w, i) => words.push({ word: w, start: +(t0 + i * step).toFixed(2), end: +(t0 + i * step + 0.1).toFixed(2) }));
say(P.deriveCode(secret, attemptId, 'open').split('').map((d) => DIG[+d]).join(' '), 0.2, 0.2);
say((q.keyPoints || []).join(' ').replace(/[^a-zA-Z ]/g, ''), lead + 0.5, 0.05);
say(P.deriveCode(secret, attemptId, 'close').split('').map((d) => DIG[+d]).join(' '), 23.2, 0.2);
fs.writeFileSync(path.join(sub, 'words.json'), JSON.stringify(words));
fs.writeFileSync(path.join(sim, 'submission_metadata.json'), JSON.stringify({
  assignment: { title: 'Quiz ' + Number((assignmentId.match(/week[-_ ]?(\d+)/i) || [])[1] || 1), id: 4242 },
  users: [{ email, name: 'Package Test', id: 1 }],
}));

// Run it exactly as the container does: <root>/run_autograder, cwd elsewhere.
const r = spawnSync('bash', [path.join(sim, 'run_autograder')], {
  cwd: os.tmpdir(),
  env: {
    ...process.env,
    ORALSCALE_SUBMISSION: sub,
    ORALSCALE_RESULTS: path.join(sim, 'results', 'results.json'),
    ORALSCALE_METADATA: path.join(sim, 'submission_metadata.json'),
    ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR: '1',   // no Whisper needed for a packaging check
    ORALSCALE_GRADING_BACKEND: 'heuristic',    // …and no grading model either
  },
  encoding: 'utf8',
});
const stderr = (r.stderr || '').trim();
check('run_autograder executes from the Gradescope layout',
  r.status === 0 && !/No such file or directory/.test(stderr),
  stderr ? stderr.split('\n').slice(-1)[0].slice(0, 120) : `exit=${r.status}`);

const resPath = path.join(sim, 'results', 'results.json');
check('it writes results.json', fs.existsSync(resPath));
if (fs.existsSync(resPath)) {
  const res = JSON.parse(fs.readFileSync(resPath, 'utf8'));
  // Gradescope's required shape.
  check('results.json has the Gradescope shape',
    typeof res.score === 'number' && Array.isArray(res.tests)
      && res.tests.every((t) => typeof t.name === 'string' && typeof t.output === 'string'),
    `score=${res.score} tests=${(res.tests || []).length}`);
  const visible = (res.tests || []).filter((t) => (t.visibility || 'visible') === 'visible');
  const hidden = (res.tests || []).filter((t) => t.visibility === 'hidden');
  const blob = (ts) => ts.map((t) => t.name + '\n' + t.output).join('\n');

  check('a valid submission is graded', typeof res.score === 'number' && res.score > 0,
    `score=${res.score}`);

  // Students must not learn HOW the integrity checks work — naming them is a map
  // of what to defeat. All of it lives in hidden tests.
  // 'Spoken codes' and the transcript ARE deliberately student-visible: the codes are
  // the one thing a student is asked to DO, so naming that check is coaching, and a
  // garbled transcript explains a low score better than any message we could write.
  const leaked = ['Identity', 'Audio integrity', 'Timing window', 'Duration',
    'Certificate signature', 'Transcription', 'Assignment']
    .filter((n) => visible.some((t) => t.name === n));
  check('student view hides the individual integrity checks', leaked.length === 0,
    leaked.join(', '));
  check('student view carries a single validation result',
    visible.some((t) => t.name === 'Validation checks'),
    visible.map((t) => t.name).join(' | '));

  // The grading model must not be student-visible.
  check('student view does not name the grader',
    !/graded by:|genai|gemma|heuristic/i.test(blob(visible) + (res.output || '')));
  // `backends:` (plural) since a multi-question attempt can be graded by more
  // than one. The singular spelling this looked for stopped being emitted some
  // time ago; the stale zip hid it.
  check('instructor view DOES name the grader',
    /backends?:/.test(blob(hidden)),
    (blob(hidden).match(/backends?: [^\n]+/) || [''])[0]);

  check('feedback is wrapped, not one long line',
    visible.filter((t) => /feedback/i.test(t.name))
      .every((t) => t.output.split('\n').every((l) => l.length <= 100)));
}


// ---------------------------------------------------------------------------
// A FAILING submission must tell the student nothing about WHICH check caught it.
// ---------------------------------------------------------------------------
{
  // Same audio, but a certificate issued to somebody else.
  const other = P.studentRefFromEmail(course.pseudonymSalt, 'someone.else@purdue.edu');
  const bad = { ...cert, studentRef: other };
  fs.writeFileSync(path.join(sub, 'certificate.json'),
    JSON.stringify({ ...bad, certificateToken: P.signToken(secret, bad) }, null, 2));
  const badRes = path.join(sim, 'results', 'bad.json');
  spawnSync('bash', [path.join(sim, 'run_autograder')], {
    cwd: os.tmpdir(),
    env: { ...process.env, ORALSCALE_SUBMISSION: sub, ORALSCALE_RESULTS: badRes,
      ORALSCALE_METADATA: path.join(sim, 'submission_metadata.json'),
      ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR: '1', ORALSCALE_GRADING_BACKEND: 'heuristic' },
    encoding: 'utf8',
  });
  const res = JSON.parse(fs.readFileSync(badRes, 'utf8'));
  const vis = (res.tests || []).filter((t) => (t.visibility || 'visible') === 'visible');
  const hid = (res.tests || []).filter((t) => t.visibility === 'hidden');
  const visText = vis.map((t) => t.name + '\n' + t.output).join('\n') + (res.output || '');
  const hidText = hid.map((t) => t.name + '\n' + t.output).join('\n');

  check('a failed submission scores 0', res.score === 0, `score=${res.score}`);
  check('student is NOT told which check failed',
    !/identity|hash|signature|timing window|duration|pre-record/i.test(visText));
  check('student is told to retry and to contact a TA',
    /retry|fresh attempt/i.test(visText) && /TA/.test(visText));
  check('instructor gets a REVIEW flag naming the failure',
    /REVIEW/.test(hidText) && /identity mismatch/i.test(hidText));
  check('instructor sees both identities in full',
    hidText.includes('someone.else@purdue.edu') || /certificate studentRef/.test(hidText));
  check('the review note says to treat it as benign until a pattern emerges',
    /benign/i.test(hidText) && /pattern/i.test(hidText));
}

// ---------------------------------------------------------------------------
// An UNCERTIFIED BACKUP preserves audio after /finish fails, but it must never
// become a weaker route to automatic credit (INV-INTEGRITY-7).
// ---------------------------------------------------------------------------
{
  fs.rmSync(path.join(sub, 'certificate.json'), { force: true });
  fs.writeFileSync(path.join(sub, 'UNCERTIFIED_BACKUP.json'), JSON.stringify({
    format: 'oralscale-uncertified-backup-v1', certified: false,
    warning: 'student-controlled marker; never trusted',
  }));
  const backupRes = path.join(sim, 'results', 'backup.json');
  spawnSync('bash', [path.join(sim, 'run_autograder')], {
    cwd: os.tmpdir(),
    env: { ...process.env, ORALSCALE_SUBMISSION: sub, ORALSCALE_RESULTS: backupRes,
      ORALSCALE_METADATA: path.join(sim, 'submission_metadata.json'),
      ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR: '1', ORALSCALE_GRADING_BACKEND: 'heuristic' },
    encoding: 'utf8',
  });
  const res = JSON.parse(fs.readFileSync(backupRes, 'utf8'));
  const vis = (res.tests || []).filter((t) => (t.visibility || 'visible') === 'visible');
  const hid = (res.tests || []).filter((t) => t.visibility === 'hidden');
  const text = (ts) => ts.map((t) => t.name + '\n' + t.output).join('\n');

  check('t_uncertified_backup_zero — audio without a certificate scores exactly 0',
    res.score === 0, `score=${res.score}`);
  check('t_uncertified_backup_zero — student sees uncertified, retry, and manual-review policy',
    /uncertified backup/i.test(text(vis) + res.output)
      && /fresh certified attempt/i.test(text(vis))
      && /manually override|manual review/i.test(text(vis) + res.output));
  check('t_uncertified_backup_zero — instructor gets a review flag and no grader ran',
    /REVIEW/i.test(text(hid)) && /no content grader ran/i.test(text(hid).replace(/\s+/g, ' '))
      && !/Answer 1 feedback|backends?:/i.test(text(vis) + text(hid)));
}

if (!process.env.ORALSCALE_KEEP_SIM) fs.rmSync(sim, { recursive: true, force: true });
const passed = results.filter(Boolean).length;
console.log(`\n${passed === results.length ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
