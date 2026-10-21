"""Product/OS installation evidence. Discovery never launches a solver."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path
import hashlib
import json
import os
import platform
import re
import shutil
import threading
from contextlib import contextmanager

_launch_environment_lock = threading.Lock()

@contextmanager
def installation_environment(root, version):
    """Scope the official Workbench SDK's required installation selector."""
    key = "AWP_ROOT" + version.replace(".", "")
    with _launch_environment_lock:
        previous = os.environ.get(key)
        os.environ[key] = str(root)
        try: yield
        finally:
            if previous is None: os.environ.pop(key, None)
            else: os.environ[key] = previous

PRODUCTS = {
    "mechanical": {"windows": ("aisol/bin/winx64/AnsysWBU.exe",),
                   "linux": ("aisol/bin/linx64/AnsysWBU",)},
    "workbench": {"windows": ("Framework/bin/Win64/RunWB2.exe",),
                  "linux": ("Framework/bin/Linux64/runwb2", "Framework/bin/Linux64/RunWB2", "Framework/bin/Linux64/RunWB2.sh")},
}

@dataclass
class Installation:
    product: str
    version: str | None
    platform: str
    root: str
    executable: str
    source: str
    verified: bool = False
    sources: list[str] = field(default_factory=list)
    version_source: str = "unknown"

    @property
    def id(self):
        key = f"{self.product}|{self.platform}|{os.path.normcase(self.executable)}"
        return hashlib.sha256(key.encode()).hexdigest()[:16]

    def to_dict(self):
        return {"id": self.id, **asdict(self)}

def _version(value):
    from sim.compat import _normalize_solver_version
    if value is None: return None
    value = _normalize_solver_version(str(value))
    return value if re.fullmatch(r"\d{2}\.\d+", value) else None

def discover(product, explicit=None, *, host_platform=None, env=None, standard_roots=None, sdk_find=None, path_find=None):
    os_name = host_platform or platform.system().lower()
    if product not in PRODUCTS or os_name not in PRODUCTS[product]:
        raise ValueError(f"unsupported discovery: {product}/{os_name}")
    env = os.environ if env is None else env
    candidates = []
    if explicit: candidates.append((explicit, "explicit", None))
    if sdk_find is None:
        try:
            import ansys.tools.path as tools
            sdk_find = getattr(tools, f"find_{product}", None)
        except ImportError: pass
    if sdk_find:
        try:
            found = sdk_find()
            if found and found[0]: candidates.append((found[0], "official_sdk", _version(found[1])))
        except Exception: pass
    for key, value in sorted(env.items()):
        if re.fullmatch(r"AWP_ROOT\d{3}", key) and value:
            candidates.append((value, f"environment:{key}", _version(key[-3:])))
    for key in (f"SIM_{product.upper()}_ROOT", "ANSYS_ROOT"):
        if env.get(key): candidates.append((env[key], f"environment:{key}", None))
    path_find = path_find or (lambda name: shutil.which(name, path=env.get("PATH", "")))
    for relative in PRODUCTS[product][os_name]:
        exe = path_find(Path(relative).name)
        if exe: candidates.append((exe, "PATH", None))
    bases = standard_roots if standard_roots is not None else (
        ["C:/Program Files/ANSYS Inc", "D:/Program Files/ANSYS Inc"] if os_name == "windows"
        else ["/usr/ansys_inc", "/ansys_inc", "/opt/ansys_inc", "/srv/shared/ansys_inc"])
    for base in map(Path, bases):
        if base.is_dir():
            candidates.append((str(base), "standard_directory", None))
            candidates.extend((str(p), "standard_directory", None) for p in sorted(base.iterdir()) if p.is_dir())
    results = {}
    for raw, source, version in candidates:
        p = Path(raw).expanduser()
        root, executable = p, None
        if p.is_file():
            executable = p.resolve()
            for relative in PRODUCTS[product][os_name]:
                if executable.as_posix().lower().endswith(relative.lower()):
                    root = executable
                    for _ in Path(relative).parts: root = root.parent
                    break
            else: root = executable.parent
        else:
            for relative in PRODUCTS[product][os_name]:
                candidate = p / relative
                if candidate.is_file(): executable = candidate.resolve(); break
        if executable is None: continue
        root = root.resolve()
        version_source = source if version else "unknown"
        metadata = root / "installation.json"
        if metadata.is_file():
            try:
                reported = _version(json.loads(metadata.read_text()).get("version"))
                if reported: version, version_source = reported, "installation_metadata"
            except (ValueError, OSError): pass
        if not version:
            match = re.fullmatch(r"v(\d{3})", root.name, re.I)
            if match: version, version_source = _version(match[1]), "directory_hint"
        item = Installation(product, version, os_name, str(root), str(executable), source,
                            sources=[source], version_source=version_source)
        if item.id in results:
            old = results[item.id]
            if source not in old.sources: old.sources.append(source)
            rank = lambda value: 3 if value == "installation_metadata" else 2 if value == "official_sdk" else 1 if value.startswith("environment:") else 0
            if version and (not old.version or rank(version_source) > rank(old.version_source)):
                old.version, old.version_source = version, version_source
        else: results[item.id] = item
    return list(results.values())

def probe(installation):
    """Installation evidence only, distinct from connected runtime verification."""
    exe = Path(installation.executable)
    present = exe.is_file()
    return {"stage": "installation", "installation": installation.to_dict(),
            "executable_exists": present, "executable_runnable": present and (installation.platform == "windows" or os.access(exe, os.X_OK)),
            "runtime_version": None, "version_source": installation.version_source,
            "compatibility": "unknown", "verified": False}

def save_discovery(items):
    """Persist selection IDs on the machine where discovery ran."""
    target = Path(os.environ.get("SIM_HOME", str(Path.home() / ".sim"))) / "installations.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    prior = json.loads(target.read_text()) if target.is_file() else {}
    prior.update({i.id: i.to_dict() for i in items})
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(prior, indent=2), encoding="utf-8")
    temporary.replace(target)

def selected_installation(identifier, product):
    target = Path(os.environ.get("SIM_HOME", str(Path.home() / ".sim"))) / "installations.json"
    data = json.loads(target.read_text()).get(identifier) if target.is_file() else None
    if not data or data["product"] != product: raise ValueError("unknown installation ID; run discover first")
    data.pop("id", None)
    item = Installation(**data)
    if not Path(item.executable).is_file(): raise ValueError("selected installation no longer exists")
    if item.platform != platform.system().lower(): raise ValueError("installation belongs to another platform")
    return item
