#!/usr/bin/env node
/* List the models Purdue GenAI Studio offers, and say whether the one a course
 * grades with is among them (INV-DEPLOY-8).
 *
 *   node tools/genai-models.js --course courses/<id>/course.json
 *   node tools/genai-models.js --course courses/<id>/course.json --model qwen3.8:27b
 *
 * Why this exists. Purdue replaces a model IN PLACE (qwen3.6:27b -> qwen3.8:27b on
 * 2026-09-23) and the model ID is baked into every autograder zip at build time.
 * The day the old ID disappears, every submission to every zip built against it
 * fails. This tool is how you find the ID to switch to; the build calls it too,
 * and refuses to package against a model the service does not list.
 *
 * Credentials resolve exactly as the build resolves them: exported env, then the
 * course's .env, then the engine's .env. The key is sent only to the course's own
 * GENAI_STUDIO_BASE_URL, and is never printed.
 *
 * Exit: 0 the model is offered · 3 the service answered and does NOT offer it ·
 *       2 could not ask (unreachable, bad key, no credentials) · 1 usage.
 * --json prints one object instead of prose; the build reads that.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SECRETS = require('./lib/secrets.js');

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const asJson = argv.includes('--json');
const coursePath = val('--course');
if (!coursePath || argv.includes('--help')) {
  console.error('usage: node tools/genai-models.js --course courses/<id>/course.json [--model <id>] [--json]');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const courseDir = path.dirname(path.resolve(coursePath));
const COURSE_ENV = SECRETS.readEnvFile(SECRETS.envPath(courseDir));
const ENGINE_ENV = SECRETS.readEnvFile(path.join(ROOT, '.env'));
const cfgVar = (k) => process.env[k] || COURSE_ENV[k] || ENGINE_ENV[k] || '';

const base = cfgVar('GENAI_STUDIO_BASE_URL');
const key = cfgVar('GENAI_STUDIO_API_KEY');
const model = val('--model') || cfgVar('GENAI_STUDIO_MODEL');
const timeoutMs = Number(process.env.ORALSCALE_GENAI_MODELS_TIMEOUT_MS || 15000);

/* Same family, nearest first: "qwen3.6:27b" is replaced by something that starts
 * "qwen" and very likely keeps ":27b". Only a hint; the instructor picks. */
function nearest(want, ids) {
  const fam = (String(want).match(/^[a-z]+/i) || [''])[0].toLowerCase();
  const tag = (String(want).match(/:[^:]+$/) || [''])[0].toLowerCase();
  if (!fam) return [];
  return ids.filter((id) => id.toLowerCase().startsWith(fam))
    .sort((a, b) => (b.toLowerCase().endsWith(tag) - a.toLowerCase().endsWith(tag)) || a.localeCompare(b));
}

function done(code, o, prose) {
  if (asJson) process.stdout.write(JSON.stringify({ code, model, ...o }) + '\n');
  else console[code === 0 ? 'log' : 'error'](prose);
  process.exit(code);
}

(async () => {
  if (!base || !key) {
    return done(2, { error: 'no credentials' },
      'No GENAI_STUDIO_BASE_URL / GENAI_STUDIO_API_KEY for this course (exported, course .env, or engine .env).');
  }
  const url = base.replace(/\/+$/, '') + '/api/models';
  let ids;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    ids = (Array.isArray(j) ? j : j.data || []).map((m) => (m && (m.id || m.name)) || '').filter(Boolean);
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : (e.message || String(e));
    return done(2, { error: why },
      `Could not list models at ${url}: ${why}.\nCheck https://www.rcac.purdue.edu/news/outages-and-maintenance for a GenAI Studio outage.`);
  }
  const offered = !!model && ids.includes(model);
  const near = offered ? [] : nearest(model, ids);
  const list = ids.map((id) => `  ${id === model ? '*' : ' '} ${id}`).join('\n');
  if (!model) return done(3, { offered: false, models: ids, nearest: [] },
    `No GENAI_STUDIO_MODEL is set for this course. Offered:\n${list}`);
  if (offered) return done(0, { offered: true, models: ids, nearest: [] },
    `'${model}' is offered (marked *).\n${list}`);
  return done(3, { offered: false, models: ids, nearest: near },
    `'${model}' is NOT offered by ${base}.\n`
    + (near.length ? `Closest by name: ${near.slice(0, 3).join(', ')}\n` : '')
    + `Offered:\n${list}\n\n`
    + `To switch: set GENAI_STUDIO_MODEL=<id> in ${path.relative(process.cwd(), SECRETS.envPath(courseDir))}, `
    + 'rebuild, upload the new zip to Gradescope and regrade. A different model can mark differently, so '
    + 'check it on a few known answers first (tools/eval).');
})();
