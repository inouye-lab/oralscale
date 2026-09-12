#!/usr/bin/env node
/**
 * Package the metadata probe as a Gradescope autograder zip.
 *
 * A throwaway diagnostic: upload it to a scratch assignment, submit any file,
 * and read the output. It answers a question the documentation does not — which
 * of a per-student due date, a late due date, and a DRC accommodation actually
 * reach an autograder — by printing everything Gradescope hands over.
 *
 *   node tools/make-metadata-probe.js
 *   → dist/oralscale-metadata-probe.zip
 *
 * Carries no secret, no bank and no course config, so it is safe to hand to
 * anyone. It scores 0 out of 0 and grades nothing.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'tools', 'metadata-probe');
const OUTDIR = path.join(ROOT, 'dist');
const OUT = path.join(OUTDIR, 'oralscale-metadata-probe.zip');

fs.mkdirSync(OUTDIR, { recursive: true });
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

// Zip root must hold setup.sh, run_autograder and probe.py — Gradescope extracts
// into /autograder/source/ and run_autograder locates its sibling either way.
const r = spawnSync('zip', ['-j', OUT, path.join(SRC, 'setup.sh'),
  path.join(SRC, 'run_autograder'), path.join(SRC, 'probe.py')],
  { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(1);
}

console.log(`Built ${path.relative(ROOT, OUT)}  (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
console.log(`
In Gradescope, on a THROWAWAY assignment:
  1. Programming Assignment → Configure Autograder → upload this zip.
  2. Container: the default is fine. Timeout: the default is fine.
  3. Point value 0.
  4. Submit any file at all.

Then set the things you want to learn about — a due date, a late due date, an
extension for one student, a DRC accommodation — and submit again as that
student. Test ① lists every date-shaped field and how far the submission sits
from each, so a field that moved is the field that carries what you changed.

It echoes the submitter's own name and email back to them. Fine for your own
testing; delete the assignment before a class can see it.`);
