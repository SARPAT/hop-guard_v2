"""HopGuard demo UI: a small web app served by Python's standard library (no extra dependencies).

Run: python ui/app.py   then open http://127.0.0.1:7860
"""
import argparse
import json
import mimetypes
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from hopguard.agent.data import EMPLOYEES, POLICY_DOCS  # noqa: E402
from hopguard.agent.tools import Session, read_outbox, reset_outbox  # noqa: E402
from hopguard.guard import AuditLog  # noqa: E402
from hopguard.guard.audit import read_rows, redact  # noqa: E402
from hopguard.pipeline import guarded_run  # noqa: E402
from ui import logic  # noqa: E402

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
LOG_DIR = os.path.join(ROOT, "logs")
AUDIT_PATH = os.path.join(LOG_DIR, "audit_ui.jsonl")
MAX_MESSAGE = 2000
MAX_BODY = 16_000

_audit: AuditLog | None = None
_lock = threading.Lock()  # one request at a time: the outbox file and audit chain are shared


def audit() -> AuditLog:
    global _audit
    if _audit is None:
        os.makedirs(LOG_DIR, exist_ok=True)
        _audit = AuditLog(AUDIT_PATH)
    return _audit


class BadRequest(ValueError):
    pass


def handle_ask(body: dict) -> dict:
    """Validate one chat request, run it through the guarded pipeline and build the view."""
    message = str(body.get("message", "")).strip()
    user_id = str(body.get("user_id", "")).upper()
    role = body.get("role")
    if not message:
        raise BadRequest("Please type a question first.")
    if len(message) > MAX_MESSAGE:
        raise BadRequest(f"Please keep the question under {MAX_MESSAGE} characters.")
    if user_id not in EMPLOYEES:
        raise BadRequest("Please pick who is asking.")
    if role not in logic.ROLES:
        raise BadRequest("Please pick a role.")
    layers = body.get("layers") or {}
    toggles = {k: bool(layers.get(k)) for k in ("G1", "G3", "G4")}
    guard_on = any(toggles.values())

    docs = dict(POLICY_DOCS)
    scenario = logic.scenario_by_id(body.get("scenario_id"))
    if scenario and scenario["doc"]:
        docs[scenario["doc"]["id"]] = scenario["doc"]["text"]

    with _lock:
        reset_outbox()
        g = guarded_run(message, Session(user_id, role), docs, toggles if guard_on else None, audit())
        outbox = read_outbox()
        g1_rows = [r for r in read_rows(AUDIT_PATH) if r["trace_id"] == g.trace_id and r["layer"] == "G1"]

    res = g.result
    step_list = logic.steps(res.trace, g1_rows, user_id, guard_on)
    return {"trace_id": g.trace_id, "ms": res.ms, "guard_on": guard_on,
            "answer": redact(res.answer or ""), "error": res.error and redact(res.error),
            "steps": step_list, "emails": logic.emails(outbox), "quarantined": g.quarantined,
            "outcome": logic.outcome(res.answer, res.error, outbox, step_list, user_id, role, guard_on),
            "audit": logic.audit_view(AUDIT_PATH)}


class Handler(BaseHTTPRequestHandler):
    server_version = "HopGuard"

    def log_request(self, code="-", size="-"):  # keep the terminal quiet apart from errors
        if not (isinstance(code, int) and code < 400):
            super().log_request(code, size)

    def _send(self, code: int, data: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/setup":
            return self._json(200, logic.setup())
        if path == "/api/audit":
            return self._json(200, logic.audit_view(AUDIT_PATH))
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC, name))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            return self._json(404, {"error": "Not found"})
        with open(full, "rb") as f:
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            self._send(200, f.read(), ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""))

    def do_POST(self):
        if self.path != "/api/ask":
            return self._json(404, {"error": "Not found"})
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size > MAX_BODY:
                raise BadRequest("Request too large.")
            body = json.loads(self.rfile.read(size) or b"{}")
            if not isinstance(body, dict):
                raise BadRequest("Bad request.")
            return self._json(200, handle_ask(body))
        except (BadRequest, json.JSONDecodeError) as e:
            return self._json(400, {"error": str(e) if isinstance(e, BadRequest) else "Bad request."})
        except Exception as e:  # show a friendly message, keep details in the terminal
            self.log_error("ask failed: %s", redact(f"{type(e).__name__}: {e}"))
            return self._json(500, {"error": "The assistant could not finish this request. "
                                             "Check the terminal where the app is running for details."})


def main() -> None:
    ap = argparse.ArgumentParser(description="HopGuard demo UI")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7860)
    a = ap.parse_args()
    keys = logic.keys_status()
    print("HopGuard demo UI  ·  keys: " + ", ".join(f"{k} {'SET' if v else 'MISSING'}" for k, v in keys.items()))
    print(f"Open http://{a.host}:{a.port} in your browser. Press Ctrl+C to stop.")
    try:
        ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
