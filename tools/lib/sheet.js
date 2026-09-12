'use strict';
/*
 * Read a roster export into rows, whether it is CSV or XLSX.
 *
 * WHY THIS EXISTS
 * An instructor exports whatever their LMS gives them. Brightspace hands out CSV;
 * plenty of people then open it in Excel and save it back as .xlsx without
 * thinking about it. Refusing that file is a pointless obstacle at the exact
 * moment someone is trying to get a class set up.
 *
 * NO DEPENDENCIES. An .xlsx is a ZIP of XML, and Node ships zlib, so the reader
 * is a central-directory walk plus inflateRaw. That is ~70 lines and no supply
 * chain, against a package that would have to be vetted for a tool that handles
 * a class roster.
 *
 * Deliberately NOT a general spreadsheet library: it reads the first worksheet
 * as text and stops. Formulas come back as their cached value, formatting is
 * ignored, and dates are left as serial numbers — none of which matter for
 * finding an email column.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---- CSV ---------------------------------------------------------------- */
/* Quoted fields, embedded commas and newlines, doubled quotes, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => String(f).trim()));
}

/* ---- XLSX --------------------------------------------------------------- */
/* Minimal ZIP reader: walk the End of Central Directory back to the entries. */
function unzip(buf) {
  const out = {};
  // EOCD signature, searched from the end because the comment field is variable.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // The local header repeats the name/extra lengths, and they can differ.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    try {
      out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    } catch { /* a member we cannot read is a member we did not need */ }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const unescapeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');

/* "BC12" -> 54 (zero-based column index) */
function colIndex(ref) {
  const letters = String(ref).replace(/[^A-Z]/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// OOXML producers are free to qualify spreadsheet tags (for example
// <x:row><x:c>...</x:c></x:row>). Excel usually omits the prefix, while some
// LMS exporters include it. Match either form without trying to be a general
// XML parser; this reader still consumes only the small worksheet subset above.
const XML_PREFIX = '(?:[A-Za-z_][\\w.-]*:)?';
const pairedTag = (name) => new RegExp(
  `<${XML_PREFIX}${name}\\b[^>]*>([\\s\\S]*?)<\\/${XML_PREFIX}${name}\\s*>`, 'g');

function textRuns(xml) {
  return [...String(xml).matchAll(pairedTag('t'))]
    .map((m) => unescapeXml(m[1]))
    .join('');
}

function parseWorksheetXml(xml, shared = []) {
  const rows = [];
  for (const rowMatch of String(xml).matchAll(pairedTag('row'))) {
    const rowXml = rowMatch[1];
    const cells = [];
    const cellPattern = new RegExp(
      `<${XML_PREFIX}c\\b([^>]*)>([\\s\\S]*?)<\\/${XML_PREFIX}c\\s*>`
      + `|<${XML_PREFIX}c\\b([^>]*)\\/>`, 'g');
    for (const m of rowXml.matchAll(cellPattern)) {
      const attrs = m[1] || m[3] || '';
      const inner = m[2] || '';
      const refM = attrs.match(/r="([A-Z]+\d+)"/);
      const idx = refM ? colIndex(refM[1]) : cells.length;
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      let v = '';
      if (type === 'inlineStr') {
        v = textRuns(inner);
      } else {
        const vm = [...inner.matchAll(pairedTag('v'))][0];
        v = vm ? unescapeXml(vm[1]) : '';
        if (type === 's') v = shared[Number(v)] !== undefined ? shared[Number(v)] : '';
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = v;
    }
    rows.push(cells);
  }
  return rows.filter((r) => r.some((f) => String(f).trim()));
}

function parseXlsx(buf) {
  const files = unzip(buf);
  // Shared strings: xlsx stores most text once and references it by index.
  const shared = [];
  const ss = files['xl/sharedStrings.xml'];
  if (ss) {
    for (const si of ss.toString('utf8').matchAll(pairedTag('si'))) {
      // A string can be split across runs; concatenate every <t>.
      shared.push(textRuns(si[1]));
    }
  }
  const sheetName = Object.keys(files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort()[0];
  if (!sheetName) throw new Error('no worksheet found in the .xlsx');
  const xml = files[sheetName].toString('utf8');
  return parseWorksheetXml(xml, shared);
}

/* ---- entry point -------------------------------------------------------- */
function readRows(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') return parseXlsx(fs.readFileSync(file));
  if (ext === '.xls') {
    throw new Error('.xls is the old binary Excel format. Re-save it as .xlsx or .csv '
      + '(File > Save As), or export CSV from your LMS.');
  }
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

module.exports = { readRows, parseCsv, parseXlsx, parseWorksheetXml };
