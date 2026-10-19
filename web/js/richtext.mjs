/*
 * Safe rich text for Question prompts (INV-SEC-6).
 *
 * (`.mjs`, not `.js`, only so Node's unit tests can `import()` it directly: the
 * repo's package.json says "type": "commonjs", and the safety properties below
 * are worth testing outside a browser. Browsers treat both extensions the same
 * inside a `<script type="module">` graph.)
 *
 * Question text is instructor/AI-authored and arrives from the Signer. It used to
 * be rendered with `textContent`, which was safe but meant an equation had to be
 * written as prose. This module keeps the safety and adds formatting, by never
 * producing HTML at all:
 *
 *     text  --parseRich-->  a tree of PLAIN OBJECTS  --renderRich-->  DOM nodes
 *
 * The middle step is pure (no DOM, unit-testable in Node), and the renderer only
 * ever calls `createElement` on a name from a fixed whitelist and puts author text
 * into TEXT NODES. There is no `innerHTML` anywhere in the pipeline, so there is no
 * parse step for an injected `<script>` or `onerror=` to survive: a prompt
 * containing raw HTML displays that HTML as literal characters, which is exactly
 * what an instructor who typed `<` meant.
 *
 * Supported (a deliberate subset of GitHub-flavoured Markdown — the constructs an
 * LLM writes without being asked, and nothing whose safety needs an argument):
 *
 *     **bold**   *italic*   _italic_   `code`   ```fenced blocks```
 *     - bullet lists        1. numbered lists    blank-line paragraphs
 *     $inline math$   $$display math$$   \\(…\\)   \\[…\\]
 *
 * NOT supported, on purpose: links, images, raw HTML, tables, headings. A link in
 * a quiz question is either a distraction or a phishing vector, and none of the
 * rest survives being read aloud, which is what these prompts are for.
 */

// ---------------------------------------------------------------------------
// Whitelist. Nothing outside this can reach the DOM, by construction: renderRich
// refuses any tag not listed, and attributes are fixed strings chosen HERE — never
// values taken from the source text.
// ---------------------------------------------------------------------------
export const HTML_TAGS = ['p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'span'];
export const MATHML_TAGS = ['math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mfrac', 'msqrt', 'mroot',
  'msup', 'msub', 'msubsup', 'mover', 'munder', 'munderover', 'mspace'];
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

const isMath = (tag) => MATHML_TAGS.includes(tag);

// ---------------------------------------------------------------------------
// LaTeX -> MathML spec. A subset, not a TeX engine.
//
// Browsers render MathML natively now, so this needs no library, no fonts, and no
// new runtime dependency — which matters for a static app a student opens on a
// phone on campus wifi. Anything outside the subset is shown as literal source
// rather than silently dropped: a question that renders oddly is a bug the
// instructor can see and fix, whereas a silently missing exponent is a wrong
// question nobody notices.
// ---------------------------------------------------------------------------
const SYMBOLS = {
  // greek
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
  Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // relations & operators
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', equiv: '≡', approx: '≈',
  sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', forall: '∀', exists: '∃',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', mapsto: '↦',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹', iff: '⟺',
  infty: '∞', partial: '∂', nabla: '∇', ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮',
  perp: '⊥', parallel: '∥', angle: '∠', degree: '°', circ: '∘', oplus: '⊕', otimes: '⊗',
  land: '∧', lor: '∨', neg: '¬', therefore: '∴', because: '∵', sqrt_: '√',
  // Norm bars and the pseudoinverse dagger. Without these a linear-algebra
  // prompt cannot write the two things it most needs to write — the norm
  // ‖x‖ and the Moore–Penrose inverse A† — and an author who reaches for the
  // standard macro gets the macro name printed on the student's phone.
  dagger: '†', Vert: '‖', lVert: '‖', rVert: '‖', vert: '|', lvert: '|', rvert: '|',
  '|': '‖',
};
const BIG_OPS = { sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', oint: '∮',
  bigcup: '⋃', bigcap: '⋂', lim: 'lim', max: 'max', min: 'min', argmax: 'arg max',
  argmin: 'arg min', sup: 'sup', inf: 'inf' };
// Multi-letter function names are ONE identifier, not a product of letters.
const FUNCS = ['sin', 'cos', 'tan', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'log', 'ln', 'exp', 'det', 'dim', 'ker', 'deg', 'gcd', 'Pr', 'tr', 'rank', 'mod'];
const ACCENTS = { hat: '^', widehat: '^', bar: '‾', overline: '‾', vec: '→', tilde: '~',
  widetilde: '~', dot: '˙', ddot: '¨', check: 'ˇ' };
// \mathbb{R} and friends: the blackboard letters students actually see.
const BB = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', E: '𝔼', P: 'ℙ' };

const mi = (t) => ({ t: 'mi', text: t });
const mn = (t) => ({ t: 'mn', text: t });
const mo = (t) => ({ t: 'mo', text: t });
const mrow = (children) => ({ t: 'mrow', children });

/** Tokenize a LaTeX fragment. Whitespace is structural only. */
function texTokens(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      if (!m) { i++; continue; }
      out.push({ k: 'cmd', v: m[1] });
      i += m[0].length;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) { out.push({ k: 'let', v: c }); i++; continue; }
    out.push({ k: 'ch', v: c });
    i++;
  }
  return out;
}

function parseTex(tokens, state) {
  const nodes = [];
  while (state.i < tokens.length) {
    const tok = tokens[state.i];
    if (tok.k === 'ch' && tok.v === '}') break;
    state.i++;

    let node = null;
    if (tok.k === 'num') node = mn(tok.v);
    else if (tok.k === 'let') node = mi(tok.v);
    else if (tok.k === 'ch') {
      if (tok.v === '{') { state.i--; node = braceGroup(tokens, state); }   // step back onto '{'
      else if (tok.v === '^' || tok.v === '_') { state.i--; node = null; }  // handled by applyScripts
      else node = mo(tok.v);
    } else if (tok.k === 'cmd') {
      node = texCommand(tok.v, tokens, state);
    }
    if (!node) {
      // A stray script marker with nothing to attach to: consume it so the loop
      // cannot spin, and drop it rather than emitting a dangling operator.
      if (tok.k === 'ch' && (tok.v === '^' || tok.v === '_')) { state.i++; braceGroup(tokens, state); }
      continue;
    }

    // Postfix scripts bind to the atom just produced.
    node = applyScripts(node, tokens, state);
    nodes.push(node);
  }
  return nodes;
}

/** Consume `{ … }` (or a single following atom, as TeX does for `x^2`). */
function braceGroup(tokens, state) {
  const tok = tokens[state.i];
  if (tok && tok.k === 'ch' && tok.v === '{') {
    state.i++;                                  // past '{'
    const inner = parseTex(tokens, state);
    if (tokens[state.i] && tokens[state.i].v === '}') state.i++;   // past '}'
    return inner.length === 1 ? inner[0] : mrow(inner);
  }
  if (!tok) return mrow([]);
  /* A BRACELESS ARGUMENT IS ONE TOKEN, AND A DIGIT IS A TOKEN.
   *
   * In TeX, `\frac12` means `\frac{1}{2}`: each argument takes a single token,
   * and digits tokenize individually. Our lexer groups a run of digits into one
   * number for everything else's benefit, so without this the numerator becomes
   * `12` and the DENOMINATOR becomes whatever came next — silently eating it.
   *
   *   $\mathrm{diag}(3,\tfrac12)$  ->  diag(3, [12 over ")"]
   *
   * with the closing bracket gone and nothing to show anything went wrong: no
   * unknown macro, no raw-source fallback, just a wrong equation on a student's
   * phone. Found in a live bank (quiz-03 q3-029 and q3-060, 2026-09-16). So take
   * the first digit and leave the remainder in place to be read next.
   */
  if (tok.k === 'num' && tok.v.length > 1) {
    tokens[state.i] = { k: 'num', v: tok.v.slice(1) };
    return mn(tok.v[0]);
  }
  state.i++;
  if (tok.k === 'num') return mn(tok.v);
  if (tok.k === 'let') return mi(tok.v);
  if (tok.k === 'cmd') return texCommand(tok.v, tokens, state) || mo('\\' + tok.v);
  return mo(tok.v);
}

function applyScripts(base, tokens, state) {
  let sub = null; let sup = null;
  for (;;) {
    const tok = tokens[state.i];
    if (!tok || tok.k !== 'ch' || (tok.v !== '^' && tok.v !== '_')) break;
    state.i++;
    const arg = braceGroup(tokens, state);
    if (tok.v === '^') sup = arg; else sub = arg;
  }
  if (sub && sup) return { t: base.under ? 'munderover' : 'msubsup', children: [base, sub, sup] };
  if (sup) return { t: base.under ? 'munderover' : 'msup', children: base.under ? [base, mrow([]), sup] : [base, sup] };
  if (sub) return { t: base.under ? 'munder' : 'msub', children: [base, sub] };
  return base;
}

function texCommand(name, tokens, state) {
  if (SYMBOLS[name]) {
    // Greek letters are identifiers; everything else is an operator.
    return /^[a-zA-Z]/.test(SYMBOLS[name]) || /[α-ωΑ-Ω]/.test(SYMBOLS[name])
      ? mi(SYMBOLS[name]) : mo(SYMBOLS[name]);
  }
  if (BIG_OPS[name]) {
    const node = mo(BIG_OPS[name]);
    // \sum_{i=1}^{n} stacks its limits; \int keeps them beside the sign.
    node.under = !['int', 'iint', 'oint'].includes(name);
    return node;
  }
  if (FUNCS.includes(name)) return mi(name);
  if (ACCENTS[name]) {
    return { t: 'mover', accent: true, children: [braceGroup(tokens, state), mo(ACCENTS[name])] };
  }
  switch (name) {
    case 'frac': case 'dfrac': case 'tfrac': {
      const num = braceGroup(tokens, state);
      const den = braceGroup(tokens, state);
      return { t: 'mfrac', children: [num, den] };
    }
    case 'sqrt': {
      // optional [n]
      const tok = tokens[state.i];
      if (tok && tok.k === 'ch' && tok.v === '[') {
        state.i++;
        const idx = [];
        while (tokens[state.i] && tokens[state.i].v !== ']') {
          const t2 = tokens[state.i]; state.i++;
          idx.push(t2.k === 'num' ? mn(t2.v) : t2.k === 'let' ? mi(t2.v) : mo(t2.v));
        }
        if (tokens[state.i]) state.i++;          // past ']'
        return { t: 'mroot', children: [braceGroup(tokens, state), idx.length === 1 ? idx[0] : mrow(idx)] };
      }
      return { t: 'msqrt', children: [braceGroup(tokens, state)] };
    }
    case 'text': case 'textrm': case 'mbox': {
      const g = braceGroup(tokens, state);
      return { t: 'mtext', text: flattenText(g) };
    }
    case 'mathbb': {
      const g = braceGroup(tokens, state);
      const raw = flattenText(g);
      return mi(BB[raw] || raw);
    }
    case 'mathrm': case 'mathbf': case 'mathcal': case 'mathit': case 'boldsymbol':
    case 'operatorname': {
      const g = braceGroup(tokens, state);
      return mi(flattenText(g));
    }
    case 'left': case 'right': {
      const tok = tokens[state.i];
      if (tok) { state.i++; return mo(tok.v === '.' ? '' : String(tok.v)); }
      return null;
    }
    case ',': case ';': case ':': case ' ': case 'quad': case 'qquad':
      return { t: 'mspace', width: name === 'qquad' ? '2em' : name === 'quad' ? '1em' : '0.25em' };
    case '\\': return null;                       // line break inside math: ignore
    case '%': case '&': case '#': case '$': case '_': case '{': case '}':
      return mo(name);                            // escaped literal
    default:
      // Unknown macro: SHOW it. Silently dropping it would turn a broken question
      // into a plausible-looking wrong one.
      return { t: 'mtext', text: '\\' + name };
  }
}

function flattenText(node) {
  if (!node) return '';
  if (node.text != null) return node.text;
  return (node.children || []).map(flattenText).join('');
}

/** LaTeX source -> a `math` spec node. Never throws: bad input becomes literal text. */
export function latexToSpec(tex, display) {
  let children;
  try {
    const tokens = texTokens(tex);
    const state = { i: 0 };
    children = parseTex(tokens, state);
  } catch {
    children = null;
  }
  if (!children || !children.length) return { t: 'code', cls: 'math-raw', text: tex };
  return { t: 'math', display: !!display, tex, children: [mrow(children)] };
}

// ---------------------------------------------------------------------------
// Markdown subset -> spec tree
// ---------------------------------------------------------------------------

/** Inline scan: math, code, bold, italic, escapes. Returns spec nodes. */
function parseInline(src) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', text: buf }); buf = ''; } };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    // backslash escape: \$ \* \_ \` \\ — and \( \[ open math, handled below
    if (src[i] === '\\' && '$*_`\\#'.includes(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }

    let m;
    if ((m = /^\$\$([\s\S]+?)\$\$/.exec(rest)) || (m = /^\\\[([\s\S]+?)\\\]/.exec(rest))) {
      flush(); out.push(latexToSpec(m[1].trim(), true)); i += m[0].length; continue;
    }
    if ((m = /^\$(?!\s)([^$\n]+?)\$/.exec(rest)) || (m = /^\\\(([\s\S]+?)\\\)/.exec(rest))) {
      flush(); out.push(latexToSpec(m[1].trim(), false)); i += m[0].length; continue;
    }
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush(); out.push({ t: 'code', text: m[1] }); i += m[0].length; continue;
    }
    if ((m = /^\*\*([\s\S]+?)\*\*/.exec(rest)) || (m = /^__([\s\S]+?)__/.exec(rest))) {
      flush(); out.push({ t: 'strong', children: parseInline(m[1]) }); i += m[0].length; continue;
    }
    if ((m = /^\*([^*\n]+?)\*/.exec(rest)) || (m = /^_([^_\n]+?)_/.exec(rest))) {
      flush(); out.push({ t: 'em', children: parseInline(m[1]) }); i += m[0].length; continue;
    }
    if (src[i] === '\n') { flush(); out.push({ t: 'br' }); i++; continue; }
    buf += src[i];
    i++;
  }
  flush();
  return out;
}

/**
 * Parse question text into a whitelisted spec tree. PURE — no DOM, no globals,
 * so the safety properties can be unit-tested in Node (see t_richtext_safe).
 */
export function parseRich(src) {
  const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  const blocks = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {                    // fenced code
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;                                          // closing fence
      blocks.push({ t: 'pre', children: [{ t: 'code', text: body.join('\n') }] });
      continue;
    }
    if (!line.trim()) { i++; continue; }            // blank line = block break

    const bullet = /^\s*[-*+]\s+/;
    const number = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || number.test(line)) {
      const ordered = !bullet.test(line);
      const re = ordered ? number : bullet;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push({ t: 'li', children: parseInline(lines[i].replace(re, '')) });
        i++;
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', children: items });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i])
           && !bullet.test(lines[i]) && !number.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ t: 'p', children: parseInline(para.join('\n')) });
  }

  if (!blocks.length) blocks.push({ t: 'p', children: [] });
  return blocks;
}

// ---------------------------------------------------------------------------
// Spec tree -> DOM. The only place that touches the document.
// ---------------------------------------------------------------------------

/** Does this browser actually render MathML? Safari/Firefox/Chrome 109+ do. */
export function supportsMathML() {
  return typeof MathMLElement !== 'undefined';
}

function buildNode(doc, spec, mathOk) {
  if (spec.t === 'text') return doc.createTextNode(spec.text || '');

  // A math node in a browser without MathML degrades to its own source, styled as
  // code. Unreadable-but-honest beats a silently mangled equation.
  if (spec.t === 'math' && !mathOk) {
    const el = doc.createElement('code');
    el.className = 'math-raw';
    el.textContent = spec.tex || '';
    return el;
  }

  const tag = spec.t;
  if (!HTML_TAGS.includes(tag) && !MATHML_TAGS.includes(tag)) {
    // Unreachable from parseRich; a hard stop if it ever becomes reachable.
    return doc.createTextNode('');
  }
  const el = isMath(tag) ? doc.createElementNS(MATHML_NS, tag) : doc.createElement(tag);

  // Attributes are fixed strings decided here, never values from the source.
  if (tag === 'math' && spec.display) el.setAttribute('display', 'block');
  if (tag === 'mover' && spec.accent) el.setAttribute('accent', 'true');
  if (tag === 'mspace' && spec.width) el.setAttribute('width', /^[0-9.]+em$/.test(spec.width) ? spec.width : '0.25em');
  if (spec.cls === 'math-raw') el.className = 'math-raw';

  if (spec.text != null) el.textContent = spec.text;      // author text -> TEXT NODE
  for (const child of spec.children || []) el.appendChild(buildNode(doc, child, mathOk));
  return el;
}

/**
 * Render question text into `el`, replacing its contents. Returns the element.
 * No innerHTML is used anywhere on this path (INV-SEC-6).
 */
export function renderRich(el, src) {
  const doc = el.ownerDocument;
  const mathOk = supportsMathML();
  el.textContent = '';                                    // clear, without parsing
  for (const block of parseRich(src)) el.appendChild(buildNode(doc, block, mathOk));
  return el;
}
