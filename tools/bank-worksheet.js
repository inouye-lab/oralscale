#!/usr/bin/env node
/**
 * Render a draft bank as an offline INSTRUCTOR FEEDBACK WORKSHEET.
 *
 *   node tools/bank-worksheet.js <bank.json> [-o out.html] [--title "Quiz 5"] [--prepared "date"]
 *
 * WHY: `bank-review-sheet.js` is for READING a bank. This is for REVIEWING one, question by
 * question, and handing the verdicts back. The conventions come from the pilot course's
 * reviews and are deliberate:
 *
 *  - SHUFFLED ORDER, fixed per revision. Banks are authored in topic blocks, so five
 *    questions on one idea arrive in a row and the fifth is read with the first four in
 *    mind. The order is seeded by the bank's SHA-256: the same on every reload and every
 *    rebuild of one revision, different after any edit. It is display-only (CSS order);
 *    the bank's authored order is untouched, and an Order control switches back to it.
 *  - THE ID IS ALWAYS VISIBLE, on a phone too, and is a link to that question, so feedback
 *    can be written as "q5-042: …" without hunting.
 *  - Keep / Revise / Remove plus a note per question, saved in browser storage when it is
 *    available, exportable as JSON (tied to the bank hash, so notes on an older revision
 *    are never silently applied to changed prompts) and copyable as plain text for
 *    pasting back to whoever is revising the bank.
 *  - Prompts are rendered THROUGH THE STUDENT APP'S OWN PARSER (web/js/richtext.mjs), as in
 *    bank-review-sheet.js, so the reviewer sees the notation the student will see.
 *
 * The output contains prompts AND answer keys, so it is assessment content: it stays in the
 * private course folder (`*-review.html` is gitignored there) and is never published.
 * Everything is embedded; the page makes no network requests.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseRich, HTML_TAGS, MATHML_TAGS } = require('../web/js/richtext.mjs');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const bankPath = args.find((a, i) => !a.startsWith('-') && !['-o', '--title', '--prepared'].includes(args[i - 1]));
if (!bankPath) {
  console.error('usage: node tools/bank-worksheet.js <bank.json> [-o out.html] [--title "Quiz N"] [--prepared "date"]');
  process.exit(2);
}
const raw = fs.readFileSync(bankPath);
const bank = JSON.parse(raw);
const sha = crypto.createHash('sha256').update(raw).digest('hex');
const out = opt('-o', path.join(path.dirname(bankPath), path.basename(bankPath, '.json') + '-review.html'));
const label = opt('--title', bank.title || bank.bankId || 'Question bank');
const prepared = opt('--prepared', new Date().toISOString().slice(0, 10));

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Same serialisation as bank-review-sheet.js: tags only from the parser's whitelists,
// fixed attributes, all text escaped (INV-SEC-6).
const specToHtml = (spec) => {
  if (!spec) return '';
  if (spec.t === 'text') return esc(spec.text || '');
  const tag = spec.t;
  if (!HTML_TAGS.includes(tag) && !MATHML_TAGS.includes(tag)) return '';
  let attrs = '';
  if (tag === 'math') {
    attrs += ' xmlns="http://www.w3.org/1998/Math/MathML"';
    if (spec.display) attrs += ' display="block"';
  }
  if (tag === 'mover' && spec.accent) attrs += ' accent="true"';
  if (tag === 'mspace' && spec.width) {
    attrs += ` width="${/^[0-9.]+em$/.test(spec.width) ? spec.width : '0.25em'}"`;
  }
  if (spec.cls === 'math-raw') attrs += ' class="math-raw"';
  if (tag === 'br') return '<br>';
  const inner = spec.text != null ? esc(spec.text) : (spec.children || []).map(specToHtml).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
};
const rich = (s) => {
  const blocks = parseRich(String(s || ''));
  if (blocks.length === 1 && blocks[0].t === 'p') return (blocks[0].children || []).map(specToHtml).join('');
  return blocks.map(specToHtml).join('');
};

// Deterministic shuffle seeded by the bank hash (mulberry32 + Fisher–Yates).
let seed = parseInt(sha.slice(0, 8), 16) >>> 0;
const rand = () => {
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const qs = bank.questions || [];
const order = qs.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const shuffledPos = new Array(qs.length);
order.forEach((bankIdx, pos) => { shuffledPos[bankIdx] = pos; });

const scoring = (bank.gradingProfile && bank.gradingProfile.scoring) || {};
const rw = scoring.requiredWeight || 2;
const ow = scoring.optionalWeight || 1;
const count = (xs) => xs.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});
const diffs = count(qs.map(q => q.difficulty));
const topics = [...new Set(qs.map(q => q.topic))];
const kinds = [...new Set(qs.map(q => q.kind))].sort();
const meetings = [...new Set(qs.map(q => q.review && q.review.sourceMeeting).filter(Boolean))].sort();
const topicCounts = count(qs.map(q => q.topic));
const nCore = qs.length ? (qs[0].keyPoints || []).length : 0;
const nOpt = qs.length ? (qs[0].bonusPoints || []).length : 0;
const list = (xs) => '<ul>' + (xs || []).map(x => `<li>${esc(x)}</li>`).join('') + '</ul>';

const criteria = (q) => {
  const pd = (q.gradingContext && q.gradingContext.pointDecisions) || [];
  const rows = pd.length ? pd : [
    ...(q.keyPoints || []).map((m, i) => ({ id: 'R' + (i + 1), meaning: m })),
    ...(q.bonusPoints || []).map((m, i) => ({ id: 'O' + (i + 1), meaning: m })),
  ];
  return rows.map(p => `<tr><th scope="row">${esc(p.id)}</th><td>${p.id.startsWith('R') ? rw : ow}</td><td>${esc(p.meaning)}` +
    (p.sufficientExample ? `<div class="said">Sounds like: “${esc(p.sufficientExample)}”</div>` : '') + '</td></tr>').join('');
};

const cards = qs.map((q, i) => {
  const ev = (q.evidence || []).map(e => `<figure><figcaption>${esc(String(e.source || '').split('/').pop())}` +
    (e.line ? `, line ${e.line}` : '') + (e.section ? ` · ${esc(e.section)}` : '') +
    `</figcaption><blockquote>${esc(e.quote)}</blockquote></figure>`).join('');
  const meeting = (q.review && q.review.sourceMeeting) || '';
  const gc = q.gradingContext || {};
  return `<article class="question" id="${esc(q.id)}" data-topic="${esc(q.topic)}" data-difficulty="${esc(q.difficulty)}" data-kind="${esc(q.kind)}" data-day="${esc(meeting)}" data-bank="${i}" data-shuffled="${shuffledPos[i]}" style="order:${shuffledPos[i]}">
<details class="item"><summary><a class="number" href="#${esc(q.id)}" title="Link to ${esc(q.id)}" onclick="event.stopPropagation()">${esc(q.id)}</a><span class="prompt">${rich(q.prompt)}</span><span class="badge ${esc(q.difficulty)}">${esc(q.difficulty)}</span></summary>
<div class="body"><p class="meta">${esc(q.topic)} · ${esc(q.kind)}${meeting ? ' · ' + esc(meeting) : ''}</p>
<p class="principle"><b>Principle:</b> ${esc(q.principle)}</p>
<div class="columns"><section><h3>Example answer</h3><p class="answer">${esc(q.referenceAnswer)}</p><p class="hint">Illustrative spoken answer. Equivalent explanations and correct additional reasoning count.</p><h3>Likely misconceptions</h3>${list(q.commonErrors)}</section>
<section><h3>Core and supporting points</h3><table><thead><tr><th>Criterion</th><th>Points</th><th>Meaning</th></tr></thead><tbody>${criteria(q)}</tbody></table><p class="hint">R = core; O = supporting. A partly made point earns half. Supporting omissions are never reported to the student as missed.</p></section></div>
${gc.courseExplanation ? `<details class="metadata"><summary>Grading context</summary><p>${esc(gc.courseExplanation)}</p><p>${esc(q.rubric)}</p></details>` : ''}
<details class="metadata"><summary>Verbatim lecture evidence (${(q.evidence || []).length})</summary><p class="hint">Quotes are verbatim, including speech-to-text errors. Scenarios may be new applications of the taught principle.</p>${ev}</details>
<div class="review"><label>Review status <select class="status" aria-label="Review status for ${esc(q.id)}"><option value="unreviewed">Not reviewed</option><option value="keep">Keep</option><option value="revise">Revise</option><option value="remove">Remove</option></select></label><label class="notelabel">Your notes<textarea class="note" rows="2" aria-label="Review notes for ${esc(q.id)}" placeholder="Ambiguity, grading concern, or proposed edit…"></textarea></label></div></div></details></article>`;
}).join('\n');

const opts = (xs) => xs.map(x => `<option>${esc(x)}</option>`).join('');
const scope = bank.scope || {};
const table = scoring.table ? scoring.table.map((v, i) => `${i}→${Math.round(v * 100)}%`).join(', ') : '';
const payload = JSON.stringify({ bankId: bank.bankId, ids: qs.map(q => q.id) }).replace(/</g, '\\u003c');
const storeKey = `oralscale-worksheet-${bank.bankId || 'bank'}-${sha.slice(0, 16)}`;
const slug = (bank.bankId || 'bank').replace(/[^a-z0-9-]+/gi, '-');

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(label)} — review worksheet</title><style>
:root{color-scheme:light;--ink:#182d38;--muted:#52646d;--line:#d6dfdf;--teal:#126c69;--paper:#fff;--bg:#f2f5f4}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,sans-serif}header,main,footer{max-width:1250px;margin:auto;padding:28px}header{padding-top:40px}h1{font-size:clamp(28px,4vw,44px);line-height:1.12;margin:12px 0}h3{font-size:16px;margin:0 0 10px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:750;color:var(--teal)}.subtitle{max-width:870px;color:var(--muted)}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}.stat{padding:12px 18px;border:1px solid var(--line);border-radius:10px;background:#fff}.stat b{display:block;font-size:22px}.notice{padding:14px 18px;border-left:4px solid var(--teal);background:#e4f0ed}.overview,.toolbar{padding:20px;background:#fff;border:1px solid var(--line);border-radius:12px;margin-bottom:18px}.filters{display:grid;grid-template-columns:2fr 1.4fr 1fr 1fr;gap:12px}label{font-size:13px;font-weight:650;color:var(--muted)}input,select,textarea,button{font:inherit;border:1px solid #afbebf;border-radius:6px;padding:9px 11px;color:var(--ink);background:#fff}label input,label select{display:block;width:100%;margin-top:5px}button{cursor:pointer;font-size:14px}button:hover{background:#e9f2f0}button.primary{color:#fff;background:var(--teal);border-color:var(--teal)}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}.result{color:var(--muted);font-size:14px;margin:15px 0}#questions{display:flex;flex-direction:column}.question{border:1px solid var(--line);background:var(--paper);border-radius:10px;margin:10px 0;overflow:hidden}.question[hidden]{display:none}.question.reviewed-keep{border-left:5px solid #3a8a5a}.question.reviewed-revise{border-left:5px solid #c98a1d}.question.reviewed-remove{border-left:5px solid #b3413a}.item>summary{display:flex;align-items:start;gap:15px;padding:20px;cursor:pointer;list-style:none}.item>summary::-webkit-details-marker{display:none}.item>summary:before{content:'+';font-size:22px;line-height:1.1;color:var(--teal)}.item[open]>summary:before{content:'−'}.number{font:700 13px/1.6 ui-monospace,monospace;color:var(--teal);white-space:nowrap;text-decoration:none;border:1px solid var(--line);border-radius:5px;padding:2px 7px;background:#eef4f3}.prompt{flex:1;font-weight:600}.prompt math{font-size:1.05em}.badge{font-size:11px;text-transform:uppercase;letter-spacing:.05em;background:#eef1f3;padding:4px 8px;border-radius:4px}.intro{background:#e2efe7}.stretch{background:#f5e8d7}.body{padding:0 24px 24px}.meta,.hint{font-size:13px;color:var(--muted)}.principle{padding:12px 0;border-bottom:1px solid var(--line)}.columns{display:grid;grid-template-columns:1fr 1.1fr;gap:30px;margin:20px 0}.answer{margin-top:0}.said{margin-top:4px;font-size:13px;color:var(--muted)}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:9px 8px}th{font-size:12px}ul{padding-left:22px}li{margin:6px 0}.metadata{border-top:1px solid var(--line);padding:12px 0}.metadata>summary,.overview>summary{cursor:pointer;font-weight:650}.metadata p{font-size:14px}figure{margin:15px 0}figcaption{font-size:12px;color:var(--muted)}blockquote{font-size:13px;white-space:pre-wrap;margin:8px 0;padding:10px 14px;border-left:3px solid #b5caca;background:#f5f7f6}.review{display:flex;gap:18px;border-top:1px solid var(--line);padding-top:18px}.notelabel{flex:1}textarea{display:block;width:100%;margin-top:5px;font-weight:400}a{color:var(--teal)}:focus-visible{outline:3px solid #d39b3b;outline-offset:3px}.coverage{columns:2}code.math-raw{background:#fde8e8;color:#8a1f1f;padding:0 .25em}.small{font-size:13px}footer{color:var(--muted);font-size:12px;padding-bottom:45px}@media(max-width:800px){header,main,footer{padding:16px}.filters{grid-template-columns:1fr 1fr}.columns{grid-template-columns:1fr;gap:18px}.item>summary{padding:14px;gap:9px}.number{font-size:11px;padding:1px 5px}.badge{font-size:10px}.body{padding:0 16px 16px}.review{flex-direction:column}.coverage{columns:1}}@media print{body{background:#fff;font-size:11px}.toolbar,.review,.actions{display:none!important}header,main,footer{padding:8px;max-width:none}.question{break-inside:avoid;border-color:#aaa}}
</style></head><body><header><div class="eyebrow">${esc(bank.course || '')} · Private instructor worksheet · ${esc(bank.status || 'draft')}</div><h1>${esc(label)}: review the questions</h1><p class="subtitle">${esc(bank.title || '')}. ${esc(bank.note || '')}</p>
<div class="stats"><div class="stat"><b>${qs.length}</b>questions</div><div class="stat"><b>${diffs.intro || 0} / ${diffs.core || 0} / ${diffs.stretch || 0}</b>intro / core / stretch</div><div class="stat"><b>${nCore} + ${nOpt}</b>core + supporting criteria</div><div class="stat"><b>${topics.length}</b>topics</div></div>
<div class="notice"><b>How to use this.</b> Questions appear in a shuffled order that is fixed for this revision, so neighbouring items on one idea do not bias your reading. Mark each one Keep, Revise or Remove and add a note; then use <b>Copy feedback</b> to paste every note, by question ID, back to whoever is revising the bank.</div></header><main>
<details class="overview"><summary>Scope, coverage and grading policy</summary>
<p><b>Scope:</b> ${esc(scope.start || '')}${scope.end ? ' to ' + esc(scope.end) : ''}.${(scope.excluded || []).length ? ' Excluded: ' + (scope.excluded || []).map(esc).join('; ') + '.' : ''}</p>
${scoring.mode === 'points' ? `<p><b>Points:</b> core ${rw} each, supporting ${ow} each, a partly made point earns ${scoring.partlyFactor != null ? scoring.partlyFactor : 0.5} of its weight, and correct unlisted points earn up to ${scoring.novelCap != null ? scoring.novelCap : 3}. Raw totals map to ${esc(table)}${scoring.curveRounding === 'up' ? ', rounding fractional totals up' : ''}. An uncorrected false claim caps the answer at ${Math.round((scoring.falseClaimCapScore || 0.85) * 100)}%; no core point caps it at ${Math.round((scoring.noCoreCapScore || 0.7) * 100)}%.</p>` : ''}
<div class="coverage"><table><thead><tr><th>Topic</th><th>Questions</th></tr></thead><tbody>${topics.map(t => `<tr><td>${esc(t)}</td><td>${topicCounts[t]}</td></tr>`).join('')}</tbody></table></div></details>
<section class="toolbar" aria-label="Review controls"><div class="filters"><label>Search<input id="search" type="search" placeholder="Prompt, answer, principle, ID…"></label><label>Topic<select id="topic"><option value="">All topics</option>${opts(topics)}</select></label><label>Difficulty<select id="difficulty"><option value="">All levels</option><option>intro</option><option>core</option><option>stretch</option></select></label><label>Question type<select id="kind"><option value="">All types</option>${opts(kinds)}</select></label><label>Lecture<select id="day"><option value="">All lectures</option>${opts(meetings)}</select></label><label>Order<select id="order"><option value="shuffled">Shuffled (fixed for this revision)</option><option value="bank">Bank order</option></select></label><label>Review status<select id="statusFilter"><option value="">All statuses</option><option value="unreviewed">Not reviewed</option><option value="keep">Keep</option><option value="revise">Revise</option><option value="remove">Remove</option></select></label></div>
<div class="actions"><button class="primary" id="copy">Copy feedback</button><button id="export">Export notes (JSON)</button><button id="import">Import notes</button><input id="importFile" type="file" accept=".json,application/json" hidden><button id="expand">Expand visible</button><button id="collapse">Collapse all</button><button id="reset">Reset filters</button><button id="print">Print visible</button></div><p class="small" id="saveMessage">Notes save in this browser when storage is available. Export or copy them before moving the file or switching browsers.</p></section>
<p id="result" class="result" role="status" aria-live="polite"></p><div id="questions">${cards}</div></main>
<footer>Private course material · Prepared ${esc(prepared)} · Bank ${esc(bank.bankId || '')} revision ${esc(bank.revision || '')} · SHA-256 <code>${sha}</code><br>Everything is embedded; the page makes no network requests.</footer>
<script type="application/json" id="bank">${payload}</script><script>
'use strict';
const bank=JSON.parse(document.getElementById('bank').textContent),SHA='${sha}',KEY='${storeKey}';
const cards=[...document.querySelectorAll('.question')],controls=['search','topic','difficulty','kind','day','statusFilter'].map(id=>document.getElementById(id));
const valid=['unreviewed','keep','revise','remove'];let state={},storage=true;
try{state=JSON.parse(localStorage.getItem(KEY)||'{}')||{}}catch(e){storage=false;state={}}
function clean(v){const c={};for(const id of bank.ids){const x=v&&v[id];if(x&&valid.includes(x.status)&&typeof x.note==='string')c[id]={status:x.status,note:x.note}}return c}
state=clean(state);
function msg(t){document.getElementById('saveMessage').textContent=t}
function paint(c){const v=state[c.id]||{status:'unreviewed'};c.classList.remove('reviewed-keep','reviewed-revise','reviewed-remove');if(v.status!=='unreviewed')c.classList.add('reviewed-'+v.status)}
function apply(){for(const c of cards){const v=state[c.id]||{status:'unreviewed',note:''};c.querySelector('.status').value=v.status;c.querySelector('.note').value=v.note;paint(c)}}
function save(){try{localStorage.setItem(KEY,JSON.stringify(state));msg('Saved in this browser. Copy or export to keep a copy.')}catch(e){storage=false;msg('Browser storage is unavailable; copy or export your notes before closing.')}}
function filter(){const [s,t,d,k,day,st]=controls.map(e=>e.value);let shown=0;for(const c of cards){const ok=(!s||c.textContent.toLowerCase().includes(s.toLowerCase()))&&(!t||c.dataset.topic===t)&&(!d||c.dataset.difficulty===d)&&(!k||c.dataset.kind===k)&&(!day||c.dataset.day===day)&&(!st||c.querySelector('.status').value===st);c.hidden=!ok;if(ok)shown++}const n=Object.values(state).filter(v=>v.status!=='unreviewed').length;document.getElementById('result').textContent='Showing '+shown+' of '+cards.length+' questions · '+n+' reviewed'}
apply();if(!storage)msg('Browser storage is unavailable; copy or export your notes before closing.');
for(const c of cards){for(const e of [c.querySelector('.status'),c.querySelector('.note')])e.addEventListener('input',()=>{state[c.id]={status:c.querySelector('.status').value,note:c.querySelector('.note').value};paint(c);save();filter()})}
const orderSel=document.getElementById('order');function applyOrder(){for(const c of cards)c.style.order=orderSel.value==='bank'?c.dataset.bank:c.dataset.shuffled}
orderSel.addEventListener('input',applyOrder);controls.forEach(e=>e.addEventListener('input',filter));
document.getElementById('expand').onclick=()=>cards.filter(c=>!c.hidden).forEach(c=>c.querySelector('.item').open=true);
document.getElementById('collapse').onclick=()=>document.querySelectorAll('.question details').forEach(e=>e.open=false);
document.getElementById('reset').onclick=()=>{controls.forEach(e=>e.value='');orderSel.value='shuffled';applyOrder();filter()};
document.getElementById('print').onclick=()=>{cards.filter(c=>!c.hidden).forEach(c=>c.querySelector('.item').open=true);window.print()};
function dl(name,data){const b=new Blob([JSON.stringify(data,null,2)+'\\n'],{type:'application/json'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
function notes(){return bank.ids.map(id=>({id,...(state[id]||{status:'unreviewed',note:''})}))}
document.getElementById('export').onclick=()=>dl('${slug}-review-notes.json',{bankId:bank.bankId,bankSha256:SHA,exportedAt:new Date().toISOString(),questions:notes()});
document.getElementById('copy').onclick=async()=>{const rows=notes().filter(q=>q.status!=='unreviewed'||q.note.trim());const text=['Review of '+bank.bankId+' ('+SHA.slice(0,12)+'), '+rows.length+' of '+bank.ids.length+' questions:'].concat(rows.map(q=>q.id+' ['+q.status+']'+(q.note.trim()?' '+q.note.trim().replace(/\\s+/g,' '):''))).join('\\n');try{await navigator.clipboard.writeText(text);msg('Copied '+rows.length+' entries to the clipboard.')}catch(e){const w=window.open('','_blank');if(w){w.document.body.innerText=text}else{msg('Clipboard unavailable; use Export instead.')}}};
document.getElementById('import').onclick=()=>document.getElementById('importFile').click();
document.getElementById('importFile').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;const d=JSON.parse(await f.text());if(d.bankId!==bank.bankId||d.bankSha256!==SHA||!Array.isArray(d.questions))throw Error('these notes belong to a different bank revision');state={...state,...clean(Object.fromEntries(d.questions.map(q=>[q.id,q])))};apply();save();filter()}catch(err){msg('Import failed: '+err.message)}finally{e.target.value=''}};
filter();
</script></body></html>`;
fs.writeFileSync(out, page);
console.log(`wrote ${out}  (${qs.length} questions, ${Math.round(page.length / 1024)} KB, sha ${sha.slice(0, 16)})`);
