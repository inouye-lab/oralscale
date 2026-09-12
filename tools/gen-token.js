#!/usr/bin/env node
'use strict';
/*
 * Generate a class-wide ASSIGNMENT TOKEN that students paste into the web app.
 * Distribute it via Gradescope/Brightspace (it is not secret — it is signed, so
 * it cannot be forged, but anyone with it can attempt the assignment).
 *
 * Usage:
 *   node tools/gen-token.js --assignment hw3-oral --limit 180 --days 14 [--nonce-words 3]
 *
 * Reads the secret + bankId the same way the Signer does (server/config.json or
 * ORALSCALE_SECRET, and bank/bank.json).
 */
const fs = require('fs');
const path = require('path');
const P = require('../server/lib/protocol');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function loadSecret() {
  if (process.env.ORALSCALE_SECRET) return process.env.ORALSCALE_SECRET;
  const cfgPath = path.join(__dirname, '..', 'server', 'config.json');
  if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).secret;
  console.error('No secret found. Run: node tools/make-config.js  (or set ORALSCALE_SECRET)');
  process.exit(1);
}

const bank = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bank', 'bank.json'), 'utf8'));
const secret = loadSecret();

const assignmentId = arg('assignment', 'oral-1');
const limitSec = Number(arg('limit', '180'));
const days = Number(arg('days', '14'));
const nonceWords = Number(arg('nonce-words', '3'));
const expiresAt = Math.floor(Date.now() / 1000) + days * 86400;

const token = P.signToken(secret, {
  v: 1, kind: 'assignment',
  bankId: bank.bankId,
  assignmentId,
  limitSec,
  nonceWords,
  expiresAt,
});

console.log('\nAssignment token (paste this value into the web app / distribute via Gradescope):\n');
console.log(token);
console.log('\nDetails:');
console.log(`  bankId       ${bank.bankId}`);
console.log(`  assignmentId ${assignmentId}`);
console.log(`  limitSec     ${limitSec}`);
console.log(`  nonceWords   ${nonceWords}`);
console.log(`  expiresAt    ${new Date(expiresAt * 1000).toISOString()}`);
