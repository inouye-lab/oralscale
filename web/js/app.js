import { signerUrl, adoptSignerFromToken } from './config.js';
import { Recorder, extForMime, sha256Hex, recordingSupported } from './recorder.js';
import { makeZip } from './zip.js';
import { renderRich } from './richtext.mjs';

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');
const setText = (id, t) => { $(id).textContent = t; };
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
// INV-PLAT-4: move focus to the newly relevant element so a screen-reader / keyboard user
// lands where the sighted user is looking after every state transition.
const focusEl = (id) => { const el = $(id); if (el) setTimeout(() => el.focus({ preventScroll: false }), 60); };
const announce = (t) => { setText('timeAnnounce', t); };

/* Read a signed token's payload for DISPLAY ONLY. Nothing here is trusted — the
 * Signer verifies the signature; this is how the app knows what to put on screen
 * before it has spoken to anyone.
 *
 * UTF-8, NOT latin-1. `atob` returns a BINARY STRING: one character per byte. For
 * an all-ASCII payload that is also the text, which is why this went unnoticed for
 * as long as every field was an id, a hex salt or a boolean. The moment a token
 * carried a human title (INV-USE-1), the em dash in "Oral Quiz 2 — …" arrived as
 * its three UTF-8 bytes and was rendered as three latin-1 characters:
 * `Oral Quiz 2 â€" …`. Observed on a live pilot quiz link, 2026-09-08, before it
 * was handed to anyone.
 *
 * So the bytes are recovered from the binary string and decoded as UTF-8. Pure
 * ASCII decodes identically, so every token minted before this is unaffected. */
function decodePayload(token) {
  try {
    const p = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}
// INV-PLAT-3: a failed request must never leave the student staring at a live
// recorder with a disabled button. A rejected fetch (offline, DNS, a CORS
// preflight the Signer failed) used to propagate out of the click handler and
// freeze the UI on "fetching your question…", so every failure is caught here and
// reported as a normal, actionable outcome instead.
async function api(path, body, retries = 0) {
  // Step name for diagnostics: '/closing' -> 'CLOSING'.
  const STEP = String(path).replace('/', '').toUpperCase();
  // `retries` is for the calls made WHILE RECORDING, where a dropped packet
  // costs the student their whole answer.
  //
  // A single blip used to end the attempt: /closing failed, the recorder was
  // stopped, and the student had to retake — having already spoken for several
  // minutes. On shared campus wifi with a room full of students that is not an
  // edge case, it is a Tuesday.
  //
  // Only NETWORK-level failures are retried (the fetch itself threw). An HTTP
  // answer from the Signer — 403 deadline, 429 cooldown — is a decision, and
  // repeating the question does not change it.
  //
  // Safe because these calls are idempotent: /question and /closing derive their
  // output from the SIGNED TOKEN they are given, so the same token in gives the
  // same code and the same segments out, however many times it is sent.
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(signerUrl() + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      if (attempt >= retries) {
        // Carry the browser's own reason through. `TypeError: Failed to fetch`
        // is what Chrome reports for net::ERR_CONNECTION_CLOSED, and knowing
        // which of the two it was decides whether to look at the network or at
        // the Signer.
        const detail = `${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : 'unknown'}`;
        const code = `E_NET_${STEP}`;
        console.error(`[OralScale] ${code} after ${attempt + 1} attempt(s) — ${detail}`);
        return { ok: false, status: 0, offline: true, code, detail, attempts: attempt + 1,
          data: { code, detail, attempts: attempt + 1,
            error: 'Could not reach the quiz server. Check your connection and try again — '
              + 'if it keeps happening, tell your instructor (the quiz server may be misconfigured).' } };
      }
      // Short and bounded: the per-question deadline is still running, so a long
      // backoff would trade a network failure for a timeout failure.
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

const S = {
  // v3: courseToken (public, class-wide) + studentRef the student supplies here.
  // v2: quizToken (per-student accommodation link) carries identity itself.
  courseToken: null, quizToken: null, pseudonymSalt: null, studentRef: null, courseId: null,
  // v6: the personal quiz key (INV-SEC-8). Required unless the link says otherwise.
  requireKey: true, accessKey: null, allowPrivateCode: true,
  reveal: null, question: null, closing: null, recorder: null,
  // v6: an attempt can hold several questions in ONE continuous recording.
  qNumber: 1, questionCount: 1, awaitingBoundary: false,
  revealClientMs: 0, countdownTimer: null, tailTimer: null, leadTimer: null,
  blob: null, audioBytes: null, sha: null, ext: 'webm', cert: null,
  certFailure: null, durationSec: null,
  // v7: split times on the AUDIO's own clock (INV-GRADE-8). See mark().
  marks: [],
};

/* ---------------------------------------------------------------------------
 * SPLIT TIMES (INV-GRADE-8) — where each question starts and ends IN THE AUDIO.
 *
 * The certificate already carries per-question offsets, but they are measured on
 * the SIGNER's clock, from the moment /reveal was answered. The recording started
 * before that — microphone permission, stream setup, a network round trip — so
 * every server offset sits a second or two ahead of the same moment in the audio,
 * by an amount that varies with the student's phone and their wifi.
 *
 * That is fine for the boundary-code windows, which are ±15 s wide for exactly
 * this reason. It is not fine for cutting the recording up. When the codes are
 * missing and someone has to split the audio BY HAND to find out what a student
 * actually said, "about here, give or take" is the difference between a usable
 * segment and a sentence lost off each end.
 *
 * So the app timestamps the moments it alone can see — the recorder starting, each
 * code appearing, each question appearing, each "I'm done" tap — against
 * `recorder.startedAt`, which IS the audio's t=0. Seconds, from the start of the
 * file, no correction needed.
 *
 * THESE ARE CLIENT-ASSERTED AND ARE NEVER USED FOR INTEGRITY. They are signed into
 * the certificate so they are tamper-evident afterwards, not so they are trusted:
 * the browser could say anything. Every check that decides whether an attempt is
 * genuine — the boundary-code windows, the deadline, the duration — still runs on
 * the Signer's own clock. These exist to make a recording READABLE, which is a job
 * the student has no reason to sabotage and every reason to want done right.
 * ------------------------------------------------------------------------- */
function mark(event, index) {
  if (!S.recorder || !S.recorder.startedAt) return;
  const atSec = Math.round((Date.now() - S.recorder.startedAt)) / 1000;
  // Bounded: a runaway loop must not grow the request body without limit. The
  // ceiling is far above any real attempt (5 questions => ~12 entries).
  if (S.marks.length >= 64) return;
  S.marks.push(index === undefined ? { event, atSec } : { event, atSec, index });
}


/* ---------------------------------------------------------------------------
 * Screen Wake Lock (INV-PLAT-5).
 *
 * The single most likely way an honest student loses an attempt on a phone.
 * A student answering a 120-second question is TALKING, not touching the screen,
 * and the iOS default auto-lock is 30 seconds. When the screen locks, Safari
 * suspends the page: MediaRecorder stops collecting, the countdown intervals
 * freeze — and the Signer's deadline does not, because it runs on the server. The
 * student comes back to a dead attempt, having done nothing wrong.
 *
 * The lock is held for the whole attempt and released the moment recording ends —
 * holding it into the review screen would keep a phone awake for no reason.
 *
 * Best-effort by design. The API is unavailable on older iOS (< 16.4) and needs a
 * secure context, so failure is normal and must never interrupt an attempt: every
 * path here swallows its error. Students on those devices are covered by the
 * written warning in the guide instead, which is why that warning is not
 * redundant.
 *
 * Re-acquired on visibilitychange because the browser drops the lock whenever the
 * page is hidden; without that, one glance at a notification silently ends the
 * protection for the rest of the attempt.
 * ------------------------------------------------------------------------- */
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    // NotAllowedError (not visible, low battery) is expected — never surface it.
    console.warn('[OralScale] wake lock unavailable —', e && e.name);
  }
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch { /* already gone */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  // Only while an attempt is actually live — otherwise we would hold a phone
  // awake on the review screen.
  if (document.visibilityState === 'visible' && S.recorder && !wakeLock) acquireWakeLock();
});

/* ---------------------------------------------------------------------------
 * Unsaved-work guard (INV-PLAT-6).
 *
 * Two moments where leaving the page destroys work that cannot be recovered:
 * mid-recording, and — worse — after the recording is CERTIFIED but before the
 * student has downloaded the .zip. In the second case they have finished the
 * quiz, everything worked, and closing the tab means they submitted nothing. The
 * recording exists only in this tab's memory; there is no draft on a server to
 * recover it from.
 *
 * The browser shows its own generic wording and ignores ours, so this is purely a
 * "are you sure" — but that is exactly the intervention needed for an accidental
 * back-swipe on a phone.
 * ------------------------------------------------------------------------- */
let downloaded = false;
function unsavedWork() {
  if (S.recorder) return true;               // recording in progress
  if (S.blob && !downloaded) return true;    // certified OR backup, never downloaded
  return false;
}
window.addEventListener('beforeunload', (e) => {
  if (!unsavedWork()) return;
  e.preventDefault();
  e.returnValue = '';                        // required by older browsers
});

// ---- identity (v3) ---------------------------------------------------------
// INV-PRIV-2: a plaintext email must never reach the Signer. The student types
// their address; we HMAC it here with the course's PUBLIC salt and send only the
// digest. The autograder re-derives the same value from the Gradescope-
// authenticated email at submission time (INV-SEC-2).
//
// Honest limit: the salt is public, so a party holding it can brute-force a known
// class roster back to an address. This removes plaintext PII from the wire and
// from edge logs; it is not anonymity. Students who need more use a private code,
// which is salted with the server Secret this browser never sees.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function emailRef(salt, email) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(email.trim().toLowerCase()));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'e:' + hex.slice(0, 32);
}

// Accept a key typed with spaces, lowercase, or missing dashes, and fold the
// glyphs the alphabet deliberately excludes (O/0, I/L/1, U/V) — students retype
// these from a Brightspace announcement, so the confusable pairs are designed out.
function normalizeAccessKey(input) {
  const raw = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  return raw.length === 16 ? raw.replace(/(.{4})(?=.)/g, '$1-') : null;
}

// Accept a code typed with spaces, lowercase, or missing dashes.
function normalizePseudonym(input) {
  const raw = String(input || '').toUpperCase().replace(/^P:/, '').replace(/[^0-9A-Z]/g, '');
  if (raw.length !== 12) return null;
  const ref = 'p:' + raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12);
  return /^p:[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(ref) ? ref : null;
}

/* Namespaced BY COURSE. One shared key meant a student enrolled in two OralScale
 * courses had the first course's quiz key offered to the second, which rejects it
 * — a confusing KEY_INVALID for someone who did nothing wrong. Separate
 * subdomains per course would also avoid it; namespacing avoids it even when
 * several courses share one origin, which is the cheaper and more general fix. */
const IDENTITY_KEY = () => `oralscale.identity.${(S && S.courseId) || 'default'}`;

function showIdentity(err) {
  hide('landingCard');
  show('identityCard');
  if (S.requireKey) {
    show('keyMode'); hide('emailMode'); hide('codeMode');
    hide('usePrivateCode'); hide('useEmail');
  } else {
    hide('keyMode'); show('emailMode');
    if (S.allowPrivateCode) show('usePrivateCode');
  }
  setText('identityErr', err || '');
  focusEl(S.requireKey ? 'keyInput' : 'emailInput');
}

function adoptIdentity(ref, label, remember) {
  S.studentRef = ref;
  setText('whoami', label);
  if (remember) {
    try { localStorage.setItem(IDENTITY_KEY(), JSON.stringify({ ref, label, key: S.accessKey })); }
    catch { /* private mode */ }
  }
  hide('identityCard');
  show('landingCard');
  focusEl('landingTitle');
}

/**
 * KEY-ONLY: the key is the whole identity. The shape is checked here so an obvious
 * typo is caught before the mic is opened; whether it is a REAL key is decided by
 * the Signer, which alone holds the Secret. The browser never learns, and never
 * sends, anything about who this student is.
 */
function submitKeyIdentity() {
  const key = normalizeAccessKey($('keyInput').value);
  if (!key) {
    setText('identityErr', 'A quiz key is 16 letters and numbers, like ABCD-EFGH-JKMN-PQRS. '
      + 'Yours was posted in Brightspace.');
    return focusEl('keyInput');
  }
  S.accessKey = key;
  setText('identityErr', '');
  // studentRef is derived BY THE SERVER from the key; the app never sends one.
  adoptIdentity(null, 'quiz key ' + key.slice(-4), true);
}

async function submitIdentity() {
  if (S.requireKey) return submitKeyIdentity();

  const usingCode = !$('codeMode').classList.contains('hidden');
  let ref, label;
  if (usingCode) {
    ref = normalizePseudonym($('codeInput').value);
    if (!ref) {
      setText('identityErr', 'That code should be 12 letters/numbers, like ABCD-EFGH-JKMN.');
      return focusEl('codeInput');
    }
    label = 'private code ' + ref.slice(2);
  } else {
    const email = $('emailInput').value.trim();
    if (!EMAIL_RE.test(email)) {
      setText('identityErr', 'Please enter a valid email address.');
      return focusEl('emailInput');
    }
    ref = await emailRef(S.pseudonymSalt, email);
    label = email;
  }
  setText('identityErr', '');
  adoptIdentity(ref, label, true);
}

/* ---------------------------------------------------------------------------
 * WHICH QUIZ IS THIS? (INV-USE-1)
 *
 * Every assignment has its own signed link, and every link looks the same: the
 * same page, the same "Oral quiz" heading, a token nobody reads. So a student who
 * clicks the Quiz 1 link while sitting in the Quiz 2 assignment gets a normal,
 * working attempt — and only finds out at grading time, when the certificate
 * names the wrong assignment and the whole recording scores nothing.
 *
 * That was the single commonest failure of the first pilot quiz, to the point
 * of leading the instructor's reminder announcement ("the links for every quiz
 * are different").
 *
 * The fix is to say which one this is, before the microphone is touched. It costs
 * nothing and needs nothing new from the server: `courseId` and `assignmentId`
 * are already inside the signed token this page was opened with. That matters for
 * links MINTED BEFORE this change — including the live Quiz 1 link, which is
 * posted, unexpired and must keep working exactly as it is.
 *
 * IT NAMES THE QUIZ AND NOTHING ELSE (instructor decision, 2026-09-08). Just
 * "Oral Quiz 2" and the course. Not the assignment's full title, and not its id —
 * because both of those name the WEEK'S TOPICS. `quiz-02-methods-and-models`
 * tells a student, before they have read a single question, that this quiz is
 * about methods and models. That is a hint, printed above
 * the quiz, in service of a line whose only job is to say *which* quiz this is.
 *
 * It also has to survive the topics changing. A quiz may be re-scoped, or be a
 * review drawing on several weeks; a student who was shown last week's topic
 * names is worse off than one who was shown nothing. The number identifies the
 * quiz without asserting anything about its content.
 *
 * Where the name comes from, in order:
 *   1. `assignmentLabel` — set by the instructor (`shortTitle` in course.json).
 *      The only one they control, and the answer for an id like `review-01`.
 *   2. Derived from the id: `quiz-02-…` -> "Oral Quiz 2".
 *   3. The raw id, as a last resort. Identifying the quiz beats saying nothing,
 *      and an instructor who dislikes it sets `shortTitle`.
 * ------------------------------------------------------------------------- */
function quizTitleFor(assignmentId) {
  // "quiz-01-introduction" -> "Oral Quiz 1". Deliberately conservative: anything
  // that does not clearly encode a quiz number is shown as-is rather than
  // guessed at, because a confidently wrong quiz number is worse than none.
  const m = /(?:^|-)quiz-?0*(\d+)(?:-|$)/i.exec(String(assignmentId || ''));
  return m ? `Oral Quiz ${Number(m[1])}` : null;
}

function showWhichQuiz(p) {
  if (!p || !p.assignmentId) return;              // nothing trustworthy to show
  // `assignmentTitle` is deliberately NOT read. Older links still carry it and it
  // names the week's topics; ignoring it is what makes those links safe too.
  const title = p.assignmentLabel || quizTitleFor(p.assignmentId) || p.assignmentId;
  setText('quizWhichTitle', title);
  setText('quizWhichIds', p.courseTitle || p.courseId || '');
  show('quizWhich');
  document.title = `${title} — OralScale`;
}

// ---- boot -----------------------------------------------------------------
(function boot() {
  const token = location.hash.replace(/^#/, '').trim();
  if (!token) return fail('No quiz link', 'Open the unique link posted in Gradescope for this assignment.', 'E_NO_LINK');
  if (!recordingSupported()) {
    return fail('Recording not supported',
      'This browser can’t record audio. Use Safari on iPhone, Chrome on Android, or a desktop browser, and make sure you opened this over https.', 'E_NO_RECORDER');
  }
  const p = decodePayload(token);
  /* BEFORE the expiry check, so it is on screen for the FAILURE cards too. The
   * banner lives in <header>, outside every card, and `fail()` does not touch it.
   * A student staring at "this quiz link has expired" is in exactly the position
   * where knowing WHICH quiz expired decides what they do next — the expired link
   * may also be the wrong one, and an expired Quiz 1 link is a different problem
   * from an expired Quiz 2 link. */
  showWhichQuiz(p);
  if (p && p.exp && Date.now() / 1000 > p.exp) {
    return fail('Link expired', p && p.kind === 'course'
      ? 'This quiz link has expired. Ask your instructor for the current link.'
      : 'This quiz link has expired. Get a fresh link from Gradescope (resubmit to generate one).', 'E_LINK_EXPIRED');
  }

  if (p && p.kind === 'course') {
    // v3 public class link: the student identifies themselves here.
    // The Signer URL rides in the signed token, so web/ needs no per-deploy edit.
    adoptSignerFromToken(p);
    S.courseToken = token;
    S.courseId = p.courseId || null;      // namespaces the cached identity
    S.pseudonymSalt = p.pseudonymSalt;
    // Fails CLOSED, like the Signer: a link that says nothing asks for a key.
    S.requireKey = p.requireKey !== false;
    S.allowPrivateCode = p.allowPrivateCode !== false;
    if (!S.pseudonymSalt) {
      return fail('Link misconfigured', 'This quiz link is missing its course salt. Ask your instructor to regenerate it.', 'E_LINK_NO_SALT');
    }
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(IDENTITY_KEY()) || 'null'); } catch { /* ignore */ }
    if (saved && (S.requireKey ? saved.key : saved.ref)) {
      S.studentRef = saved.ref || null;
      S.accessKey = saved.key || null;
      setText('whoami', saved.label || saved.ref || 'you');
      show('landingCard');
    } else {
      showIdentity();
    }
    return;
  }

  // v2 per-student accommodation link: identity travels in the signed token.
  S.quizToken = token;
  S.requireKey = false;          // the Signer minted this link itself; no key needed
  if (p && p.studentRef) setText('whoami', `${p.studentRef}`);
  $('changeIdentity').classList.add('hidden');
  show('landingCard');
})();

/* ---------------------------------------------------------------------------
 * Credential fields: masked, revealable, and legible enough to check.
 *
 * These are password inputs so a password manager will offer to save the key and
 * fill it back. That is the actual goal: the key lasts the whole term, and a
 * student who has to hunt for it every time is a student who ends up keeping it
 * somewhere worse — a screenshot, a note, a message to a friend.
 *
 * Masking creates one new problem, which is that you cannot tell a mistyped key
 * from last term's. So while hidden, the last four characters are shown beneath
 * the field. Four of sixteen is enough to recognise your own key and useless to
 * anyone reading over your shoulder — and the app already labels a saved
 * identity the same way ("quiz key 1PFS"), so it is a shape students will
 * recognise rather than a new idea.
 * ------------------------------------------------------------------------- */
function wireCredentialField(inputId, toggleId, hintId, label) {
  const input = $(inputId);
  const toggle = $(toggleId);
  const hint = $(hintId);
  if (!input || !toggle || !hint) return;

  const tail = (v) => String(v).replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
  const refresh = () => {
    const hidden = input.type === 'password';
    const t = tail(input.value);
    // Only worth showing once there is enough typed to identify, and only while
    // the value is actually hidden — otherwise it just repeats what is on screen.
    if (hidden && t.length === 4) {
      setText(hintId, `ends in ${t}`);
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  };

  toggle.addEventListener('click', () => {
    const nowVisible = input.type === 'password';
    input.type = nowVisible ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(nowVisible));
    toggle.setAttribute('aria-label', `${nowVisible ? 'Hide' : 'Show'} ${label}`);
    refresh();
    // Keep the caret where it was: a reveal that dumps you at the start of the
    // field makes correcting a typo harder than not revealing at all.
    const pos = input.value.length;
    input.focus();
    try { input.setSelectionRange(pos, pos); } catch { /* type change can reset it */ }
  });

  input.addEventListener('input', refresh);
  refresh();
}

wireCredentialField('keyInput', 'keyReveal', 'keyHint', 'quiz key');
wireCredentialField('codeInput', 'codeReveal', 'codeHint', 'private code');

$('identityNext').addEventListener('click', () => submitIdentity());
for (const id of ['emailInput', 'codeInput', 'keyInput']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submitIdentity(); });
}
$('usePrivateCode').addEventListener('click', () => {
  hide('emailMode'); show('codeMode'); hide('usePrivateCode'); show('useEmail');
  setText('identityErr', ''); focusEl('codeInput');
});
$('useEmail').addEventListener('click', () => {
  hide('codeMode'); show('emailMode'); hide('useEmail'); show('usePrivateCode');
  setText('identityErr', ''); focusEl('emailInput');
});
$('changeIdentity').addEventListener('click', () => {
  try { localStorage.removeItem(IDENTITY_KEY()); } catch { /* ignore */ }
  showIdentity();
});
// Any unexpected rejection inside an attempt must land on the failure card with a
// retake, never leave the UI mid-state.
const guard = (fn) => (...a) => Promise.resolve(fn(...a)).catch((e) => {
  try { if (S.recorder) { S.recorder.stop().catch(() => {}); S.recorder = null; } } catch { /* ignore */ }
  fail('Something went wrong', (e && e.message ? e.message + ' — ' : '')
    + 'Retake for a fresh question; nothing has been submitted.',
    { code: 'E_UNEXPECTED', detail: e && e.name ? `${e.name}: ${e.message}` : String(e) });
});
// ---------------------------------------------------------------------------
// Extended-time accommodation (INV-ACCOM-1).
//
// Collapsed by default. Most students do not have an accommodation, and putting
// a disability question in front of everyone is both noise and a nudge. Nothing
// is remembered between attempts on purpose: a stored "2x" that silently
// reapplied months later would be a claim the student did not make today.
// ---------------------------------------------------------------------------
$('accomToggle').addEventListener('click', () => {
  const panel = $('accomPanel');
  const open = panel.classList.toggle('hidden') === false;
  $('accomToggle').setAttribute('aria-expanded', String(open));
  if (open) $('accomSelect').focus();
  else $('accomSelect').value = '1';        // collapsing means "never mind"
});

/* What the student selected, as a number. Anything unexpected becomes 1 — the
   server is the authority and rejects off-ladder values, so the client never
   needs to be clever here. */
function claimedTimeMultiplier() {
  const v = Number($('accomSelect').value);
  return Number.isFinite(v) && v > 1 ? v : 1;
}

$('startBtn').addEventListener('click', guard(beginAttempt));
// One button, two phases: "I'm done" starts the closing code, "Finish" ends it.
// One button, three phases: "I'm done with this question" advances a segment,
// "I'm done" closes the last one, "Finish" ends the recording.
$('stopBtn').addEventListener('click', guard(() => (S.closing ? finishRecording() : beginClosing('stopped'))));
$('downloadBtn').addEventListener('click', downloadPackage);
$('retakeBtn').addEventListener('click', () => location.reload());
$('retryBtn').addEventListener('click', () => location.reload());

/* `info` is the api() result, or a bare code string. Whatever identifying detail
   exists is shown — a student who can quote E_NET_CLOSING turns "it broke" into
   a five-second diagnosis, and the alternative is guessing from a screenshot. */
function fail(title, msg, info) {
  releaseWakeLock();
  hide('identityCard'); hide('landingCard'); hide('recordCard'); hide('reviewCard');
  setText('failTitle', title); setText('failMsg', msg);

  const r = typeof info === 'string' ? { code: info } : (info || {});
  const code = r.code || (r.data && r.data.code)
    || (r.status ? `E_HTTP_${r.status}` : null);
  const detail = r.detail || (r.data && r.data.detail);
  const attempts = r.attempts || (r.data && r.data.attempts);
  if (code) {
    const bits = [`Error code: ${code}`];
    if (attempts > 1) bits.push(`after ${attempts} attempts`);
    if (detail) bits.push(detail);
    setText('failCode', bits.join(' · ') + '  — quote this to your instructor.');
    show('failCode');
    console.error(`[OralScale] ${code}${detail ? ' — ' + detail : ''}`);
  } else {
    hide('failCode');
  }
  show('failCard');
  focusEl('failTitle');
}

// ---- begin attempt: CAPTURE BEFORE QUESTION -------------------------------
async function beginAttempt() {
  hide('landingCard');
  show('recordCard');
  setBanner('Starting microphone…');
  // 1) Start recording FIRST (within this user gesture — required by iOS).
  S.recorder = new Recorder();
  try {
    await S.recorder.start();
  } catch (e) {
    return fail('Microphone blocked',
      'We couldn’t access your microphone. Allow mic access in your browser settings and reopen the link. ' +
      '(On iPhone: Settings → Safari → Microphone, or tap “AA” in the address bar → Website Settings.)', 'E_MIC_BLOCKED');
  }
  S.marks = [];
  mark('recordingStart');             // t=0 of the audio file, by definition
  $('recDot').classList.add('live');
  S.blob = null; S.audioBytes = null; S.sha = null; S.cert = null; S.certFailure = null;
  downloaded = false;                 // a new attempt is unsaved work again
  // Only now: requesting before the mic is live would race the permission prompt.
  acquireWakeLock();
  setBanner('Recording… fetching your question.');

  // 2) Only now ask the server to reveal the question.
  // The accommodation claim rides with the reveal. It is only ever sent on the
  // course-link paths: a legacy quizToken already carries an instructor-minted
  // multiplier, which is an authorisation rather than a claim and must not be
  // overridable from here.
  const timeMultiplier = claimedTimeMultiplier();
  const { ok, status, data } = await api('/reveal', S.courseToken
    ? (S.requireKey
      // Key-only: the key IS the identity. Nothing else is sent (INV-PRIV-2).
      ? { courseToken: S.courseToken, accessKey: S.accessKey, timeMultiplier }
      : { courseToken: S.courseToken, studentRef: S.studentRef, timeMultiplier })
    : { quizToken: S.quizToken });
  if (!ok) {
    await S.recorder.stop().catch(() => {});
    S.recorder = null;
    if (status === 0) return fail('No connection to the quiz server', data.error, data);
    // A cooldown is not an error the student caused — say what to do, not "failed".
    if (data.code === 'COOLDOWN') {
      return fail('Hang on a moment', data.error
        || 'You opened a question recently and did not finish it. Try again in a few minutes.', data);
    }
    // A key problem is fixable RIGHT HERE, so send them back to the field rather
    // than to a dead-end failure card (INV-PLAT-3).
    if (data.code === 'KEY_REQUIRED' || data.code === 'KEY_INVALID') {
      S.requireKey = true;
      hide('recordCard');
      try { localStorage.removeItem(IDENTITY_KEY()); } catch { /* ignore */ }
      return showIdentity(data.error);
    }
    if (data.code === 'KEY_LOCKED') return fail('Too many tries', data.error, data);
    const msg = status === 403 ? (data.error || 'This link expired — get a fresh one from Gradescope.')
      : (data.error || 'Could not start the quiz. Please reopen the link from Gradescope.');
    return fail('Could not start', msg, data);
  }
  S.reveal = data;
  S.revealClientMs = Date.now();
  S.questionCount = Number(data.questionCount || 1);
  S.qNumber = 1;
  showProgress();

  // PHASE 1 — the first boundary code alone. The question does not exist client-side
  // yet; the Signer withholds it until codeLeadSec has passed, so reading the code
  // cannot be skipped and cannot be spoiled by watching the network.
  showCode(data.code || data.openingCode, 'Say this code aloud:', 0);
  setText('recHint', 'Read the digits out loud. Your question appears in a moment — '
    + 'the timer does not start until it does.');
  setBanner('');
  focusEl('nonceVal');
  await waitForQuestion();
}

/** "Question 2 of 3" — shown only when there is more than one. */
function showProgress() {
  if (S.questionCount <= 1) return hide('qProgress');
  setText('qProgress', `Question ${S.qNumber} of ${S.questionCount}`);
  show('qProgress');
}

/**
 * Poll for the question. The wait is server-authoritative: /question refuses until
 * codeLeadSec has elapsed on ITS clock, so a fiddled client clock gains nothing.
 */
async function waitForQuestion() {
  const lead = Number(S.reveal.codeLeadSec || 0);
  const dueMs = S.revealClientMs + lead * 1000;

  const tick = () => {
    const left = Math.max(0, Math.ceil((dueMs - Date.now()) / 1000));
    setText('nonceIdx', left > 0
      ? `Read the digits one at a time. Question in ${left}s…`
      : 'Read the digits one at a time.');
  };
  tick();
  S.leadTimer = setInterval(tick, 250);

  for (;;) {
    await new Promise((r) => setTimeout(r, Math.max(300, dueMs - Date.now())));
    const { ok, data } = await api('/question', { revealToken: S.reveal.revealToken }, 3);
    if (ok && data.ready) {
      clearInterval(S.leadTimer);
      S.question = data;
      if (data.questionCount) S.questionCount = Number(data.questionCount);
      if (data.qNumber) S.qNumber = Number(data.qNumber);
      showProgress();
      renderQuestion(data);
      startCountdown(data.limitSec, data.bufferSec);
      return;
    }
    if (!ok) {
      clearInterval(S.leadTimer);
      await S.recorder.stop().catch(() => {});
      S.recorder = null;
      return fail('Could not start', data.error || 'The quiz server did not send your question.', data);
    }
    // not ready yet — the server said how long to wait
    await new Promise((r) => setTimeout(r, Math.max(300, (data.availableInSec || 1) * 1000)));
  }
}

function renderQuestion(d) {
  mark('question', Number(d.qIndex || 0));
  setBanner('');
  const q = d.question;
  /* THE META LINE IS THE SERVER'S CALL, NOT OURS (INV-COURSE-5).
   *
   * `topic` and `principle` arrive only for an assignment that set
   * `showQuestionMeta`; for every other one the Signer does not send them and the
   * bundle does not contain them. So the line is not hidden here — there is
   * nothing to hide, and a student who reads the network traffic sees the same
   * thing a student who reads the screen does.
   *
   * Why it is off by default: `principle` states the durable idea the question is
   * testing, printed directly above the question. On "an interesting question
   * comes up in class and the instructor answers it, but nothing about it appears
   * on a slide — can it show up on a quiz?" the line read "anything stated or
   * explained in lecture is examinable, whether or not it appears on a slide",
   * which is the answer.
   *
   * `difficulty` is part of the same line and is withheld with them. On its own it
   * renders as a bare "CORE" above the prompt — it tells a student how worried to
   * be and nothing they can act on. It is still in the deployed bundle, because
   * `difficultyMix` selects on it, but that is a server-side use and the Signer no
   * longer puts it on the wire. */
  const meta = [q.topic, q.principle, q.difficulty].filter(Boolean).join(' · ');
  setText('qMeta', meta);
  $('qMeta').classList.toggle('hidden', !meta);
  // Markdown + LaTeX via a whitelist DOM builder — never innerHTML (INV-SEC-6).
  renderRich($('qPrompt'), q.prompt);
  show('qBox');
  // The hint still says "your question appears in a moment" until we replace it —
  // it is the only text on screen that would now be describing the past.
  setText('recHint', S.questionCount > 1 && S.qNumber < S.questionCount
    ? 'Speak clearly. Tap the button when you have finished THIS question — the next one follows.'
    : 'Speak clearly. Recording continues until you finish the last step.');
  setText('stopBtnLabel', S.questionCount > 1
    ? (S.qNumber < S.questionCount ? 'I’m done with this question' : 'I’m done — last question')
    : 'I’m done');
  $('stopBtn').disabled = false;
  focusEl('qPrompt');                    // INV-PLAT-4
}

// ---- countdown ------------------------------------------------------------
// Two clocks, deliberately: `limitSec` is the promise made to the student and is
// what the countdown shows; `bufferSec` is the grace afterwards for finishing a
// sentence. Ending a recording mid-word to enforce a round number would be a
// worse assessment, and a limit that silently means "limit plus a bit" would be a
// dishonest one — so the buffer is visible and separate.
function startCountdown(limitSec, bufferSec) {
  // Starts when the QUESTION appears, so the code-reading seconds are not deducted
  // from thinking time.
  const targetMs = Date.now() + limitSec * 1000;
  const hardStopMs = targetMs + Math.max(0, Number(bufferSec) || 0) * 1000;
  const warned = { 60: false, 15: false, over: false };
  const tick = () => {
    const left = (targetMs - Date.now()) / 1000;
    const t = $('timer');
    if (left > 0) {
      setText('timer', fmt(left));
      t.classList.toggle('warn', left <= 60 && left > 15);
      t.classList.toggle('crit', left <= 15);
      // INV-PLAT-4: the visual timer is aria-hidden (it would spam a live region), so announce
      // the two warnings a sighted user gets from the colour change.
      if (left <= 60 && left > 15 && !warned[60]) { warned[60] = true; announce('One minute remaining.'); }
      if (left <= 15 && !warned[15]) { warned[15] = true; announce('15 seconds remaining.'); }
    } else {
      setText('timer', '0:00');
      t.classList.remove('warn');
      t.classList.add('crit');
      if (!warned.over) {
        warned.over = true;
        setBanner('Time’s up — finish your sentence.');
        announce('Time is up. Finish your sentence.');
      }
      if (Date.now() >= hardStopMs) { guard(beginClosing)('deadline'); return; }
    }
  };
  tick();
  S.countdownTimer = setInterval(tick, 200);
}

// ---- challenge codes (bookend: one at the start, one at the end) ----------
// No mid-answer codes by design — interrupting an explanation degrades the very
// thing being graded. See models/06 and DESIGN-QUESTIONS C2.
function showCode(code, label, boundary) {
  if (boundary !== undefined) mark('code', boundary);
  const spaced = String(code).split('').join(' ');
  setText('nonceLabel', label);
  setText('nonceVal', spaced);
  setText('nonceIdx', 'Read the digits one at a time.');
  // INV-PLAT-4: announce as separated digits so a screen reader says
  // "four, seven, one" rather than "four hundred seventy-one thousand…".
  setText('nonceSr', `${label} ${String(code).split('').join(', ')}`);
  const box = $('nonceBox');
  box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
}

// ---- segment boundaries (one code between every pair of questions) --------
// The student taps "I'm done with this question" (or the timer expires). The
// recorder KEEPS RUNNING: we hide the question, fetch a code that did not exist
// until this moment, and they read it aloud. That single code closes the answer
// just given AND opens the next question — one reading, two jobs — so a recording
// is pinned at every boundary, not only at its two ends (INV-INTEGRITY-5).
//
// Hiding the question makes "I'm done" a real commitment rather than a soft pause,
// and it stays hidden while the next one loads: no going back to an earlier answer.
async function beginClosing(reason) {
  if (S.closing) return;                    // deadline and tap can race
  if (S.awaitingBoundary) return;           // …and so can a double tap mid-boundary
  S.awaitingBoundary = true;
  // The TAP, not the reply to it: /closing is a network round trip away, and it is
  // the tap that ends the answer in the audio.
  mark(reason === 'deadline' ? 'deadline' : 'done', Number(S.qNumber) - 1);
  clearInterval(S.countdownTimer); clearInterval(S.leadTimer);
  $('stopBtn').disabled = true;
  if (!S.recorder) return;

  hide('qBox');                             // question disappears — answer is final
  setBanner(reason === 'deadline' ? 'Time’s up — one last step.' : 'Almost done — one last step.');

  const { ok, data } = await api('/closing', { questionToken: S.question.questionToken }, 3);
  if (!ok) {
    S.awaitingBoundary = false;
    await S.recorder.stop().catch(() => {});
    S.recorder = null;
    return fail('Could not finish in time',
      data.error || 'The recording window closed. Retake for a fresh question — it only takes a moment.', data);
  }
  S.awaitingBoundary = false;

  if (data.more) {
    // MORE QUESTIONS — the same digits end this answer and start the next one.
    S.qNumber = Number(data.nextQNumber || S.qNumber + 1);
    showProgress();
    showCode(data.code || data.closingCode, 'Say this code aloud:', Number(data.answered));
    setText('recHint', 'Read the digits out loud. Your next question appears in a moment — '
      + 'the timer does not start until it does.');
    setBanner(`Answer ${data.answered} of ${S.questionCount} saved. Keep recording.`);
    focusEl('nonceVal');
    S.reveal = { revealToken: data.nextRevealToken, codeLeadSec: S.reveal.codeLeadSec };
    S.revealClientMs = Date.now();
    return waitForQuestion();
  }

  // LAST QUESTION — this is the closing code; read it and finish.
  S.closing = data;
  setBanner('');
  showCode(data.code || data.closingCode, 'Last step — say these digits aloud:',
    Number(data.answered));
  setText('recHint', 'Read them out loud, then tap Finish. Keep talking until you do.');

  // Auto-finish just INSIDE the server's tail window, leaving room for hashing the
  // blob and one round trip. The tail is now short by design (2 s per code digit,
  // ~12 s at six digits), so the old fixed 8 s of headroom would have eaten most
  // of it — take 2 s, never dropping below 6 s of reading time.
  const tailLimit = Math.max(6, Number(data.tailLimitSec) || 12);
  const tail = Math.max(6, tailLimit - 2);
  setText('stopBtnLabel', 'Finish & submit');
  $('stopBtn').disabled = false;
  focusEl('stopBtn');                        // INV-PLAT-4
  S.tailTimer = setTimeout(() => finishRecording(), tail * 1000);
}

// ---- stop / finish --------------------------------------------------------
async function finishRecording() {
  clearTimeout(S.tailTimer);
  releaseWakeLock();
  $('recDot').classList.remove('live');
  $('stopBtn').disabled = true;
  if (!S.recorder) return;
  setBanner('Finalizing…');
  mark('finish');
  const blob = await S.recorder.stop();
  const durationSec = Math.round((Date.now() - S.recorder.startedAt) / 1000);
  S.durationSec = durationSec;          // shown on the review card (see enterReview)
  const clientMarks = S.marks.slice();
  S.recorder = null;
  if (!blob || blob.size === 0) return fail('No audio captured', 'We didn’t capture any audio. Retake for a fresh question.', 'E_NO_AUDIO');

  S.blob = blob; S.ext = extForMime(blob.type);
  const buf = await blob.arrayBuffer();
  S.audioBytes = new Uint8Array(buf);
  S.sha = await sha256Hex(buf);

  // The most expensive call in the flow to lose: the student has finished
  // speaking and the recording is complete but uncertified. Retried on network
  // failure only — /finish derives the certificate from the signed closingToken
  // and the audio hash, so re-sending the same pair is safe.
  const { ok, data } = await api('/finish', {
    closingToken: S.closing.closingToken, audioSHA256: S.sha, durationSec, clientMarks,
  }, 3);
  if (!ok) {
    // e.g. DEADLINE_EXCEEDED or a network failure after all retries. The audio is
    // already complete and exists nowhere else, so preserve it as an explicitly
    // UNTRUSTED backup. It carries no certificate and therefore earns 0
    // automatically (INV-INTEGRITY-7); Gradescope retains it for manual review.
    hide('recordCard'); show('reviewCard');
    S.cert = null;
    S.certFailure = {
      code: data.code || 'E_CERTIFICATE_UNAVAILABLE',
      message: data.error || 'The quiz server could not certify this recording.',
    };
    enterReview(false,
      'UNCERTIFIED BACKUP — this recording will score 0 automatically. Download and upload it '
      + 'only as evidence for instructional staff. A fresh certified attempt is strongly preferred; '
      + 'staff may manually override the 0 after careful review if you cannot retry.');
    return;
  }
  S.cert = { ...data.certificate, certificateToken: data.certificateToken };
  hide('recordCard'); show('reviewCard');
  enterReview(true, 'Certified ✓ — download and upload to Gradescope.');
}

// ---- review / package -----------------------------------------------------
/* ---------------------------------------------------------------------------
 * THE PLAYER'S OWN LENGTH IS NOT TRUSTWORTHY, SO WE PRINT OURS.
 *
 * A student finishes a 21-second answer and the playback bar looks short, or the
 * time only fills in after they have listened to the whole thing. It reads as a
 * truncated recording, which is the most alarming thing this screen could
 * imply — reported by a TA on 2026-09-09.
 *
 * Nothing is truncated. `MediaRecorder` writes a LIVE WebM/Matroska stream, and a
 * live muxer cannot write a Duration into the header: it does not know the length
 * when the header goes out, and it never seeks back to patch it. So
 * `HTMLMediaElement.duration` is `Infinity` until the browser has decoded to the
 * end, and the built-in controls draw whatever they can from that.
 *
 * It is a DISPLAY problem only, and the rest of the system already knew:
 *   - `durationSec` in the Certificate comes from the recorder clock, never the
 *     container, so the Signer's window check is unaffected;
 *   - the autograder's `audio_duration_sec` names this exact case and falls
 *     through to the decoded packet timeline (INV-INTEGRITY-3).
 *
 * WHY NOT THE USUAL FIX. The known trick is to seek the element to a huge time so
 * the browser scans the file and learns the duration. It works, and it is a seek
 * on the ONLY COPY of a recording the student has not downloaded yet — on an
 * element whose failure modes vary by browser. The recording is not worth a
 * cosmetic scrubber. We already know the true length from the recorder clock, so
 * we say it, and say why the control disagrees.
 * ------------------------------------------------------------------------- */
function enterReview(certified, msg) {
  const url = URL.createObjectURL(S.blob);
  $('player').src = url;
  const d = Number(S.durationSec);
  if (Number.isFinite(d) && d > 0) {
    setText('durationOut', fmt(d));
    show('durationNote');
  } else {
    hide('durationNote');
  }
  setText('certState', msg);
  $('certState').className = 'certstate ' + (certified ? 'ok' : 'err');
  $('downloadBtn').disabled = !(S.blob && S.audioBytes);
  setText('downloadBtnLabel', certified
    ? 'Download & upload to Gradescope'
    : 'Download UNCERTIFIED BACKUP');
  if (certified) hide('backupHelp'); else show('backupHelp');
  setText('shaOut', S.sha || '');
  focusEl('reviewTitle');                 // INV-PLAT-4
}

async function downloadPackage() {
  const c = S.cert;
  const audioName = `answer.${S.ext}`;
  let files, filename;
  if (c) {
    const certObj = { ...c, audioFile: audioName,
      note: 'OralScale submission — upload this whole .zip to Gradescope.' };
    files = [
      { name: audioName, data: S.audioBytes },
      { name: 'certificate.json', data: new TextEncoder().encode(JSON.stringify(certObj, null, 2)) },
    ];
    filename = `oralscale_${c.studentRef.replace(/[^a-z0-9]+/gi, '-')}_${c.assignmentId}_${c.attemptId}.zip`;
  } else {
    // This marker is deliberately NOT signed and the autograder trusts none of
    // it. Its only job is to make the artifact unmistakable to a human; audio
    // without certificate.json always scores 0 regardless of this file.
    const token = decodePayload(S.closing?.closingToken || S.reveal?.revealToken || '') || {};
    const marker = {
      format: 'oralscale-uncertified-backup-v1', certified: false,
      warning: 'NO CERTIFICATE. Automatic score: 0. Instructor review required for any override.',
      courseId: S.courseId || token.courseId || null,
      assignmentId: token.assignmentId || null,
      attemptId: token.attemptId || null,
      audioFile: audioName, audioSHA256: S.sha,
      failure: S.certFailure || { code: 'E_CERTIFICATE_UNAVAILABLE' },
      note: 'Upload only as a backup if a fresh certified attempt is not possible.',
    };
    files = [
      { name: audioName, data: S.audioBytes },
      { name: 'UNCERTIFIED_BACKUP.json',
        data: new TextEncoder().encode(JSON.stringify(marker, null, 2)) },
    ];
    const aid = String(marker.assignmentId || 'unknown-assignment').replace(/[^a-z0-9-]+/gi, '-');
    filename = `oralscale_UNCERTIFIED_BACKUP_${aid}_${Date.now()}.zip`;
  }
  const zip = makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  downloaded = true;                      // the unload guard can stand down
  setText('certState', c
    ? 'Downloaded ✓ — now upload it to Gradescope. You can retake for a new question anytime.'
    : 'UNCERTIFIED BACKUP downloaded. Upload it to Gradescope as evidence, then make a fresh '
      + 'certified attempt if you can. It will receive an automatic 0 unless staff override it.');
}

function setBanner(msg) { setText('banner', msg); }
