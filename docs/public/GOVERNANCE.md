# Public OralScale guides

The public release surface is `site/`: overview, Student guide, Faculty guide, screenshots, and
printable downloads. It contains no private Course material. HTML is primary. Each PDF uses that
same HTML and stylesheet: one US Letter Quickstart page, followed by one FAQ page (INV-DOC-1).
On screen, each guide is a continuous scrolling document. Page framing, running headers and
page numbers belong only to print. Keep the audience label and Quickstart heading useful online.
Copy the complete `site/` directory to any static host; no build, runtime service, analytics,
external fonts, or student information is needed to serve it.

## Source of truth and review mapping

- `content.json`: audience copy, stable FAQ IDs, and source references per FAQ and Quickstart.
- `site/guide.css`: shared web and print design. Do not maintain a second PDF template.
- `tools/public-guides/build.cjs`: generates the three HTML entrypoints from the copy.
- `external-sources.json`: official Gradescope sources and verification date. Recheck at release
  and at least every six months; the gate fails when this review becomes overdue.
- `screenshots.json`: input and output fingerprints for reproducible app captures.
- `render.json`: fingerprints binding PDFs to the HTML/CSS/images used in their render.
- `review.json`: explicit editorial review, mapped sources, and artifact fingerprints.

**The review blocks at release, not on every commit** (instructor, 2026-09-12). `npm run
test:guides` is advisory. On ordinary commits and pushes to main, it lists changes that suggest a
guide update and exits cleanly. `npm run test:guides:release` is the gate: CI runs it on every `v*`
release tag, and it fails until the review is acknowledged. Structural errors, such as a malformed
`content.json` or an FAQ with no sources, fail in both modes. Changed specifications identify
affected FAQ IDs and Quickstarts. Changed app UI, CSS, recording code, or screenshot recipe requires fresh screenshots.
Changed copy, images, HTML, CSS, or renderer requires fresh PDFs. Added/removed FAQs and missing
sources are detected too. The check reads only explicitly named public sources, never private
courses, credentials, student records, or the accommodation audit.

A hash can flag a change; it cannot decide whether an answer is still true or a screenshot is
helpful. Review the affected content, correct it where needed, and record a specific disposition.
Do not refresh review fingerprints merely to make CI pass. A change with no public effect can be
acknowledged with an explanation, after regenerating any affected screenshots and downloads.

## Update workflow

Run from the OralScale repository root. Node is sufficient for the build and drift gate.
Screenshot/PDF work additionally needs Playwright and Chrome as **authoring tools**, not app
runtime dependencies. Set `PLAYWRIGHT_MODULE` to an installed Playwright package if it is not on
Node's module path; `CHROME_CHANNEL` defaults to `chrome`. Poppler is used for visual PDF review.

1. Read affected models and current UI. Update `content.json` and its source mapping as needed.
2. `npm run guides:capture` captures the actual app renderer using synthetic response fixtures,
   an empty key-entry screen, fake microphone audio, and an isolated local server. All requests
   outside that server are blocked. There is no live Course, valid signing token, or student.
   These are **UI illustrations**, not evidence that the certification/grading pipeline passed.
   Do not replace them with screenshots from a real course or Gradescope student submissions.
3. `npm run guides:build` regenerates HTML. Start a local preview:
   `python3 -m http.server 8766 --bind 127.0.0.1 --directory docs/public/site`.
4. `npm run guides:render` checks links, images, layout at 360/768/1440 pixels and print overflow,
   then renders both PDFs from those pages. `GUIDE_PREVIEW_URL` may point to another **local** preview.
   The renderer asserts two US Letter pages in each generated Chromium PDF.
5. Render **all four PDF pages** with `pdftoppm`, inspect them for clipping, readable labels and
   whitespace, and inspect the mobile and desktop images in `tmp/public-guides/`. Review content,
   keyboard navigation and downloadable links. This manual review is mandatory for release.
6. Record what was reviewed (include any deliberate no-change decisions):
   `node tools/public-guides/check.cjs --acknowledge --reviewer "Name" --note "Specific review"`.
7. At release, run `npm run test:guides:release` and the repository test gate. Between releases,
   `npm run test:guides` only suggests updates. Keep models/07 and STATUS current. Rendering and
   acknowledgement never run automatically in CI; the release-tag gate must catch stale
   materials.
8. Copy only the files in `site/` to the website. Run its local build and check `/oralscale/`,
   both guide links, screenshots and PDF downloads. Publishing/pushing is a separate user decision.

## Website handoff

The portable directory is suitable for a Hugo site's `static/oralscale/`. Add an **OralScale**
main-menu entry pointing to `/oralscale/`. Keep it as one self-contained static section, so website
styles cannot change the guides or their print rendering. Never copy `content.json`, manifests,
maintenance scripts, a private course, or the OralScale repository wholesale into public assets.
Maintain the guides here, then replace the complete allowlisted public bundle on the destination.

`repositoryUrl` is `https://github.com/inouye-lab/oralscale`, explicitly approved by the user
for the upcoming public release. Guide and setup links use that repository even while it is
private; verify anonymous access when publishing. This does not authorize changing visibility.

## Scope and limits

The faculty guide leads with AI-assisted setup of an owned demo course and website, then
source-grounded bank generation. An AI coding agent replaces the technical-partner prerequisite;
faculty provide accounts, source materials, teaching goals and judgment. Include a copyable starter
prompt directly after prerequisites, before the steps, and direct question-design/specification links. Distinguish an agent with file/command
access from text-only chat. Do not invent a faculty dashboard or no-code installer. Course timing,
question counts and policies are examples, not universal promises. Preserve the active-submission
rule, code-reading steps, explicit Gradescope upload, and distinction between audio and transcript
processing. No screenshot refresh requires inspecting student records.

Accommodation guidance must describe the instructor-run offline audit without accessing its
restricted code or records. Preserve the excess-time condition, human review and unchanged
grades. Approval lists stay out of the autograder and AI tools. Explain cleanup of local copies
under institutional retention rules, and instructor responsibility for FERPA and local policy.
The guide provides no blanket legal compliance or developer-liability guarantee.

## Visual identity

Use plum/apricot with white backgrounds, charcoal body copy and deep-plum headings. Student
controls and steps lean plum; Faculty controls and steps use dark burnt apricot, with shared
plum panels. Landing-path colors must match guide accents. Keep text audience labels and the
shared typography/layout; do not rely on color alone. Check text/button contrast (4.5:1) and
render the same palette in both PDFs. The website-only main navigation uses stable plum brand
colors, and the project navigation remains plum across all audience pages. Audience-specific
accents belong in the content below the navigation.

Keep the overview developer note secondary: link to GitHub, identify the MIT license, and
welcome improvements and pull requests. The license file is fingerprinted by the guide gate
so a license change requires review of this public claim.
