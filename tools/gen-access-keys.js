#!/usr/bin/env node
'use strict';
/*
 * Mint the per-student quiz keys that gate the question Bank (INV-SEC-8).
 *
 *   node tools/gen-access-keys.js --course courses/<id>/course.json --roster roster.csv
 *   node tools/gen-access-keys.js --course … --student maya@purdue.edu
 *
 * WHY: the CourseLink is public and carries no identity, so without a key anyone
 * could call /reveal in a loop until they had mined the whole week's Bank — and the
 * Bank is the one asset that must not leak before the quiz.
 *
 * The key is SELF-AUTHENTICATING, which is what makes this a one-step job:
 *
 *     key = sid ‖ tag
 *     sid = base32( HMAC(Secret, "sid:v1:"‖courseId‖":"‖epoch‖":"‖email) )[0..5]
 *     tag = base32( HMAC(Secret, "ktag:v1:"‖courseId‖":"‖sid) )[0..9]
 *
 * The Signer verifies a key by RECOMPUTING its tag. There is no roster at the edge
 * and nothing to upload or sync — adding a student mid-term is this command plus a
 * Brightspace post, and the Signer never has to hear about it.
 *
 * `sid` is also the Student's identity (`studentRef = "k:"+sid`), derived server
 * side from the key, so **the student never types an email** and nothing derived
 * from one is ever transmitted. The autograder re-derives the same `k:<sid>` from
 * the Gradescope-authenticated email to bind the submission (INV-SEC-2).
 *
 * ⚠️  The output pairs emails with credentials. Keep it out of the repo (the
 * default output name is gitignored) and distribute over Brightspace, which is
 * inside the FERPA boundary.
 *
 * Rotation: keys change only if the Secret changes. Rotating the Secret
 * invalidates every key, every live link, and every unsubmitted certificate.
 */
const fs = require('fs');
const path = require('path');
const P = require('../server/lib/protocol');
const { readRows } = require('./lib/sheet.js');
const SECRETS = require('./lib/secrets.js');
const GUARDS = require('./lib/course-guards.js');

const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p);
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes('--' + name);
function die(...lines) { console.error('\n' + lines.join('\n') + '\n'); process.exit(1); }

/* Per course (secrets/<courseId>.json), falling back to the legacy shared
 * secret so a course deployed before the split keeps minting the same keys. */
function loadSecret(courseDir, courseId) {
  const r = SECRETS.resolve(courseDir, courseId);
  if (!r) {
    return die(`No signing Secret for "${courseId}".`, '',
      `Mint one:  node tools/make-config.js --course courses/${courseId}/course.json`);
  }
  return r;
}

/**
 * Pull students out of whatever the LMS exported — CSV or XLSX.
 *
 * COLUMN-AWARE, WITH A SCRAPE AS THE BACKSTOP. Brightspace's export is
 *
 *     OrgDefinedId,Username,Email,Calculated Final Grade Numerator,…,End-of-Line Indicator
 *
 * and every column but three is noise here. Finding the header and reading only
 * the columns we need beats scraping addresses out of the whole file: a scrape
 * would also pick up an instructor address in a footer, or anything email-shaped
 * in a comment column, and quietly mint keys for people who are not students.
 *
 * OrgDefinedId and Username are carried along because the Brightspace grade
 * IMPORT needs them to match rows back to students — Brightspace will not accept
 * an email as the key.
 *
 * The scrape still runs when no Email column is found, so a plain list of
 * addresses in a .txt keeps working.
 */
const HEADER_ALIASES = {
  email: ['email', 'email address', 'e-mail', 'primary email', 'student email'],
  orgDefinedId: ['orgdefinedid', 'org defined id', 'student id', 'id'],
  username: ['username', 'user name', 'login', 'net id', 'netid'],
};

const norm = (h) => String(h).trim().toLowerCase().replace(/\s+/g, ' ');

function findColumns(header) {
  const cells = header.map(norm);
  const pick = (aliases) => {
    for (const a of aliases) {
      const i = cells.indexOf(a);
      if (i >= 0) return i;
    }
    // Looser second pass, so "Email Address (primary)" still resolves.
    for (let i = 0; i < cells.length; i++) {
      if (aliases.some((a) => cells[i].includes(a))) return i;
    }
    return -1;
  };
  return {
    email: pick(HEADER_ALIASES.email),
    orgDefinedId: pick(HEADER_ALIASES.orgDefinedId),
    username: pick(HEADER_ALIASES.username),
  };
}

const EMAIL_RE = /[^\s,;"'<>]+@[^\s,;"'<>]+\.[^\s,;"'<>]+/;

function readRoster(file) {
  const rows = readRows(file);
  if (!rows.length) return [];

  // Find the header: the first row that names an email column. Brightspace can
  // prepend blank or title rows, so row 0 is not a safe assumption.
  let headerIdx = -1, cols = null;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const c = findColumns(rows[i]);
    if (c.email >= 0) { headerIdx = i; cols = c; break; }
  }

  const seen = new Set();
  const out = [];
  const push = (email, orgDefinedId, username) => {
    const e = P.normalizeEmail(email);
    if (!e || seen.has(e)) return;
    seen.add(e);
    out.push({ email: e, orgDefinedId: (orgDefinedId || '').trim(), username: (username || '').trim() });
  };

  if (cols) {
    for (const r of rows.slice(headerIdx + 1)) {
      const cell = String(r[cols.email] || '').trim();
      const m = cell.match(EMAIL_RE);
      if (m) push(m[0], cols.orgDefinedId >= 0 ? r[cols.orgDefinedId] : '',
        cols.username >= 0 ? r[cols.username] : '');
    }
    if (out.length) return out;
  }

  // No usable Email column — fall back to scraping every address in the file.
  for (const r of rows) {
    for (const cell of r) {
      const m = String(cell).match(EMAIL_RE);
      if (m) push(m[0], '', '');
    }
  }
  return out;
}

const csvCell = (s) => (/[",\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s));

(function main() {
  const coursePath = arg('course', process.env.ORALSCALE_COURSE || '');
  if (!coursePath || !fs.existsSync(coursePath)) {
    die('Which course? Pass --course <courses/<id>/course.json>.',
      '', 'Keys are derived from courseId, so the wrong course.json mints keys that',
      'the Signer will reject for every student in the class.');
  }
  const course = JSON.parse(fs.readFileSync(coursePath, 'utf8'));
  const courseDir = path.dirname(path.resolve(coursePath));

  /* GUARDS BEFORE KEYS. What this command is about to write pairs student
   * emails with credentials — the single most damaging file in the project to
   * commit. The .gitignore and the pre-commit hook go in FIRST, in this repo
   * AND in the course's own repo if it has one, so the protection exists before
   * the thing it protects. Installing them afterwards leaves a window, and the
   * window is exactly when someone runs `git add -A` on a folder full of new
   * files. */
  GUARDS.ensure(courseDir, { log: (m) => console.error(m) });

  const resolved = loadSecret(courseDir, course.courseId);
  const secret = resolved.secret;
  console.error(`  secret: ${resolved.source}`);

  /* A Secret shared with another course means either can mint the other's keys.
   * Refused here rather than warned: these keys go to students. */
  const clash = SECRETS.clashes(secret, course.courseId);
  if (clash.length) {
    die('This course shares its signing Secret with another, so keys minted now',
      'would open questions in that course too.', '',
      ...SECRETS.clashAdvice(courseDir, course.courseId, clash));
  }

  const rosterPath = arg('roster', '');
  const one = arg('student', '');
  let students;
  if (one) students = [{ email: P.normalizeEmail(one), orgDefinedId: '', username: '' }];
  else if (rosterPath) {
    if (!fs.existsSync(rosterPath)) die(`No such roster file: ${rosterPath}`);
    students = readRoster(rosterPath);
    if (!students.length) die(`No email addresses found in ${rosterPath}.`);
  } else {
    die('Pass --roster <file exported from Brightspace/Gradescope> or --student <email>.',
      '', 'CSV or XLSX. Only the Email column is read (plus OrgDefinedId and Username',
      'when present, which the Brightspace grade import needs); every other column',
      'is ignored. A plain list of addresses in a .txt works too.');
  }

  const epoch = Number(course.accessKeyEpoch || 1);
  const rows = students.map((st) => ({
    email: st.email,
    orgDefinedId: st.orgDefinedId,
    username: st.username,
    quizKey: P.accessKeyFor(secret, course.courseId, st.email, epoch),
    studentRef: P.studentRefForEmail(secret, course.courseId, st.email, epoch),
  }));

  // The id inside a key is 30 bits, so a collision across a big roster is unlikely
  // but not impossible — and two students sharing an id would share an identity at
  // grading time, which is a silent, serious wrong answer. We hold the whole roster
  // here, so we can simply check, and the fix is a one-line config bump.
  const byRef = new Map();
  for (const r of rows) {
    if (byRef.has(r.studentRef)) {
      die(`COLLISION: ${r.email} and ${byRef.get(r.studentRef)} would share the identity `
        + `${r.studentRef}.`, '',
        `Fix: set "accessKeyEpoch": ${epoch + 1} in ${rel(coursePath)} and re-run this command.`,
        'That re-mints every key in the course, so redistribute all of them.',
        '(Do this BEFORE handing keys out — changing the epoch later invalidates keys',
        ' students are already using.)');
    }
    byRef.set(r.studentRef, r.email);
  }

  const format = arg('format', 'csv');
  let out;
  if (format === 'text') {
    // One block per student, for a mail-merge or an individual message.
    out = rows.map((r) => `${r.email}\n  quiz key: ${r.quizKey}\n`).join('\n');
  } else {
    // studentRef is included so an instructor can match a flagged attempt in the
    // access log back to a student without the autograder in front of them.
    out = ['email,quizKey,studentRef']
      .concat(rows.map((r) => [r.email, r.quizKey, r.studentRef].map(csvCell).join(',')))
      .join('\n') + '\n';
  }

  // ---- Brightspace grade import ------------------------------------------
  //
  // The distribution problem: every student needs THEIR key and nobody else's.
  // Emailing 200 of them individually is the obvious wrong answer. Brightspace
  // already solves it — a grade item is per-student and private — and it accepts
  // a CSV in exactly the shape it exports.
  //
  // A TEXT grade item is the trick: Brightspace's own sample uses
  // "Participation Text Grade" to carry a sentence of feedback, so a text item
  // carries a 16-character key just as happily. The column header is
  // "<item name> Text Grade", which is why the item must be named before the
  // file is generated.
  //
  // Brightspace matches rows on OrgDefinedId (and Username), NOT on email — so
  // this file can only be produced from an export that carries them. That is
  // the whole reason the roster reader keeps those two columns.
  const itemName = arg('item', 'Oral Quiz Key');
  // INSIDE THE COURSE FOLDER. A key export is course material; writing it to
  // the repo root put the most sensitive file in the project outside the folder
  // that is meant to contain the whole course.
  const bsPath = arg('brightspace', has('no-brightspace') ? ''
    : path.join(courseDir, `${course.courseId}.brightspace-import.csv`));
  if (bsPath) {
    const withId = rows.filter((r) => r.orgDefinedId || r.username);
    if (!withId.length) {
      console.error('\n  ⚠️  No OrgDefinedId or Username column in that roster, so no Brightspace');
      console.error('      import file was written — Brightspace matches on those, never on email.');
      console.error('      Export the roster from Brightspace itself (it includes both) and re-run.');
    } else {
      // Header and row shape follow Brightspace's own sample export, including the
      // End-of-Line Indicator column, which its importer requires.
      const header = ['OrgDefinedId', 'Username', `${itemName} Text Grade`, 'End-of-Line Indicator'];
      const bs = [header.join(',')]
        .concat(withId.map((r) => [r.orgDefinedId, r.username, r.quizKey, '#'].map(csvCell).join(',')))
        .join('\n') + '\n';
      fs.writeFileSync(bsPath, bs);
      try { fs.chmodSync(bsPath, 0o600); } catch { /* best effort */ }
      console.log(`Brightspace import -> ${bsPath}  (${withId.length} row(s))`);
      if (withId.length !== rows.length) {
        console.log(`  ${rows.length - withId.length} student(s) had no OrgDefinedId/Username and were left out.`);
      }
      console.log(`  In Brightspace: Grades > Import, then create a TEXT grade item named exactly`);
      console.log(`  "${itemName}". Students see only their own row.`);
    }
  }

  const outPath = arg('out', has('stdout') ? ''
    : path.join(courseDir, `${course.courseId}.keys.csv`));
  if (outPath) {
    fs.writeFileSync(outPath, out);
    // 0600: this file pairs addresses with credentials.
    try { fs.chmodSync(outPath, 0o600); } catch { /* best effort */ }
    console.log(`\n${rows.length} key${rows.length === 1 ? '' : 's'} for course "${course.courseId}" -> ${outPath}`);
  } else {
    process.stdout.write(out);
  }

  console.error('\n  ┌──────────────────────────────────────────────────────────────────┐');
  console.error('  │  ⚠️  THESE FILES PAIR STUDENT EMAILS WITH CREDENTIALS             │');
  console.error('  └──────────────────────────────────────────────────────────────────┘');
  console.error('  Do this now, in order:');
  console.error('    1. UPLOAD to Brightspace (inside the FERPA boundary).');
  console.error('    2. DELETE the local files:');
  if (outPath) console.error(`         rm ${rel(outPath)}`);
  if (bsPath) console.error(`         rm ${rel(bsPath)}`);
  console.error('    3. Then commit whatever else you were committing.');
  console.error('');
  console.error('  A pre-commit guard is installed and will REFUSE a commit that stages them,');
  console.error('  in this repo and in the course\'s own repo. That is a backstop, not the plan:');
  console.error('  the file is dangerous while it exists, not only once it is committed.');
  console.error('');
  console.error('  Each student needs only the "quizKey" column. It is the ONLY thing they type:');
  console.error('  no email, no login. Nothing is uploaded anywhere — the quiz server verifies a');
  console.error('  key by recomputing it, so there is no roster to sync and no second step.');
  console.error('  Re-running this is safe and idempotent: keys are derived, not stored, so you');
  console.error('  can delete the files freely and regenerate them whenever you need them.\n');
})();
