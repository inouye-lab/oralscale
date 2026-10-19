#!/usr/bin/env node
/**
 * Render a question bank as a single self-contained HTML review sheet.
 *
 * WHY: `courses/AGENTS.md` rule 1 is that the instructor owns the questions and
 * no bank is frozen before they have read it. A hundred questions of JSON is not
 * something anyone reads. This turns the bank into the thing the rule actually
 * asks for: a document you can sit down with, filter, and disagree with.
 *
 * The output stays INSIDE the course folder and is never published anywhere
 * (rule 3): it contains the prompts AND the reference answers, so a copy of it
 * is a copy of the assessment.
 *
 *   node tools/bank-review-sheet.js courses/<id>/banks/<bank>.json [-o out.html]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const bankPath = args.find(a => !a.startsWith('-'));
const oIdx = args.indexOf('-o');
if (!bankPath) {
  console.error('usage: node tools/bank-review-sheet.js <bank.json> [-o out.html]');
  process.exit(2);
}
const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
const out = oIdx >= 0 ? args[oIdx + 1]
  : path.join(path.dirname(bankPath), '..', path.basename(bankPath, '.json') + '-review.html');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* The prompt is rendered THROUGH THE STUDENT APP'S OWN PARSER, not a lookalike.
 *
 * WHY: this sheet exists so the instructor reads the bank as the students will
 * meet it (courses/AGENTS.md rule 1), and from quiz-02 on the banks carry real
 * notation in prompts. A hand-rolled bold/italic pass printed `$A=U\Sigma V^T$`
 * as raw dollar-sign source, so the one audience who most needs to see the
 * equation was the only audience that never did. Worse, the two renderers could
 * drift: the sheet could show something the app does not.
 *
 * So `parseRich` is imported from web/js/richtext.mjs and its spec tree is
 * serialised to an HTML string here. The tree is the same one the app turns into
 * DOM nodes, so an unsupported macro shows up on this page exactly as literally
 * as it will on a phone — which is the point. Browsers render MathML natively,
 * so this needs no library and no network fetch, and the sheet stays one
 * self-contained file.
 *
 * SAFETY (INV-SEC-6): tag names come only from the parser's whitelists, every
 * attribute is a fixed string decided here rather than taken from the source,
 * and all text goes through esc(). Bank text is instructor- and LLM-authored, so
 * this must not become an injection path. Mirrors buildNode() in richtext.mjs.
 */
const { parseRich, HTML_TAGS, MATHML_TAGS } = require('../web/js/richtext.mjs');

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
  const inner = spec.text != null
    ? esc(spec.text)
    : (spec.children || []).map(specToHtml).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
};

/* Prompts are one flowing line in this sheet, so a single paragraph is unwrapped
 * rather than boxed; anything richer (a list, several paragraphs) keeps its
 * blocks. */
const inline = (s) => {
  const blocks = parseRich(s);
  if (blocks.length === 1 && blocks[0].t === 'p') {
    return (blocks[0].children || []).map(specToHtml).join('');
  }
  return blocks.map(specToHtml).join('');
};

const qs = bank.questions || [];
const DIFFS = ['intro', 'core', 'stretch'];
const KINDS = [...new Set(qs.map(q => q.kind))].sort();
const BANDS = ['full', 'strong', 'partial', 'weak', 'none'];

const count = (fn) => qs.filter(fn).length;
const matrix = KINDS.map(k => ({ kind: k, cells: DIFFS.map(d => count(q => q.kind === k && q.difficulty === d)),
                                 total: count(q => q.kind === k) }));

// Which source each question leans on, for the coverage strip. A question may
// cite more than one; it is counted once per distinct source it cites, because
// the question being asked is "is every lecture represented", not "how many
// citations are there".
const srcKey = (s) => {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return (/slide/i.test(s) ? 'slides ' : 'lecture ') + m[1];
  if (/syllabus/i.test(s)) return 'syllabus';
  if (/contract/i.test(s)) return 'redesign contract';
  return 'other';
};
const srcCounts = {};
for (const q of qs) {
  for (const k of new Set((q.evidence || []).map(e => srcKey(e.source)))) {
    srcCounts[k] = (srcCounts[k] || 0) + 1;
  }
}
const srcRows = Object.entries(srcCounts).sort((a, b) => b[1] - a[1]);
const topics = [...new Set(qs.map(q => q.topic))];

const entry = (q, i) => `
<article class="q" data-diff="${esc(q.difficulty)}" data-kind="${esc(q.kind)}"
         data-text="${esc((q.prompt + ' ' + q.topic + ' ' + q.principle).toLowerCase())}">
  <header class="q-head">
    <button class="q-toggle" aria-expanded="false" aria-controls="body-${esc(q.id)}">
      <span class="q-n">${String(i + 1).padStart(3, '0')}</span>
      <span class="q-main">
        <span class="q-topic">${esc(q.topic)}</span>
        <span class="q-prompt">${inline(q.prompt)}</span>
      </span>
      <span class="q-tags">
        <span class="tag tag-${esc(q.difficulty)}">${esc(q.difficulty)}</span>
        <span class="tag tag-kind">${esc(q.kind)}</span>
        <span class="chev" aria-hidden="true"></span>
      </span>
    </button>
  </header>
  <div class="q-body" id="body-${esc(q.id)}" hidden>
    <p class="principle"><span class="lbl">Principle</span>${esc(q.principle)}</p>
    <div class="cols">
      <section>
        <h4>What earns credit</h4>
        <p class="rubric">${esc(q.rubric)}</p>
        <h4>Required <span class="hint">without these, the question is not answered</span></h4>
        <ul class="kp">${(q.keyPoints || []).map(k => `<li>${esc(k)}</li>`).join('')}</ul>
        ${q.bonusPoints && q.bonusPoints.length ? `<h4>Optional <span class="hint">strengthens an answer; never costs a mark</span></h4>
        <ul class="bp">${q.bonusPoints.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
        ${q.commonErrors ? `<h4>Does not earn credit</h4>
        <ul class="ce">${q.commonErrors.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
      </section>
      <section>
        <h4>Reference answer <span class="hint">spoken</span></h4>
        <p class="ref">${esc(q.referenceAnswer)}</p>
        <h4>Bands</h4>
        <dl class="bands">${BANDS.filter(b => q.scoringBands && q.scoringBands[b])
          .map(b => `<dt class="band-${b}">${b}</dt><dd>${esc(q.scoringBands[b])}</dd>`).join('')}</dl>
      </section>
    </div>
    <section class="evidence">
      <h4>Evidence <span class="hint">verified verbatim against the sources</span></h4>
      ${(q.evidence || []).map(e => `<figure>
        <blockquote>${esc(e.quote)}</blockquote>
        <figcaption>${esc(e.source)}</figcaption>
      </figure>`).join('')}
    </section>
    <p class="qid"><code>${esc(q.id)}</code></p>
  </div>
</article>`;

const html = `<title>${esc(bank.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
  /* Rendered MathML, so the reviewer sees the equation the student sees. */
  math { font-size: 1.05em; }
  math[display="block"] { display: block; margin: .5em 0; overflow-x: auto; }
  code.math-raw { background: #fde8e8; color: #8a1f1f; padding: 0 .25em; border-radius: 3px; }

:root{
  --paper:#e9edf1; --surface:#fff; --surface-2:#f3f6f8;
  --ink:#12181f; --ink-2:#4d5a68; --ink-3:#7d8b99;
  --rule:#d2dae2; --rule-2:#e3e9ee;
  --accent:#0d6a6a; --accent-soft:#0d6a6a1a;
  --intro:#2f6d50; --core:#2a5788; --stretch:#8a4526;
  --quote:#f6f4ef;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --paper:#0f1317; --surface:#161c22; --surface-2:#1b232a;
    --ink:#e4eaf0; --ink-2:#9fadba; --ink-3:#74828f;
    --rule:#2a333c; --rule-2:#222a32;
    --accent:#4fb5ad; --accent-soft:#4fb5ad1f;
    --intro:#63b58c; --core:#7aa8de; --stretch:#d3906a;
    --quote:#1a2129;
  }
}
:root[data-theme="dark"]{
  --paper:#0f1317; --surface:#161c22; --surface-2:#1b232a;
  --ink:#e4eaf0; --ink-2:#9fadba; --ink-3:#74828f;
  --rule:#2a333c; --rule-2:#222a32;
  --accent:#4fb5ad; --accent-soft:#4fb5ad1f;
  --intro:#63b58c; --core:#7aa8de; --stretch:#d3906a;
  --quote:#1a2129;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font-family:"IBM Plex Sans",system-ui,-apple-system,sans-serif;
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1060px;margin:0 auto;padding:0 24px 96px}
code,.mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.86em}

/* masthead */
.mast{padding:44px 0 26px;border-bottom:2px solid var(--ink)}
.eyebrow{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);
  font-weight:600;margin:0 0 12px}
.mast h1{font-family:Spectral,Georgia,serif;font-weight:600;font-size:clamp(28px,4.2vw,42px);
  line-height:1.14;margin:0 0 10px;text-wrap:balance;letter-spacing:-.01em}
.mast .sub{color:var(--ink-2);margin:0;max-width:62ch}
.facts{display:flex;flex-wrap:wrap;gap:0 30px;margin-top:22px;
  font-size:12.5px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.facts b{color:var(--ink);font-weight:600}

/* coverage */
.cover{display:grid;grid-template-columns:1.35fr 1fr;gap:26px;margin:30px 0 8px}
@media (max-width:760px){.cover{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:18px 20px}
.panel h2{font-size:11.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);
  font-weight:600;margin:0 0 14px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:13.5px}
th,td{text-align:right;padding:5px 0;border-bottom:1px solid var(--rule-2)}
th:first-child,td:first-child{text-align:left}
thead th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
tbody tr:last-child td{border-bottom:0}
td.tot{font-weight:600}
.bar{display:block;height:3px;background:var(--accent);border-radius:2px;margin-top:4px}

/* filters */
.bar-wrap{position:sticky;top:0;z-index:5;background:var(--paper);
  padding:14px 0 12px;border-bottom:1px solid var(--rule);margin-top:26px}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chip{font:inherit;font-size:12.5px;padding:5px 11px;border:1px solid var(--rule);
  background:var(--surface);color:var(--ink-2);border-radius:99px;cursor:pointer;
  transition:background .12s,color .12s,border-color .12s}
.chip:hover{border-color:var(--accent);color:var(--ink)}
.chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:500}
:root[data-theme="dark"] .chip[aria-pressed="true"]{color:#0f1317}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]) .chip[aria-pressed="true"]{color:#0f1317}
}
input[type=search]{font:inherit;font-size:13px;padding:6px 11px;border:1px solid var(--rule);
  border-radius:99px;background:var(--surface);color:var(--ink);min-width:190px}
.sep{flex:1}
.shown{font-size:12.5px;color:var(--ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}

/* entries */
.q{border-bottom:1px solid var(--rule-2)}
.q.hide{display:none}
.q-toggle{width:100%;display:grid;grid-template-columns:auto 1fr auto;gap:16px;align-items:start;
  background:none;border:0;padding:16px 4px;text-align:left;cursor:pointer;color:inherit;font:inherit}
.q-toggle:hover .q-prompt{color:var(--accent)}
.q-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.q-n{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink-3);padding-top:4px}
.q-topic{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--ink-3);font-weight:600;margin-bottom:3px}
.q-prompt{font-family:Spectral,Georgia,serif;font-size:16.5px;line-height:1.45;
  color:var(--ink);transition:color .12s}
.q-tags{display:flex;align-items:center;gap:7px;padding-top:3px}
.tag{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;font-weight:600;
  padding:2px 7px;border-radius:2px;white-space:nowrap}
.tag-intro{color:var(--intro);background:color-mix(in srgb,var(--intro) 12%,transparent)}
.tag-core{color:var(--core);background:color-mix(in srgb,var(--core) 12%,transparent)}
.tag-stretch{color:var(--stretch);background:color-mix(in srgb,var(--stretch) 12%,transparent)}
.tag-kind{color:var(--ink-3);border:1px solid var(--rule)}
.chev{width:8px;height:8px;border-right:1.5px solid var(--ink-3);border-bottom:1.5px solid var(--ink-3);
  transform:rotate(45deg) translate(-2px,-2px);transition:transform .15s}
[aria-expanded="true"] .chev{transform:rotate(-135deg) translate(-2px,-2px)}
.q-body{padding:2px 4px 26px 44px;max-width:none}
@media (max-width:640px){.q-body{padding-left:4px}}
.principle{margin:0 0 20px;font-family:Spectral,Georgia,serif;font-size:15px;color:var(--ink-2);
  border-left:2px solid var(--accent);padding-left:14px}
.lbl{display:block;font-family:"IBM Plex Sans",sans-serif;font-size:10.5px;letter-spacing:.12em;
  text-transform:uppercase;color:var(--accent);font-weight:600;margin-bottom:3px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}
@media (max-width:760px){.cols{grid-template-columns:1fr}}
.q-body h4{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);
  font-weight:600;margin:0 0 7px}
.q-body section+section,.q-body h4+*{margin-top:0}
.q-body h4:not(:first-child){margin-top:18px}
.rubric,.ref{margin:0;color:var(--ink-2);font-size:14px}
.ref{font-family:Spectral,Georgia,serif;font-size:14.5px;color:var(--ink)}
ul{margin:0;padding-left:17px;font-size:14px;color:var(--ink-2)}
li{margin-bottom:3px}
.ce li::marker{color:var(--stretch)}
/* Required and optional have to be told apart AT A GLANCE, because the whole
   point of reviewing a bank now is checking that nothing optional was filed as
   required (INV-GRADE-9). */
.bp{color:var(--ink-3)}
.bp li::marker{color:var(--ink-3)}
h4 .hint{font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink-3);font-size:11px}
.bands{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13.5px}
.bands dt{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;font-weight:600;
  padding-top:3px;color:var(--ink-3)}
.bands dd{margin:0;color:var(--ink-2)}
.band-full{color:var(--intro)!important}.band-strong{color:var(--core)!important}
.band-none{color:var(--stretch)!important}
.evidence{margin-top:22px;border-top:1px solid var(--rule-2);padding-top:16px}
.evidence figure{margin:0 0 12px;background:var(--quote);border-left:2px solid var(--rule);
  padding:11px 14px;border-radius:0 2px 2px 0}
.evidence blockquote{margin:0;font-family:Spectral,Georgia,serif;font-size:14px;
  line-height:1.5;color:var(--ink)}
.evidence figcaption{margin-top:6px;font-size:11.5px;color:var(--ink-3);
  font-family:"IBM Plex Mono",monospace}
.hint{text-transform:none;letter-spacing:0;font-weight:400;color:var(--ink-3);font-size:11px}
.qid{margin:16px 0 0;color:var(--ink-3)}
.foot{margin-top:36px;padding-top:18px;border-top:1px solid var(--rule);
  font-size:12.5px;color:var(--ink-3);max-width:70ch}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
<header class="mast">
  <p class="eyebrow">Draft for instructor review — not frozen</p>
  <h1>${esc(bank.title)}</h1>
  <p class="sub">${inline(bank.note || "")}</p>
  <div class="facts">
    <span><b>${qs.length}</b> questions</span>
    <span><b>${topics.length}</b> topics</span>
    <span><b>${qs.reduce((n, q) => n + (q.evidence || []).length, 0)}</b> evidence quotes</span>
    <span><b>${DIFFS.map(d => count(q => q.difficulty === d)).join(' / ')}</b> intro / core / stretch</span>
    <span class="mono">${esc(bank.bankId)}</span>
  </div>
</header>

<div class="cover">
  <div class="panel">
    <h2>Question kind × difficulty</h2>
    <table>
      <thead><tr><th>kind</th>${DIFFS.map(d => `<th>${d}</th>`).join('')}<th>all</th></tr></thead>
      <tbody>${matrix.map(r => `<tr><td>${esc(r.kind)}</td>${r.cells.map(c => `<td>${c}</td>`).join('')}<td class="tot">${r.total}</td></tr>`).join('')}
      <tr><td class="tot">all</td>${DIFFS.map(d => `<td class="tot">${count(q => q.difficulty === d)}</td>`).join('')}<td class="tot">${qs.length}</td></tr>
      </tbody>
    </table>
  </div>
  <div class="panel">
    <h2>Questions citing each source</h2>
    <table>
      <tbody>${srcRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="tot">${v}<span class="bar" style="width:${Math.round(100 * v / qs.length)}%"></span></td></tr>`).join('')}</tbody>
    </table>
  </div>
</div>

<div class="bar-wrap">
  <div class="filters">
    <button class="chip" data-f="all" aria-pressed="true">all</button>
    ${DIFFS.map(d => `<button class="chip" data-f="diff:${d}" aria-pressed="false">${d}</button>`).join('')}
    ${KINDS.map(k => `<button class="chip" data-f="kind:${k}" aria-pressed="false">${esc(k)}</button>`).join('')}
    <input type="search" id="search" placeholder="Search prompts and principles" aria-label="Search questions">
    <span class="sep"></span>
    <button class="chip" id="expand" aria-pressed="false">expand all</button>
    <span class="shown" id="shown">${qs.length} shown</span>
  </div>
</div>

<main id="list">${qs.map(entry).join('')}</main>

<p class="foot">Every question carries an <code>evidence</code> array quoting the slide, lecture
transcript, or syllabus clause it rests on; all ${qs.reduce((n, q) => n + (q.evidence || []).length, 0)}
were verified verbatim against the source files with <code>tools/check-bank-evidence.js</code>.
This sheet contains the reference answers, so it is assessment content: keep it inside the course
folder.</p>
</div>

<script>
const list = document.getElementById('list');
const cards = [...list.querySelectorAll('.q')];
const shown = document.getElementById('shown');
let active = new Set();
let query = '';

function apply(){
  const diffs = [...active].filter(f => f.startsWith('diff:')).map(f => f.slice(5));
  const kinds = [...active].filter(f => f.startsWith('kind:')).map(f => f.slice(5));
  let n = 0;
  for (const c of cards){
    const ok = (!diffs.length || diffs.includes(c.dataset.diff))
            && (!kinds.length || kinds.includes(c.dataset.kind))
            && (!query || c.dataset.text.includes(query));
    c.classList.toggle('hide', !ok);
    if (ok) n++;
  }
  shown.textContent = n + (n === 1 ? ' shown' : ' shown');
}

for (const btn of document.querySelectorAll('.chip[data-f]')){
  btn.addEventListener('click', () => {
    const f = btn.dataset.f;
    if (f === 'all'){ active.clear(); }
    else if (active.has(f)) active.delete(f);
    else active.add(f);
    for (const b of document.querySelectorAll('.chip[data-f]')){
      b.setAttribute('aria-pressed', b.dataset.f === 'all' ? String(active.size === 0)
                                                           : String(active.has(b.dataset.f)));
    }
    apply();
  });
}
document.getElementById('search').addEventListener('input', e => {
  query = e.target.value.trim().toLowerCase(); apply();
});
for (const t of document.querySelectorAll('.q-toggle')){
  t.addEventListener('click', () => {
    const open = t.getAttribute('aria-expanded') === 'true';
    t.setAttribute('aria-expanded', String(!open));
    document.getElementById(t.getAttribute('aria-controls')).hidden = open;
  });
}
const ex = document.getElementById('expand');
ex.addEventListener('click', () => {
  const open = ex.getAttribute('aria-pressed') !== 'true';
  ex.setAttribute('aria-pressed', String(open));
  ex.textContent = open ? 'collapse all' : 'expand all';
  for (const t of document.querySelectorAll('.q-toggle')){
    t.setAttribute('aria-expanded', String(open));
    document.getElementById(t.getAttribute('aria-controls')).hidden = !open;
  }
});
</script>`;

fs.writeFileSync(out, html);
console.log(`wrote ${out}  (${qs.length} questions, ${(html.length / 1024).toFixed(0)} KB)`);
