"""Explicit verification stages; smoke never attaches to user projects."""
from pathlib import Path
import tempfile

def verify_driver(driver, *, smoke=False, endpoint=None, connect_probe=False):
    if driver is None: return {"ok": False, "stage": "configuration", "error": "driver unavailable"}
    if smoke and endpoint:
        return {"ok": False, "stage": "isolated_smoke", "error": "smoke cannot attach to a user session"}
    if not (smoke or connect_probe):
        return {"ok": True, "stage": "installation", "installations": [i.to_dict() for i in driver.discover()]}
    if getattr(driver, "is_connected", False):
        return {"ok": False, "stage": "isolated_smoke" if smoke else "read_only_connection", "error": "driver already has a session; current project preserved"}
    with tempfile.TemporaryDirectory(prefix="logos-verification-") as directory:
        try:
            info = driver.attach(endpoint) if endpoint else driver.launch(ui_mode="no_gui", workspace=directory)
            if info.get("ok") is False: return {"ok": False, "stage": "connection", "evidence": info}
            version = info.get("solver_version")
            if not version:
                return {"ok": False, "stage": "runtime_version", "error": "active runtime version not reported", "evidence": info}
            if not smoke:
                return {"ok": True, "stage": "read_only_connection", "evidence": info, "acceptance": "not_evaluated"}
            hook = getattr(driver, "verify_smoke", None)
            if hook is None:
                return {"ok": False, "stage": "isolated_smoke", "error": "product has no isolated smoke implementation", "evidence": info}
            return {"ok": True, "stage": "isolated_smoke", "evidence": info, "result": hook(Path(directory)), "acceptance": "not_evaluated"}
        except Exception as exc:
            return {"ok": False, "stage": "isolated_smoke" if smoke else "read_only_connection", "error": {"type": type(exc).__name__, "message": str(exc)}}
        finally:
            # Attach is connection-only; launched sessions are owned by the verifier.
            if endpoint: driver.detach()
            else: driver.disconnect()
