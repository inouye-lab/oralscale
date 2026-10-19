#!/usr/bin/env node
'use strict';
/*
 * Bundle a course's config + its banks into server/worker/bundle.json so the
 * Cloudflare Worker is self-contained (Workers can't read the filesystem).
 *
 *   node tools/build-worker.js [courses/<id>/course.json]
 */
const fs = require('fs');
const path = require('path');
const { resolveBank } = require('./lib/course.js');

const ROOT = path.join(__dirname, '..');
/* `--out <path>` writes somewhere OTHER than the deploy artifact.
 *
 * server/worker/bundle.json is what `wrangler deploy` uploads, and it is a single
 * shared file: whichever course was built last wins. A test that rebuilt it for a
 * fixture course left the next deploy pointing at that fixture — which is not a
 * hypothetical. On 2026-09-08 a pilot course's Worker was deployed carrying the
 * testsuite bundle, and the live Quiz 1 answered ASSIGNMENT_GONE to every student
 * until it was rebuilt and redeployed. The test file carried a comment warning
 * about exactly that ordering, which is precisely the point: a warning is not a
 * control. Tests now build to a temp path and never touch the deploy artifact. */
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx > 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : null;
const coursePath = process.argv.slice(2).filter((a, i, all) =>
  !a.startsWith('--') && all[i - 1] !== '--out')[0]
  || path.join(ROOT, 'courses', 'demo', 'course.json');
const course = JSON.parse(fs.readFileSync(coursePath, 'utf8'));

/* ---------------------------------------------------------------------------
 * WHAT THE SIGNER IS ALLOWED TO SEE (INV-PRIV-7).
 *
 * A Bank question carries its own answer key: `rubric`, `keyPoints`,
 * `bonusPoints`, `referenceAnswer`, `scoringBands`, `commonErrors` and the
 * `evidence` quotes that say which slide it came from. The Signer needs NONE of
 * it. It hands a student a prompt; nothing is graded at quiz time, and the
 * grading data reaches the grader by a different road entirely (the autograder
 * zip, which never leaves Gradescope).
 *
 * So the bundle is built by ALLOW-LIST rather than by deletion: a field that is
 * not named here does not reach Cloudflare, and a field added to the bank schema
 * later is withheld by default instead of leaking by default.
 *
 * This is not a hypothetical. Until 2026-09-08 `bundle.json` was the whole bank,
 * so every reference answer and every scoring band for the term sat inside a
 * deployed Worker — one misconfigured route, one `wrangler tail`, one person with
 * dashboard access, and the week's answer key is out. Nothing was serving it, but
 * nothing had to: it was there.
 *
 * `difficulty` stays IN THE BUNDLE because `difficultyMix` selects on it when the
 * Signer picks an attempt's questions. That is a server-side use only: neither
 * Signer puts it on the wire unless the assignment opted into the meta line, since
 * a lone "CORE" above the prompt is the same kind of hint as the rest of it.
 * `topic` and `principle` are META — see below.
 * ------------------------------------------------------------------------- */
const SERVE_ALWAYS = ['id', 'difficulty', 'prompt'];

/* THE META LINE (INV-COURSE-5): `topic` and `principle` are the small blue line
 * the app used to print above every prompt. They are withheld unless the
 * assignment asks for them, because `principle` states the durable idea the
 * question is testing — which is a large part of the answer, printed above the
 * question. Default OFF: an assignment that says nothing gets nothing.
 *
 * A course sets it true only for a quiz that was already live when this
 * changed, and a student taking it late must see the same
 * screen as one who took it on time. */
const SERVE_META = ['topic', 'principle'];

const showMeta = (a) => !!(a.showQuestionMeta != null
  ? a.showQuestionMeta : (course.defaults || {}).showQuestionMeta);

function servedQuestion(q, meta) {
  const out = {};
  for (const f of SERVE_ALWAYS) if (q[f] !== undefined) out[f] = q[f];
  if (meta) for (const f of SERVE_META) if (q[f] !== undefined) out[f] = q[f];
  return out;
}

const P = require('../server/lib/protocol');

const banks = {};
const metaOn = [];
for (const [assignmentId, a] of Object.entries(course.assignments || {})) {
  const bankPath = resolveBank(coursePath, a.bank);
  const bankRaw = fs.readFileSync(bankPath);
  const bank = JSON.parse(bankRaw.toString('utf8'));
  const meta = showMeta(a);
  if (meta) metaOn.push(assignmentId);
  banks[assignmentId] = {
    bankId: bank.bankId,
    title: bank.title,
    revision: bank.revision,
    /* A digest of the WHOLE bank file — answers, rubrics, evidence and all
     * (INV-DEPLOY-7). It never goes on the wire: /health publishes a KEYED tag
     * derived from it, because a plain digest would let anyone holding a leaked
     * bank confirm it is genuine. Its job is to make "which questions is the
     * Worker actually serving?" a question with an answer, which it was not
     * before: a bank can be revised while its bankId and its question ids stay
     * put, and a Worker and a Gradescope zip built from different revisions
     * mis-grade silently rather than failing. */
    bankDigest: P.bankDigest(bankRaw),
    questions: (bank.questions || []).map((q) => servedQuestion(q, meta)),
  };
}

const out = outPath || path.join(ROOT, 'server', 'worker', 'bundle.json');
fs.writeFileSync(out, JSON.stringify({ course, banks }, null, 0) + '\n');
const nq = Object.values(banks).reduce((s, b) => s + b.questions.length, 0);
console.log(`Wrote ${out} — course "${course.courseId}", ${Object.keys(banks).length} assignment(s), ${nq} questions total.`);
console.log(`  Prompts only: rubrics, key points, reference answers, scoring bands and evidence`);
console.log(`  stay out of the bundle (INV-PRIV-7).`);
console.log(metaOn.length
  ? `  topic/principle line SHOWN for: ${metaOn.join(', ')} (showQuestionMeta)`
  : `  topic/principle line shown for no assignment (INV-COURSE-5).`);
console.log('Now: cd server/worker && npx wrangler deploy');
