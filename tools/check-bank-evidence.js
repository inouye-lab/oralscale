#!/usr/bin/env node
/**
 * Verify that every `evidence` quote in a bank actually appears in the source
 * material the bank names.
 *
 * WHY THIS EXISTS
 * ---------------
 * `evidence` is the answer to the only question that matters about a graded
 * question in a course whose policy is "anything said in lecture is fair game":
 * was this actually taught? An unchecked quote is worth nothing — the failure
 * mode is not fabrication, it is DRIFT. An author reading a speech-to-text
 * transcript naturally tidies it: drops the stumble, joins two sentences the
 * ASR split, silently repairs a garbled word. Every one of those edits makes
 * the quote read better and makes it a worse record of what was said, and none
 * of them look wrong on the page. The first pass over a real week-1 bank
 * had 15 such fragments out of 182, all of them well-intentioned.
 *
 * Matching is normalised — case, punctuation, smart quotes, whitespace and
 * markdown emphasis are ignored — because the point is whether the WORDS were
 * said, not whether the author reproduced the transcript's comma. Elisions are
 * written as `...` and each side is checked separately, so a quote may skip
 * material but may not invent any.
 *
 *   node tools/check-bank-evidence.js <bank.json> --root <source-repo-dir>
 *
 * Exits non-zero if any fragment cannot be found, naming the question and the
 * word at which the quote stops matching, which is where the tidying happened.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const bankPath = args.find(a => !a.startsWith('--'));
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? args[rootIdx + 1] : '';
if (!bankPath || !root) {
  console.error('usage: node tools/check-bank-evidence.js <bank.json> --root <source-repo-dir>');
  process.exit(2);
}

const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
const sources = bank.sources || [];
if (!sources.length) {
  console.error(`${bankPath}: no "sources" array — cannot check evidence against anything.`);
  process.exit(2);
}

// A source entry may name a companion file in parentheses, e.g.
// "lectures/frozen/.../delivered.qmd (+ transcripts/.../lecture.md)". Read every
// path-looking token in the entry, so the note stays human-readable.
const files = [];
for (const entry of sources) {
  for (const tok of entry.split(/[\s()+,]+/)) {
    if (!/[\/.]/.test(tok) || !/\.(qmd|md|txt|json|srt)$/.test(tok)) continue;
    const p = path.resolve(root, tok.replace(/^\.\.\./, ''));
    if (fs.existsSync(p)) files.push(p);
  }
}
if (!files.length) {
  console.error(`${bankPath}: none of the paths in "sources" exist under ${root}`);
  process.exit(2);
}

const norm = (t) => t
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[^a-z0-9]+/gi, ' ').toLowerCase().trim();

const blob = norm(files.map(f => fs.readFileSync(f, 'utf8')).join('\n'));

let checked = 0;
const misses = [];
for (const q of bank.questions || []) {
  for (const e of q.evidence || []) {
    checked++;
    for (const frag of String(e.quote || '').split('...')) {
      // Very short fragments are connective tissue, not claims about the source.
      if (frag.trim().length <= 25) continue;
      const n = norm(frag);
      if (blob.includes(n)) continue;
      const w = n.split(' ');
      let ok = 0;
      for (let k = w.length; k > 3; k--) {
        if (blob.includes(w.slice(0, k).join(' '))) { ok = k; break; }
      }
      misses.push({ id: q.id, source: e.source, ok, total: w.length,
                    at: w.slice(Math.max(0, ok - 4), ok + 5).join(' ') });
    }
  }
}

console.log(`${path.basename(bankPath)}: ${checked} evidence entries against ${files.length} source file(s)`);
if (!misses.length) {
  console.log('✅ every quote appears verbatim in the sources');
  process.exit(0);
}
console.log(`❌ ${misses.length} fragment(s) not found:\n`);
for (const m of misses) {
  console.log(`  ${m.id}  (${m.source})`);
  console.log(`    matches ${m.ok}/${m.total} words, then diverges near: …${m.at}…\n`);
}
process.exit(1);
