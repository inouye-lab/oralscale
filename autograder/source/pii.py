"""Redact personal details from a transcript before it leaves the FERPA boundary.

WHERE THE BOUNDARY IS (INV-PRIV-4)
----------------------------------
Three places hold different things, and the rules differ at each:

  * The **Signer** holds hashes and timestamps. It never sees audio or text.
    Nothing to redact — INV-PRIV-1 and INV-PRIV-2 keep it empty by construction.
  * **Gradescope** holds the audio, the transcript, and the grade. It is the
    system of record and is inside Purdue's FERPA boundary. Nothing is redacted
    here: an instructor investigating an attempt needs the real transcript, and
    the audio is right there anyway, so redacting the text would be theatre.
  * **Purdue GenAI Studio** is where the transcript LEAVES the autograder to be
    graded. It is the only outbound flow, and it is the one this module guards.

So redaction is applied to the copy sent for grading, and only to that copy. The
instructor's view, the student's view of their own transcript, and the stored
submission are untouched.

WHY REDACT AT ALL, GIVEN THE STUDENT WAS ASKED NOT TO
-----------------------------------------------------
The web app now tells students to answer the question and say nothing personal
(INV-PRIV-4), which is the real control — nothing said is nothing to protect.
This is the backstop for when it happens anyway: a student saying "this is Priya
Sharma, PUID 0012345678" out of habit before answering should not have that
shipped to a grading service, and a nervous student who narrates their phone
number is not committing an error worth a FERPA incident.

WHAT IT IS NOT
--------------
It is not a general PII classifier and does not pretend to be. It matches a short
list of shapes with high precision — addresses, government-style ID numbers,
phone numbers, email addresses, explicit self-identification — and deliberately
misses everything ambiguous. Detecting a bare name in prose is not reliably
possible and an aggressive attempt would mangle answers ("Bayes", "Markov",
"Frobenius" are all names). The order is: ask first, redact what is
unmistakable, tell the instructor what was found.

FALSE POSITIVES ARE A GRADING BUG
---------------------------------
Every pattern here is written against a transcript of someone explaining
mathematics out loud. "Ten to the minus three", "zero point zero zero one",
"a 256 by 256 image", "equation 3.14" must all survive untouched, because
redacting them changes the answer the grader reads and therefore the grade. The
digit rules are all anchored to a shape a number in a maths answer does not
have — a nine-plus digit run, a 3-3-4 phone grouping, an explicit label.
"""
from __future__ import annotations
import re

# Each entry: (label, compiled pattern). Order matters — the more specific
# patterns run first so their text is gone before a looser one can see it.
_PATTERNS = [
    # Written-out email, and the way one is actually SPOKEN.
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("email", re.compile(
        r"\b[A-Za-z][A-Za-z0-9 .'-]{1,40}?\s+at\s+"
        r"(?:purdue|gmail|yahoo|hotmail|outlook|icloud|protonmail|aol)\s+dot\s+"
        r"(?:edu|com|org|net|io)\b", re.I)),

    # Government-style identifiers. The SSN shape is distinctive; a Purdue PUID
    # is ten digits beginning 00. A bare nine-or-more digit run is not something
    # anyone produces while explaining gradient descent.
    ("id-number", re.compile(r"\b\d{3}[-\s]\d{2}[-\s]\d{4}\b")),
    ("id-number", re.compile(r"\b00\d{8}\b")),
    ("id-number", re.compile(r"\b\d{9,}\b")),
    ("id-number", re.compile(
        r"\b(?:student\s+(?:id|number)|puid|social\s+security(?:\s+number)?|ssn|"
        r"passport(?:\s+number)?|driver'?s?\s+licen[cs]e)\s*(?:is|number|#|:)?\s*"
        r"[A-Za-z0-9][A-Za-z0-9\s-]{3,20}", re.I)),

    # Phone. Requires the 3-3-4 grouping or an explicit label, so "three one
    # four one five nine" (someone reciting pi) does not trip it.
    ("phone", re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b")),
    ("phone", re.compile(r"\b(?:phone|cell|mobile|telephone)\s*(?:number)?\s*(?:is|:)?\s*"
                         r"(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b", re.I)),

    # Street address.
    ("address", re.compile(
        r"\b\d{1,5}\s+(?:[NSEW]\.?\s+)?[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+"
        r"(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|"
        r"Way|Circle|Cir|Place|Pl|Terrace|Ter|Mall|Parkway|Pkwy|Highway|Hwy|"
        r"Trail|Loop|Square|Sq|Apartment|Apt)\b\.?", re.I)),

    # Explicit self-identification. Only the unmistakable openings: a bare "I am"
    # would swallow "I am going to explain", which is how half of these answers
    # begin.
    # The lead-in is case-insensitive (Whisper capitalises sentence starts), but
    # the NAME itself must be capitalised — that is what separates "my name is
    # David Inouye" from "this is the key idea". The eponym veto below is what
    # keeps "this is Bayes Rule" out of it; see _NAME_STOP.
    ("name", re.compile(
        r"\b(?i:my\s+name\s+is|this\s+is|i\s+am|i'?m|speaking\s+is)\s+"
        r"[A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){1,2}\b")),
    ("name", re.compile(r"\b(?i:my\s+name\s+is)\s+[A-Z][a-z'-]+\b")),

    ("date-of-birth", re.compile(
        r"\b(?:date\s+of\s+birth|born\s+on|my\s+birthday\s+is|d\.?o\.?b\.?)\s*(?:is|:)?\s*"
        r"[A-Za-z0-9,\s/-]{4,25}", re.I)),
]

# Machine learning is built out of dead mathematicians, and its transcripts are
# therefore full of capitalised two-word phrases that look exactly like personal
# names: "this is Bayes Rule", "I'm using Monte Carlo". Redacting those would
# delete the answer and change the grade. A hit on the `name` pattern is vetoed
# if any capitalised word in it is one of these.
#
# Deliberately biased toward vetoing: a missed self-identification is flagged to
# the instructor by the other patterns in the same sentence more often than not,
# whereas a redacted technical term is an invisible grading error.
_NAME_STOP = {w.lower() for w in """
Bayes Bayesian Markov Markovian Gauss Gaussian Newton Euler Fourier Taylor Jacobian
Hessian Frobenius Bernoulli Poisson Laplace Laplacian Lagrange Lagrangian Kalman
Boltzmann Hopfield Shannon Nash Monte Carlo Hoeffding Chebyshev Jensen Cauchy Schwarz
Lipschitz Kullback Leibler Wasserstein Dirichlet Beta Gamma Adam Lasso Ridge
Rule Theorem Law Method Equation Property Model Network Learning Machine Deep Neural
Descent Divergence Inequality Distribution Process Chain Tree Forest Regression
Central Limit Bias Variance Kernel Support Vector Principal Component Analysis
Expectation Maximization Gradient Stochastic Convolutional Recurrent Attention
Transformer Encoder Decoder Softmax Sigmoid Entropy Information Bound Estimator
Sampling Inference Prior Posterior Likelihood Loss Error Score Accuracy Precision
Recall True False Positive Negative Training Test Validation Cross Batch Norm
""".split()}


def _name_vetoed(matched: str) -> bool:
    words = re.findall(r"[A-Z][a-z'-]+", matched)
    # The lead-in words themselves are lowercase in speech but Whisper may
    # capitalise the first; ignore the first token when it is the lead-in.
    return any(w.lower() in _NAME_STOP for w in words)


# The redaction marker. Readable to a grader ("something was removed here"), and
# it carries no information about what.
def _marker(label):
    return f"[{label} removed]"


def redact(text: str):
    """Return (redacted_text, findings).

    `findings` is a list of {"type", "count"} — the KINDS found and how many, and
    deliberately not the matched text. The instructor report says "one phone
    number was removed before grading", not the number; the real transcript is
    already in Gradescope for them to read if they need it, and copying it into a
    second place is the thing this module exists to avoid.
    """
    t = str(text or "")
    if not t.strip():
        return t, []
    counts = {}
    for label, pat in _PATTERNS:
        def sub(m, label=label):
            if label == "name" and _name_vetoed(m.group(0)):
                return m.group(0)
            counts[label] = counts.get(label, 0) + 1
            return _marker(label)
        t = pat.sub(sub, t)
    findings = [{"type": k, "count": v} for k, v in sorted(counts.items())]
    return t, findings


def summary(findings) -> str:
    if not findings:
        return ""
    return ", ".join(f"{f['count']} × {f['type']}" for f in findings)
