import pytest
from sim.driver import SolverInstall

def test_workbench_never_replays_after_sdk_failure(monkeypatch, tmp_path):
    from sim_plugin_workbench import driver as module
    driver = module.WorkbenchDriver()
    monkeypatch.setattr(driver, "detect_installed", lambda: [SolverInstall("workbench", "26.1", str(tmp_path), "test")])
    monkeypatch.setattr(module, "_try_import_pyworkbench", lambda: object())
    monkeypatch.setattr(driver, "_run_file_sdk", lambda *args: None)
    monkeypatch.setattr(driver, "_run_file_runwb2", lambda *args: pytest.fail("must never replay"))
    script = tmp_path / "mutate.wbjn"; script.write_text("modify_model()")
    with pytest.raises(RuntimeError, match="partially committed"):
        driver.run_file(script)

@pytest.mark.parametrize("product", ["mechanical", "workbench"])
def test_attach_runtime_version_and_disconnect_ownership(monkeypatch, product):
    import importlib
    module = importlib.import_module("sim_plugin_" + product + ".driver")
    cls = module.MechanicalDriver if product == "mechanical" else module.WorkbenchDriver
    class Client:
        version = "2026 R1"
        closed = False
        def exit(self): self.closed = True; pytest.fail("attached software must not close")
    client = Client()
    class SDK:
        __version__ = "test-sdk"
        def connect_to_mechanical(self, **kwargs): return client
        def connect_workbench(self, **kwargs): return client
    monkeypatch.setattr(module, "_try_import_py" + product, lambda: SDK())
    driver = cls()
    info = driver.attach("localhost:1234")
    assert info["solver_version"] == "26.1"
    assert not info["ownership"]["close_software"]
    driver.disconnect()
    assert not client.closed

def test_workbench_result_file_is_operation_scoped(tmp_path, monkeypatch):
    from sim_plugin_workbench.driver import WorkbenchDriver
    import tempfile
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    driver = WorkbenchDriver()
    driver._begin_operation()
    first = driver._operation_result_file
    first.write_text('{"script_ok":true}')
    driver._begin_operation()
    assert driver._operation_result_file != first
    assert driver._append_result_file("") == ""

def test_verify_smoke_rejects_existing_endpoint():
    from sim.validation import verify_driver
    assert verify_driver(object(), smoke=True, endpoint="localhost:1234")["ok"] is False
