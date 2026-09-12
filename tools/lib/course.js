'use strict';
/* Course-folder plumbing shared by every tool that opens a course.json.
 *
 * A course folder is SELF-CONTAINED and is expected to be its own private git
 * repository, cloned into courses/<courseId>/. It must therefore not know that
 * it lives inside OralScale: bank paths in course.json are resolved relative to
 * the course.json itself, not to the engine repo root (INV-COURSE-1).
 *
 * The pre-split layout wrote repo-root-relative paths ("banks/<courseId>/x.json").
 * Those still resolve, so an old course.json keeps working — see resolveBank().
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

/* Absolute path of a bank referenced by an assignment.
 * Order: absolute -> beside the course.json (current) -> engine root (legacy). */
function resolveBank(coursePath, bankRef) {
  if (path.isAbsolute(bankRef)) return bankRef;
  const beside = path.join(path.dirname(coursePath), bankRef);
  if (fs.existsSync(beside)) return beside;
  const legacy = path.join(ROOT, bankRef);
  if (fs.existsSync(legacy)) return legacy;
  return beside;   // report the path we actually want, not the fallback
}

function loadCourse(coursePath) {
  const p = path.resolve(coursePath);
  if (!fs.existsSync(p)) {
    console.error(`No such course.json: ${p}`);
    process.exit(1);
  }
  return { coursePath: p, courseDir: path.dirname(p), course: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

/* ---------------------------------------------------------------------------
 * Backup warning (decision R3).
 *
 * A course folder holds hand-authored questions that are expensive to lose and
 * damaging to leak. Losing a semester of banks to a dead laptop is a real and
 * unrecoverable failure, so the warning REPEATS every run until the instructor
 * either backs the course up or explicitly opts out. It is a nag on purpose.
 *
 * It never blocks and never touches the network — it only reads local git
 * config. Opt out permanently with ORALSCALE_ACK_COURSE_UNBACKED=1.
 * ------------------------------------------------------------------------- */
const ACK_VAR = 'ORALSCALE_ACK_COURSE_UNBACKED';

/* Courses that SHIP WITH THE ENGINE and are therefore backed up by definition.
 * Warning on these would be a false positive on every single run, which is the
 * fastest way to teach someone to ignore the warning that matters. */
const SHIPPED = new Set(['demo', '_template', '_shell-for-testsuite']);

function gitState(dir) {
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0) return { repo: false, remote: null, shared: false };
  const toplevel = top.stdout.trim();
  // A course folder inside the ENGINE's working tree is not backed up as a
  // course: it rides in the engine repo, which is exactly what the split
  // exists to prevent. Treat it as un-repo'd.
  if (path.resolve(toplevel) === path.resolve(ROOT)) return { repo: false, remote: null, shared: true };
  const rem = git('remote', '-v');
  const remote = rem.status === 0 && rem.stdout.trim()
    ? rem.stdout.trim().split('\n')[0].split(/\s+/)[1]
    : null;
  return { repo: true, remote, shared: false };
}

function warnIfUnbacked(courseDir, { courseId = path.basename(courseDir) } = {}) {
  if (process.env[ACK_VAR] === '1') return null;
  if (SHIPPED.has(path.basename(path.resolve(courseDir)))) return null;
  const st = gitState(courseDir);
  if (st.repo && st.remote) return null;

  const why = st.shared
    ? `it is tracked inside the OralScale engine repository, not its own`
    : st.repo
      ? `its git repository has no remote`
      : `it is not a git repository`;

  const lines = [
    '',
    '  ⚠️  This course folder is not backed up.',
    '',
    `      courses/${courseId} — ${why}.`,
    '',
    '      Question banks are expensive to author and damaging to leak. Put this',
    '      folder in its own PRIVATE git repository with a remote:',
    '',
    `        git -C courses/${courseId} init`,
    `        git -C courses/${courseId} add -A && git -C courses/${courseId} commit -m "Initial course content"`,
    `        git -C courses/${courseId} remote add origin git@github.com:<you>/oralscale-${courseId}.git`,
    `        git -C courses/${courseId} push -u origin main`,
    '',
    '      PRIVATE. A public bank is a bank your students have read.',
    '',
    `      To silence this permanently: export ${ACK_VAR}=1`,
    '',
  ];
  console.warn(lines.join('\n'));
  return why;
}

module.exports = { ROOT, ACK_VAR, resolveBank, loadCourse, warnIfUnbacked, gitState };
