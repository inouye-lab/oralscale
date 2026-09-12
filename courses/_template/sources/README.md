# `sources/` — raw materials the question bank was generated from

Drop whatever you have here: slides, lecture notes, reading lists, past exams, homework solutions.
PDF, PPTX, Markdown, plain text and scans are all fine — it is an archive, not a pipeline input
format.

**Organise by week** where you can. A generator uses the folder name as a hint:

```
sources/
  week-01/lecture-01.pdf
  week-02/slides.pptx
  syllabus.pdf          <- course-wide material can sit at the top level
  README.md
```

**These files are kept, not consumed.** They are not deleted after a bank is generated, and they
are the reason you can regenerate week 4 in November after deciding the questions drifted from
what you actually taught.

**Two things that do not belong here**, because this is a normal folder in your repository:

- anything with a student's name, work, or grade in it;
- unreleased solution sets, or an exam you still intend to reuse.

If your course materials are large or licensed, add `sources/` to `.gitignore` and keep them
locally instead — nothing in the system reads them at quiz time or at grading time. They are for
you and for whatever assistant helps you author the bank.

Record what each file is, and which week it belongs to, in your `question-design.md`.
