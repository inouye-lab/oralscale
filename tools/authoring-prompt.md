# Question-bank authoring prompt (use once, offline, then freeze)

Paste this into Claude or ChatGPT to mass-generate questions, then save the JSON
to `bank/bank.json` and run `node tools/validate-bank.js`. **No AI is called at
quiz time** — this is the only place AI touches question content.

---

You are helping me build a **frozen** oral-assessment question bank for an
undergraduate ECE course. Produce questions a student can **answer aloud in
2–5 minutes** — conceptual "explain and reason" prompts, not calculation-heavy
problems that need scratch paper.

Return **only** valid JSON matching this shape:

```json
{
  "version": 1,
  "bankId": "REPLACE-course-term",
  "title": "Human-readable title",
  "course": "Course name",
  "createdWith": "Model name, frozen YYYY-MM-DD",
  "questions": [
    {
      "id": "q-short-slug",
      "topic": "Circuits | Signals & Systems | ...",
      "difficulty": "intro | core | stretch",
      "prompt": "The question shown to the student. Phrase it to be answered by speaking. Markdown (**bold**, *italic*, `code`, - lists) and LaTeX ($inline$, $$display$$) are rendered; links, images, tables and HTML are not.",
      "rubric": "1–2 sentences telling an AI grader what earns credit.",
      "keyPoints": ["ONLY what the question asks for — 2 to 4 points, without which the answer is wrong"],
      "bonusPoints": ["optional: what makes an answer stronger. Never required, never costs a mark."]
    }
  ]
}
```

Requirements:
- Generate **[N]** questions spread across topics **[list your topics]**.
- Difficulty mix: roughly 25% intro, 50% core, 25% stretch.
- `keyPoints` lists ONLY what the question asks for: 2–4 points **without which the answer is
  wrong or has not answered the question as stated**. Four is the ceiling; `validate-bank.js`
  warns above it. Everything that merely makes an answer *stronger* goes in `bonusPoints`, whose
  absence can never cost a mark. The test for each point: would an answer without it be **wrong**,
  or merely **weaker**? Wrong is required; weaker is bonus.
- Anything you make required must be **explicitly asked for in the prompt**. A student cannot be
  marked down for not answering something they were not asked.
- Prompts must **not** be Googleable one-liners; favor "explain why", "compare",
  "walk me through your reasoning", "give an example".
- Unique `id` for every question. Keep `bankId` stable across the term.
- Avoid questions whose answer is a single number or a memorized formula alone.

After generating, I will freeze this file and never regenerate it during the term,
so aim for a **large** bank (the bigger the bank, the less any single leak matters
and the more distinct retakes each student can get).
