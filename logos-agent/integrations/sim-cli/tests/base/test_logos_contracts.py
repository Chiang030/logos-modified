import json
from pathlib import Path
import pytest
from sim.installations import discover, probe
from sim.capabilities import CapabilityRule, assess

@pytest.mark.parametrize("product,platform,relative", [
    ("mechanical", "linux", "aisol/bin/linx64/AnsysWBU"),
    ("mechanical", "windows", "aisol/bin/winx64/AnsysWBU.exe"),
    ("workbench", "linux", "Framework/bin/Linux64/runwb2"),
    ("workbench", "windows", "Framework/bin/Win64/RunWB2.exe"),
])
def test_cross_platform_custom_directory(tmp_path, product, platform, relative):
    root = tmp_path / "custom-installation"
    exe = root / relative
    exe.parent.mkdir(parents=True); exe.touch()
    root.joinpath("installation.json").write_text(json.dumps({"version": "2026 R1"}))
    items = discover(product, str(root), host_platform=platform, env={"AWP_ROOT261": str(root)},
                     standard_roots=[], sdk_find=lambda: None, path_find=lambda _: None)
    assert len(items) == 1
    assert items[0].version == "26.1"
    assert items[0].sources == ["explicit", "environment:AWP_ROOT261"]
    assert items[0].verified is False
    assert probe(items[0])["runtime_version"] is None

def test_multiple_installs_unknown_version_not_discarded(tmp_path):
    for name in ("unknown", "v252"):
        f = tmp_path / name / "aisol/bin/linx64/AnsysWBU"
        f.parent.mkdir(parents=True); f.touch()
    items = discover("mechanical", host_platform="linux", env={}, standard_roots=[tmp_path],
                     sdk_find=lambda: None, path_find=lambda _: None)
    assert len(items) == 2
    assert {i.version for i in items} == {None, "25.2"}

def test_compatibility_is_per_capability_and_not_document_profile():
    rule = CapabilityRule("mechanical", "linux", "26.1", "0.12", "connect", "verified", "test record")
    assert assess("mechanical", "linux", "26.1", "0.12", "connect", rules=[rule])["status"] == "verified"
    assert assess("mechanical", "linux", "26.1", "0.12", "gui", rules=[rule])["status"] == "unknown"
    assert assess("mechanical", "linux", "26.1", "0.12", "connect", detected=True)["status"] == "experimental"

def test_attached_disconnect_never_calls_software_exit(monkeypatch):
    from sim import server, drivers
    from fastapi.testclient import TestClient
    class Driver:
        supports_session = True
        closed = False
        def attach(self, endpoint, **kwargs): return {"ok": True, "solver_version": "26.1", "session_id": "attached-test"}
        def disconnect(self): self.closed = True; raise AssertionError("must not close")
        def detach(self): return {"ok": True}
    driver = Driver()
    monkeypatch.setattr(drivers, "get_driver", lambda _: driver)
    server._sessions.clear()
    client = TestClient(server.app)
    attached = client.post("/connect", json={"solver": "workbench", "session_origin": "attached", "endpoint": "localhost:1234"})
    assert attached.status_code == 200, attached.text
    assert attached.json()["data"]["ownership"]["close_software"] is False
    assert client.post("/disconnect").status_code == 200
    assert not driver.closed

def test_exec_script_exception_has_independent_evidence(tmp_path):
    from sim import server
    from fastapi.testclient import TestClient
    class Driver:
        def run(self, *args): raise RuntimeError("inner Mechanical failure")
    server._sessions.clear()
    state = server.SessionState(session_id="failure-test", solver="workbench", workspace=str(tmp_path), driver=Driver())
    server._register_session(state)
    client = TestClient(server.app)
    a = client.post("/exec", json={"code": "fail()"}).json()
    b = client.post("/exec", json={"code": "fail()"}).json()
    assert a["transport_ok"] is True
    assert a["data"]["script_ok"] is False
    assert a["data"]["acceptance"] == "not_evaluated"
    assert a["data"]["operation_id"] != b["data"]["operation_id"]
    server._sessions.clear()
