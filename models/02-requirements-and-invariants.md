# 02 — Requirements & Invariants

Functional requirements (FR) describe *what it does*. Invariants (INV) are the hard,
**testable** properties that must always hold; each has a stable ID and a test in
[07-test-model](07-test-model.md). Assumptions (A) are things we take as true; if an
assumption breaks, revisit the design.

## Functional requirements
- **FR-1 Deliver** — a Student opens the public CourseLink, enters their AccessKey — **the only
  thing they type; no email, no login** — and receives `questionsPerAttempt` random, distinct
  Questions from the Week's Bank, one after another in a single continuous recording, with no AI
  call at quiz time.
- **FR-2 Capture** — the app records a spoken answer in-browser on desktop and mobile
  (iOS/Android), audio never leaving the tab except to Gradescope.
- **FR-3 Certify** — the app obtains a Certificate binding the audio to the question and a
  validated real-time window.
- **FR-4 Submit** — the Student uploads one `.zip` to Gradescope.
- **FR-5 Grade** — the autograder validates integrity, transcribes, grades content via
  Purdue GenAI, and writes a Gradescope score + feedback.
- **FR-6 Retake** — unlimited retakes, each a fresh Question, subject to the anti-shopping
  cooldown in INV-SEC-7 (finishing an Attempt clears it, so answering is never penalised). Attempt
  combination is **not** implemented in OralScale, and Gradescope cannot do it either: it grades the
  **active** submission — the newest unless the Student activates an earlier one. There is no
  "highest score" setting to turn on. The property is delivered by telling the Student, so the
  Student-facing text must never promise that their best attempt counts — see INV-DEPLOY-1.
- **FR-7 Configure** — instructor knobs, per Assignment with fallback to course `defaults`:

  | Knob | Default | Controls |
  |------|---------|----------|
  | `questionsPerAttempt` | 5 | Questions in one recording |
  | `limitSec` | 120 | answer time **per Question** — the countdown the Student sees. A ceiling, not an expectation: Students commit early, and a good answer to one of these runs about a minute |
  | `bufferSec` | 20 | grace after 0:00 to finish a sentence, per Question |
  | `codeLeadSec` | 5 | how long the boundary code is shown before the Question |
  | `tailLimitSec` | 20 | seconds between the final code and `/finish` |
  | `codeDigits` | 6 | length of a spoken boundary code (4–8) |
  | `difficultyMix` | — | per-slot difficulty, e.g. `["intro","core","stretch"]` |
  | `requireAccessKey` | **true** | the enrolment gate + key-only identity (INV-SEC-8) |
  | `accessKeyEpoch` | 1 | course-wide; bumping it re-mints every key |
  | `allowPrivateCode` | true | offer the `p:` opt-out (open-mode courses only) |
  | `maxPoints` | 10 | Gradescope points for the Assignment |
  | `scoreAggregation` | `dropLowest` | how Questions combine: `dropLowest` (best N−1 of N), `mean`, or `min`. The dropped Question's feedback is still shown, marked as not counting. **The rule is NAMED in the student's `Overall Score` heading** — an "Overall" label over a number that is not the average of the marks above reads as an arithmetic error, so the heading says which rule produced it and the body says which Questions counted |
| `gradingBackend` | `local` | `local` (bundled model, transcript never leaves the container) or `genai` (Purdue GenAI). **No fallbacks** — the named grader runs or the submission is not graded (INV-GRADE-1) |
  | `scoring` | bands | `"points"` (or `{mode:"points", requiredWeight, optionalWeight, strongAt, fullAt, falseClaimCap}`) has the model judge each point and computes the band in code (INV-GRADE-10); adding `table` (with `novelWeight`, `novelCap`, `falseClaimCapScore`, `noCoreCapScore`) reads the mark straight off the instructor's curve instead of the bands and credits correct points nobody listed; absent keeps the band ladder |
  | `showTranscript` | true | whether the Student sees the automatic transcript |
  | `retakeCooldownSec` / `cooldownClearsAfterSec` | 300 / 60 | anti-shopping (INV-SEC-7) |
  | `linkTtlMin` | 30 | TTL of legacy accommodation links |
  | `timeMultiplier` | 1 | per-Student extended time (scales `limitSec` **and** `bufferSec`) |

  `limitSec` and `bufferSec` are separate on purpose: the first is the promise made to the
  Student, the second is the humane slack on top of it, and an Instructor must be able to move
  one without moving the other. Server clock skew is a **third** thing (`GRACE_SEC`, deployment-
  wide) and is never folded into either. The number of codes is **not** a knob: always one per
  Segment boundary, N+1 for N Questions (decision C2).
- **FR-8 Portable** — a new course = one new `courses/<id>` folder holding **both** its config and
  its Banks; zero code change. The folder is self-contained so it can be its own private
  repository (INV-COURSE-1, INV-COURSE-2).
- **FR-9 Author** — instructor mass-generates a Bank with an LLM, validates, freezes.
- **FR-10 Enrol** — the instructor mints one AccessKey per Student per Course
  (`tools/gen-access-keys.js --roster <export.csv|xlsx>`) and posts them in Brightspace. CSV and
  XLSX exports are both accepted, including namespace-prefixed OOXML produced by LMS exporters. That is the
  **whole** enrolment procedure: keys are *derived and self-authenticating*, so nothing is stored
  and nothing is uploaded to the Signer — adding a student mid-term is the same command plus a
  Brightspace post. A lost key is re-issued by re-running the tool, or by the Student submitting to
  Gradescope with no recording, which prints their own key in the feedback.

## Integrity invariants (real-time authorship)
- **INV-INTEGRITY-1 (byte binding)** — a Certificate is valid only for the exact audio bytes
  whose SHA-256 equals `certificate.audioSHA256`. Any change → reject.
- **INV-INTEGRITY-2 (window binding)** — `/finish` issues a Certificate only if
  `t_finish ≤ deadline` where `deadline = t_reveal + limitSec·timeMultiplier + grace`, all on
  the **server clock**. No client timestamp is trusted.
- **INV-INTEGRITY-3 (duration ≈ window)** — the autograder rejects if the true audio duration
  `D` (measured from the file) exceeds `elapsed + tol` or `limit + grace`. A pre-recorded file
  longer than the live window cannot be submitted.
- **INV-INTEGRITY-4 (opening freshness)** — the first boundary code (`b0`) is unpredictable and
  revealed only at `tReveal`; it must appear near the start of the transcript. Audio content
  provably postdates the reveal.
  - The **question is withheld** for `codeLeadSec` (default 5 s) and served by a separate
    `/question` call, so the student reads the code before seeing anything to answer. Withholding
    it *server-side* is the point: hiding it in the client would still ship it in the `/reveal`
    response, where a student watching the network could read it early.
  - The answer clock starts at `tQuestion`, not `tReveal`, so seconds spent reading the code are
    not deducted from thinking time — and that holds for **every** Segment, not just the first.
    Total recording budget is `N·(codeLeadSec + limitSec) + tailLimitSec`
    (≈ 5 + 180 + 20 = 205 s at N = 1; ≈ 575 s at N = 3).
- **Each code is sought only in ITS OWN window.** The slack around a boundary is generous (±15 s,
    plus 30 s of reach past the question opening) and is sized for 120 s questions, where it cannot
    reach a code two minutes away. On its own that is not safe: with short questions the windows
    overlap, and a code the student never uttered can be satisfied by the digits of the one beside
    it — `code_spoken_in` forgiving one edit widens the coincidence further. Windows are therefore
    **clamped to the midpoint between neighbouring boundaries**, which keeps the slack wherever
    there is room for it and makes the windows disjoint wherever there is not. Found by a flaky
    e2e (S5, ~1 run in 4); pinned deterministically by `t_code_windows`, which plants a code's
    digits at a *different* boundary and requires it to be rejected.
- **INV-INTEGRITY-5 (boundary liveness)** — every later boundary code `b_k` is issued only when
  the Student says "I'm done with this question" for Segment `k` (or that Segment's deadline
  fires), and must appear in the transcript at or after that Segment's `closingOffsetSec`. The
  recording provably ran until each such moment.
  - With `questionsPerAttempt = 1` this is exactly the v4 bookend: two codes, the ends pinned and
    the middle inferred. **With N > 1 the property strengthens on its own** — an N-question
    attempt carries N+1 codes, so the timeline is pinned every couple of minutes rather than only
    at its ends, and the unpinned stretches shrink to one answer each. That is a side effect of
    asking more questions, not a reason to ask them.
  - `/finish` refuses any token that is not a *final* ClosingToken: a RevealToken (the closing
    step is not skippable) and a mid-attempt ClosingToken (an Attempt cannot be cashed in after
    two of three Questions, which would also leak two Questions per Attempt to a shopper).
  - **This is deliberately weaker than the rolling-nonce scheme it replaced** (decision C2). That
    scheme pinned *every* 45 s of the timeline; a single-Question attempt pins only the two ends, so a sufficiently
    determined attacker could in principle construct the middle. Two reasons it is still the right
    trade: (a) rolling codes never stopped script-reading or playback-with-live-codes anyway —
    the attacks they uniquely blocked all fall under T7, which is accepted; and (b) interrupting a
    student four times mid-explanation degrades the fluent unassisted reasoning the assessment
    exists to measure. Both codes are matched with a one-edit tolerance (see 05), because the
    verifier re-derives them and only needs to survive a transcription slip.
  - The middle is not unconstrained: INV-INTEGRITY-3 keeps total duration inside the live window,
    the tail between closing and finish is bounded (`tailLimitSec`), and the recording is a single
    continuous stream with no pause/resume.
- **INV-INTEGRITY-6 (capture-before-question)** — the client starts recording before `/reveal`
  returns the question; the Certificate records this ordering, and INV-3/5 make a post-hoc
  recording infeasible even if the client lies about ordering.
- **INV-INTEGRITY-8 (the submission is untrusted input)** — the `.zip` is authored by the
  Student. The autograder trusts exactly two things from it: the **audio bytes** (only after their
  SHA-256 matches the Certificate) and the **signed Certificate** itself. Everything else in the
  archive is inert. In particular the transcript **must be produced by the grader**, never read
  from the submission: a `words.json` / `transcript.txt` sidecar would otherwise let a Student
  fabricate both the spoken codes and a full-marks answer while the real audio was never
  transcribed. Sidecars are gated behind `ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR=1`, which the test
  harnesses set and a Gradescope container must never set; Whisper always takes precedence.
- **INV-INTEGRITY-9 (a code is absent only when the audio says so)** — a boundary code is
  reported missing only after it has been sought **twice**: once in the transcript of the whole
  recording, and again by re-transcribing that boundary's own window of the audio in short
  overlapping chunks with decode settings tuned for bare digits. The instructor output states
  which of the two found it, and, for a code still missing, whether any speech at all was
  transcribed in that window.
  - **Why this is an invariant and not a tuning detail.** On 2026-08-21 a live attempt failed
    integrity for a closing code the recording plainly contained. Whisper decodes in 30-second
    windows and drops runs of digits that fall at a window edge with silence either side — which
    is exactly what every boundary code is. Re-running the same file locally recovered the closing
    code and dropped the *opening* one instead: which of the two survived was close to a coin
    flip. The system was therefore reporting a **transcription** failure to a student as a
    **compliance** failure, in a message that by design does not say why.
  - That is the one error this system must not make. Every other check here fails closed against
    an attacker; this one failed closed against an honest student, and told them nothing they
    could act on. A missed attack costs one inflated grade on one formative quiz. A false
    accusation costs the credibility of the whole scheme.
  - Three settings carry the main pass — `vad_filter` (decisive: it makes the digits the start of
    a speech region rather than debris at a window edge), a `small` or better model, and a pinned
    `language="en"` with `condition_on_previous_text=False`. The rescue pass is the backstop for
    when they are not enough. Verified on the failing recording: it passes at the new settings,
    and passes again with both codes deleted from the main transcript by hand.
  - The rescue reads only the audio the grader already holds and the code it already derives from
    the Secret, so it takes nothing from the Student and cannot weaken INV-INTEGRITY-8. It can
    only turn a false negative into a true one, never the reverse — confirmed by a negative
    control on codes that were never spoken.
- **INV-INTEGRITY-7 (no certificate ⇒ no automatic credit, but preserve the evidence)** — a
  submission without a valid Certificate is scored 0 and flagged for instructor review, never
  silently graded. If the browser captured non-empty audio but `/finish` could not issue a
  Certificate, it must still offer an unmistakably **UNCERTIFIED BACKUP** zip containing that
  audio. The student is told that the backup will score 0 automatically, that a fresh certified
  attempt is strongly preferred, and that instructional staff may manually override the 0 only
  after reviewing the retained audio and circumstances. The backup carries no trust claim: its
  marker and metadata are student-controlled, the autograder does not content-grade it, and only
  Gradescope receives the audio (INV-PRIV-1). This preserves evidence of both student work and
  rollout failures without weakening any Certificate check.

## Security invariants
- **INV-SEC-1 (unforgeable capability)** — UniqueURL/RevealToken/Certificate/NonceSchedule are
  all HMAC-SHA256 signed with the Secret; verification is constant-time. Nothing is trusted unsigned.
- **INV-SEC-2 (identity bound at submission)** — every Certificate carries an opaque `studentRef`,
  and the autograder grades a submission only if it can re-derive that exact ref from the
  **Gradescope-authenticated** email in `submission_metadata.json` (decision B1/B5). The quiz link
  itself is public and carries no identity, so identity is established where it is actually
  authenticated — at upload — rather than at link-mint time. A Certificate submitted by anyone
  other than the person who made it scores 0, except the explicitly marked instructor-only
  DEBUG artifact in INV-DEBUG-1 (identity is still checked and flagged).
- **INV-SEC-3 (per-attempt salt)** — question selection uses a fresh random `attemptSalt`, and
  nonce derivation is salted per `attemptId`; two attempts never share a nonce schedule.
- **INV-SEC-4 (secret isolation)** — the Secret exists only in the Signer env and the autograder
  env. It never reaches the browser, the repo, or logs. Each Course deploys to its own named
  Worker and Pages project, and the deploy path uploads that Course's own Secret; deploying one
  Course must never overwrite another Course's Signer or substitute the legacy shared Secret.
  - **A Course's Secret lives INSIDE that Course's folder** — `courses/<id>/.env` — or, for CI, in
    the course-scoped `ORALSCALE_SECRET_<COURSEID>`. Nothing else is consulted, and a Course without
    one **cannot be built at all**; every tool fails loudly and offers to create it.
  - **Why inside the folder.** A Course folder is meant to be its own private repository. A Secret
    parked beside the engine is a piece of the Course that does not travel: the folder clones
    cleanly and then every Certificate fails to verify on the other machine, for reasons nothing in
    the folder explains. See [courses/GOVERNANCE.md](../courses/GOVERNANCE.md).
  - **Neither removed fallback was a convenience.** `server/config.json`, the pre-split shared
    Secret, meant whichever Course wrote it last decided what every other Course signed with — that
    is how a demo link came to be signed with the pilot course's Secret. A bare `ORALSCALE_SECRET` is the
    same failure with a shorter fuse: it is a whole-shell value, so a terminal holding one Course's
    Secret silently signs another's artifacts. The **course-scoped** variable replaces it because
    `ORALSCALE_SECRET_CHEM101_FALL2026` can only ever be that course's. (The unscoped variable still
    carries the Secret *into* a running Worker and autograder image; that is a different job, and
    the build sets it from the per-Course value.)
  - **No two Courses may hold the same Secret VALUE**, which no single build can see — two Courses
    can each have their own `.env` and still hold the same string. Checked **before minting, before
    building, and at commit time**, against every Course on disk including `_template` and the test
    fixtures: the way a Secret gets shared is by copying a folder that had one. **A clash refuses
    the build.** Sharing means either Course can forge the other's Certificates and mint the other's
    quiz keys, and a Secret compromised in one ends every grade in both.
  - **`_template` ships without a Secret**, deliberately. A skeleton carrying one is a Secret shared
    by every Course ever copied from it.
  - **Built-in Courses are not re-keyable.** `_template`, `demo` and the fixtures keep the Secrets
    they ship with; rotation is refused. A clash is resolved in the **user's** Course, and the tools
    name that command. Rotating the built-in makes the message disappear while the real problem —
    a Course signing with a Secret every copy of that folder holds — stays, and re-keys either the
    skeleton every future Course is copied from or a fixture the suite depends on. Matched by
    **path**, never by courseId, because a copied folder keeps its id.
  - **A rotation REPLACES `.env`** and reports what it dropped. The reason to rotate is almost
    always that the file was copied, so every other line in it was copied too; keeping them would
    leave one Course using another's credentials.
  - **Every minting tool signs with the Secret of the Course it was asked for.** `gen-url.js`,
    `gen-access-keys.js` and `audit-accommodations.js` resolve `secrets/<courseId>.json`; none may
    read `server/config.json` — the pre-split shared Secret — directly.
  - **Why this needs saying, and testing.** Found in production on the public demo: a CourseLink
    that returned `invalid course token`. `gen-url.js` had never learned about the split and read
    the legacy file whatever `--course` said, so once that file held another Course's Secret every
    demo link was signed by the wrong Course. **Nothing in the payload differs** — same courseId,
    same assignment, same salt, same expiry — only the signature, so there is nothing to notice
    until a Student is already stuck on a link that looks perfect. The same bug in
    `audit-accommodations.js` is quieter still: it derives `studentRef`s no Certificate in
    that Course can match, so every accommodation claim returns UNVERIFIED and a disability
    accommodation silently becomes unconfirmable.
  - **Every tool prints which Secret it used**, because a wrong Secret is otherwise invisible until
    it fails — and it fails on a link that looks perfect, in a student's hands.
- **INV-SEC-5 (rate limiting / DoS)** — `/reveal` and `/finish` are rate-limited per token and per
  IP (token bucket in the small DB + Cloudflare edge); bodies are size-capped; malformed input is
  rejected before any crypto or DB work.
- **INV-SEC-7 (retake cooldown)** — a Student may open at most one Question per Assignment per
  `retakeCooldownSec`, **unless their previous Attempt genuinely consumed at least
  `cooldownClearsAfterSec` of the window**, which clears the cooldown immediately. "Finished" is
  measured in *elapsed time*, not in reaching `/finish`: reveal → `/closing` → `/finish` with a
  junk hash takes under a second, so clearing on the call alone made the cooldown a no-op (found
  and closed 2026-08-18; regression test O2). Conversely a Student who answered fully and then
  fumbled the last step has their cooldown cleared anyway — they were not shopping (test O3). Unlimited retakes remain policy (FR-6); what is refused is *rerolling* —
  opening a Question, abandoning it unanswered, and drawing again until an easy one appears.
  Answering takes minutes anyway, so an honest Student is never blocked; and because capture starts
  before `/reveal` (INV-INTEGRITY-6), a denied or broken mic never consumes an Attempt.
  This is the one piece of correctness-relevant Signer state; losing it degrades shopping
  resistance, not integrity.
- **INV-SEC-8 (enrolment-gated Bank, and key-only identity)** — `/reveal` selects and serves a
  Question only if the request carries an **AccessKey whose own MAC verifies** against the Secret
  for this `courseId`. The check runs **before** question selection, so a failed request touches no
  Bank and learns nothing about it — not even how many Questions it holds. The verified key also
  *produces* the identity: `studentRef = "k:" + sid`, derived by the Signer, so any `studentRef`
  the client sends is ignored. The Certificate records `accessKeyVerified`, and the autograder
  refuses to grade a Certificate lacking it on an Assignment configured to require keys — so a
  Signer accidentally deployed with the gate off cannot quietly produce gradeable work.
  - **The hole this closes:** the CourseLink is public (INV-SEC-2 binds identity at submission, not
    at link time) and `studentRef` used to be client-supplied, so a script could invent refs and
    call `/reveal` in a loop until it had mined the whole week's Bank. Assumption A-4 — the reason
    a Bank is safe to reuse at all — depends on that not happening.
  - **Self-authenticating, therefore stateless.** `tag = HMAC(Secret, courseId‖sid)` is checked by
    recomputation, so there is **no roster at the edge, no database, and no sync step**. An
    alternative design — precompute every valid key hash and upload it to the edge — was
    considered and rejected: it buys only revocation, and costs a second deployment step that can
    silently drift out of date exactly when a new student joins.
  - **Bit budget** (16 typed characters): 30 to `sid`, 50 to `tag`. The tag is what an attacker
    must forge; 2^50 guesses against a rate-limited edge is not a path anyone takes. The 30-bit id
    can collide with probability ≈1e-4 across a 500-student roster, which `gen-access-keys.js`
    **detects at mint time** (it holds the whole roster) and fixes by bumping `accessKeyEpoch`.
  - **What it is not:** proof that the holder is the person it was minted for. Sharing a key lets
    someone else *open* Questions as that Student; it never lets them earn that Student's grade,
    because the Certificate is still checked against the authenticated submitter (INV-SEC-2).
    Sharing is therefore self-harm, which is why one long-lived key per Student is enough.
- **INV-SEC-9 (access decisions are logged; forgery is rate-limited)** — every `/reveal` decision
  is recorded server-side (`granted`/`denied` + reason + hashed ref + hashed IP + assignment), so a
  mining attempt is *visible* and not merely blocked; a burst of `KEY_INVALID` rows is the
  signature of key guessing. Rows carry no PII: the ref is already opaque and is hashed again, and
  the address is stored only as a hash. After `KEY_FAIL_LIMIT` (10) **invalid keys** from one
  source address in `KEY_FAIL_WINDOW_SEC` (900), that source is refused for the rest of the window.
  - **Why the source and not the identity, here.** A forged key names nobody — there is no identity
    to attach a limit to until the key verifies. This cuts against the campus-NAT argument that
    governs every *other* limit in this system (T18), so the threshold is deliberately loose and
    the window short and self-clearing: a lecture hall would have to fumble ten keys within fifteen
    minutes to trip it, and it lets go on its own. Honest students paste a key from Brightspace and
    it either works or does not; they never accumulate failures.
  - Losing the log (no D1 binding on the Worker) degrades visibility and this limit, **not** the
    gate itself, which is pure crypto. `GET /health` reports which of the two are in force.
- **INV-SEC-10 (the grader cannot be instructed by the thing it is grading)** — a Student's
  transcript is untrusted input to a privileged decision, and no wording in it may change the
  grade, the rubric, the output format, or the grading rules. An attempt to do so is an academic
  integrity event: the submission is **not graded**, the Student is told only that validation
  failed, and the Instructor is given the evidence and told that this is a Dean of Students
  matter rather than a technical fault.
  - **Three layers, and only one of them is the model.** (a) A deterministic scan
    (`autograder/source/injection.py`) runs **before** any model call and its verdict is enforced
    in Python — an attacker cannot argue with a regular expression. (b) The prompt puts the
    transcript inside a **per-request random delimiter** and states that its contents are a record
    of speech, never a command; a fixed delimiter is the standard weakness here, because a student
    who knows the fence can say the closing tag. (c) The model is asked to report a suspected
    attempt, folded in as an extra Instructor flag. Layer (c) can only *add* suspicion and can
    never clear layers (a) or (b): a successfully injected grader reports whatever the attacker
    wanted it to.
  - **Two severities, deliberately.** `high` requires an imperative addressed to the grader
    *together with* a grading outcome, or a bare command about the grade, or the grader's own
    output format spoken aloud. `possible` is injection-adjacent vocabulary with no instruction,
    which is graded normally and merely flagged. The distinction is not fussiness: this is an AI
    course whose first week is *intro-llm-use*, and an on-topic answer may correctly describe
    telling a model to ignore its instructions. Zeroing that Student — with a message that by
    design does not say why — would be a false misconduct accusation produced by a regex, so the
    detector is tuned to miss a borderline attempt rather than to catch an innocent explanation.
    The Instructor still sees the flag either way.
  - **What it does not claim.** It is not a guarantee that no phrasing can ever influence a model.
    It is a guarantee that a *detected* attempt is refused in code, that detection does not depend
    on the model's cooperation, and that the attempt is visible to a human. Residual **T19** in
    [06](06-threat-model.md).
- **INV-SEC-6 (no injection: authored content is data, never markup)** — the Signer echoes no
  client-controlled data into signed fields without validation, and the web app renders Question
  text through a **whitelist DOM builder**, never as HTML.
  - Prompts support a deliberate subset of Markdown (`**bold**`, `*italic*`, `` `code` ``, fenced
    blocks, bullet/numbered lists, paragraphs) and LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`)
    rendered to **MathML**, because a question about gradient descent that cannot show
    `∇θ J(θ)` is a worse question. Links, images, tables, headings and raw HTML are **not**
    supported — a link in a spoken quiz question is either a distraction or a phishing vector.
  - The safety is *structural*, not a sanitizer: `parseRich` emits a tree of plain objects whose
    tags come from a fixed list and whose author text lives only in text nodes; `renderRich` builds
    DOM with `createElement`/`createElementNS` and `textContent`. **No `innerHTML` exists on the
    path**, so there is no markup parser for an injected `<script>` or `onerror=` to survive: raw
    HTML in a prompt displays as literal characters. Attribute values are fixed strings chosen by
    the renderer, never taken from the source. An unknown LaTeX macro is *shown as its source*
    rather than dropped, so a broken question is visible to its author instead of silently
    becoming a different question.
  - Because v3 lets an open-mode client supply `studentRef`, the Signer validates it against the
    exact opaque shapes of INV-PRIV-2 **before any crypto or bank work**. A plaintext email fails
    that check by design; one may enter a signed field only from inside a server-minted QuizToken
    (accommodation links). In key-only mode no client-supplied ref is read at all.

## Grading invariants
Fairness before accuracy. A grader that is slightly worse but applies the same standard to everyone
is *better here* than a grader that is sharper on average and inconsistent, because the second one
produces marks a student cannot be told the reason for.

**And when it is wrong, it is wrong upward** — INV-GRADE-11. The two rules are companions: the
first says every student meets the same standard, the second says that standard errs in their
favour.

- **INV-GRADE-11 (a grading mistake falls the student's way)** — no automatic grader is right
  every time, so the question is not whether it errs but **which way**. Every mistake this system
  can make is one of two kinds, and they are **not** to be traded off against each other:
  - a **positive mistake** — credit for something the student did not quite earn;
  - a **negative mistake** — a mark taken off something they did earn.

  **Positive mistakes are acceptable. Negative mistakes are the ones to design against.** Where a
  choice is genuinely uncertain — a verdict, a threshold, a rounding rule, an unparseable reply, a
  penalty resting on thin evidence — it resolves **in the student's favour**. Instructor decision,
  2026-09-17, and it is a rule about the whole project rather than one knob.
  - **Why, and it is not sentiment.** The two errors do not cost the same thing. A positive mistake
    costs a fraction of a mark on one question, and the student never learns of it. A negative
    mistake takes marks for work they actually did, is invisible to them (they cannot see the
    rubric — INV-GRADE-10), and is indistinguishable from the assessment simply not working. The
    first is noise. The second destroys the claim this system rests on: that the mark reflects what
    the student said. A student who suspects the grader is docking them for things they said stops
    treating the exercise as an assessment of understanding.
  - **It is also the only asymmetry a student can act on.** There is no appeal path that scales to
    a whole cohort. An instructor can spot-check a suspiciously *high* mark; nobody spots a
    correct answer quietly marked down.
  - **What it already decides, so the rule is read as descriptive rather than aspirational.** Each
    of these was chosen separately and they all point the same way, which is what made it worth
    naming: `curveRounding: "up"` (a total between two rungs takes the higher); a missing verdict
    is a **gap, not an `absent`** (INV-GRADE-10) so a formatting slip never docks anyone; penalties
    **need a quote** and an unevidenced `contradicted` is scored `absent`; an uncorrected false
    claim **caps** rather than zeroes; self-correction is never an error; `dropLowest` discards the
    worst answer; optional points may only ever **raise** a mark (INV-GRADE-9); and a grader that
    cannot run produces **no mark at all** rather than a low one (INV-GRADE-1).
  - **What it forbids.** Tuning a grader, a prompt or a policy to minimise *total* error, which
    buys accuracy on positive mistakes with exactly the negative ones this rule exists to prevent.
    Any evaluation of a grader must therefore report the two directions **separately** — `under`
    and `over` in `tools/eval/points-bench.py` — and a change that lowers total error while raising
    `under` is a regression, whatever its headline number says.
  - **What it is NOT.** Not grade inflation, and not licence to be vague: the ladder, the curve and
    the point weights are the instructor's to set, and this rule never moves them. It governs only
    what happens at the **margin of uncertainty**, where the system would otherwise have to guess.
    Nor does it weaken integrity checking — INV-INTEGRITY holds regardless, and a submission that
    fails validation is not being *graded* at all.

- **INV-GRADE-1 (one grader per cohort, or nothing)** — every Submission for an Assignment is
  graded by the backend the course names, under the same calibration. **There are no fallbacks.**
  When the chosen grader cannot run, the affected Submissions are **not graded at all**: no score
  is produced, the Student is told plainly that it is not their fault, and the Instructor gets a
  `REGRADE REQUIRED` flag naming the backend and the reason.
  - **Why this is the first grading invariant.** The worst outcome available here is not a mark
    that is 0.1 too low. It is two Students who said the same thing getting different marks because
    one of them submitted while a service was throttled. That is invisible to both of them and
    indefensible when challenged.
  - **This used to be a fallback chain, and that was wrong on its own terms** (decision R12,
    2026-08-24). The chain was justified by exactly the argument above — and then produced the
    thing the argument forbids, by grading the unlucky Student with a *different method*. A weaker
    grader is not a smaller version of the same measurement; it is a different measurement, and
    which one a Student received came down to timing. "Flagged" did not fix that: it recorded the
    unfairness rather than preventing it.
  - **Failing hard is the recoverable option.** An ungraded Submission is visible, and the
    Instructor rebuilds and regrades **everyone affected together, with one grader**. A Submission
    silently scored by keyword matching is neither visible nor recoverable — nobody knows to
    look.
  - **The Student is never made to feel at fault.** The visible message says the recording passed
    every check, that they need not resubmit, that they will not be marked down, and where to ask
    (`supportChannel`, default Piazza) if a score never appears.
  - **A consequence worth keeping:** a course that grades with `genai` no longer bundles the local
    model, because with no fallback it could never be used. Two gigabytes and a fragile
    `llama-cpp-python` build removed from every image that does not grade locally.
- **INV-GRADE-4 (an unusable reply is retried; a different grader is not)** — when the chosen
  grader returns successfully but the reply cannot be parsed, the Submission is retried **within
  that same grader** before INV-GRADE-1 fails it. The ladder is: the batch as sent, then the batch
  with an output-format reminder, then one request per Question.
  - **Why it is not covered by the transport retry.** The transport retry watches for failures to
    *reach* the service. This failure is an HTTP 200 whose body is prose, or JSON truncated by a
    token limit — the call succeeded, so nothing retried, and one unparseable reply cost the whole
    Submission. Observed in the field, and transient: the same Student resubmitting was graded
    normally.
  - **Why the rungs must differ from each other.** At `temperature: 0` an identical re-ask mostly
    reproduces an identical bad reply, so a plain retry is close to worthless. Rung 2 changes the
    *format* instruction only; rung 3 changes the *batch size* only. Neither touches the rubric,
    the key points, the model or the temperature, so what is being measured is unchanged — this is
    a retry, not the fallback chain INV-GRADE-1 forbids.
  - **Rung 3 also isolates.** Per-Question requests mean one unparseable answer no longer costs the
    other four, and a short reply is far less likely to be truncated in the first place.
  - **It must still be able to fail.** A ladder that always finds some way to produce a score has
    quietly become a fallback chain. A grader that cannot return usable output at any batch size
    still yields no score and a `REGRADE REQUIRED`.
  - **A failure carries its evidence.** `finish_reason` and a bounded excerpt of the actual reply
    reach the Instructor-only output, and travel on the exception so they survive a *total* failure
    — previously the one case that most needed the evidence was the one case that discarded it,
    leaving "could not parse model reply as JSON" and nothing to act on. Truncation is named as
    truncation, with the knob to change (`ORALSCALE_GENAI_MAX_TOKENS`), because "the model ignored
    the format" and "the reply did not fit" have different fixes.
  - **No completion cap is sent, and that is a measured decision.** The obvious move — size a
    generous `max_tokens` — is wrong here, in the dangerous direction. Measured against Purdue GenAI
    Studio (`gemma4:26b-a4b`, 2026-08-27): with `max_tokens` unset the reply is **not capped** (a
    deliberately long generation ran to 1492 characters and returned `finish_reason: "stop"`), and
    when it *is* set the gateway enforces it as a **character** budget rather than a token budget —
    500 gave exactly 500 characters, 1200 exactly 1200, both `finish_reason: "length"`. A
    five-answer reply runs well past 2000 characters, so any sane-looking token number would have
    truncated replies that are fine today. The service default is the largest budget available, and
    `/api/models` exposes no per-model maximum to read. `ORALSCALE_GENAI_MAX_TOKENS` remains as an
    override for a *different* gateway that does cap by default; setting it on Purdue GenAI can
    only make things worse.
  - **The Instructor log is verbose, structured and free of student text.** One machine-greppable
    line per request (`[diag]` / `[req]` / `[rungN]` / `[result]`), including the requests that
    **succeeded** — across a cohort the useful question is "how often did the first ask fail", and
    that is unanswerable if only failures are recorded. Nothing student-derived appears: a model
    reply is reduced to its structure, keeping JSON **keys** (our own schema, and the whole
    diagnostic) and replacing string **values** with `<str:N>`, because the model's `feedback`
    quotes and paraphrases what the Student said. A reply that is not JSON is *described* — length,
    prose or refusal-like — and never echoed, since there is no reliable way to tell model
    boilerplate from a paraphrase of the answer.
  - `gradingBackend` defaults to **`local`** — a model bundled in the autograder image, so the
    transcript never leaves the container. That is not a claim that local grades better; it does
    not. It is the conservative choice to make on an Instructor's behalf, because the alternative
    exports student work to a service that carries no FERPA certification, and that is a decision
    only they can take (see INV-PRIV-4 and the disclosure in TEACHER-GUIDE).
  - A `local` image build explicitly downloads the course-selected repository/file into
    `source/models`, verifies that `llama_cpp` imports, and verifies that the model loads and answers
    before Gradescope accepts the image. The known musl-linked prebuilt wheel is not trusted
    on Gradescope's glibc base image; the fallback compiles only `llama-cpp-python` from source with
    an explicit compiler/Python/pip toolchain (including runtime imports omitted from upstream
    package metadata), a pinned build backend, and baseline-x86 flags rather than host-specific SIMD.
    If either runtime or model
    cannot load, the image build fails before any
    Student can submit rather than creating a class-wide zero.
  - **This binds the LOCAL grader too, and did not until 2026-09-17.** The GenAI path had a
    four-rung ladder and `_grade_locally` had no retry at all: one reply the parser could not read
    left that question ungraded, and one ungraded question fails the whole Submission under
    INV-GRADE-1. Measured on real Quiz 3 answers a 3B misses the reply format on the order of one
    call in ten, so across five questions that is roughly two Submissions in five lost to nothing
    but punctuation — the exact shape INV-GRADE-11 forbids, the model's mistake landing on the
    Student. The local path now retries (`ORALSCALE_LOCAL_ATTEMPTS`, default 3).
  - **A retry must change the request, and may change only the FORMAT.** Grading runs at
    temperature 0, so a bit-identical request returns a bit-identical reply and a "retry" that
    changes nothing is not one. Rung 2 onward therefore appends a format reminder — and nothing
    else. Never the rubric, never the points, never a hint about the score: a reminder that nudged
    the JUDGEMENT would make a Student's mark depend on how many attempts their answer happened to
    need, which is the same unfairness INV-GRADE-1 exists to prevent, arrived at from the other
    direction.

- **INV-GRADE-2 (a score transform may never reorder)** — any calibration applied to a grader's
  raw score is **monotone increasing**. It may move a mark; it may not swap two answers.
  - Implemented as `clamp(scale·raw + shift, 0, 1)` with `scale > 0` **enforced** — a fit that
    wants a non-positive slope is refused rather than applied, because it would invert the ranking.
  - This is what makes calibration safe to apply automatically. It bounds the blast radius: the
    worst a mis-fitted calibration can do is make everyone's marks too high or too low *together*,
    which is visible in the distribution and correctable, rather than scrambling individuals
    against each other, which is not.
  - It also bounds what calibration can *achieve*, and the Instructor is told so: it repairs
    absolute scale, and it cannot repair a grader that mis-ranks — a monotone map preserves a wrong
    order exactly as faithfully as a right one.
- **INV-GRADE-3 (a grader is qualified before it is used, on three properties in order)** —
  `tools/calibrate-grader.py` reports, and refuses to certify on the first two:
  1. **Consistency** — the same answer gets the same mark on a re-run. Failing this is
     disqualifying and is not fixable by scaling: it makes a grade depend on *when* a Student
     submitted.
  2. **Ranking** — within one Question, a better answer never scores below a worse one. Failing
     this is disqualifying for the reason in INV-GRADE-2.
  3. **Absolute value** — wrong answers near 0, full answers near 1. The only one calibration
     fixes, and the least important of the three.
  - Ranking is measured **within a Question**, not across the set, because that is the only
    comparison this system ever makes: two answers to different Questions are never ranked against
    each other, so a grader that is uniformly harsh on one topic costs nobody anything.

- **INV-DEPLOY-4 (the upload carries code; the image carries weights)** — the autograder zip
  contains source, the Bank, and the secrets, and **never model weights**. `setup.sh` downloads the
  GGUF and the Whisper weights at **image build time**, where Gradescope has network, into the same
  `source/models/` a developer running the grader locally ends up using.
  - The zip is ~95 KB. It reached **1.9 GB** the moment a developer had a GGUF in `source/models/`,
    because `zip -r source` swept it in — so the model travelled twice, once in the upload and again
    on the image build that downloads it anyway.
  - This is not merely wasteful. Gradescope does not reject an oversized upload cleanly; it takes
    twenty minutes or dies on a weak connection, with nothing that names the cause. So the build
    **refuses** a zip over 100 MB and prints its largest entries, and `t_no_weights_in_zip` asserts
    on the *extracted* tree rather than on the build, so it holds whatever a developer happens to
    have lying around.

- **INV-GRADE-5 (a grader names a band; the code does the arithmetic)** — **both** graders are
  asked for one of five **named bands** (`full` / `strong` / `partial` / `weak` / `none`) and never
  for a number. The default band→score map (`1.0 / 0.9 / 0.8 / 0.7 / 0.0`) is a table in
  `localmodel.py` and the same table in `grade.py`, so no model ever emits a score at all.
  - **The LADDER is the instructor's — names, count and prices.** `defaults.bandScores` re-prices
    the default five (the pilot course uses `1.0 / 0.92 / 0.8 / 0.7 / 0.0`); `defaults.bands` replaces the
    ladder outright with an ordered map of name → score (or name → `{score, meaning}`). Resolution
    lives in `autograder/source/bands.py`, which both graders import, so the two cannot drift.
    A ladder is accepted only if it has **at least two rungs**, names matching
    `^[A-Za-z][A-Za-z0-9_-]{0,23}$` and unique case-insensitively, scores numeric within `[0, 1]`,
    and scores **non-increasing** down the order given. Anything else is rejected **whole** and the
    default ladder is used, because a half-applied ladder would draw part of a Student's mark from
    each of two scales.
  - **The measured prompt wording only covers the DEFAULT ladder.** Both graders' band boundaries
    were tuned on the default names against real answers. A course that defines its own ladder gets
    boundaries **generated** from its own `meaning` strings plus the two rules that hold for any
    ladder (missing a point is not being wrong about one; shallow is not wrong). The engine does not
    claim a tuning it never ran — `Ladder.is_default` is what each grader checks to decide.
  - **A bank's `scoringBands` is filtered to the ladder in force.** A description for a band the
    grader cannot choose is dropped rather than passed through, since it would be an instruction to
    pick something outside the list.
  - **The same five names in both backends is the point, not a coincidence.** It makes the two
    graders' marks *commensurable*: a course that switches backend mid-term, or regrades one week
    with the other grader, no longer moves every Student's scale. The old design could not claim
    that — two graders each inventing their own float had no shared meaning.
  - A reply carrying **no readable band** is an **ungraded answer**, not a zero. It is dropped in
    `_parse_batch` so the INV-GRADE-4 ladder re-asks, and failing that INV-GRADE-1 reports
    `REGRADE REQUIRED`. This is the same class-wide zero one layer down, where no prompt change
    could ever have reached it, so it is closed in the parser rather than in the prompt.
  - This exists because asking a 3B model for a number is what produced the class-wide zeros the
    first pilot saw. Measured against Purdue GenAI on 35 answers: asking for a number gave
    MAE 0.460, 28% within-question rank agreement, and **collapsed 21 of 26 non-zero answers to
    0.0**. The same rubric, the same bank context, asking for a band instead: MAE 0.117, 95% rank
    agreement, **0 collapses**. Nothing else about the prompt changed.
  - **It was costing the remote grader too, just quietly.** Purdue GenAI is `gemma4:26b-a4b` — a
    mixture-of-experts with roughly *four billion active parameters per token*, so the gap to a 3B
    dense model is far smaller than "26B vs 3B" suggests, and the defect was never about capacity.
    Across 512 constructed answers spanning all 16 Banks (`tools/eval/bench.py`), asked for a number
    it **inverted 9 pairs** at MAE 0.092; asked for a band, **5 inversions** at 0.066; asked for a
    band *and* told to derive it from `covered`/`missed`, **4 inversions** at 0.058. Same model,
    same rubric, same temperature.
  - **The remote grader derives its band from the key points it lists.** `full` requires the key
    points that carry the reasoning, not merely a good answer, and a key point in `missed` caps the
    band at `partial`. This exists because Gemma is *generous*: on the hand-authored calibration
    answers it gave the ones the Bank author called `partial` a mean of **0.91**. Two rule-shaped
    attempts to talk it down moved that by nothing at all; making the test **countable** — which key
    points were actually stated — is what moved it. It also makes `covered`/`missed` load-bearing
    rather than decorative, since the Instructor already reads them.
  - **Bands buy fewer inversions and pay in ties, which is the right trade.** Four values cannot
    separate two answers the grader judges alike, so ties rose 7% → 10%. A tie marks two answers
    equally; an **inversion** puts a worse answer above a better one, is the failure INV-GRADE-2/3
    exist to prevent, and no monotone calibration can repair it. The two are reported separately
    for exactly this reason — added together they hide a grader getting fairer.
  - The rubric text, `commonErrors`, and the band descriptions stay in the prompt. Removing them was
    tried and made it worse (MAE 0.327 and 0.297) — the numeric ask was the whole defect, not the
    context around it.
  - The boundary rules live in the **system** message, not the user turn; the same words in the user
    turn score measurably worse. The rules a small model most needs spelled out are the ones a
    human grader treats as obvious: a missing example does not cost full credit, and *shallow is not
    wrong* — an answer that says what happens but not why is `weak` at lowest, never `none`.
  - Bands, not a continuum, because INV-GRADE-3 ranks **within a Question**: four ordered buckets
    are all the resolution that comparison needs, and they are what the model can actually hold.

- **INV-GRADE-8 (the certificate carries split times on the audio's own clock, signed and never
  trusted)** — the app timestamps the moments only it can see — the recorder starting, each code
  appearing, each question appearing, each "I'm done" tap, the finish — measured from
  `recorder.startedAt`, which *is* t=0 of the audio file. The Signer validates the shape by
  allow-list and signs them into the Certificate as `clientMarks`.
  - **Why the server's own offsets are not enough.** They are measured from the moment the Signer
    answered `/reveal`; recording began before that (microphone permission, stream setup, a round
    trip), so every server offset sits a second or two ahead of the same instant in the audio, by
    an amount that varies with the phone and the network. The boundary-code windows are ±15 s wide
    and do not care. Cutting the file up by hand does: "about here, give or take" is the difference
    between a usable segment and a sentence lost off each end.
  - **Signed is not trusted, and this is the whole design.** Every check that decides whether an
    attempt is genuine — the boundary-code windows, the deadline, the duration — keeps running on
    the Signer's clock, which the browser cannot touch. These marks answer a different question:
    *where in this file is the answer to question 3?* Signing them makes them tamper-evident
    afterwards; it does not make them evidence of anything.
  - **Fails soft.** A malformed set is dropped and the attempt is still certified. This runs after
    the student has finished speaking, and refusing to certify a good recording over a cosmetic
    field would be the worse bug by a wide margin.
  - **They carry nothing personal.** Six fixed event names, a question index, and seconds — the
    allow-list rejects the whole array if any entry is not exactly that shape, so a browser cannot
    smuggle a field through it (INV-PRIV-2 is unaffected).
  - **What they are FOR.** When a code is missing the automatic split cannot be relied on, and the
    attempt fails validation and scores 0. That is exactly when a human has to read what the
    student actually said. So the autograder now prints the per-question split — question, window
    on both clocks, and the transcript slice — as an **instructor-only** output on any validation
    failure. The student is still told only that validation failed (except under INV-USE-1).
- **INV-GRADE-9 (required key points are what the question asks; optional points may only ever
  RAISE a band)** — `keyPoints` lists only points **without which the question has not been
  answered**. Anything that merely makes an answer stronger, richer or easier to mark goes in
  `bonusPoints`. Both graders are told that an omitted optional point can never push a band **down**
  and may never appear under "missed"; how many are needed to push one **up** is the ladder's
  business, not the grader's.
  - **Where the top band sits is the instructor's policy, and it moved once already.** The engine
    default puts *answered the question as asked and said nothing false* at `full`. The pilot course decided
    on 2026-09-09 that this was too lenient — depth bought nothing — and set a course ladder where a
    complete, correct, required-only answer is `partial` (0.80) and the optional points are the
    climb: one or two for `strong` (0.92), two or three for `full` (1.00). Both are legitimate
    readings of the same guarantee, because in neither is a student marked **down** for omitting
    something the question did not ask. The floor for answering the question correctly is a solid
    mark; only the ceiling moved.
  - **Who is told about the unmade optional points depends on the mode, and that is an instructor
    decision that moved.** In BAND mode they are reported to the student (`strongerIf`), on every
    answer including a full-marks one, in their own section after the mark and phrased as an
    opportunity. In POINTS mode they are **not shown to the student at all** (instructor,
    2026-09-15): a student who answered well and is handed a list of things they did not say reads
    it as a tally of what they lost, and several of those points are not derivable from the prompt,
    so the list teaches recitation rather than understanding. They stay in the instructor record.
    In both modes, folding them into "missed" would be false and would teach padding.
  - **The failure it fixes.** A first-draft bank reliably fills `keyPoints` with everything a
    complete treatment of the topic would mention — the Quiz 1 bank averages **5.7 per question**,
    every one of its 100 items over the limit — and a grader handed that list withholds marks for
    each one the student left out, including things the prompt never asked for. A student could
    answer exactly what was asked, correctly and completely, and land two bands down.
  - **The test for an author is a single question:** would an answer without this point be *wrong*,
    or merely *weaker*? Wrong is `keyPoints`. Weaker is `bonusPoints`. `validate-bank.js` warns
    above four required points, because a question asks at most two things (question-design.md) and
    a fifth required point means either the question grew a third part or something optional was
    filed as required.
  - **Anything genuinely required must be explicit in the prompt.** A student cannot be marked down
    for not answering something they were not asked. This is a bank-authoring rule, and it is why
    the ceiling above is a warning an author reads rather than a number a grader enforces.
  - **Existing banks are unaffected.** No `bonusPoints` means behaviour identical to before the
    split existed; the change is what the fields *mean* to an author and how the bands are worded.
  - **It marks more leniently on purpose, and therefore not retroactively.** See INV-DEPLOY-6: a
    quiz already released is graded by the zip it was released with.

- **INV-GRADE-10 (points mode: the model judges each point, the code computes the mark)** — a
  course or assignment may set `scoring: "points"` (or `{"mode": "points", …}`). The model is then
  never shown a band, a threshold or a number; for **every** listed point (required `R1…`,
  optional `O1…`) it returns one of `stated` / `partly` / `absent` / `contradicted`, a quote of
  the student's own words for the first three, and a separate list of `falseClaims`.
  `autograder/source/pointscore.py` turns those into a mark, identically for every backend:
  - weights: required 2, optional 1 (`requiredWeight`, `optionalWeight`); `stated` earns the
    weight, `partly` `partlyFactor` × the weight (**0.5** by default), `absent` 0, `contradicted`
    **minus** the weight. `partlyFactor` prices a novel `partial` too, and may never exceed 1 — a
    half-made point that outscored a fully made one would not be a generous policy but an
    incoherent one. At 1 the knob makes an answer that gestures at every point score what a crisp
    one does, which is usually more thumb on the scale than intended. The model is never told the
    number; it reports the verdict and the course prices it.
  - `curveRounding` decides which way a total between two rungs goes: `"down"` (default) or
    `"up"`. Rounding **up** is the cheaper way to be kind to a half-made point: it keeps `partly`
    worth half — two of them still buy what one whole point buys, so vagueness still costs — while
    guaranteeing a lone `partly` never rounds away to nothing. Rounding down, a 0.5 total is
    indistinguishable from silence, which contradicts feedback that tells the student the grader
    saw something.
  - `base` = required weight × required count. `≤ 0` → `none`; below `base`, or no required point
    at least `partly` → `weak`; `base` → `partial`; `base + strongAt` (1) → `strong`;
    `base + fullAt` (2) → `full`. Thresholds are **relative to each question** because Banks mix
    2- and 3-required questions, and are clamped to the optional weight the question offers so the
    top is always reachable.
  - **An uncorrected false claim caps the band at `falseClaimCap` (`partial`)**, on top of any
    point deduction — the course treats a confident misconception as a penalty, not a gap.
  - **Self-correction is never an error.** Only the student's final position is judged; a slip they
    correct within the answer is neither `contradicted` nor a false claim. This is stated in both
    graders' prompts.
  - **An AWARD may be required to have evidence too — `requireGroundedEvidence`, the instructor's
    call and OFF by default.** When on, a `stated` or `partly` verdict whose quote does not appear
    in the Transcript is scored `absent`: the grader awarded credit on words the Student never said.
    It is the rule below extended from "no quote" to "a quote of nothing".
    - **Measured** (`tools/eval/points-bench.py`, 449 credited verdicts over 102 constructed
      answers, qwen2.5-3b, quiz-03): a quote NOT in the transcript accompanied a false credit **97%
      of the time**, against 35% for a grounded one — 91 of 216 false credits sitting on an
      ungrounded quote. **Confirmed end to end** by running the whole benchmark with the knob on
      and off: `over` falls **50.9% -> 32.5%** (a 36% relative cut) while `under` rises **0.0% ->
      0.6%**, and `grounded` goes to 100% by construction. The largest lever measured on
      over-crediting, and unlike every prompt change tried it is deterministic code needing no
      second model call.
    - **Off by default anyway**, because those 3 are **negative** mistakes and INV-GRADE-11 says to
      design against them: a grader that paraphrases rather than quotes would cost marks for its own
      habits. Whether 42% less false credit is worth 0.7% of credits wrongly withdrawn is a
      grading-policy decision, and those are the Instructor's.
    - **The match is deliberately loose** — short words ignored, a clear majority of the rest
      required. An exact-substring test would reject the honest quotes a model reformats, and
      manufacture exactly the mistakes this is meant to avoid.
  - **Penalties need evidence, and a reason.** A `contradicted` verdict with no quote is scored
    `absent`, and a false claim with no quote is dropped; both are noted in the instructor log. A
    false claim whose `why` merely **restates the quote** is dropped too: it carries no reason, so
    there is nothing to check and nothing to tell the Student. Found on a real Quiz 3 submission
    (2026-09-17) and it was not a rare slip — it was every question. The model judged all the points
    correctly, earned 7 of 7, and then reported `FALSE: "The single values are ordered, 3, 1, 0." —
    The single values are ordered, 3, 1, 0.`, which is neither false nor an argument;
    `falseClaimCapScore` then capped a 1.00 answer to 0.85 five times over, for every Student. A
    systematic mark taken off work that was done, arriving through a penalty the grader could not
    justify — the exact error INV-GRADE-11 exists to prevent. The test is deliberately crude and
    one-directional: dropping a real false claim is the acceptable direction, keeping a fabricated
    one is not. **The test is "is this the whole quote back again"**, not "does it share words":
    a first version asked for a third of the reason's words to be its own and also threw out a
    SHORT reason naming the misconception inside a LONG quote — a real detection poorly justified
    rather than a fabricated one. Measured over the six planted misconceptions in `points-bench`,
    that blunter test took detection from 6/6 to 2/6; the narrower one keeps 4/6 while still
    rejecting every fabrication.
  - **A missing verdict is a gap, not an `absent`.** An entry lacking a verdict for any listed point
    is unparseable, so INV-GRADE-4 re-asks and INV-GRADE-1 fails it rather than silently docking it.
    This is the right rule and it is unforgiving, so **the reply format has to be one the chosen
    model can actually produce** — a format the grader cannot follow is indistinguishable, from
    here, from an answer it could not judge. The per-point rules in `pointscore.system_prompt` are
    shared word for word, so both graders are asked the identical QUESTION; **everything else about
    the two prompts may differ, including how much of the bank each is shown** (instructor decision,
    2026-09-17). The fairness property INV-GRADE-1 protects is that one Assignment is graded by one
    backend — no Student is ever measured against another by a different grader — and that is not
    weakened by wording the two graders differently. It is the reason the local prompt carries
    `referenceAnswer` and the `evidence` quotes and the remote one need not: a 27B can be trusted to
    know what a good answer looks like, and a 3B cannot. The remote 27B is given a schema
    with an `A|B|C|D` alternation and reads it as "pick one"; the local 3B reads it as text to copy
    and copies it, so `localmodel.build_points_prompt` shows a filled EXAMPLE instead — real point
    ids, one real verdict each, and every key the shared rules ask for. Established the hard way on
    Quiz 3 (2026-09-17), where the alternation, an invented `points` object and a missing
    `novelPoints` key each cost a whole submission. Test `t_local_points_prompt_shape`.
  - **A reply is read for the first BALANCED object that is an answer**, not by slicing from the
    first brace to the last. A small model that answers correctly and then keeps talking has still
    answered, and a greedy slice glues the answer to the chatter and discards both.
    `pointscore.parse_reply` is shared by every backend for the same commensurability reason.
    Test `t_points_reply_trailing_text`.
  - The band is priced by the course ladder (INV-GRADE-5), which must carry all five standard names;
    a points policy that cannot be applied — an unknown key, a negative weight, `fullAt < strongAt`,
    a ladder missing a name — grades **nobody** (`REGRADE REQUIRED`) rather than grading wrongly.
  - **The optional points are described WITHOUT saying what they are worth.** The prompt asks only
    "did the student convey this idea?", by the same test as a core point. It used to add "an absent
    one is never a fault", which is a statement about scoring handed to a model that rule 5 has just
    told it does not choose the grade; measured against qwen2.5-3b it read as permission to skip
    them — **72 of 72 optional judgements came back `absent`**, including on answers that stated all
    three in plain language, which capped every Student at 0.92 and made the curve's top three rungs
    unreachable. INV-GRADE-9's guarantee is untouched, because the prompt was never what enforced
    it: `optionalWeight` is **added and never subtracted**, so crediting an optional point is
    monotone non-decreasing in the mark whatever the model is told. The guarantee lives in the
    arithmetic, which is where a guarantee belongs. (INV-GRADE-9's "both graders are told" clause
    applies to BAND mode, where the grader picks the band and the statement is meaningful.)
  - **Students get a narrative, never the rubric** (instructor, 2026-09-12). The feedback is 3–6
    sentences of prose: what they got right, any uncorrected false claim and what is actually true,
    what the question was getting at that they did not reach, and the optional ideas that would have
    *strengthened* the answer — always, full marks included, as extensions and never as faults. It
    never names points, scores, bands, verdicts, "required"/"optional" or a rubric, and no point
    list or stronger-if list is printed under it; a laid-out rubric reads as a hidden answer key to
    guess at. When the model returns no feedback, `pointscore.narrative_fallback` writes one from
    the verdicts in the same shape. The per-point verdicts, quotes and arithmetic are in the
    instructor detail only.
  - **Absent `scoring` is band mode, byte for byte**, so released assignments (INV-DEPLOY-6) are
    unaffected. The pilot course sets `defaults.scoring: "points"` from Quiz 3 on and pins Quiz 0–2 to
    `"bands"` explicitly, so a later rebuild of a released quiz cannot change its scale.

## Privacy invariants
- **INV-PRIV-1 (no audio at rest outside Gradescope)** — the Signer and DB store only hashes,
  IDs, and timestamps; never audio, never transcripts.
- **INV-PRIV-2 (the Signer learns nothing about who the Student is)** — the Signer never receives
  an email, and in the default configuration never receives anything *derived* from one by the
  client either.
  - **Key-only mode (default).** The Student sends one value: their AccessKey. The Signer derives
    `studentRef = "k:"+sid` from it. `sid` is keyed by the **Secret**, which the browser never
    holds, so no party at the edge — including one holding the course link, the salt, and a full
    class roster — can map it back to a person. Only the Secret holder (Signer host, autograder)
    can, and the autograder must, to bind identity at submission.
  - **Open mode** (`requireAccessKey:false`) keeps the v3 forms: `e:<hex>` = HMAC(public course
    salt, email) computed **in the browser**, or `p:XXXX-XXXX-XXXX` = HMAC(Secret, email) minted by
    the autograder. The Signer rejects anything else, so no code path can put an address on the wire.
    - **Stated limitation of `e:`, not a gap:** the salt is public, so a party holding it can
      brute-force a known class roster back to an address. That is pseudonymization, not
      anonymization — and it is exactly the weakness key-only mode removes. See DESIGN-QUESTIONS **B5/B7**.
  - No third-party analytics or cookies in the web app beyond a local attempt cache.
- **INV-PRIV-3 (transcription locality)** — transcription runs inside the Gradescope autograder
  container (local Whisper); only de-identified transcript text is sent to Purdue GenAI for grading.

- **INV-PRIV-4 (the transcript leaves the FERPA boundary minimised)** — Students are told, before
  they record, to answer the question and say nothing personal; and the copy of the transcript
  sent to Purdue GenAI for grading has recognisable personal details removed first
  (`autograder/source/pii.py`). The Instructor is told what kind of thing was removed and how
  much, never the text itself; the Student is told plainly and without penalty.
  - **The asking is the control; the redaction is the backstop.** Nothing said is nothing to
    protect, so the disclosure on the landing card does the real work. Redaction covers the
    student who introduces themselves out of habit.
  - **Only the outbound copy.** Gradescope holds the audio and the full transcript and is inside
    Purdue's FERPA boundary; redacting the Instructor's view would be theatre, since the audio is
    right there. The Signer holds neither (INV-PRIV-1/2). The single outbound flow is the one
    that is minimised.
  - **A false positive here is a grading bug**, not a harmless excess: removing "Bayes Rule" or a
    learning rate changes the answer the grader reads. Patterns are therefore anchored to shapes
    that spoken mathematics does not produce, and a capitalised-name match is vetoed against a
    list of the eponyms this field is built out of.
  - The disclosure names the flows exactly: audio is recorded in the browser and uploaded **only**
    to Gradescope; the Signer receives a hash and timings; transcription happens inside the
    Gradescope container; the **text** is what goes to Purdue GenAI, never the audio.
- **INV-PRIV-5 (the edge stores keyed tags, and not for long)** — every identifier the Signer
  writes to its database is `HMAC(Secret, value)` truncated to 64 bits, never a plain hash and
  never a raw value; and every table has a retention bound that is actually swept.
  - **Why keyed and not hashed.** An IPv4 address is 32 bits and a `studentRef` is a 30-bit id.
    A plain hash of either is invertible by enumerating the domain in seconds, so "we store only
    a hash" protected nothing against the one party it was written for — someone holding a dump
    of the database. The Secret never leaves the Signer env (INV-SEC-4), so the Worker can
    recompute a tag to look a row up and nobody else can go backwards.
  - Found by the edge-database audit of 2026-08-21 (findings F-1, F-2, F-3 in
    [06](06-threat-model.md)), which also found the rate limiter using the **raw address** as its
    row key, and the cooldown table growing without bound.

- **INV-PRIV-7 (the deployed Signer bundle carries prompts, never the answer key)** —
  `tools/build-worker.js` builds `bundle.json` by **allow-list**: `id`, `difficulty`, `prompt`, and
  `topic`/`principle` only where INV-COURSE-5 permits. `rubric`, `keyPoints`, `bonusPoints`,
  `referenceAnswer`, `scoringBands`, `commonErrors` and `evidence` never leave the repository.
  - **What it was.** Until 2026-09-08 the bundle was the whole bank, so every reference answer and
    every scoring band for the term sat inside a deployed Cloudflare Worker. Nothing served it —
    and nothing had to. One misconfigured route, one `wrangler tail`, one person with dashboard
    access, and the week's answer key is out. The Signer never needed any of it: it hands over a
    prompt, and nothing is graded at quiz time.
  - **Allow-list, not deletion.** A field added to the bank schema later is withheld by default
    rather than leaked by default. That is the whole reason this is a list of what may go rather
    than a list of what may not.
  - The grading data reaches the grader by an entirely separate road — the autograder zip, which
    exists only inside Gradescope (INV-PRIV-6 governs what may be in it).

## Deployment invariants
- **INV-DEPLOY-1 (the Student controls which attempt counts)** — Gradescope grades the **active**
  submission, which is the most recent one unless the Student activates an earlier one from their
  Submission History. There is no instructor setting to change this on a Programming Assignment, so
  the property has to be delivered by **telling the Student**, not by configuring Gradescope.
  - **This corrected a false premise** (2026-08-29). The invariant used to require the instructor to
    set "submission to be graded → highest score". That option does not exist for Programming
    Assignments; it was assumed rather than checked, and the autograder printed an instruction
    naming a setting nobody could find. Verified against the Gradescope UI and the published guides:
    *"A student's autograder score is determined from their last, most recent submission… They can
    also view and activate any of your other submissions from the Submission History."*
  - **What actually protects a Student.** Retakes are unlimited and each is a fresh Question, so a
    later attempt can score lower than an earlier one — and a submission with **no valid recording
    scores 0**. Either would stand as the grade if it were left active. So the Student guide states
    the rule plainly: *your most recent upload is the one that counts; if an earlier attempt was
    better, re-activate it in Submission History.* Two clicks, and it is theirs to make.
  - **Why not simply hide the failure.** A retake that scores worse is a real result and the Student
    should see it. Silently keeping their best would also mean silently discarding evidence, which
    is not something an integrity tool should do without saying so.
- **INV-DEPLOY-2 (one artifact per Assignment, named for it)** — packaging a Course writes one zip
  **per Assignment** to
  `courses/<courseId>/autograders/<courseId>-<assignmentId>-oralscale-v<version>.zip`, beside the
  Course it contains, and removes the ambiguous intermediate `autograder/autograder.zip`.
  `autograders/` is gitignored in the engine and in every Course repository because each zip
  contains the signing Secret and may contain a GenAI API key in plaintext.
  - **The filename is a safety mechanism, not decoration.** Nothing is inferred at grading time, so
    the file states which Assignment it grades: uploading the wrong one is a visible mistake at the
    moment it is made rather than a plausible-looking score weeks later.
  - **Each zip carries only its OWN Bank.** A quiz-1 autograder does not contain quiz-14's questions
    and reference answers. This repository once packaged fourteen Banks from a different Course;
    one Assignment per zip makes that structurally impossible rather than something a build step
    has to remember.
  - **An Assignment that cannot be packaged is skipped with a warning**, not fatal: no Bank, a Bank
    that is missing or empty, or no `limitSec`. A half-written week 12 must not stop weeks 1–11
    shipping. The build fails only if *nothing* could be built, or if the single Assignment
    explicitly requested is the broken one.
- **INV-DEPLOY-3 (an autograder grades exactly the Assignment it was built for)** — the Assignment
  is written into the zip at build time as `ORALSCALE_ASSIGNMENT` and is **the only thing
  consulted**. Nothing is inferred from the Gradescope assignment, and there is no precedence.
  - **What this replaced.** One zip served a whole Course, so the Assignment had to be guessed from
    the Gradescope assignment: its numeric id, a declared title alias, a declared title substring,
    the Assignment id appearing inside the title, a week number inside the title, or "there is only
    one". Six rules that could disagree, plus conflict detection whose entire purpose was to notice
    the guessing going wrong.
  - **Why removing it was the fix rather than tuning it.** Guessing made a **superficial** property
    load-bearing: a Gradescope title is presentation to everyone who has not read the source, and
    renaming one could silently change which Bank a Submission was graded against. A wrong guess
    produces a *score*, not an error — there is nothing to notice.
  - **Pinning is not less flexible, only more honest.** Changing which Assignment a Gradescope
    assignment grades has always required rebuilding and re-uploading, because the Bank lives inside
    the zip. The title was never the real control; it only looked like one. (Decision R15.)
  - **A zip that does not say which Assignment it grades does not grade.** Not a guess, not a
    default: an unpinned or drifted zip fails with instructor-facing text naming the rebuild
    command. The Student is told it is not their fault, that they will not be marked down and need
    not resubmit, and to post on the Course support channel — one post, because this fails for a
    whole cohort at once.
  - **The zip's ENVIRONMENT follows the Assignment inside it, not the Course.** One zip holds one
    Assignment, so every backend-derived build-time value is decided from that Assignment: the
    `GENAI_STUDIO_*` credentials are written in **only** when that Assignment grades with `genai`,
    `ORALSCALE_LOCAL_REQUIRED` and `ORALSCALE_SKIP_LOCAL_LLM` follow the same one Assignment, and
    the container sizing the build prints is given per zip. Deciding these across the whole Course
    put the GenAI key, in plaintext, into the zip of every locally-graded Assignment whenever some
    *other* week used GenAI — an unused credential in a staff-readable artifact, which is exactly
    what INV-SEC-4 says must not happen — and, in the mirror direction, baked a ~2 GB GGUF into a
    `genai`-only zip that INV-GRADE-1 forbids it ever reaching. Test: `t_zip_env_matches_backend`.
  - **The Certificate is checked against the zip on both axes.** `courseId` and `assignmentId` must
    both match, and every `questionId` must exist in the bundled Bank. A mismatch scores 0 and is
    flagged with both sides named. The `courseId` check is not redundant with the signature: two
    Courses sharing the legacy Secret verify each other's Certificates, and Assignment ids collide
    readily across Courses.

- **INV-DEPLOY-7 (the deployed Signer says WHICH BANK it is serving, and the tooling checks it)** —
  the Worker bundle carries a sha256 of each Bank **file**, `/health` publishes the Bank's
  `revision` and a **keyed tag** `HMAC(Secret, "bank:v1:"‖courseId‖":"‖assignmentId‖":"‖digest)`,
  and `tools/gen-url.js` **refuses to mint** when that tag disagrees with the Bank on disk.
  `tools/verify-deployment.js` checks the same thing on demand, across every Assignment and every
  built autograder zip.
  - **Why existence was not enough.** INV-DEPLOY-5 proves the Worker knows the Assignment and
    agrees about its knobs. It cannot see the questions. A Bank revised in place keeps its
    `bankId`, its `assignmentId` and its question ids (`q3-001`…`q3-100`), so a Worker serving one
    revision and a Gradescope zip built from another are invisible to every other check — and the
    autograder resolves a submission's questions **by id**, so it does not fail. It marks the
    student's answer against a *different question's* rubric and returns an ordinary-looking grade.
    Observed across three same-day revisions of a live quiz (2026-09-16), where the only available
    check was comparing a local file's mtime against a deploy log.
  - **Why a keyed tag and not the digest.** `/health` is public and unauthenticated. A plain
    digest would let anyone holding a copy of a Bank confirm it is the genuine article — turning a
    leak they could not be sure of into one they could. The tag means everything to tooling that
    holds the Secret and nothing to anyone else, which is the same reasoning the D1 schema uses for
    its keyed tags (INV-PRIV-5). The human-readable `revision` travels beside it in the clear,
    because `1.2` is not a secret and is what an instructor actually reads.
  - **Absent is a warning, not a refusal.** A Worker deployed before this existed reports no tag,
    and minting continues with a warning: refusing would break every Course that has not yet
    redeployed, and the failure this guards against is drift, not absence. A *mismatch* refuses.

- **INV-DEPLOY-8 (a GenAI autograder is never built against a model the service does not offer)** —
  for a Course where any Assignment grades with `genai`, `tools/build-autograder.js` asks
  `<GENAI_STUDIO_BASE_URL>/api/models` (via `tools/genai-models.js`) whether `GENAI_STUDIO_MODEL`
  is listed, and **refuses to package** when the service answers without it, naming the nearest
  same-family IDs. At grading time, a "model not found" reply fails fast with the cause and the
  remedy named, not a bare HTTP line, and produces no mark (INV-GRADE-1).
  - **Why.** The model ID is baked into the zip, and Purdue replaces models in place
    (`qwen3.6:27b` → `qwen3.8:27b`, 2026-09-23). A zip built against a retired ID is well-formed,
    uploads cleanly, and then fails every submission.
  - **Unreachable warns, it does not refuse.** This is the opposite of INV-DEPLOY-5, on purpose. A
    link is what students click, so "not shown to work" must stop it. A build is not what students
    touch, and GenAI Studio being down at build time (it was, 2026-09-19..21) says nothing about
    the model. Refusing would block local-only fixes to a mixed Course during an outage. A service
    that answers "no such model" is evidence; one that does not answer is not.

- **INV-DEPLOY-5 (a link is never minted for an Assignment the deployed Signer does not serve)** —
  when a Course declares a `signerUrl`, `tools/gen-url.js` calls `<signerUrl>/health` **before**
  signing and **refuses to mint** unless the live Worker reports the same `courseId`, lists this
  `assignmentId`, and agrees on the knobs the token stamps (`questionsPerAttempt`,
  `requireAccessKey`). Unreachable counts as refusal: "not shown to work" is not "works".
  - **Why the check has to be against the Worker, not the repo.** The Course config is *bundled into
    the Worker at deploy time*. `course.json` therefore describes the instructor's intent, never the
    students' experience; `/health` is the only statement of what is actually being served.
  - **Why refuse rather than warn.** The failure is silent on the minting side and loud on the
    student side. The link is signed, unexpired and structurally perfect, so nothing about it looks
    wrong; `/reveal` answers `ASSIGNMENT_GONE` and the Student reads *"this quiz link is out of
    date"* about a link handed to them minutes earlier, with no action available to them. A warning
    scrolls off the screen above the link the instructor is about to paste — the link must not
    exist.
  - **Knob drift is refused too, not just absence.** A deployed bundle that serves 1 question where
    `course.json` says 5, or disagrees about `requireAccessKey`, proves the Worker is running an
    older config. The link would "work" and deliver a different quiz than the one just reviewed —
    the wrong-guess failure mode of INV-DEPLOY-3, one layer up.
  - **No override flag**, for the same reason `audit-accommodations.js` has none: the escape hatch
    would be taken on exactly the rushed day the check exists for. The remedy is always `npm run
    deploy`, which is idempotent and takes under a minute.
  - **Not enforced without a `signerUrl`.** There is then no deployment to interrogate and no link a
    Student could use either; that case already fails loudly and visibly as a local-dev link.
  - **Found in production** (pilot course, 2026-09-02): Quiz 1 was authored, frozen, packaged and
    linked in Gradescope while the deployed Worker still carried the Quiz-0-only bundle.

- **INV-GRADE-6 (a run ends with a cause, never with a killed container)** — the grading ladder
  retries hard on purpose, but the retries share **one whole-submission budget** measured from
  container start, sized to stay under the Gradescope autograder timeout. When it runs out the
  autograder **gives up on purpose** and writes its own result naming the cause, rather than being
  killed mid-retry.
  - **Why a per-request deadline was not enough.** `ORALSCALE_GENAI_DEADLINE_SEC` (25 min) bounds one
    request. `_genai_batch` is a ladder of up to `2 + questionsPerAttempt` requests, each getting its
    own full deadline, so five questions could retry for hours under sustained throttling. The
    module docstring reasoned about that 25 minutes as if it were the total.
  - **A killed container says nothing.** Gradescope reports *"the autograder failed to respond in
    the expected amount of time"* with no output at all — no score, no traceback, no cause — and
    every diagnostic line buffered for the final result dies with the process. So retry lines are
    **streamed to stderr as they happen**, and throttling is **counted** (`RATE LIMITED: N throttled
    replies, M min waiting`) so the cause is a measurement rather than an inference.
  - **Throttling is nobody's mistake.** The instructor block says so explicitly, because a rate limit
    otherwise reads as a broken key or a bad zip, and because relaunching a whole-cohort regrade into
    the same limit is the natural wrong response.
  - **Found in production** (pilot course, 2026-09-02): a submission that graded normally on the
    student's third upload.
- **INV-GRADE-7 (a dropped answer still shows its mark)** — under `dropLowest` the excluded question
  displays the mark it earned, on the **same scale as the counted questions**, labelled as excluded.
  The figure is **text only**: it is never passed as a Gradescope `score`, so it cannot re-enter the
  total the drop exists to keep it out of.
  - **Why.** "Not counted" alone made a near miss and a blank read identically — on the one answer a
    student is explicitly told carries the most useful feedback on the attempt, and therefore the one
    they most need to calibrate.

- **INV-DEPLOY-6 (a released assignment is not repackaged)** — an assignment with `"frozen": true`
  is skipped by `npm run package` and refused even when named explicitly, unless
  `--repackage-frozen` is passed. The zip already in `autograders/` is never deleted or moved.
  - **The accident it prevents.** `npm run package` packages *every* assignment in the course, one
    zip each, over the same filenames. That is right while a course is being built and wrong the
    moment one of its quizzes is live: cutting the week 2 zip silently overwrites the week 1 zip
    with an autograder built from today's engine. Nobody does this on purpose; everybody does it by
    accident, because the command that packages the new week is the command that repackages the old
    one, and it succeeds quietly.
  - **Why it matters.** Grading is not stable across engine versions and is not meant to be — band
    wording, grader prompts and rubric handling all move. Two students who said the same words must
    not be marked by different code because one submitted a week later. Late submissions make that
    concurrent rather than hypothetical: a pilot quiz was still accepting them when INV-GRADE-9
    landed, which marks *more leniently*, so a rebuild would have graded the late half of the
    cohort by a softer standard than the punctual half.
  - **Package before you set the flag.** The guard refuses to build a zip for an assignment already
    marked `frozen`, so flagging it first locks you out of producing the very artifact the freeze
    exists to pin. The sequence is: freeze the bank (`revision` + `frozenOn`), `npm run package`,
    *then* `frozen: true`, then deploy and upload. Written down because the natural order to write
    it in is the wrong one, and the pilot course's own note had it backwards until the first real freeze.
  - **The override exists and says what it costs.** If a grading fix is genuinely needed, the right
    move is to rebuild once and regrade the WHOLE assignment, not to let the two halves diverge.
    `--repackage-frozen` prints exactly that before it proceeds.
  - **A REGRADE VARIANT is the other half of that, and it does not need the override.** An
    assignment may declare `regrade: {id, scoring, gradingBackend, note}`; `--assignment <aid>
    --regrade <id>` then builds a SECOND zip that is pinned to the **same** assignment id (a new
    id would reject every certificate it was built to re-mark, INV-DEPLOY-3), carries the same
    bank, replaces **only the grading settings it declares**, and is written to
    `…-regrade-<id>.zip`. The released artifact is not read, moved or overwritten, so the accident
    this invariant guards is not reachable and the freeze flag is not consulted — a frozen
    assignment is the normal case for a regrade.
    - **Two settings may move, and a variant must name at least one.** `scoring` re-marks the same
      judgements on a different scale. `gradingBackend` re-marks with a different GRADER, which is
      the remedy INV-GRADE-1 already names in prose: when the chosen grader cannot run, nothing is
      graded, and the way out is to rebuild with a working one and regrade the whole cohort
      together. A variant declaring neither is refused: that is a rebuild wearing a new filename.
    - **Both are declared in the course, never on the command line**, so "which scale, and which
      grader, produced these marks?" is answerable from the repository six weeks later rather than
      from a shell history.
    - **Only the declared settings move**, so a difference between the two sets of marks cannot be
      anything else. The build says out loud that uploading the variant re-marks every submission,
      including ones already returned.
    - **A backend variant must be applied before the image is decided**, not after. Whether
      setup.sh bakes in the ~2 GB local GGUF, and whether the GenAI credentials are written into
      the zip at all, are both derived from the assignment's backend. A variant flipping to
      `local` that lands after those are computed yields a zip that ASKS for a local model and
      does not carry it — a failure that surfaces one submission at a time at grading, rather than
      at build time where it is still cheap.
    - **A variant freezes too.** `regrade: {frozen: true, frozenOn, sha256}` makes `--regrade`
      refuse to rebuild it without `--repackage-frozen`, and the refusal names the frozen
      artifact's hash. Once a regrade zip is what a cohort is being re-marked against it has the
      same claim on being left alone as the original release — more urgently, because a regrade
      runs over submissions that already carry marks, so a rebuild midway grades half the cohort
      with different code. A frozen variant therefore also pins whatever engine defaults it was
      built with, and the right response to a scoring change that postdates it is to leave it
      alone, not to repair it.

## Accommodation invariants
- **INV-PRIV-6 (the autograder contains no personal information)** — the built zip carries the
  course **Secret**, the **bank**, and configuration. It carries **no roster, no accommodation
  record, no email, and no per-student data of any kind**, and `build-autograder.js` **refuses the
  build** if such a file is present beside `course.json` rather than warning about it.
  - **The distinction is capability versus person.** A signing Secret and a question bank are
    *course* secrets: disclosure is bad and is repaired by rotating the Secret or retiring the bank.
    A roster is data about identified people; nothing repairs its disclosure, and the artifact it
    was riding in gets uploaded to Gradescope, cached in an image, and copied wherever the zip goes.
  - **This removed a working feature, deliberately.** `accommodations.json` verified extended-time
    claims at grading time and did it correctly. It was still the wrong place: a check needed at
    most once per quiz was being paid for by shipping the most sensitive data this system touches
    into every container, permanently. The check moved to `tools/audit-accommodations.js`, run by
    the instructor on their own machine (INV-ACCOM-1).
  - `extensions.json` went with it, and was never needed: measurement on 2026-09-02 showed
    Gradescope supplies the per-student due date in the submission's own metadata.
  - The student's email still reaches the container at RUN time, in Gradescope's
    `submission_metadata.json` — unavoidable, since identity binding is the point — and is used
    transiently. Nothing derived from it is written to disk.
  - `t_no_personal_data_in_zip` asserts on the EXTRACTED zip of every course in the repo, so it
    holds against whatever a developer happens to have lying around.
  - **The same "only what this zip needs" rule governs the course secrets it does carry.** They are
    not personal data, so this invariant does not forbid them — but a credential no Assignment in
    the zip can use is carried for nothing, and the one zip / one Assignment rule of INV-DEPLOY-3
    is what decides which. See INV-DEPLOY-3 and `t_zip_env_matches_backend`.
- **INV-ACCOM-1 (extended time is claimed by the Student and audited OFFLINE)** — the Student
  selects their own multiplier from a fixed ladder (1, 1.25, 1.5, 1.75, 2); the Signer scales the
  countdown and the buffer by it and records it in the **signed Certificate**. The autograder
  **notes the claim and assumes it correct**; it never verifies it and never holds a roster.
  - **Why a claim and not an authorisation.** Gradescope is the system of record for extended time
    and does not expose it to an autograder — confirmed by measurement on 2026-09-02: a per-student
    time-limit extension produces metadata byte-identical to one with no extension. So the Student
    asserts what they already hold.
  - **Why the audit is offline** (INV-PRIV-6). Verifying in the container required shipping a
    roster into the artifact. `tools/audit-accommodations.js` does the same join on the
    instructor's own machine, against downloaded submissions, whenever they choose — once a term,
    once a quiz, or at random. The claim is assumed correct until that audit says otherwise.
  - **The audit refuses to run for an automation.** It requires a TTY on both stdin and stdout,
    refuses when an assistant or CI environment marker is present, and has **no override flag**.
    Its inputs and outputs name students who hold disability accommodations; that data must not
    enter a model's context, a transcript, or a CI log. A `--self-test` mode exercises the
    arithmetic on synthetic data and refuses to accept a real roster, so the logic stays covered by
    the test suite without anyone handling a real one.
  - **Off-ladder values are REFUSED, never clamped** (INV-SEC-5). Silently granting less time than
    a student asked for would surface as a countdown dying mid-sentence.
  - **An instructor-minted accommodation link is an authorisation**, not a claim. `source` records
    which of the two this was, and the audit treats it as already-granted.
- **INV-ACCOM-2 (a mismatch is only a fault if the Student actually took the time)** — claiming
  more than granted is reported for review **only** when the answers also ran past what the granted
  multiplier would have allowed, buffer included.
  - **This is the fairness rule, and it is the point of the design.** A Student who selects 2x and
    answers within their real 1.5x has taken nothing they were not entitled to; flagging them would
    punish a misread dropdown. Selecting *less* than granted, or nothing at all, is never an event
    and is never recorded as one.
  - **Verification never changes a score.** Every outcome is information for a human. The most
    likely explanations for a genuine mismatch — an accommodation granted after the roster was
    exported, or one recorded at course level rather than on the assignment — are our records being
    stale, not the student cheating, and the output says so.
  - **No roster means "cannot say", never "denied".** A missing or malformed roster reports the
    claim as unverified. A student is never faulted for a file the instructor did not bundle.
- **INV-ACCOM-3 (accommodation data never touches the server, and is minimised everywhere else)** —
  a student's claimed multiplier is **never written to any Signer table, never derived into any key
  or tag, and never logged**. The Signer is *told* it, so it can compute a deadline — unavoidable,
  because the deadline is enforced server-side — and then drops it. It exists at rest in exactly
  one place: the **signed Certificate**, which travels inside the student's own submission to
  Gradescope, already the system of record for their accommodation.
  - **Stricter than "no PII", deliberately.** The multiplier names nobody. The rule is stricter
    because disability status is the most sensitive datum this system touches and an edge database
    is the worst place to keep it — so the requirement is not "unlinkable" but "absent".
  - `t_accommodation_not_persisted` fails the build on a schema column, a persistence call, or a
    key derivation that mentions it. The regression it guards is silent: someone adds a column
    "for debugging" and disability data is in an edge DB indefinitely.
  - The verification roster is keyed by opaque `studentRef`, holds no emails or names, is
    gitignored, and never leaves the Gradescope container. The multiplier is never sent to a
    grading backend. Notification email carries a **pointer, never a copy**: assignment and
    submission id only — no name, no identifier, no accommodation detail.
- **INV-ACCOM-4 (an unverified accommodation is assumed correct)** — a claim that cannot be
  verified, or that disagrees with the roster, **grades normally and never changes a score**. The
  student is told plainly that it could not be confirmed automatically, that it has been raised
  with their instructor, and that their score is unaffected if the accommodation is genuine. The
  instructor gets a review flag and, when notification is configured, an email.
  - **The default has to fall towards the student.** Our records are the thing most likely to be
    wrong — a grant added after the roster was exported, or recorded at course level rather than on
    the assignment — and the cost of wrongly withholding an accommodation lands on the person least
    able to absorb it. Verification exists to prompt a human, not to adjudicate.
  - **The student is never told a promise the system did not keep.** The wording tracks whether the
    email actually sent; unsent degrades to "flagged for your instructor", which is true either way.

## Boundary-code invariants
- **INV-CODE-1 (the code is four digits, and four is a floor)** — a boundary code is
  `CODE_DIGITS` digits, default **4** (reduced from 6 on 2026-08-24), and `codeDigits` in
  `course.json` is clamped to **[4, 8]** by both Signers.
  - **The floor is a safety property, not a preference.** `code_spoken_in` tolerates one
    Damerau-Levenshtein edit over windows of length `L-1 … L+1`, so at `L = 3` **any two of the
    three digits in order are accepted**. Measured false-accept for a code the Student never said,
    against digits that merely occur in their answer: **26% with ten digits of noise in the window,
    48% with twenty**. In a course where students say numbers aloud while explaining, three digits
    is not a weaker check — it is no check.
  - **Lowering the tolerance instead is worse.** At tolerance 0 an honest Student whose transcript
    drops a single digit fails **100%** of the time, and a dropped digit is precisely the failure
    the rescue pass (INV-INTEGRITY-9) exists to catch. The tolerance must stay; length is the only
    lever.
  - **Why 4 suffices:** every one of the N+1 boundaries must match *for a clean pass*, so an attack compounds. (Since INV-CODE-4, half the boundaries matching is still graded, but always flagged for review.) A
    pre-recorded answer reciting 30 random digits at each boundary of a 5-question attempt succeeds
    with probability ~5 × 10⁻⁶. Reaching 1% requires 120 digits per boundary — eight digits a
    second inside the window, which no mouth produces and which is unmistakable to an Instructor
    playing the recording.
  - **Shorter is the goal, not a concession.** Every digit is one more thing a nervous person has
    to read correctly. Four cuts a 5-question attempt from 36 spoken digits to 24, and the read
    windows derive from the length (1 s per digit, doubled at the final code), so the attempt gets
    shorter too.
- **INV-CODE-2 (a certificate is read with the digit count it was issued under)** — verification
  uses `cert.codeDigits`, falling back to `CODE_DIGITS` only when absent. Certificates issued
  before the change verify unchanged, so the default can move without invalidating work already
  submitted.

- **INV-CODE-3 (a student told a code was missed is told WHICH, and what was heard)** — the
  student-visible message for a missed boundary code lists **every** code the attempt required, in
  order, with where it was shown and whether it was heard.
  - **"We could not hear one of your codes" is true and useless.** The student cannot tell which
    four digits they failed to say, so they cannot check whether they said them; the honest ones
    conclude the system is broken. The transcript is already printed on the same page
    (`showTranscript`), so naming the digits turns an accusation into something they can verify for
    themselves in ten seconds — and, when we are wrong, disprove.
  - **Showing the expected digits is safe, which is what lets this be student-visible at all.** A
    code is `HMAC(Secret, attemptId:phase)`: it belongs to that attempt and no other. The attempt
    is over, certified, and pinned to the hash of audio that already exists, so a code learned here
    cannot be spoken into anything. The next attempt draws a fresh server-random `attemptId` and
    therefore fresh codes, which nobody can derive without the Secret. There is nothing to reuse.

- **INV-CODE-4 (failures zero a score but never skip the grading)** — once the certificate verifies
  and every question is in the bundled bank, the attempt is **always graded**. What a failure
  decides is only whether that grade is shown and counted.
  - **At least half the codes heard, everything else passed** (`2·heard ≥ N+1`; 3 of 6 at five
    questions, 1 of 2 at one): graded normally and the score stands. It is flagged for review, and
    the student sees a failed, visible "Validation checks" saying review **may affect their final
    grade** and encouraging a fresh attempt.
  - **Fewer than half heard, or any other integrity failure** (identity, access key, course or
    assignment mismatch, audio hash, timing window, duration, empty transcript, high-severity
    injection): scores **0**. The grading still runs, but every graded item is moved to
    instructor-only with its score removed, and a hidden "Would-have-been score" test carries the
    figure to override with. The student is told only what they were told before (which check
    failed stays hidden, INV-INTEGRITY-8 reasoning; codes are the named exception, INV-CODE-3).
    After an injection the figure is marked as possibly manipulated.
  - **Still not graded:** an invalid certificate signature, and a question the bank does not hold.
    In both cases there is nothing trustworthy to grade against.
  - **Why.** Even with the rescue pass (INV-INTEGRITY-9), a Quiz 4 submission lost its opening
    code in transcription when the student had read it. Zeroing that attempt is a negative mistake
    (INV-GRADE-11). Grading every failure out of sight turns an instructor override from a re-mark
    from the audio into a single edit.
  - **What this gives up (instructor decision, 2026-10-05).** INV-CODE-1's compounding argument
    assumed *every* boundary had to match. Now half is enough to be graded, so a pre-recorded
    answer padded with digit strings at each boundary passes on chance more often than 5 × 10⁻⁶.
    The defence is the review flag rather than the score: every such attempt is put in front of
    the instructor, with the codes that were missed and what was heard at each one.

## Grading-policy invariants
- **INV-LATE-1 (a broken policy grades everything)** — an unrecognised `mode`, a `steps` list that
  is empty or unreadable, a missing policy, or a submission time that cannot be parsed all result
  in **no deduction**, and the problem is reported to the Instructor.
  - **The failure has to fall this way.** A typo in `course.json` must never be the reason a
    student receives a zero. Grading everything is recoverable in a minute; a silently zeroed
    cohort is discovered weeks later, by the students.
  - A timestamp we cannot read is *our* problem: an unknown submission time counts as on time.
- **INV-LATE-2 (deductions are a percentage of the MAXIMUM, not of the earned score)** —
  `deductPercentOfMax: 20` on a 10-point assignment costs 2 points whether the student scored 9 or
  4.
  - Deducting a percentage of the *earned* mark would make the same delay cost a strong submission
    more than a weak one, which is not what "one day late costs two marks" means to anybody, and
    would quietly make the penalty regressive in the student's favour exactly where it is least
    deserved.
  - Applied **last**, after aggregation and after any `scoreBonus`: a bonus repairs the mark the
    student earned, so the lateness deduction comes off the repaired figure rather than being
    repaired away.
- **INV-LATE-3 (a deduction is an arithmetic default, never a finding of fact)** — Gradescope
  exposes only an **assignment-level** `due_date` to an autograder; per-student due-date extensions
  are invisible, exactly as accommodations are (INV-ACCOM-1). A student who was granted an
  extension is therefore indistinguishable from one who is late.
  - Every deduction says so: the Instructor is told to check before finalising, and the Student is
    told the deduction is automatic and who can override it. Neither is left to discover it.
  - Courses that grant extensions often are advised to leave `mode: "none"` and handle lateness by
    hand. **Everything that ships defaults to `"none"`** — a shipped default that silently zeroes
    late work is the worst possible thing for an instructor to inherit without noticing.

## Demonstration invariants
- **INV-DEMO-1 (the demo identity bypass is opt-in, loud, and contained)** — an assignment may set
  `demoSkipIdentityCheck: true`, which makes the autograder grade a submission **without** checking
  that the certificate was issued to the student submitting it (suspending INV-SEC-2 for that
  assignment alone).
  - **Why it exists.** An instructor evaluating OralScale records on the public demo site, which
    hands out **one shared quiz key** minted for a dummy address, and then uploads the result to
    **their own** Gradescope course. The certificate names the demo key's holder; Gradescope names
    the evaluator. They never match, so an honest evaluation scores 0 and the product looks broken.
    The alternative — every evaluator mints themselves a key against a Secret only the author
    holds — is the friction that stops an evaluation before it starts.
  - **Why it is an invariant rather than a flag.** Without identity binding, one recording can be
    uploaded by any number of students and every one of them is graded on it. That is not a
    degraded assessment, it is no assessment. So the setting carries four constraints, and all four
    are tested:
    1. **Per-assignment only.** It is never read from `defaults`, so it cannot be inherited by an
       assignment nobody thought about — and `defaults` setting it is itself a commit failure. It
       does not leak to other assignments in the same course.
    2. **Allow-listed by path.** `tools/check-course-safety.js` refuses the commit if any course
       outside `courses/demo/` sets it, on the same reasoning as open mode: the way a dangerous
       setting reaches a real course is by being copied out of a working example.
    3. **Announced at build time.** `build-autograder.js` prints a banner when it bundles one. A
       build log is read once, at the moment the artifact is made; a grade report is read after
       the damage.
    4. **Visible to the student, flagged to the instructor.** Every submission graded under it
       carries a student-visible warning, emitted as a *failed* test so Gradescope renders it in
       red, and an instructor review flag recording what the identity check *would* have said.
  - **The Signer is unchanged.** This is an autograder-side setting only: the attempt is still
    gated by a real quiz key (INV-SEC-8), and the certificate still names whoever held it. Nothing
    about what the demo *records* is weakened — only what the grader *requires* of the uploader.

## Course-content invariants
- **INV-COURSE-4 (one folder is the whole course)** — everything belonging to a Course lives under
  `courses/<courseId>/`, and nothing a Course needs lives anywhere else. Copy that one directory, or
  clone that one repository, onto another machine and the Course works. That is the test.
  - **In the folder, committed:** `course.json`, `banks/`, authoring notes, `.gitignore`.
    **In the folder, never committed:** `.env` (the signing Secret, and optionally this Course's
    `GENAI_STUDIO_*`), `<courseId>.keys.csv`, `<courseId>.brightspace-import.csv`,
    `accommodations.json`, `autograders/`.
  - **Every generator writes into the Course folder and nowhere else.** Key exports used to land in
    the repository root — the most sensitive file in the project, outside the folder meant to
    contain the whole Course.
  - **The guards are installed BEFORE the thing they protect exists.** `.gitignore` and a
    `pre-commit` hook are written by `make-config.js` before it mints, by `gen-access-keys.js`
    before it writes keys, and by `build-autograder.js` before it packages — into **both** the
    engine repository and the Course's own repository when it is a separate checkout. Protection
    that arrives after the artifact leaves a window, and the window is exactly when a folder full of
    new files invites `git add -A`.
  - **The hook is a backstop, not the plan.** A key export pairs Student emails with credentials and
    is dangerous while it exists, not only once committed. The tool says: upload to Brightspace,
    then delete. Keys are derived rather than stored, so deleting costs nothing.
  - Full statement in [courses/GOVERNANCE.md](../courses/GOVERNANCE.md).
- **INV-COURSE-1 (a course folder is self-contained)** — every path a `course.json` names is
  resolved **relative to that `course.json`**, never to the engine repository root. A course folder
  must work identically whether it was cloned to `courses/<id>/`, checked out elsewhere, or mounted
  read-only.
  - **Why it is an invariant and not a convenience.** Course content lives in its own **private**
    repository, because a Bank contains the questions *and* the reference answers — publishing one
    ends the assessment. That separation only holds if the course folder never needs to know where
    it sits inside the engine. A single root-relative path re-couples them and the separation
    silently stops being real.
  - Repo-root-relative paths from before the split still resolve, so an old `course.json` keeps
    working; new courses must not rely on it. `tools/lib/course.js:resolveBank()`.
- **INV-COURSE-2 (private by default)** — the engine repository ships `courses/demo/`,
  `courses/_template/` and `courses/_shell-for-testsuite/` and **nothing else**. `.gitignore` allow-lists
  those and excludes everything else under `courses/`, so a newly created course folder is private
  unless it is deliberately un-ignored.
  - **Allow-list, not block-list.** The failure being prevented is publishing an assessment, and it
    is silent, unrecoverable, and easy: one forgotten `git add -A`. A block-list fails open on
    exactly the case nobody anticipated. This one fails closed.
  - The engine's own tests must therefore depend only on `demo/` or `_shell-for-testsuite/` — a test that
    needs private content is a test that cannot run on a clean checkout (INV-COURSE-3).
- **INV-COURSE-3 (the gate runs on a clean checkout)** — the full test gate passes on a fresh clone
  of the engine with **no** private course content present. CI asserts both halves: that the suites
  pass, and that nothing outside the allow-list is tracked.

- **INV-COURSE-5 (a question's topic and principle are not served unless the assignment asks)** —
  `topic` and `principle` reach the browser only for an assignment with `showQuestionMeta: true`.
  The default is **false**, and when it is false the fields are not merely hidden by the app:
  `tools/build-worker.js` leaves them out of the deployed bundle and neither Signer sends them, so
  there is nothing in the tab, the network trace or the edge to read.
  - **Why off is the right default.** `principle` names the durable idea the question is testing,
    printed directly above the question. On a question like "why does a coin that has landed heads
    five times still have a fifty-fifty chance?", the line would read *"past outcomes do not change
    an independent process"*. That is the answer, given away for free, above the question.
  - **`difficulty` travels with them rather than alone.** It has to stay in the bundle because
    `difficultyMix` selects on it, but shown by itself it is a bare "stretch" over the prompt: it
    tells the student how worried to be and nothing they can use.
  - **A live quiz keeps what it shipped with.** The display format is part of the quiz a cohort
    sat. One pilot quiz sets it true because it was already released when this landed, and a
    student submitting late must see the screen the punctual ones saw. It is the only assignment
    anywhere that sets it.

## Student-comprehension invariants

*Its own family because the property is neither security nor grading: it is whether the person in
front of the screen can tell what is happening. Every item here was a real, repeated, avoidable
loss of an honest attempt in the Fall 2026 pilot, not a hypothetical.*

- **INV-USE-1 (the app says which quiz this link is for, and a wrong link is named as such)** —
  the student app prints the course and assignment of the link it was opened with, above every
  card, before the microphone is touched; and a submission whose certificate names a different
  assignment or course is the **one** validation failure whose cause is told to the student.
  - **The failure it prevents.** Every assignment has its own signed link and every link looks
    identical: same page, same "Oral quiz" heading, an opaque token nobody reads. Opening last
    week's link produces a completely normal, working, correct attempt that scores zero. This was
    the commonest real failure of the Quiz 1 pilot, to the point of leading the instructor's
    reminder announcement ("the links for every quiz are different so you have to click the link
    in Quiz 1").
  - **Why this one failure may be named, when no other may.** Naming a failing check normally
    hands an adversary a map (see INV-SEC-3 and `VALIDATION_FAILED_MSG`). Here there is no map:
    the student already knows which assignment they are in and which link they clicked, and using
    another week's link is not an attack — it is already caught and teaches nobody anything. The
    generic message, meanwhile, is actively wrong here. It says "record a fresh attempt, following
    the steps exactly", which is precisely what they did; they will do it again with the same
    wrong link and fail again, indefinitely, with no way out.
  - **It names the quiz and nothing else.** `shortTitle` is REQUIRED on every assignment, and is
    the only assignment text shown to a student or stamped into their link. The assignment's full
    title, its id, and its `difficulty` are all withheld: the first two name the week's topics
    (`quiz-02-methods-and-models`), and a lone `difficulty` renders as "CORE" above the
    prompt, which tells a student how worried to be and nothing they can act on. `difficulty` stays
    in the deployed bundle because `difficultyMix` selects on it, but that is a server-side use and
    neither Signer puts it on the wire unless the assignment opted in.
    - Enforced twice: `gen-url.js` refuses to mint without a `shortTitle` (no derivation escape —
      a link being minted today has its course.json open in front of somebody), and
      `check-course-safety.js` refuses the commit. It is display only, so requiring it across every
      course is cheap: backfilling one cannot change anybody's mark.
    - From `quiz-03` onward assignment ids are generic too. The id rides inside every link and is
      readable by anyone who decodes one; it also has to stay true when a quiz is re-scoped.
  - **It must work on links minted before it existed.** `courseId` and `assignmentId` are already
    inside every signed CourseToken, so the app names the quiz from the token it was given. Newer
    links additionally carry `courseTitle` / `assignmentTitle`, preferred when present. A live,
    posted, unexpired link is never invalidated by this.

## Platform invariants
- **INV-PLAT-1 (cross-platform capture)** — capture works on current iOS Safari, Android Chrome,
  and desktop Chrome/Firefox/Safari/Edge via `MediaRecorder.isTypeSupported()` negotiation.
- **INV-PLAT-2 (responsive)** — the UI is usable one-handed on a phone (≥360px wide) and on desktop;
  no horizontal scroll; touch targets ≥44px.
- **INV-PLAT-4 (accessible flow)** — every state change a sighted user perceives is announced to a
  screen reader, and the whole attempt is completable with the keyboard alone: the live region
  carries state text, focus moves to the newly relevant control on each transition, the rolling
  challenge code is announced assertively as text (not only as a visual badge), and remaining-time
  warnings are announced at 60s and 15s. Decorative glyphs are hidden from assistive tech.
- **INV-PLAT-3 (graceful degradation)** — unsupported browser / denied mic / lost network each yield
  a clear, actionable message, never a dead end (retake is always offered).
- **INV-PLAT-5 (the screen stays awake for the whole attempt)** — while a Recording is live the app
  holds a Screen Wake Lock, re-acquiring it whenever the page becomes visible again.
  - **Why this is an invariant and not a nicety.** A Student answering a 120-second question is
    *talking*, not touching the screen, and the iOS default auto-lock is 30 seconds. A locked
    screen suspends the page: `MediaRecorder` stops collecting and the countdown intervals freeze,
    while the Signer's deadline — which runs on the server — does not. The Student returns to an
    attempt that is over, having done nothing wrong. This is the most likely way an honest Student
    on a phone loses work, and it is invisible in every desktop test.
  - **Best-effort, never load-bearing.** The API needs a secure context and is absent before iOS
    16.4, so every failure path is swallowed: a device that cannot hold the lock must still record
    normally. Those devices are covered by the written warning in the Student guide, which is why
    the warning is not redundant with the lock.
- **INV-PLAT-6 (work that exists only in the tab is defended on unload)** — leaving the page is
  confirmed while a Recording is running, and — the case that actually costs a grade — while a
  **certified** Recording has not yet been downloaded.
  - The Recording lives in this tab's memory and nowhere else. There is no draft on a server, so a
    back-swipe on a phone after a successful attempt means the Student did everything right and
    submitted nothing. The browser substitutes its own wording, so this buys a confirmation dialog
    and nothing more — which is precisely the intervention an accidental navigation needs.

## Usability & teaching-effort targets (measured in [08])
- **INV-DOC-1 (public guides stay reviewed)** — public Student and Instructor guides have one
  canonical HTML content source, a continuous scrolling screen layout without print-only headers
  or page numbers, shared screen/print styling, and two-page Letter PDFs: Quickstart
  first (one page), FAQ second (one page). Each FAQ identifies its authoritative model/reference
  sources in a maintainer manifest. A content or source change is flagged for review of its
  audience content, and a student UI change also flags a screenshot review. **The review blocks only
  an official release** (`npm run test:guides:release`, run by CI on `v*` tags). On ordinary
  commits the gate is advisory and lists the suggested updates (instructor, 2026-09-12).
  Screenshots use only synthetic demonstration data and the actual app renderer. Generated HTML,
  screenshots and PDFs are fingerprinted so edits cannot silently leave a stale download. A review
  acknowledgement records the reviewer and disposition; hashes detect review needs, not semantic
  correctness. Publication remains a separate, explicit decision.
- **U-1** — a Student completes a first attempt in ≤3 min of interface time (excluding thinking).
- **U-2** — a Student needs ≤5 taps from opening the link to recording.
- **T-1** — an Instructor goes from repo to a live Assignment in ≤30 min following the guide.
- **T-2** — per-week ongoing effort ≤15 min (drop in a Bank, publish, done).

## Assumptions
- **A-1** — Students are logged into Gradescope; Gradescope authenticates identity for URL minting.
- **A-2** — Students have a working mic and grant permission; campus network is generally available
  during the recording (up to ~12 min at the default 5 questions × 120 s, typically nearer six
  minutes in the pilot; the client calls the
  Signer at each Segment boundary, and INV-PLAT-3 covers blips).
- **A-3** — This is **formative, lower-stakes** assessment; the goal is deterrence + evidence, not
  proctored-exam guarantees. Collusion/script-reading residuals are accepted (see [06]).
- **A-4** — The Bank is large enough (~100/week) that memorizing all answers is impractical.
  This holds only while the Bank stays *unpublished*, which is what INV-SEC-8 defends: a single
  scripted mining run would otherwise turn a 100-question Bank into a study sheet.
- **A-5** — A course-configured grader is available. There are no automatic backend fallbacks:
  if the named grader cannot run, the submission remains ungraded for a cohort-consistent regrade
  (INV-GRADE-1).

### INV-LOCAL-1 — Versioned local grading profile
New local packages default to `qwen3.5-4b`, profile `qwen35-context-off-v1`: Q4_K_M weights and llama.cpp pinned by SHA256, one question per request, thinking off, 4096 context and 900 output tokens, no prompt caching. The tokenized full request plus output reservation must fit; never silently truncate a transcript. Complete decisions (including unclear/ungrounded diagnostic flags) receive a score; infrastructure or incomplete-output failures use the same-model retry ladder and never manufacture zeroes. Explicit `qwen2.5-3b` retains the legacy grader; unknown model IDs fail rather than silently substitute. Band-mode compatibility uses the selected runtime but is not qualified by the points-mode study.

### INV-LOCAL-2 — Portable context and immutable alternative
`gradingContext` is optional teacher-authored question metadata: courseExplanation, pointDecisions (exact rubric IDs, meaning, sufficientExample), and systemGuidance. Missing context derives from the answer key; incomplete or mismatched explicit context refuses. The software computes points and preserves INV-GRADE-11. A versioned regrade may select an alternate bank only when bankId, ordered question IDs, prompts and student selection fields are unchanged. Runtime/prompt/source/bank hashes and the effective local profile are recorded in each package. Existing artifacts and assignment grading choices are not silently replaced. No private course examples enter the public engine.

### INV-DEBUG-1 — Instructor identity-debug artifacts
An explicit `--debug-identity --zip --assignment <id>` build produces a separate
`-DEBUG-identity-flag-only.zip`. The generated package alone carries `debugAutograder`
metadata scoped to that assignment; source course configuration must not carry it.
Every result prominently says DEBUG and carries a visible warning and instructor flag.
The identity comparison still runs: mismatch or missing submitter metadata is reported
as a failed identity check, but does not block content grading in this artifact.
Signature, course/assignment, audio hash, timing, spoken codes, access-key attestation,
PII handling, injection checks and scoring are unchanged. Invalid signatures or other
failed integrity checks still prevent grading. Normal artifacts retain INV-SEC-2.
Debug output is for instructor diagnostics, never official student marks.
Explicit course-local memory experiments may derive a DEBUG-only package with larger
pinned weights. They preserve the bank, prompt and scoring, identify the actual model,
and refuse model startup without assignment-scoped DEBUG metadata. The production
package remains immutable. Weight-file size is not a claim of measured resident RAM.

### INV-USE-6 — Grading timing and feedback order
Standing instructor requirement: these diagnostics are mandatory defaults for all
future autograders, across every course, assignment, grading backend and standard or
DEBUG package. They live in the shared runner and ship automatically, without a
per-course opt-in. Backend-specific nested timings apply when that backend runs;
unavailable measurements must be identified rather than fabricated.
Every completed results file, including early refusals, gives students grading start,
finish and total elapsed time in human-readable America/Indiana/Indianapolis time
(with date, timezone abbreviation and UTC offset). Durations use a monotonic clock.
Timing covers Python grader execution through result preparation, excluding queue,
image setup and final result-file write. Instructor-only timing detail is the final
result item: contiguous main stages, plus explicitly nested model readiness and each
Qwen request/attempt, with exact timestamps and elapsed seconds. No transcripts or
identities enter timing labels. Question feedback (including dropped questions) comes
first in the test list, then overall score, then auxiliary checks/diagnostics and timing.
DEBUG remains prominently labeled. Timing/order changes never change grading decisions.
The standard Qwen runtime uses four generation and prompt threads; faster-whisper
explicitly defaults to four CPU threads, with its existing environment override retained.
Instructor resource diagnostics under INV-USE-6 also report Linux cgroup current/peak
memory and limit when exposed, with samples every 10 seconds and at stage boundaries.
Container lifetime peaks and sampled peaks have distinct labels; an unavailable cgroup
falls back to explicitly scoped Python high-water marks, never an invented
whole-container value. Sampling is best-effort, instructor-only and cannot change marks.
For cap diagnostics, identify the grader's memory cgroup from membership and mount
mapping, prefer its nearest visible finite enforcing limit, and report current/peak
charge, percentage and headroom in GiB. Inspect visible enforcing ancestors separately;
shared ancestor usage is not this container's private footprint. Unknown scope or
missing limits must remain explicit. Sample every 10 seconds plus boundaries and
summarize minute history. Verify the owned live Qwen process belongs to the measured
group; show its RSS/PSS only as supplementary footprint evidence, never add it to the
cgroup total. Include memory.stat/swap/limit-event counters when readable. No host-wide
RAM metric or sum of independent process peaks may be labeled container cap usage.
Also show OS-visible MemTotal/MemAvailable and total-minus-available as a separate
whole-system diagnostic, explicitly possibly shared-host scoped. Never compare host
used RAM to the container's 6 GiB allowance or infer model memory by subtracting
uncontrolled host readings.

INV-USE-6 completion diagnostics also emit flushed instructor-console lifecycle
events with a unique run ID, Purdue-local timestamps and monotonic elapsed time:
startup, stage/span boundaries, periodic heartbeat, selected backend/model and
package fingerprint, results-file write, model shutdown and launcher exit status.
Normal results retain detailed diagnostics at the bottom and hidden from students.
Lifecycle events never include transcripts, credentials, identities or exception messages.
A missing completion marker is evidence of an incomplete lifecycle, not proof of
platform fault; hard kills may prevent final logs.

### INV-USE-7 — A fixed note closes every question's feedback
An assignment (or the course `defaults`) may set `feedbackFooter`, a plain-text string.
When set, it is appended verbatim as the last thing in EVERY question's student
feedback, including a dropped question, after the model's narrative. It comes from
course.json and never from the grader, so every student reads the same words; it is
rendered as text, never HTML (INV-SEC-6). Its purpose is to say how the scale reads —
for example that a complete answer to the question as asked sits at about 90% — so
that a good mark is not mistaken for a near miss (INV-GRADE-11). It never changes a
mark. Anything that is not a non-empty string is ignored rather than printed.
