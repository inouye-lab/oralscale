'use strict';
/*
 * A course's signing Secret lives INSIDE THAT COURSE'S FOLDER, in `.env`.
 *
 * THE GOVERNING RULE: a course folder is the whole course. Everything that
 * belongs to it — config, banks, Secret, generated keys, accommodation roster,
 * built autograders — lives under `courses/<id>/` and nowhere else. Copy that
 * one folder, or clone that one repository, and you have a working course. No
 * companion file in the engine repo, nothing to remember to bring along.
 *
 * Secrets used to live in `secrets/<courseId>.json`, beside the engine rather
 * than the course. That is a portability bug wearing a tidiness costume: the
 * course folder is meant to be its own private repository, so a Secret parked
 * outside it is a piece of the course that does not travel — and the failure
 * shows up as "every certificate is invalid" on someone else's machine.
 *
 * Resolution, and there is no fallback chain:
 *   1. `courses/<id>/.env`                   — the answer
 *   2. ORALSCALE_SECRET_<COURSEID>           — CI / containers, course-SCOPED
 *
 * A bare ORALSCALE_SECRET is deliberately NOT consulted: it is a whole-shell
 * value, so a terminal holding one course's Secret would silently sign another
 * course's artifacts. The scoped name cannot do that.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const COURSES = path.join(ROOT, 'courses');

/** The course folder for a path that may be the folder or its course.json. */
function courseDirOf(p) {
  const abs = path.resolve(p);
  return path.basename(abs) === 'course.json' ? path.dirname(abs) : abs;
}
const envPath = (courseDir) => path.join(courseDirOf(courseDir), '.env');

/** `chem101-fall2026` -> `ORALSCALE_SECRET_CHEM101_FALL2026`. */
function envVarFor(courseId) {
  return 'ORALSCALE_SECRET_' + String(courseId).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** Minimal KEY=VALUE reader. Quotes optional; `#` starts a comment on its own line. */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

/** Every course folder on disk: {courseId, dir, coursePath}. */
function allCourses(coursesDir = COURSES) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (e.name !== 'course.json') continue;
      try {
        const id = JSON.parse(fs.readFileSync(full, 'utf8')).courseId;
        if (id) out.push({ courseId: id, dir: path.dirname(full), coursePath: full });
      } catch { /* unreadable course.json is another check's problem */ }
    }
  };
  walk(coursesDir);
  return out;
}

/**
 * `{secret, source}` for a course folder (or its course.json), or null.
 *
 * Null is not a thing to paper over. Callers must fail and offer to mint one:
 * a course with no Secret cannot sign anything, and quietly borrowing another
 * course's would let either forge the other's certificates.
 */
function resolve(courseRef, courseId = null) {
  if (!courseRef) return null;
  const dir = courseDirOf(courseRef);
  const file = envPath(dir);
  const env = readEnvFile(file);
  if (env.ORALSCALE_SECRET) {
    return { secret: env.ORALSCALE_SECRET, source: path.relative(ROOT, file) };
  }
  let id = courseId;
  if (!id) {
    try { id = JSON.parse(fs.readFileSync(path.join(dir, 'course.json'), 'utf8')).courseId; }
    catch { id = null; }
  }
  if (id) {
    const varName = envVarFor(id);
    if (process.env[varName]) {
      return { secret: process.env[varName], source: `${varName} (environment)` };
    }
  }
  return null;
}

const mint = () => crypto.randomBytes(32).toString('hex');

/** Write (or replace) ORALSCALE_SECRET in the course's own .env. */
function write(courseDir, secret, { replaceFile = false } = {}) {
  const dir = courseDirOf(courseDir);
  const file = envPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  const header = [
    '# OralScale course secrets — NEVER COMMIT THIS FILE.',
    '#',
    '# It lives here, inside the course folder, so the folder is the whole course:',
    '# copy or clone this one directory and everything needed travels with it.',
    '#',
    '# Rotating ORALSCALE_SECRET invalidates every quiz key, every live link and',
    '# every unsubmitted certificate in this course.',
    '',
  ].join('\n');
  /* replaceFile DISCARDS everything else in the file, and that is the point when
   * the Secret clashed: a clash means this .env was copied from another course,
   * so every OTHER line in it was copied too — that course's GenAI key, its
   * settings. Keeping them would leave one course quietly using another's
   * credentials. The caller tells the user exactly what was dropped. */
  let body = (!replaceFile && fs.existsSync(file)) ? fs.readFileSync(file, 'utf8') : header;
  if (/^ORALSCALE_SECRET=/m.test(body)) {
    body = body.replace(/^ORALSCALE_SECRET=.*$/m, `ORALSCALE_SECRET=${secret}`);
  } else {
    if (body && !body.endsWith('\n')) body += '\n';
    body += `ORALSCALE_SECRET=${secret}\n`;
  }
  fs.writeFileSync(file, body, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

/**
 * Every course, whether it has a Secret, and any Secret VALUE used by more than
 * one course.
 *
 * Distinctness is the property no single build can see: two courses can each
 * have their own .env and still hold the same string, which is
 * indistinguishable from borrowing until someone forges across the boundary.
 */
function audit(coursesDir = COURSES) {
  const out = { courses: [], shared: [] };
  const byValue = new Map();
  for (const c of allCourses(coursesDir)) {
    const r = resolve(c.dir, c.courseId);
    out.courses.push({ ...c, rel: path.relative(ROOT, c.coursePath), has: !!r,
      source: r ? r.source : null });
    if (r) {
      if (!byValue.has(r.secret)) byValue.set(r.secret, []);
      byValue.get(r.secret).push(c.courseId);
    }
  }
  for (const [, ids] of byValue) if (ids.length > 1) out.shared.push(ids.sort());
  return out;
}

/**
 * Is this Secret already in use by a DIFFERENT course? Returns the clashing
 * courseIds, or [].
 *
 * Checked before minting and before building, and it includes `_template` and
 * the test fixtures on purpose: the way a Secret gets shared is by someone
 * copying a course folder wholesale, and the skeleton is the folder most likely
 * to be copied.
 */
function clashes(secret, exceptCourseId, coursesDir = COURSES) {
  const hits = [];
  for (const c of allCourses(coursesDir)) {
    if (c.courseId === exceptCourseId) continue;
    const r = resolve(c.dir, c.courseId);
    if (r && r.secret === secret) hits.push(c.courseId);
  }
  return hits;
}

/* Courses that SHIP WITH THE ENGINE. They are not yours to re-key.
 *
 * When a clash is found, the tempting fix is to rotate whichever course the
 * error happens to name — and if that is `_template` or a test fixture, the
 * clash "goes away" while the real problem (a copied .env in the new course)
 * stays, now with the skeleton or the suite quietly re-keyed underneath. The
 * fixtures also back the test suite, so rotating one turns a configuration
 * mistake into a red test run nobody connects to it.
 *
 * Matched by PATH, never by courseId, because a copied folder keeps its id. */
const BUILTIN_PREFIXES = [
  'courses/_template',
  'courses/_testsuite',
  'courses/_shell-for-testsuite',
  'courses/demo',
];

/** Is this course folder one that ships with the engine? */
function isBuiltIn(courseRef) {
  const rel = path.relative(ROOT, courseDirOf(courseRef)).split(path.sep).join('/');
  return BUILTIN_PREFIXES.some((p) => rel === p || rel.startsWith(p + '/'));
}

/** Keys present in a course .env other than the Secret — what a rewrite drops. */
function otherKeys(courseRef) {
  const env = readEnvFile(envPath(courseRef));
  return Object.keys(env).filter((k) => k !== 'ORALSCALE_SECRET');
}

/**
 * Human guidance for a Secret clash, pointing at the course the user should
 * actually change.
 *
 * Never the built-in one. When a new course is started by copying `_template`,
 * the demo or a fixture, the copy brings `.env` with it — so the clash names a
 * shipped course, and rotating THAT would make the error disappear while the
 * real problem stays, with the skeleton or the test suite silently re-keyed.
 */
function clashAdvice(courseRef, courseId, clashIds, coursesDir = COURSES) {
  const mine = isBuiltIn(courseRef);
  const theirs = allCourses(coursesDir).filter((c) => clashIds.includes(c.courseId));
  const builtInHits = theirs.filter((c) => isBuiltIn(c.dir));
  const lines = [];
  if (builtInHits.length && !mine) {
    lines.push(`"${courseId}" is using a Secret that belongs to ${builtInHits.map((c) => c.courseId).join(', ')},`);
    lines.push('which ships with OralScale. Almost certainly this course was started by copying');
    lines.push('that folder, and .env came along with it.');
    lines.push('');
    lines.push('DO NOT re-key the built-in course to clear this. That hides the problem and');
    lines.push('leaves your course signing with a Secret other people also have.');
    lines.push('');
    lines.push(`Fix YOUR course:  node tools/make-config.js --course ${path.relative(ROOT, path.join(courseDirOf(courseRef), 'course.json'))} --force`);
  } else if (mine) {
    lines.push(`"${courseId}" ships with OralScale and shares a Secret with: ${clashIds.join(', ')}.`);
    lines.push('');
    lines.push('Change the OTHER course, not this one. A built-in course is not yours to re-key:');
    lines.push('the fixtures back the test suite, and the template is copied by every future course.');
    for (const c of theirs.filter((x) => !isBuiltIn(x.dir))) {
      lines.push(`   node tools/make-config.js --course ${path.relative(ROOT, c.coursePath)} --force`);
    }
  } else {
    lines.push(`"${courseId}" shares a Secret with: ${clashIds.join(', ')}.`);
    lines.push('Either course can forge the other\'s certificates and mint the other\'s quiz keys.');
    lines.push('');
    lines.push(`Re-key one of them:  node tools/make-config.js --course <course.json> --force`);
  }
  return lines;
}

module.exports = {
  otherKeys, clashAdvice,
  BUILTIN_PREFIXES, isBuiltIn,
  COURSES, courseDirOf, envPath, envVarFor, readEnvFile,
  allCourses, resolve, mint, write, audit, clashes,
};
