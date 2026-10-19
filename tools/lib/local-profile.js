'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PROFILE = 'qwen35-context-off-v1';
const DEFAULT_MODEL = 'qwen3.5-4b';
const MODELS = [DEFAULT_MODEL, 'qwen2.5-3b'];
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function validateAlternative(original, alternate) {
  const grading = new Set(['keyPoints', 'bonusPoints', 'referenceAnswer', 'rubric',
    'commonErrors', 'scoringBands', 'gradingContext', 'evidence']);
  const student = q => Object.fromEntries(Object.entries(q).filter(([k]) => !grading.has(k)));
  const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
  if (original.bankId !== alternate.bankId ||
      JSON.stringify(stable(original.questions.map(student))) !== JSON.stringify(stable(alternate.questions.map(student)))) {
    throw Error('Alternate grading bank must preserve bankId, ordered question IDs, prompts and student selection fields');
  }
}
function alternativePath(coursePath, originalBank, alternateBank) {
  const root = fs.realpathSync(path.dirname(coursePath));
  const candidate = fs.realpathSync(path.resolve(root, alternateBank));
  if (!candidate.startsWith(root + path.sep)) throw Error('Alternate bank must live inside the course folder');
  validateAlternative(JSON.parse(fs.readFileSync(originalBank)), JSON.parse(fs.readFileSync(candidate)));
  return candidate;
}
function manifest(source, assignmentId, model, bankPath) {
  if (!MODELS.includes(model)) throw Error('Unknown local model: ' + model);
  const code = Object.fromEntries(fs.readdirSync(source).filter(n => n.endsWith('.py')).sort()
    .map(n => [n, hash(path.join(source, n))]));
  for (const n of ['setup.sh', 'setup-legacy.sh', 'run_autograder']) code[n] = hash(path.join(source, '..', n));
  return { version:1, assignmentId, model, profile:model === DEFAULT_MODEL ? PROFILE : 'qwen25-legacy-lines-v1',
    runtime:model === DEFAULT_MODEL ? JSON.parse(fs.readFileSync(path.join(source,'runtime-manifest.json'))) : {package:'llama-cpp-python==0.3.35'},
    thinking:false, contextTokens:4096, outputTokens:model === DEFAULT_MODEL ? 900 : 1500,
    courseSha256:hash(path.join(source,'course.json')), bankSha256:hash(bankPath), sources:code };
}
module.exports = { PROFILE, DEFAULT_MODEL, MODELS, validateAlternative, alternativePath, manifest };
