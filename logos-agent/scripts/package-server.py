"""Build a relocatable source deployment without credentials/dependencies."""
from pathlib import Path
import hashlib
import io
import json
import subprocess
import tarfile
import zipfile

repository = Path(__file__).resolve().parents[2]
product = repository / "logos-agent"
output = product / "dist"
output.mkdir(exist_ok=True)
def collect(root: Path, prefix: str, pathspec: str = "") -> tuple[dict[str, bytes], dict[str, int]]:
    """Read committed sources only, excluding local credentials and build products."""
    command = ["git", "-C", str(root), "archive", "--format=tar", "HEAD"]
    if pathspec:
        command.append(pathspec)
    payload = subprocess.check_output(command)
    files: dict[str, bytes] = {}
    modes: dict[str, int] = {}
    with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
        for entry in archive:
            if entry.isdir():
                continue
            if not entry.isfile():
                raise ValueError(f"Unsupported archive entry: {entry.name}")
            name = prefix + entry.name
            parts = Path(name).parts
            if any(part in {"node_modules", ".venv", ".git", "runtime", "dist"} for part in parts):
                continue
            if Path(name).name.startswith(".env") and Path(name).name != ".env.example":
                continue
            if name.endswith((".vsix", ".log", ".pyc")):
                continue
            stream = archive.extractfile(entry)
            assert stream is not None
            files[name] = stream.read()
            modes[name] = entry.mode
    return files, modes


files, modes = collect(repository, "", "logos-agent")
pi_files, pi_modes = collect(repository / "vendor/pi", "vendor/pi/")
files.update(pi_files)
modes.update(pi_modes)
version = json.loads(files["logos-agent/package.json"])["version"]
release = f"logos-server-v{version}"
for relative in ("README.md", "install.sh", "start.sh", "logos.cmd", "bin/logos"):
    source = "logos-agent/deploy/" + relative
    files[relative] = files[source]
    modes[relative] = 0o755 if relative in ("bin/logos", "install.sh", "start.sh") else 0o644
revision = subprocess.check_output(["git", "-C", str(repository / "vendor/pi"), "rev-parse", "HEAD"], text=True).strip()
product_revision = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD"], text=True).strip()
pinned_revision = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD:vendor/pi"], text=True).strip()
if revision != pinned_revision:
    raise ValueError("Pi checkout does not match the committed submodule revision")
manifest = {"release": release, "version": version, "revision": product_revision, "pi_revision": revision,
            "distribution": "online-install-source", "node": ">=22.19", "python": ">=3.10",
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
files["MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
modes["MANIFEST.json"] = 0o644
required = ["vendor/pi/package-lock.json", "vendor/pi/packages/coding-agent/src/cli.ts",
            "vendor/pi/packages/coding-agent/src/experimental/source-resolver.ts",
            "logos-agent/.env.example", "logos-agent/pi-domain/extensions/simulation.mjs",
            "logos-agent/integrations/sim-cli/src/sim/installations.py", "bin/logos", "install.sh", "logos-agent/web/server/main.ts",
            "logos-agent/web/deploy/.env.example", "logos-agent/web/scripts/install-ansys-license.py"]
assert all(name in files for name in required)
assert not any(Path(name).name == ".env" or "node_modules" in Path(name).parts or ".venv" in Path(name).parts for name in files)
tar_path = output / (release + ".tar.gz")
zip_path = output / (release + ".zip")
with tarfile.open(tar_path, "w:gz") as archive:
    for name, data in sorted(files.items()):
        info = tarfile.TarInfo("logos-server/" + name)
        info.size = len(data)
        info.mode = modes[name]
        archive.addfile(info, io.BytesIO(data))
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
    for name, data in sorted(files.items()):
        info = zipfile.ZipInfo("logos-server/" + name)
        info.create_system = 3
        mode = modes[name]
        info.external_attr = (0o100000 | mode) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, data)
for path in (tar_path, zip_path):
    # Re-read archives to verify every manifest entry survived packaging.
    if path == tar_path:
        with tarfile.open(path) as archive:
            for name, digest in manifest["files"].items():
                assert hashlib.sha256(archive.extractfile("logos-server/" + name).read()).hexdigest() == digest
    else:
        with zipfile.ZipFile(path) as archive:
            for name, digest in manifest["files"].items():
                assert hashlib.sha256(archive.read("logos-server/" + name)).hexdigest() == digest
    print(f"{path.name}: {path.stat().st_size / 1024 / 1024:.1f} MiB; {len(files)} files verified")
(output / (release + ".sha256")).write_text("".join(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name + "\n" for path in (tar_path, zip_path)), encoding="utf-8")
