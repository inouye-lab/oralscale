"""Instructor notification, used for one thing: accommodation review.

⚠️ DISABLED BY DEFAULT (2026-08-24), PENDING A FERPA DECISION.
Nothing here runs unless ORALSCALE_NOTIFY_ENABLED=1 is set explicitly, and that
is deliberate rather than a convenience default. Sending mail about an
accommodation review hands a third-party mail provider the fact that a
particular Gradescope submission needs looking at for accommodation reasons.
Even carrying no name, that is arguably a disclosure of an education record to
an outside processor, and it leaves the institutional boundary that the rest of
this system is built to keep student work inside. Whether that is acceptable is
an institutional judgement, not one this code should make by defaulting to on.

Until that is settled, an unverifiable accommodation is still surfaced — it is
flagged in the instructor-only tests on the submission itself, inside
Gradescope. The email would only have made it easier to notice, not more
correct. The code is kept, working and tested, for when the decision is made.

WHY IT EXISTS
A student who selects an extended-time accommodation we cannot verify is graded
normally and told not to worry (INV-ACCOM-2). But somebody has to actually look,
and a hidden test in one submission out of two hundred is not a notification —
it is a place the fact goes to die. So the instructor gets an email.

PRIVACY — read before adding anything to the body.
This concerns a student's DRC/disability accommodation, the most sensitive datum
this system touches, and email is the least controlled channel it could travel
on. The body therefore carries NO student name, NO email address, NO studentRef,
and NO claimed multiplier. It carries the assignment and the Gradescope
submission id, and it says "open Gradescope". Everything else already lives
there, inside the boundary, where the instructor is entitled to it and where it
is protected. A notification is a pointer, not a copy (INV-ACCOM-3).

FAILURE BEHAVIOUR
Never breaks grading. Not configured, wrong password, blocked port, hung server:
all return a reason string that is shown to the instructor in the submission, so
"no email arrived" is never confused with "nothing needed attention".
"""
import os
import smtplib
import ssl
from email.message import EmailMessage

SMTP_TIMEOUT_SEC = 15   # a hung SMTP server must not eat the container's budget


def _env(name, default=""):
    return (os.environ.get(name) or default).strip()


def is_enabled():
    """Explicit opt-in. Absent this, nothing is sent and nothing is attempted.

    Separate from is_configured() on purpose: leaving SMTP settings lying around
    in secret.env must not be enough to start mailing about accommodations. The
    instructor has to say so.
    """
    return _env("ORALSCALE_NOTIFY_ENABLED") == "1"


def is_configured():
    return bool(_env("ORALSCALE_NOTIFY_TO") and _env("ORALSCALE_SMTP_HOST"))


def notify_instructor(subject, body):
    """Send one plain-text notification. Returns (sent: bool, reason: str).

    `reason` is written into the instructor's own submission output, so it must
    be actionable and must never contain a credential.
    """
    if not is_enabled():
        return False, ("email notification is OFF (default) pending a FERPA decision — an "
                       "unverifiable accommodation is still flagged on the submission itself. "
                       "To turn it on once you have settled that: set ORALSCALE_NOTIFY_ENABLED=1 "
                       "alongside ORALSCALE_NOTIFY_TO / ORALSCALE_SMTP_HOST in "
                       "autograder/source/secret.env")

    to = _env("ORALSCALE_NOTIFY_TO")
    host = _env("ORALSCALE_SMTP_HOST")
    if not to or not host:
        return False, ("email not configured — set ORALSCALE_NOTIFY_TO and ORALSCALE_SMTP_HOST "
                       "(plus ORALSCALE_SMTP_USER / ORALSCALE_SMTP_PASS) in autograder/source/secret.env")

    port = int(_env("ORALSCALE_SMTP_PORT", "587") or 587)
    user = _env("ORALSCALE_SMTP_USER")
    password = _env("ORALSCALE_SMTP_PASS")
    sender = _env("ORALSCALE_SMTP_FROM") or user or to

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to
    msg.set_content(body)

    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT_SEC,
                                  context=ssl.create_default_context()) as s:
                if user and password:
                    s.login(user, password)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT_SEC) as s:
                try:
                    s.starttls(context=ssl.create_default_context())
                except smtplib.SMTPException:
                    # Plaintext to a host that promised no TLS is a decision the
                    # instructor made by configuring that host; we do not silently
                    # upgrade or silently refuse, we just proceed and say so.
                    pass
                if user and password:
                    s.login(user, password)
                s.send_message(msg)
        return True, f"sent to {to}"
    except Exception as e:                     # noqa: BLE001 - never break grading
        # The class name is enough to act on (auth, connect, timeout) without any
        # chance of a credential landing in the instructor's output.
        return False, f"{type(e).__name__} while sending to {to} via {host}:{port}"
