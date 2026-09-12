"""Late-submission policy: how much of the mark a late submission keeps.

Configured per course in `course.json` under `gradingPolicy.late`, and
overridable per assignment. Kept deliberately small — two shapes, not a
scripting language:

    "gradingPolicy": {
      "late": {
        "mode": "none"                       // grade everything, no penalty
      }
    }

    "gradingPolicy": {
      "late": {
        "mode": "steps",
        "graceMinutes": 5,
        "steps": [ { "withinDays": 1, "deductPercentOfMax": 20 } ],
        "afterSteps": "zero"                 // or "keepLast"
      }
    }

`deductPercentOfMax` is a percentage OF THE ASSIGNMENT MAXIMUM, not of the
score earned. 20% of a 10-point assignment is 2 points, whether the student
scored 9 or 4. A percentage of the earned score would punish a weak submission
less than a strong one for the same delay, which is not what "one day late costs
two marks" means to anyone.

WHOSE DUE DATE — SETTLED BY MEASUREMENT, 2026-09-02
Every submission carries the dates TWICE: a shared `assignment` block, and a
per-user one under the submitting student.

    "users": [{"id": …, "email": …, "assignment": {
        "release_date": …, "due_date": …, "late_due_date": …}}],
    "assignment": {"id": …, "title": …, "due_date": …, …}

Three live submissions through `tools/metadata-probe` established, rather than
assumed:

  1. With no extension, the two blocks are IDENTICAL.
  2. With a per-student **due-date** extension, the per-user block DIVERGES —
     release, due and late due dates all move; the shared block does not.
  3. A per-student **time-limit** extension ("multiply available time by 1.5")
     does not appear ANYWHERE. The file is byte-identical to (1).

So `users[0].assignment.due_date` is the student's own deadline, always, and it
is what this module uses. Because (2) proves an extension would show up there,
(1) can now be read as "this student has no extension" rather than "we cannot
tell" — which is why a mark computed from it needs no review flag any more.

(3) is the DRC case, and it confirms rather than contradicts INV-ACCOM-1/2:
extended TIME is invisible to the container, so it must be claimed by the student
and verified afterwards against an export. Do not try to read it here.

There is deliberately NO instructor-supplied override file. One existed briefly,
as a fallback for the case where Gradescope did not pass the date through — a
case (2) showed does not arise. It was keyed by student email, so keeping a
fallback nobody needs would have meant shipping addresses into every autograder
zip for nothing (INV-PRIV-6).
"""
from datetime import datetime, timezone

SECONDS_PER_DAY = 86400.0


def _parse(ts):
    """Gradescope timestamps: '2018-07-01T14:22:32.365935-07:00'. None if unusable."""
    if not ts:
        return None
    s = str(ts).strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    s = s.replace(" ", "T", 1) if ("T" not in s and " " in s) else s
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    # A naive timestamp is assumed UTC rather than rejected: being an hour out is
    # recoverable, refusing to grade is not.
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


# Where a due date can come from, most authoritative first. `source` is reported
# to the instructor so a penalty is always traceable to the date that produced it.
DUE_SOURCES = (
    ("metadata-user", "this student's OWN due date (users[].assignment.due_date) — it "
                      "differs from the assignment's, so this student has an extension"),
    ("metadata-user-same", "this student's own due date (users[].assignment.due_date), "
                           "matching the assignment's — no extension for them"),
    ("metadata", "the assignment-wide due date — NO per-user block in this metadata, "
                 "which is not the shape Gradescope was measured to send"),
)


def find_due_dates(meta):
    """Every date field the metadata carried, for diagnosis. Never raises.

    Reported verbatim in the instructor output. The point is not that the code
    uses all of them — it uses one — but that an instructor who grants an
    extension can look at one real submission and SEE whether Gradescope passed
    it through, instead of taking this file's word for it.
    """
    out = {}
    if not isinstance(meta, dict):
        return out
    a = meta.get("assignment") if isinstance(meta.get("assignment"), dict) else {}
    for label, value in (("assignment.due_date", a.get("due_date")),
                         ("assignment.late_due_date", a.get("late_due_date")),
                         ("assignment.release_date", a.get("release_date")),
                         ("created_at", meta.get("created_at"))):
        if value:
            out[label] = str(value)
    # A per-user date, if this Gradescope ever emits one. Cheap to look for and
    # the most specific thing there could be.
    users = meta.get("users")
    if isinstance(users, list):
        for i, u in enumerate(users):
            if not isinstance(u, dict):
                continue
            ua = u.get("assignment") if isinstance(u.get("assignment"), dict) else {}
            for k in ("due_date", "late_due_date", "release_date"):
                if ua.get(k):
                    out["users[%d].assignment.%s" % (i, k)] = str(ua[k])
            for k in ("due_date", "extended_due_date", "effective_due_date"):
                if u.get(k):
                    out["users[%d].%s" % (i, k)] = str(u[k])
    return out


def user_due(meta):
    """The submitter's OWN due date from `users[0].assignment.due_date`, or None.

    CONFIRMED PRESENT on Gradescope, 2026-09-02, by tools/metadata-probe against
    a live submission. Every submission carries a per-user `assignment` block
    alongside the shared one:

        "users": [{"id": …, "email": …, "assignment": {
            "release_date": …, "due_date": …, "late_due_date": … }}],
        "assignment": { "id": …, "title": …, "due_date": … }

    A per-user copy of dates that could simply have been read from the shared
    block only earns its place if it can DIFFER from it — which is what an
    extension is. That is strong evidence, not proof: on a submission with no
    extension the two are identical, so one such submission cannot distinguish
    "extensions land here" from "this block is redundant". A due-date extension
    seen to move this field would settle it.

    ALSO MEASURED, 2026-09-02: a Gradescope **time-limit** extension (the
    "multiply available time by 1.5" kind) does NOT appear in the metadata at
    all — the file is byte-identical to a submission with no extension. That is
    a different feature from a due-date extension and it is the one that maps to
    a DRC accommodation, which is why extended time still has to be CLAIMED by
    the student and verified afterwards against an export (INV-ACCOM-1/2). This
    module cannot see it and must not pretend to.
    """
    users = meta.get("users") if isinstance(meta, dict) else None
    if not isinstance(users, list):
        return None
    for u in users:
        if isinstance(u, dict):
            ua = u.get("assignment")
            if isinstance(ua, dict) and ua.get("due_date") and _parse(ua["due_date"]):
                return str(ua["due_date"])
            # Flat variants, in case this ever moves.
            for k in ("due_date", "extended_due_date", "effective_due_date"):
                if u.get(k) and _parse(u[k]):
                    return str(u[k])
    return None


def effective_due(meta, student_ref=None, email=None):
    """(due_at, source, is_authoritative) for THIS submission.

    Everything comes from the metadata Gradescope wrote for this submission. The
    identity arguments are unused today and kept because every caller already has
    them: if a future Gradescope ever keys dates differently, this is where that
    lookup belongs, and it should not require changing every call site.
    """
    meta = meta if isinstance(meta, dict) else {}
    a = meta.get("assignment") if isinstance(meta.get("assignment"), dict) else {}
    shared = str(a["due_date"]) if a.get("due_date") else None
    mine = user_due(meta)

    if mine:
        # The submitter's own copy, and it is AUTHORITATIVE either way. A real
        # due-date extension was observed to move this field while leaving the
        # shared block alone (see the module docstring), so the two agreeing now
        # means "this student has no extension" rather than "we cannot tell".
        # The distinction is still reported, because an instructor reading a
        # penalty wants to see which of those two it was.
        differs = bool(shared) and _parse(mine) != _parse(shared)
        return mine, ("metadata-user" if differs else "metadata-user-same"), True
    if shared:
        # No per-user block at all. Not the shape Gradescope was measured to
        # send, so something is different about this submission — a group
        # submission, an older instance, a hand-made metadata file in a test.
        # Use the assignment date, but say it is not the student's own.
        return shared, "metadata", False
    return None, "none", False


def lateness_seconds(submitted_at, due_at):
    """Seconds late, or None if either timestamp is missing or unparseable.

    None means "cannot tell", and callers must treat it as ON TIME. A clock we
    cannot read is our problem, not the student's.
    """
    sub, due = _parse(submitted_at), _parse(due_at)
    if sub is None or due is None:
        return None
    return (sub - due).total_seconds()


def resolve(policy):
    """Normalise a `gradingPolicy.late` block. Unknown modes fall back to none."""
    p = dict(policy or {})
    mode = str(p.get("mode") or "none").strip().lower()
    if mode not in ("none", "steps"):
        return {"mode": "none", "warning": f"unknown late.mode {mode!r} — no penalty applied"}
    steps = []
    for raw in (p.get("steps") or []):
        try:
            steps.append({
                "withinDays": float(raw.get("withinDays")),
                "deductPercentOfMax": float(raw.get("deductPercentOfMax", 0)),
            })
        except (TypeError, ValueError, AttributeError):
            return {"mode": "none", "warning": f"unreadable late.steps entry {raw!r} — no penalty applied"}
    steps.sort(key=lambda s: s["withinDays"])
    if mode == "steps" and not steps:
        return {"mode": "none", "warning": "late.mode is 'steps' but no steps were given — no penalty applied"}
    after = str(p.get("afterSteps") or "zero").strip().lower()
    if after not in ("zero", "keeplast"):
        after = "zero"
    return {
        "mode": mode,
        "graceMinutes": float(p.get("graceMinutes", 0) or 0),
        "steps": steps,
        "afterSteps": after,
        "warning": None,
    }


def apply_late_policy(score, max_points, late_sec, policy):
    """Return (adjusted_score, detail).

    `detail` describes what happened and why, for both the instructor note and
    the student's own feedback. Never raises: a broken policy grades everything.
    """
    pol = resolve(policy)
    detail = {"applied": False, "mode": pol["mode"], "lateSec": late_sec,
              "deducted": 0.0, "warning": pol.get("warning"), "reason": None,
              "lateDays": None, "graceMinutes": pol.get("graceMinutes", 0)}

    if pol["mode"] == "none" or late_sec is None or late_sec <= 0:
        detail["reason"] = "on time" if (late_sec is not None and late_sec <= 0) else (
            "no late policy configured" if pol["mode"] == "none" else "submission time unknown — treated as on time")
        return round(float(score), 2), detail

    grace = pol["graceMinutes"] * 60.0
    if late_sec <= grace:
        detail["reason"] = f"within the {pol['graceMinutes']:g}-minute grace window"
        return round(float(score), 2), detail

    effective = late_sec - grace
    days = effective / SECONDS_PER_DAY
    detail["lateDays"] = round(days, 3)

    step = next((s for s in pol["steps"] if days <= s["withinDays"] + 1e-9), None)
    if step is None:
        if pol["afterSteps"] == "keeplast" and pol["steps"]:
            step = pol["steps"][-1]
        else:
            detail.update(applied=True, deducted=round(float(score), 2),
                          reason=f"more than {pol['steps'][-1]['withinDays']:g} day(s) late")
            return 0.0, detail

    deduct = max_points * (step["deductPercentOfMax"] / 100.0)
    out = max(0.0, float(score) - deduct)
    detail.update(applied=True, deducted=round(min(deduct, float(score)), 2),
                  reason=f"within {step['withinDays']:g} day(s) late "
                         f"({step['deductPercentOfMax']:g}% of the {max_points:g}-point maximum)")
    return round(out, 2), detail
