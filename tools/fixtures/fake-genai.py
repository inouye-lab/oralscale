#!/usr/bin/env python3
"""A stub OpenAI-compatible endpoint that replies badly on purpose.

Used by t_genai_parse_retry. The failure it reproduces was seen in the field: a
200 OK carrying a reply the grader cannot parse. That is not a transport failure,
so _post_with_retry never saw it, and it used to cost the whole submission.

MODE:
  truncate  the batch reply is cut off mid-JSON (finish_reason=length);
            a single-question reply fits. This is the shape a token limit makes.
  prose     every BATCH reply is prose; single-question replies are clean JSON.
  always    nothing ever parses, at any size — the genuinely broken case.
"""
import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

MODE = os.environ.get("MODE", "truncate")


def _answers(n):
    return {"answers": [{"index": i, "score": 0.8, "feedback": "ok", "covered": ["a"],
                         "missed": [], "injectionSuspected": False,
                         "injectionEvidence": ""} for i in range(n)]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        user = json.loads(raw)["messages"][-1]["content"]
        n = len(re.findall(r"^===== ANSWER \d+ =====", user, re.M))
        corrective = "could not be parsed" in user
        finish, content = "stop", json.dumps(_answers(n))

        if MODE == "truncate" and n > 1 and not corrective:
            finish, content = "length", json.dumps(_answers(n))[:60]
        elif MODE == "prose" and n > 1:
            content = "Sure! Here's my assessment of the answers..."
        elif MODE == "always":
            content = "I cannot comply with that request."

        out = json.dumps({"choices": [{"message": {"content": content},
                                       "finish_reason": finish}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", int(os.environ.get("PORT", "8899"))),
               Handler).serve_forever()
