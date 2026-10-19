#!/usr/bin/env node
'use strict';
/*
 * Mint quiz links.
 *
 *   Course link (DEFAULT) — ONE public link for the whole class. Paste it into the
 *   Gradescope assignment description. Identity is supplied by the student in the
 *   app and verified against Gradescope at submission time, so this link is not a
 *   credential and is safe to publish.
 *
 *     node tools/gen-url.js                                  pick interactively
 *     node tools/gen-url.js --course courses/<id>/course.json --assignment <id>
 *
 *   The course and the assignment are ALWAYS explicit: passed as flags, or chosen
 *   from a list. Nothing is inferred. Guessing the course would stamp the wrong
 *   pseudonymSalt into the link, which still passes /reveal but fails every
 *   identity check at grading time — a silent class-wide zero.
 *
 *   Accommodation link (legacy, per-student) — carries a time multiplier, for
 *   extended-time students only:
 *
 *     node tools/gen-url.js --course … --assignment … --student p@purdue.edu --time-mult 1.5
 *
 *   DEPLOY BEFORE YOU MINT — ENFORCED, not advised (INV-DEPLOY-5). Whenever the
 *   course has a signerUrl, this tool calls <signerUrl>/health first and REFUSES to
 *   mint unless the live Worker already serves this course and this assignment with
 *   the same knobs. There is no override flag: a link that cannot work must not
 *   exist to be pasted. If it refuses, the fix is always the same:
 *
 *     npm run deploy -- courses/<id>/course.json
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const P = require('../server/lib/protocol');
const SECRETS = require('./lib/secrets.js');

const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p);
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function die(...lines) {
  console.error('\n' + lines.join('\n') + '\n');
  process.exit(1);
}
/* PER COURSE (secrets/<courseId>.json), like every other minting tool.
 *
 * This used to read server/config.json unconditionally — the legacy SINGLE
 * SHARED secret — whatever --course said. Once courses had their own secrets
 * that silently signed every link with whichever course had most recently
 * written server/config.json, and the Signer for the course you actually asked
 * for rejected it with "invalid course token". The link looks perfect; only the
 * signature is from the wrong course, so there is nothing to see in the payload.
 *
 * Found on the public demo: a demo link signed with a real course's secret. */
function loadSecret(coursePath, courseId) {
  const r = SECRETS.resolve(coursePath, courseId);
  if (!r) {
    die(`No signing Secret for "${courseId}".`, '',
      `It belongs INSIDE the course folder, so the folder is the whole course:`,
      `  ${rel(SECRETS.envPath(coursePath))}`, '',
      `Create one:  node tools/make-config.js --course ${rel(coursePath)}`);
  }
  const clash = SECRETS.clashes(r.secret, courseId);
  if (clash.length) {
    die('This course shares its signing Secret with another.', '',
      ...SECRETS.clashAdvice(coursePath, courseId, clash));
  }
  return r;
}

/* "quiz-02-methods-and-models" -> "Oral Quiz 2", or null.
 *
 * MUST MATCH `quizTitleFor` in web/js/app.js — the app runs this same derivation
 * on links minted before labels existed, and `t_which_quiz_shown` compares the two
 * implementations against a table of ids. Conservative on purpose: an id that does
 * not clearly encode a quiz number derives nothing, because a confidently wrong
 * quiz number is worse than none. */
function quizNumberLabel(assignmentId) {
  const m = /(?:^|-)quiz-?0*(\d+)(?:-|$)/i.exec(String(assignmentId || ''));
  return m ? `Oral Quiz ${Number(m[1])}` : null;
}

/* EVERY ASSIGNMENT NAMES ITSELF (INV-USE-1). `shortTitle` is REQUIRED, and minting
 * refuses without it — there is no derivation escape.
 *
 * `quizNumberLabel` above still exists, and still runs IN THE APP, because links
 * minted before labels existed cannot be re-minted and must keep naming their quiz.
 * But a link being minted today is a link whose course.json is open in front of
 * somebody, and guessing on their behalf is the wrong default in both directions:
 * it silently accepts `week-03-pca`, whose id names the topic and would be printed
 * above the quiz, and it silently decides that `quiz-02-…` should read "Oral Quiz
 * 2" when the instructor may want "Midterm Review".
 *
 * Display only — nothing routes, grades or selects questions on this. That is
 * exactly why requiring it is cheap: backfilling a course cannot break anything. */
function requireDisplayLabel(coursePath, assignmentId, aCfg) {
  if (aCfg.shortTitle) return;
  const guess = quizNumberLabel(assignmentId);
  die(`"${assignmentId}" has no "shortTitle", which is required on every assignment.`,
    '',
    'The app names the quiz above every card so a student notices a wrong link, and',
    'this is the only assignment text they are shown. Without it the app would fall',
    'back to the id — which names the topics:',
    '',
    `    ${assignmentId}`,
    '',
    'That is a hint printed above the quiz, and it also travels inside the link,',
    'where anyone can read it before a single question is served.',
    '',
    `Add it to this assignment in ${rel(coursePath)}:`,
    '',
    `    "shortTitle": ${JSON.stringify(guess || 'Oral Quiz 3')}`,
    '',
    'Keep it topic-free. It has to stay true if you re-scope the quiz or turn it',
    'into a review, and matching the Gradescope assignment name is useful but not',
    'required. Nothing but the display depends on it.');
}

/* PREFLIGHT: the deployed Worker must already serve this assignment (INV-DEPLOY-5).
 *
 * A link names an assignment; the WORKER decides whether that assignment exists,
 * because the course config is bundled into it at deploy time. So course.json is
 * not evidence of anything a student will experience — only /health is.
 *
 * Minting first is not a harmless ordering slip. The link is signed, unexpired
 * and perfect; /reveal answers ASSIGNMENT_GONE, and what the student reads is
 * "this quiz link is out of date", about a link they were handed minutes ago and
 * can do nothing about. Observed in the pilot (2026-09-02): Quiz 1 was authored,
 * frozen and packaged, the link went into Gradescope, and the Worker still
 * carried the Quiz-0-only bundle.
 *
 * So this refuses rather than warns, and there is NO override flag. A warning is
 * printed once and scrolls away above the link you are about to paste; the whole
 * point is that a link which cannot work must not exist to be pasted. "Unknown"
 * counts as failure too — an unreachable Worker is not a Worker that has been
 * shown to serve this assignment.
 */
async function fetchHealth(signer) {
  const url = signer.replace(/\/+$/, '') + '/health';
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { error: `could not reach ${url} — ${e && e.message ? e.message : e}` };
  }
  if (!res.ok) return { error: `${url} answered HTTP ${res.status}` };
  let body;
  try { body = await res.json(); } catch { return { error: `${url} did not answer JSON` }; }
  if (!body || !Array.isArray(body.assignments)) {
    return { error: `${url} answered JSON with no "assignments" array — is that really a Signer?` };
  }
  return { health: body };
}

/* Refuse unless the live Worker is demonstrably ready for THIS link.
 * `want` is what we are about to stamp into the token, so a mismatch means the
 * deployed bundle is older than the course.json in front of you. */
async function requireDeployed(signer, coursePath, course, assignmentId, want, secret) {
  const deploy = `  npm run deploy -- ${rel(coursePath)}`;
  if (/[<>]/.test(signer)) {
    die(`"signerUrl" in ${rel(coursePath)} is still the template placeholder:`, `  ${signer}`, '',
      'That course has never been deployed, so there is no Worker to serve this link.',
      'Deploy it — that also records the real signerUrl and webappUrl:', '', deploy);
  }
  const { health, error } = await fetchHealth(signer);
  if (error) {
    die('Cannot confirm the Signer is serving this assignment, so no link was minted.', '',
      `  ${error}`, '',
      'A link is only as good as the deployed Worker behind it, and an unreachable',
      'Worker is not a Worker that has been shown to have this assignment. Fix the',
      'connectivity, or deploy:', '', deploy);
  }
  const bad = (what, ...why) => die(
    `The deployed Signer is not serving this link, so no link was minted.`, '',
    `  signer:     ${signer}`,
    `  wanted:     ${course.courseId} / ${assignmentId}`,
    `  deployed:   ${health.courseId} / ${health.assignments.join(', ') || '(none)'}`, '',
    what, ...why, '', 'Deploy, then re-run this command:', '', deploy);

  if (health.courseId !== course.courseId) {
    bad(`That Worker serves course "${health.courseId}", not "${course.courseId}".`,
      'It holds a different signing Secret, so every link you minted against it would',
      'fail with "invalid course token" — a link that looks perfect and verifies as',
      'nothing. Check "signerUrl" in the course.json, or deploy this course.');
  }
  if (!health.assignments.includes(assignmentId)) {
    bad(`That Worker has never heard of the assignment "${assignmentId}".`,
      'The course config is bundled into the Worker at DEPLOY time, so adding an',
      'assignment to course.json does not create it for students. Every student',
      'opening this link would get ASSIGNMENT_GONE — "this quiz link is out of date".');
  }
  // Beyond existence: the deployed bundle must also AGREE with the course.json we
  // are minting from. It reports these two per assignment, and either one drifting
  // proves the Worker is running an older config than the one on this disk.
  const dQ = (health.questionsPerAttempt || {})[assignmentId];
  if (want.questionsPerAttempt != null && dQ != null && Number(dQ) !== Number(want.questionsPerAttempt)) {
    bad(`Stale bundle: it serves ${dQ} question(s) per attempt for "${assignmentId}", but`,
      `${rel(coursePath)} says ${want.questionsPerAttempt}. The Worker is running an older`,
      'config than this course.json, so what students get is not what you just read.');
  }
  const dK = (health.accessKeyRequired || {})[assignmentId];
  if (want.requireKey != null && dK != null && !!dK !== !!want.requireKey) {
    bad(`Stale bundle: it has requireAccessKey=${!!dK} for "${assignmentId}", but this link`,
      `would be stamped requireKey=${!!want.requireKey}. The app and the Signer would`,
      'disagree about identity — either students are asked for a key the Signer ignores,',
      'or they are not asked for the one it demands and cannot get past /reveal.');
  }
  /* And the bank itself (INV-DEPLOY-7). The three checks above prove the Worker
   * knows this assignment and agrees about its knobs; none of them can tell
   * whether it is serving the QUESTIONS in front of you. A bank revised in place
   * keeps its bankId and its question ids, so that drift is invisible to every
   * other check here — and it is the drift that matters most, because the
   * autograder resolves a submission's questions by id and would mark against
   * the wrong rubric without erroring. */
  const wantTag = want.bankDigest
    ? P.bankTag(secret, course.courseId, assignmentId, want.bankDigest) : null;
  const gotTag = (health.bankTag || {})[assignmentId];
  if (wantTag && gotTag && gotTag !== wantTag) {
    bad(`Stale bundle: the Worker is serving a DIFFERENT BANK for "${assignmentId}".`,
      `  deployed bank revision: ${(health.bankRevision || {})[assignmentId] || '(none)'}`,
      `  bank on this disk:      ${want.bankRevision || '(none)'}`,
      'Same assignment, different questions. The link would work and students would',
      'answer questions that are not the ones you just read — and if the Gradescope',
      'zip was built from this disk, the grader would mark their answers against a',
      'different question\'s rubric, by id, without erroring.');
  }

  if (wantTag && !gotTag) {
    console.error('\n⚠️  This Worker does not report which BANK it is serving, so nothing here could');
    console.error('   check that students get the questions in front of you (INV-DEPLOY-7). It was');
    console.error('   deployed before that existed. Close the gap:');
    console.error(`     npm run deploy -- ${rel(coursePath)}`);
  }

  // Not fatal: the link works. But a graded quiz whose cooldown is not enforced
  // lets a student reroll until they like the question (INV-SEC-7), and this is
  // the last moment before the link is public.
  if (health.cooldownConfigured && !health.cooldownEnforced) {
    console.error('\n⚠️  This course configures a retake cooldown, but the deployed Worker is NOT');
    console.error('    enforcing it (the D1 binding did not take). Students can reroll questions');
    console.error(`    until they see one they like (INV-SEC-7). Re-run:\n${deploy}`);
  }
  return health;
}

/** Every courses/<id>/course.json we can see. */
function allCourses() {
  const dir = path.join(ROOT, 'courses');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort()
    .map((d) => path.join(dir, d, 'course.json'))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ path: p, course: JSON.parse(fs.readFileSync(p, 'utf8')) }));
}

const interactive = process.stdin.isTTY && process.stdout.isTTY;
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/** Numbered menu. Returns the chosen item, or exits with the list if not interactive. */
async function choose(what, items, render, howToPass) {
  if (!items.length) die(`Nothing to choose from for: ${what}.`);
  const lines = items.map((it, i) => `  ${String(i + 1).padStart(2)}. ${render(it)}`);
  if (!interactive) {
    die(`Which ${what}? Pass ${howToPass} — this is deliberately not guessed.`,
      '', 'Available:', ...lines);
  }
  console.log(`\nWhich ${what}?\n`);
  console.log(lines.join('\n'));
  for (;;) {
    const a = await ask(`\n${what} [1-${items.length}]: `);
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
    const byName = items.find((it) => render(it).startsWith(a) && a.length > 0);
    if (byName) return byName;
    console.log('  Please enter a number from the list (or Ctrl-C to quit).');
  }
}

(async () => {
  const courses = allCourses();

  // ---- 1. the course, explicitly ----------------------------------------
  let coursePath = arg('course', null) || process.env.ORALSCALE_COURSE || null;
  if (coursePath && !fs.existsSync(coursePath)) {
    die(`No such course.json: ${coursePath}`, '', 'Available courses:',
      ...courses.map((c) => `  ${c.course.courseId}   (${rel(c.path)})`));
  }
  if (!coursePath) {
    const picked = await choose('course', courses,
      (c) => `${c.course.courseId.padEnd(20)} ${rel(c.path)}`
        + (c.course.signerUrl ? '   [deployed]' : '   [not deployed]'),
      '--course <path>');
    coursePath = picked.path;
  }
  const course = JSON.parse(fs.readFileSync(coursePath, 'utf8'));
  const assignments = course.assignments || {};
  // Only now — the secret belongs to the course, so it cannot be resolved before
  // the course is known.
  const { secret, source: secretSource } = loadSecret(coursePath, course.courseId);

  // ---- 2. the assignment, explicitly ------------------------------------
  let assignmentId = arg('assignment', null);
  if (assignmentId && !assignments[assignmentId]) {
    die(`"${assignmentId}" is not an assignment in ${rel(coursePath)} (course "${course.courseId}").`,
      '', 'That course defines:', ...Object.keys(assignments).map((a) => '  ' + a),
      '', 'Use --course <path> if you meant a different course.');
  }
  if (!assignmentId) {
    assignmentId = await choose(`assignment in "${course.courseId}"`, Object.keys(assignments),
      (a) => a, '--assignment <id>');
  }

  // ---- 3. mint -----------------------------------------------------------
  const studentRef = arg('student', '');
  const base = (arg('base', course.webappUrl || 'http://localhost:8080/web/') || '').replace(/\/+$/, '') + '/';
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(base);
  const signer = arg('signer', course.signerUrl || '');

  // The knobs that go INTO the token, resolved here because the preflight
  // compares them against what the deployed Worker reports (INV-DEPLOY-5).
  const aCfg = assignments[assignmentId] || {};
  const dflt = course.defaults || {};
  const requireKey = aCfg.requireAccessKey != null ? !!aCfg.requireAccessKey
    : (dflt.requireAccessKey != null ? !!dflt.requireAccessKey : true);
  const allowPrivateCode = aCfg.allowPrivateCode != null ? !!aCfg.allowPrivateCode
    : (dflt.allowPrivateCode != null ? !!dflt.allowPrivateCode : true);
  const nQ = Number(aCfg.questionsPerAttempt != null ? aCfg.questionsPerAttempt
    : (dflt.questionsPerAttempt != null ? dflt.questionsPerAttempt : 1));

  // ---- 3a. the link must not name the week's topics (INV-USE-1) ----------
  // Unconditional: unlike the deployment check below, this is about what the token
  // CONTAINS, so it applies just as much to a local dev link someone pastes around.
  requireDisplayLabel(coursePath, assignmentId, aCfg);

  // ---- 3b. the Worker must already serve this (INV-DEPLOY-5) -------------
  // No signerUrl means there is no deployment to check and no link a student
  // could use either; that case is called out loudly after the link is printed.
  if (signer) {
    // Read the bank this course.json points at, so the preflight can ask the
    // Worker whether it is serving THESE questions (INV-DEPLOY-7).
    let bankDigest = null, bankRevision = null;
    try {
      const bp = path.resolve(path.dirname(coursePath), aCfg.bank);
      const braw = fs.readFileSync(bp);
      bankDigest = P.bankDigest(braw);
      bankRevision = JSON.parse(braw.toString('utf8')).revision;
    } catch { /* no readable bank here: the other checks still apply */ }
    await requireDeployed(signer, coursePath, course, assignmentId,
      { requireKey: studentRef ? null : requireKey, questionsPerAttempt: nQ,
        bankDigest, bankRevision }, secret);
  }

  let token, label, detail, equivalent;
  if (studentRef) {
    const minutes = Number(arg('minutes', '20'));
    const timeMultiplier = Number(arg('time-mult', '1'));
    token = P.signToken(secret, {
      v: 2, kind: 'quiz',
      courseId: course.courseId, assignmentId, studentRef, timeMultiplier,
      exp: Math.floor(Date.now() / 1000) + minutes * 60,
    });
    label = 'Accommodation link (personal — do NOT publish)';
    detail = `  course:     ${course.courseId}  (${rel(coursePath)})\n`
      + `  student:    ${studentRef}\n  expires in: ${minutes} min  (time x${timeMultiplier})`;
    equivalent = `node tools/gen-url.js --course ${rel(coursePath)} --assignment ${assignmentId}`
      + ` --student ${studentRef} --time-mult ${timeMultiplier}`;
  } else {
    const days = Number(arg('days', '120'));
    if (!course.pseudonymSalt) {
      die(`${rel(coursePath)} has no "pseudonymSalt". Add one (any random hex string).`);
    }
    // signerUrl travels INSIDE the signed token so the deployed web app needs no
    // per-deployment edit and cannot be repointed by a tampered link.
    // Does this assignment gate the Bank behind a personal quiz key (INV-SEC-8)?
    // It rides in the SIGNED token so the app knows whether to ask for one and a
    // tampered link cannot turn the prompt off — the Signer checks regardless.
    /* WHICH QUIZ, IN WORDS (INV-USE-1). The app prints this above every card so a
     * student can see, before recording, that they opened the right assignment's
     * link — the commonest way a pilot-quiz attempt was wasted.
     *
     * A CONVENIENCE, never a requirement: the app falls back to the `courseId` /
     * `assignmentId` already in the token, so links minted before this existed
     * (the live Quiz 1 link among them) name their quiz correctly without being
     * re-minted. Text from course.json, rendered as text, never markup (INV-SEC-6).
     *
     * THE ASSIGNMENT'S FULL TITLE IS NOT STAMPED, on purpose. It names the week's
     * topics, and the token travels in the URL fragment — so a title in here is a
     * topic hint sitting inside the link, readable by anyone who base64-decodes
     * it, before a single question has been served. `shortTitle` is the short
     * label the instructor controls ("Oral Quiz 2"); with none set the app derives
     * the quiz number from the id instead. */
    token = P.signToken(secret, {
      v: 3, kind: 'course',
      courseId: course.courseId, assignmentId,
      ...(course.title ? { courseTitle: String(course.title) } : {}),
      ...(aCfg.shortTitle ? { assignmentLabel: String(aCfg.shortTitle) } : {}),
      pseudonymSalt: course.pseudonymSalt,
      requireKey, allowPrivateCode,
      ...(signer ? { signerUrl: signer.replace(/\/+$/, '') } : {}),
      exp: Math.floor(Date.now() / 1000) + days * 86400,
    });
    label = (isLocal || !signer)
      ? 'LOCAL DEV link — NOT for students'
      : 'Course link (PUBLIC — paste into the Gradescope assignment description)';
    detail = `  course:     ${course.courseId}  (${rel(coursePath)})\n`
      + `  shown as:   ${aCfg.shortTitle || '(derived from the id — set shortTitle to control it)'}\n`
      + `  expires in: ${days} days\n`
      + `  questions:  ${nQ} per attempt\n`
      + `  identity:   ${requireKey
          ? 'quiz key only — students enter no email at all (hand keys out first:\n              node tools/gen-access-keys.js --course ' + rel(coursePath) + ')'
          : 'student-typed email or private code; NO key required, so anyone can open\n              questions and mine this bank (INV-SEC-8)'}\n`
      + `  signer:     ${signer || '(none — the app will fall back to its built-in default)'}\n`
      // Name the secret. A link signed by the wrong course is indistinguishable
      // from a right one until a student hits "invalid course token", and the
      // payload gives nothing away — the signature is the only thing that differs.
      + `  secret:     ${secretSource}`;
    equivalent = `node tools/gen-url.js --course ${rel(coursePath)} --assignment ${assignmentId}`;
  }

  console.log(`\n${label}:\n`);
  console.log(base + '#' + token);
  console.log(`\n  assignment: ${assignmentId}\n${detail}\n`);

  if (!studentRef && (isLocal || !signer)) {
    const why = [];
    if (isLocal) why.push(`the web app URL is ${base} (only reachable on your machine)`);
    if (!signer) why.push("no signerUrl is embedded, so the student's browser would try localhost:8787");
    console.error('⚠️  This link will NOT work for students, because ' + why.join(', and ') + '.');
    console.error('    That is fine for local testing. For a real link, deploy first:');
    console.error(`      npm run deploy -- ${rel(coursePath)}`);
    console.error('    which records signerUrl and webappUrl into that course.json, then re-run this.\n');
  }

  // Chose from the menu? Show the flags that skip it next time.
  if (interactive && (!arg('course', null) || !arg('assignment', null))) {
    console.log(`To skip the prompts next time:\n  ${equivalent}\n`);
  }
})();
