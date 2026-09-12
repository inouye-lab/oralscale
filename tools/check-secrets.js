#!/usr/bin/env node
'use strict';
/*
 * Refuse to let a credential or student record into git.
 *
 *   node tools/check-secrets.js            check what is STAGED (the commit hook)
 *   node tools/check-secrets.js --all      check every tracked file (CI)
 *   node tools/check-secrets.js --install  install the pre-commit hook
 *
 * WHY A CHECK AND NOT JUST .gitignore
 * .gitignore is advice, and it is advice that loses. `git add -f`, a file added
 * before the rule existed, a path the rule does not quite match, a TA who copies
 * a roster to a working name — every one of those slips past. This runs on the
 * staged content itself and blocks the commit, which is the last moment the
 * mistake is still cheap. Once a Secret is pushed it is not "unpushed": it is
 * rotated, and every quiz key, live link and unsubmitted certificate dies with it.
 *
 * DELIBERATELY NOISY AND HARD TO SILENCE. There is no per-file opt-out flag.
 * Bypassing it is `git commit --no-verify`, which is a thing you have to type on
 * purpose and can be seen doing.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });

/* ---- what must never be committed --------------------------------------- */
const FORBIDDEN_PATHS = [
  // secrets/ is gone — Secrets live in courses/<id>/.env now. Kept as a rule so
  // an old checkout, or a habit, cannot quietly re-create it.
  [/(^|\/)secrets\//, 'anything under secrets/ (Secrets belong in courses/<id>/.env)'],
  [/(^|\/)\.env$/, 'a .env file'],
  // `.env.example` is a committed template with no values in it — the one
  // .env-shaped file that is supposed to be in the repo.
  [/(^|\/)\.env\.(?!example$)/, 'a .env variant'],
  [/(^|\/)accommodations\.json$/, 'an accommodation roster (who holds a disability accommodation)'],
  [/(^|\/)(autograders|dist)\//, 'a built autograder (contains the signing Secret in plaintext)'],
  [/secret\.env$/, 'an autograder secret.env'],
  [/(^|\/)server\/config\.json$/, 'the Signer config (contains the signing Secret)'],
  [/\.keys\.csv$/, 'a minted quiz-key file (emails paired with credentials)'],
  [/brightspace-import\.csv$/, 'a key distribution file'],
  [/accommodations\.json$/, 'a DRC accommodation roster'],
  [/(^|\/)roster[^/]*\.(csv|txt|xlsx)$/i, 'a class roster'],
  [/bundle\.json$/, 'a built Worker bundle (contains the question bank)'],
];

/* Content patterns, for a file whose NAME looks innocent. */
// [ \t]* rather than \s*: \s crosses newlines, so `KEY=` on one line matched
// whatever happened to follow on the next and flagged three innocent files.
const FORBIDDEN_CONTENT = [
  [/\bORALSCALE_SECRET[ \t]*=[ \t]*[0-9a-f]{32,}/i, 'a signing Secret'],
  [/"secret"[ \t]*:[ \t]*"[0-9a-f]{32,}"/i, 'a signing Secret'],
  [/\bGENAI_STUDIO_API_KEY[ \t]*=[ \t]*[^\s$"'{][^\s"']{11,}/i, 'a Purdue GenAI API key'],
  [/\bsk-[A-Za-z0-9]{24,}/, 'an API key (sk-… form)'],
  [/\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/, 'something shaped like a quiz key'],
];

/* Files that legitimately DESCRIBE these things without containing one. The
 * allowance is by path, never by pattern: a doc may say ORALSCALE_SECRET=, and
 * an example file may show a placeholder, but neither may carry a real value —
 * the placeholder check below still applies to them. */
const DOC_PATHS = [
  /^docs\//, /^models\//, /\.md$/, /\.example$/,
  /^tools\/check-secrets\.js$/, /^tools\/lib\/secrets\.js$/, /^\.github\//,
];
const isDoc = (f) => DOC_PATHS.some((re) => re.test(f));

/* A value that is obviously a placeholder is fine anywhere. */
// A shell expansion (${VAR}), an empty value, or an obvious stand-in is not a
// secret. Everything else with the shape of one is treated as the real thing.
const PLACEHOLDER =
  /(your|example|placeholder|redacted|xxxx|<[^>]+>|\.\.\.|abcd-efgh|\$\{|\$[A-Z_]+)/i;

// A real credential is [A-Za-z0-9_-]. Anything carrying regex or shell
// metacharacters is a PATTERN that mentions a credential — build.sh greps for
// its own placeholder, for instance — not a credential.
const IS_PATTERN = /[\\()?^*\[\]|]/;

function stagedFiles() {
  const r = git('diff', '--cached', '--name-only', '--diff-filter=ACMR');
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}
function trackedFiles() {
  return (git('ls-files').stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}
function contentOf(file, staged) {
  if (staged) {
    const r = git('show', `:${file}`);
    return r.status === 0 ? r.stdout : '';
  }
  const p = path.join(ROOT, file);
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function install() {
  const hooksDir = (git('rev-parse', '--git-path', 'hooks').stdout || '').trim();
  const dir = path.isAbsolute(hooksDir) ? hooksDir : path.join(ROOT, hooksDir);
  fs.mkdirSync(dir, { recursive: true });
  const hook = path.join(dir, 'pre-commit');
  fs.writeFileSync(hook,
    '#!/bin/sh\n'
    + '# Installed by tools/check-secrets.js --install\n'
    + '# Blocks credentials and student records from entering git.\n'
    + 'ROOT="$(git rev-parse --show-toplevel)"\n'
    + 'node "$ROOT/tools/check-secrets.js" || exit 1\n'
    + 'node "$ROOT/tools/check-course-safety.js" || exit 1\n');
  fs.chmodSync(hook, 0o755);
  console.log(`Installed pre-commit guard -> ${path.relative(ROOT, hook)}`);
  console.log('Every commit is now checked. Bypassing it takes `git commit --no-verify`.');
  console.log('\nEach person who clones this repo has to run `npm run guard:install` once —');
  console.log('git does not ship hooks with a repository, by design.');
}

function main() {
  if (process.argv.includes('--install')) return install();
  const all = process.argv.includes('--all');
  const files = all ? trackedFiles() : stagedFiles();
  const findings = [];

  for (const f of files) {
    for (const [re, what] of FORBIDDEN_PATHS) {
      if (re.test(f)) findings.push({ f, what, how: 'path' });
    }
    if (isDoc(f)) {
      // Documentation may name these things; it may not contain a live one.
      const text = contentOf(f, !all);
      for (const [re, what] of FORBIDDEN_CONTENT) {
        const m = text.match(re);
        if (m && !PLACEHOLDER.test(m[0]) && !IS_PATTERN.test(m[0])) findings.push({ f, what, how: 'content', hint: m[0].slice(0, 12) + '…' });
      }
      continue;
    }
    const text = contentOf(f, !all);
    if (!text || /\0/.test(text.slice(0, 1024))) continue;      // binary
    for (const [re, what] of FORBIDDEN_CONTENT) {
      const m = text.match(re);
      if (m && !PLACEHOLDER.test(m[0]) && !IS_PATTERN.test(m[0])) findings.push({ f, what, how: 'content', hint: m[0].slice(0, 12) + '…' });
    }
  }

  if (!findings.length) {
    if (all) console.log(`✅ ${files.length} tracked file(s) checked — no credentials or student records.`);
    return;
  }

  console.error('\n\x1b[31m╔══════════════════════════════════════════════════════════════════╗');
  console.error('║  COMMIT BLOCKED — this would put a credential or student data    ║');
  console.error('║  into git history.                                               ║');
  console.error('╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n');
  const seen = new Set();
  for (const x of findings) {
    const k = `${x.f}:${x.what}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.error(`  ${x.f}`);
    console.error(`      ${x.how === 'path' ? 'is' : 'contains'} ${x.what}${x.hint ? ` (${x.hint})` : ''}`);
  }
  console.error('\n  What to do:');
  console.error('    git restore --staged <file>        take it back out of the commit');
  console.error('    mv <file> courses/<id>/            keep it, where it belongs');
  console.error('\n  Once a Secret is PUSHED it cannot be unpushed. It has to be rotated, and');
  console.error('  that invalidates every quiz key, every live link, and every unsubmitted');
  console.error('  certificate in the course. Blocking it here is the cheap moment.');
  console.error('\n  Every course secret, key export and built autograder belongs INSIDE that');
  console.error('  course\'s folder and is never committed. See courses/GOVERNANCE.md.\n');
  process.exit(1);
}

main();
