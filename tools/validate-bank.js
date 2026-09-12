#!/usr/bin/env node
'use strict';
/*
 * Validate a frozen question bank: structure, unique ids, required fields, and
 * report the difficulty/kind/principle distribution + a content hash.
 *
 *   node tools/validate-bank.js [path/to/bank.json]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = process.argv[2] || path.join(__dirname, '..', 'bank', 'bank.json');
const raw = fs.readFileSync(file, 'utf8');
const bank = JSON.parse(raw);
const errs = [];
const warns = [];

if (bank.version !== 1) errs.push('version must be 1');
if (!bank.bankId) errs.push('bankId is required');
if (!Array.isArray(bank.questions) || bank.questions.length === 0) errs.push('questions[] required');

const ids = new Set();
const prompts = new Set();
const diff = {};
const kind = {};
let withPrinciple = 0;
let withBonus = 0;
let reqTotal = 0;
(bank.questions || []).forEach((q, i) => {
  const where = `questions[${i}]`;
  if (!q.id) errs.push(`${where}: missing id`);
  else if (ids.has(q.id)) errs.push(`${where}: duplicate id "${q.id}"`);
  else ids.add(q.id);
  if (!q.prompt || q.prompt.length < 15) errs.push(`${where} (${q.id}): prompt too short/missing`);
  else {
    const norm = q.prompt.toLowerCase().replace(/\s+/g, ' ').trim();
    if (prompts.has(norm)) warns.push(`${where} (${q.id}): duplicate prompt text`);
    else prompts.add(norm);
    if (q.prompt.length > 500) warns.push(`${where} (${q.id}): prompt long (${q.prompt.length} chars) — may exceed 2-3 min`);
  }
  /* REQUIRED vs OPTIONAL (INV-GRADE-9).
   *
   * `keyPoints` are the points WITHOUT WHICH THE QUESTION HAS NOT BEEN ANSWERED.
   * `bonusPoints` make an answer stronger and can never cost a mark. The split
   * exists because a first-draft bank reliably lists everything a complete
   * treatment of a topic would mention, and a grader handed that list withholds
   * marks for each thing the student left out — including things the prompt never
   * asked for.
   *
   * FOUR IS THE CEILING, and it follows from a rule the design guide already has:
   * at most two things to explain per question. Two things with two required
   * points each is a full question; a fifth required point means either the
   * question grew a third part, or something optional was filed as required. Both
   * are worth a second look, and neither is an error the tool can be sure of — so
   * it is a warning that names the fix. */
  if (!Array.isArray(q.keyPoints) || q.keyPoints.length === 0) errs.push(`${where} (${q.id}): keyPoints[] required`);
  else if (q.keyPoints.length > 4) {
    warns.push(`${where} (${q.id}): ${q.keyPoints.length} REQUIRED keyPoints — a question asks `
      + `at most two things, so this is usually optional material filed as required. `
      + `Move what merely strengthens an answer into bonusPoints[]`);
  }
  if (q.bonusPoints !== undefined) {
    if (!Array.isArray(q.bonusPoints)) errs.push(`${where} (${q.id}): bonusPoints must be an array`);
    else if (q.bonusPoints.some((b) => typeof b !== 'string' || !b.trim())) {
      errs.push(`${where} (${q.id}): bonusPoints entries must be non-empty strings`);
    } else {
      // A point cannot be both. Whichever list a duplicate is read from, the other
      // reading is wrong, and the grader is told two contradictory things about it.
      const req = new Set((q.keyPoints || []).map((k) => String(k).trim().toLowerCase()));
      const dup = q.bonusPoints.filter((b) => req.has(String(b).trim().toLowerCase()));
      if (dup.length) errs.push(`${where} (${q.id}): point(s) listed as BOTH required and bonus: `
        + dup.map((d) => JSON.stringify(d)).join(', '));
    }
  }
  if (q.difficulty && !['intro', 'core', 'stretch'].includes(q.difficulty))
    errs.push(`${where} (${q.id}): difficulty must be intro|core|stretch`);
  if (q.principle) withPrinciple++; else warns.push(`${where} (${q.id}): missing principle`);

  // Prompts render through the Markdown+LaTeX subset in web/js/richtext.mjs. Raw
  // HTML is shown as literal characters (never parsed — INV-SEC-6), which is safe
  // but almost certainly not what the author meant, so say so at authoring time
  // rather than letting a student meet a prompt full of angle brackets.
  if (/<[a-z!/][^>]*>/i.test(q.prompt || '')) {
    warns.push(`${where} (${q.id}): prompt contains HTML tags — they will display as literal text`);
  }
  const dollars = ((q.prompt || '').match(/(?<!\\)\$/g) || []).length;
  if (dollars % 2 === 1) {
    warns.push(`${where} (${q.id}): odd number of $ — an unclosed math span renders as plain text`);
  }
  // A question is READ ALOUD and answered by speaking. A block of code or a wall
  // of display math usually means it belongs on a written assignment instead.
  if (/```/.test(q.prompt || '')) {
    warns.push(`${where} (${q.id}): fenced code block in a spoken question — consider describing it`);
  }

  /* A RETRIEVAL STEP BEFORE THE REASONING STEP.
   *
   * The design guide's rule is that a prompt must be self-contained: a student who
   * understands the idea but cannot recall a LABEL should not score zero on a
   * question that was never about the label. Two shapes break it in a way a tool
   * can actually recognise, and both were found in a real week-2 bank by an
   * instructor reading the live quiz rather than by anything here:
   *
   *   "A student concludes from Principle 3 that…"   -> which one is Principle 3?
   *   "…an example of one of the preservation criteria. Which is it?"  -> of WHAT?
   *
   * Deliberately narrow. The general case — "the lecture said X, why?" where X is
   * not actually stated — needs a reader, and that is what the review sheet is for.
   * These two are worth catching automatically because they are unambiguous: a
   * number or a bare "one of the …" is a pointer at something the prompt does not
   * contain. Naming the thing inline costs one clause and removes the problem. */
  const numbered = (q.prompt || '').match(/\bPrinciple\s+\d+\b/);
  if (numbered) {
    warns.push(`${where} (${q.id}): refers to "${numbered[0]}" by number — a student who knows the `
      + `idea but not its number has to retrieve before they can reason. State the principle inline`);
  }
  const unlisted = (q.prompt || '')
    .match(/\bone of the (?!following|two|three)([a-z]+(?: [a-z]+){0,2})\b/i);
  /* Only when nothing in the prompt looks like it enumerates the set. A colon, an
   * em dash, an "or", or a comma-separated list of two or more items all mean the
   * candidates are right there — "Three candidates are X, Y, and Z … what would go
   * wrong with one of the others?" points backwards at something the student can
   * see, which is the shape this rule WANTS rather than the one it is catching. */
  const enumerated = /[:—]|\bor\b/.test(q.prompt || '')
    || ((q.prompt || '').match(/,/g) || []).length >= 2;
  if (unlisted && !enumerated) {
    warns.push(`${where} (${q.id}): points at "one of the ${unlisted[1]}" without listing them — `
      + `name the candidates in the prompt, or the student must recall the set before answering`);
  }
  if (Array.isArray(q.keyPoints)) reqTotal += q.keyPoints.length;
  if (Array.isArray(q.bonusPoints) && q.bonusPoints.length) withBonus++;
  diff[q.difficulty || 'unset'] = (diff[q.difficulty || 'unset'] || 0) + 1;
  kind[q.kind || 'unset'] = (kind[q.kind || 'unset'] || 0) + 1;
});

if (errs.length) {
  console.error(`INVALID: ${file}`);
  errs.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}

const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
const n = bank.questions.length;
console.log(`VALID: ${file}`);
console.log(`  bankId:     ${bank.bankId}`);
console.log(`  questions:  ${n}`);
console.log(`  principle:  ${withPrinciple}/${n}`);
console.log(`  required:   ${(reqTotal / n).toFixed(1)} keyPoints per question (mean); `
  + `${withBonus}/${n} also carry bonusPoints`);
console.log(`  difficulty: ${Object.entries(diff).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  kind:       ${Object.entries(kind).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  sha256:     ${hash}`);
if (warns.length) console.log(`  warnings:   ${warns.length} (${warns.slice(0, 2).join('; ')}${warns.length > 2 ? '; …' : ''})`);
