#!/usr/bin/env python3
"""Dump everything Gradescope hands an autograder, and say which fields moved.

WHY THIS EXISTS
---------------
OralScale's late policy needs to know a STUDENT'S due date, not the assignment's.
Whether Gradescope tells an autograder about a per-student extension, a late due
date, or a DRC accommodation is not documented anywhere we could find, and the
codebase had been carrying an unverified assertion that it does not. Guessing in
either direction produces a wrong mark for a real student.

So: upload any file to an assignment running this, and read the output. It prints
the whole of `submission_metadata.json`, every leaf path in it, every value that
looks like a timestamp with its offset from the submission time, and the shape of
the container around it. Set an extension for one student, submit as them, and
the answer is in front of you.

It grades nothing and scores nothing. Delete the assignment when you are done.

Unlike tools/audit-accommodations.js, this one is safe for an agent to run: it
reads a submission's metadata, not a roster, and it redacts environment values.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

META = os.environ.get("ORALSCALE_METADATA", "/autograder/submission_metadata.json")
OUT = os.environ.get("ORALSCALE_RESULTS", "/autograder/results/results.json")
SUB = os.environ.get("ORALSCALE_SUBMISSION", "/autograder/submission")

TIMESTAMPY = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")
DATEISH = re.compile(r"date|time|due|deadline|extend|extension|accommod|created|released?",
                     re.I)


def parse(ts):
    s = str(ts).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def flatten(node, prefix=""):
    """Every leaf as (path, value). Nothing is skipped, so nothing is missed."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield from flatten(v, f"{prefix}.{k}" if prefix else str(k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from flatten(v, f"{prefix}[{i}]")
    else:
        yield prefix, node


def main():
    tests = []

    def add(name, output, visible=True):
        tests.append({"name": name, "output": output, "score": 0, "max_score": 0,
                      "status": "passed",
                      # "hidden" is instructor-only for the life of the
                      # assignment. "after_published" is NOT — it shows to
                      # students the moment grades publish, which is the wrong
                      # default for anything holding a container's environment.
                      "visibility": "visible" if visible else "hidden"})

    raw, meta, err = None, None, None
    try:
        with open(META, "r", encoding="utf-8") as f:
            raw = f.read()
        meta = json.loads(raw)
    except Exception as e:
        err = f"{type(e).__name__}: {e}"

    if meta is None:
        add("submission_metadata.json could NOT be read",
            f"path: {META}\nerror: {err}\n\nEverything below is empty as a result.")
        meta = {}

    leaves = list(flatten(meta))

    # 1. The headline: every value that looks like a timestamp, with its distance
    #    from the submission time. An extension shows up as one of these moving.
    submitted = parse(meta.get("created_at") or "") if meta.get("created_at") else None
    rows = []
    for path, value in leaves:
        if value is None or value == "":
            continue
        s = str(value)
        looks_like_a_date = bool(TIMESTAMPY.match(s))
        named_like_a_date = bool(DATEISH.search(path))
        if not (looks_like_a_date or named_like_a_date):
            continue
        dt = parse(s) if looks_like_a_date else None
        delta = ""
        if dt and submitted:
            hrs = (submitted - dt).total_seconds() / 3600.0
            delta = (f"   submission is {abs(hrs):.2f}h "
                     + ("AFTER this" if hrs > 0 else "BEFORE this"))
        rows.append(f"  {path}\n      = {s}{delta}")
    add("① Dates and date-shaped fields  ← the ones that matter",
        ("Every value that parses as a timestamp, or whose key mentions a date, due date,\n"
         "extension or accommodation. If you granted this student an extension, the field\n"
         "carrying it is in this list.\n\n"
         + ("\n".join(rows) if rows else "  (none found)")
         + "\n\nSubmitted at: " + str(meta.get("created_at") or "(absent)")))

    # 1b. THE DECISIVE COMPARISON. Confirmed 2026-09-02: every submission carries
    #     a per-user `assignment` block beside the shared one. A per-user copy of
    #     dates that could be read from the shared block only earns its place if
    #     it can DIFFER — which is exactly what an extension is. So: print both,
    #     side by side, and say whether they diverge.
    shared = meta.get("assignment") if isinstance(meta.get("assignment"), dict) else {}
    users = meta.get("users") if isinstance(meta.get("users"), list) else []
    mine = {}
    for u in users:
        if isinstance(u, dict) and isinstance(u.get("assignment"), dict):
            mine = u["assignment"]
            break
    keys = ("release_date", "due_date", "late_due_date")
    lines, diverged = [], []
    for k in keys:
        a_val, u_val = shared.get(k), mine.get(k)
        same = str(a_val) == str(u_val)
        if not same and u_val:
            diverged.append(k)
        lines.append(f"  {k}\n"
                     f"      assignment.{k}          = {a_val}\n"
                     f"      users[0].assignment.{k} = {u_val}\n"
                     f"      -> {'IDENTICAL' if same else '*** DIFFERENT ***'}")
    if not mine:
        verdict = ("There is NO per-user assignment block in this submission. Whatever you set "
                   "is not reaching the autograder per-student.")
    elif diverged:
        verdict = ("*** THE PER-USER BLOCK DIFFERS on: " + ", ".join(diverged) + " ***\n"
                   "That is the answer: this Gradescope DOES pass per-student dates to the\n"
                   "autograder, at users[0].assignment. OralScale reads that field, so a student\n"
                   "with an extension will not be penalised for using it.")
    else:
        verdict = ("The per-user block is present and IDENTICAL to the shared one.\n"
                   "Expected when this student has no extension. Grant one and submit again:\n"
                   "if due_date then differs, per-student dates propagate.")
    add("①b Per-student dates vs the assignment's  ← the decisive one",
        ("Gradescope sends the dates TWICE: once for the assignment, once under the\n"
         "submitting user. If an extension reaches the autograder at all, it reaches it\n"
         "as a difference between these two.\n\n"
         + "\n".join(lines) + "\n\n" + verdict))

    # 2. Every leaf, so an undocumented field cannot hide behind an unexpected
    #    name or nesting depth.
    add("② Every field in submission_metadata.json, flattened",
        ("Path = value, for every leaf. Nothing filtered.\n\n"
         + "\n".join(f"  {p} = {v!r}" for p, v in leaves) if leaves
         else "  (metadata was empty)"))

    # 3. The raw file, in case the flattening loses something meaningful.
    add("③ The raw file, verbatim",
        (raw if raw else "(unreadable)"), visible=True)

    # 4. What else the container has. Gradescope has been known to place things
    #    beside the metadata that are not documented either.
    listing = []
    for d in ("/autograder", SUB, "/autograder/results"):
        try:
            names = sorted(os.listdir(d))
        except Exception as e:
            listing.append(f"  {d}  -> {type(e).__name__}")
            continue
        listing.append(f"  {d}/")
        for n in names:
            p = os.path.join(d, n)
            try:
                size = os.path.getsize(p)
                kind = "dir" if os.path.isdir(p) else f"{size} B"
            except Exception:
                kind = "?"
            listing.append(f"      {n}  ({kind})")
    add("④ What else is in the container", "\n".join(listing))

    # 5. Gradescope sets some environment; worth a look for anything date-shaped.
    #
    # REDACTED WIDE, ON PURPOSE. A name-based filter only catches the categories
    # someone thought of, and the cost of missing one here is dumping a
    # credential — or a roster of who has a disability accommodation — into a
    # Gradescope test. Anything a course might plausibly put in its environment
    # gets its VALUE hidden while its NAME still shows, which is all this
    # diagnostic ever needed.
    SENSITIVE = re.compile(
        r"KEY|SECRET|TOKEN|PASS|CRED|AUTH|SALT|SIGN|ACCOM|EXTENSION|ROSTER|"
        r"STUDENT|EMAIL|GRANT|DRC|PII", re.I)
    envs = [(k, ("<redacted>" if SENSITIVE.search(k) else v))
            for k, v in sorted(os.environ.items())]
    add("⑤ Environment",
        "\n".join(f"  {k} = {v}" for k, v in envs) or "  (none)", visible=False)

    result = {
        "score": 0,
        "output": ("OralScale metadata probe — this assignment grades nothing.\n\n"
                   "Open the tests below. ① is the answer to 'does Gradescope tell an "
                   "autograder about per-student due dates and accommodations'.\n\n"
                   "NOTE: this echoes the submitter's own name and email back to them. "
                   "Fine for your own testing; do not leave it open to a class."),
        "visibility": "visible",
        "stdout_visibility": "visible",
        "tests": tests,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print(f"wrote {OUT} with {len(tests)} test(s)")


if __name__ == "__main__":
    sys.exit(main())
