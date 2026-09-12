#!/usr/bin/env node
'use strict';
/* Validate every bank under banks/<courseId>/ and print a summary table.
 *   node tools/validate-all-banks.js [banks/<courseId>]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
/* Accepts a banks/ directory, or a course folder (in which case banks/ inside it).
 * Defaults to the DEMO course: the engine repo ships no private course content, so
 * this must not depend on a bank that lives in someone's private course repo. */
let dir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'courses', 'demo', 'banks');
if (fs.existsSync(path.join(dir, 'banks'))) dir = path.join(dir, 'banks');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

let ok = 0, total = 0, questions = 0;
const rows = [];
for (const f of files) {
  const p = path.join(dir, f);
  const r = spawnSync('node', [path.join(__dirname, 'validate-bank.js'), p], { encoding: 'utf8' });
  total++;
  const valid = r.status === 0;
  if (valid) ok++;
  const nMatch = r.stdout.match(/questions:\s+(\d+)/);
  const n = nMatch ? Number(nMatch[1]) : 0;
  questions += n;
  const diffMatch = r.stdout.match(/difficulty: (.*)/);
  rows.push(`  ${valid ? '✅' : '❌'} ${f.padEnd(42)} ${String(n).padStart(3)} q  ${valid ? (diffMatch ? diffMatch[1] : '') : r.stderr.trim().split('\n')[0]}`);
}
console.log(`Banks in ${path.relative(ROOT, dir)}:\n`);
rows.forEach((x) => console.log(x));
console.log(`\n${ok}/${total} valid · ${questions} questions total`);
process.exit(ok === total ? 0 : 1);
