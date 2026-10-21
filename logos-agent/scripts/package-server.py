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
release = "logos-server-20261009"
excluded_dirs = {".git", "node_modules", ".venv", "__pycache__", ".pytest_cache", ".logos", ".pi", "dist", ".artifacts", "packages", "previews"}

def collect(root, prefix):
    import os
    files = {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        # `packages` is excluded only for LOGOS integration download caches,
        # never for the Pi monorepo's source packages.
        skip = excluded_dirs - {"packages"}
        dirs[:] = [d for d in dirs if d not in skip and not (d == "packages" and Path(directory) == product / "integrations")]
        for name in names:
            if name == ".git" or (name.startswith(".env") and name != ".env.example"):
                continue
            if name.endswith((".pyc", ".log", ".whl")):
                continue
            path = Path(directory) / name
            if path.is_symlink():
                path.resolve().relative_to(repository)
            relative = path.relative_to(root).as_posix()
            files[prefix + "/" + relative] = path.read_bytes()
    return files

files = collect(product, "logos-agent")
files.update(collect(repository / "vendor/pi", "vendor/pi"))
for relative in ("README.md", "install.sh", "start.sh", "logos.cmd", "bin/logos"):
    files[relative] = (product / "deploy" / relative).read_bytes()
revision = subprocess.check_output(["git", "-C", str(repository / "vendor/pi"), "rev-parse", "HEAD"], text=True).strip()
manifest = {"release": release, "pi_revision": revision,
            "distribution": "online-install-source", "node": ">=22.19", "python": ">=3.10",
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
files["MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
required = ["vendor/pi/package-lock.json", "vendor/pi/packages/coding-agent/src/cli.ts",
            "vendor/pi/packages/coding-agent/src/experimental/source-resolver.ts",
            "logos-agent/.env.example", "logos-agent/pi-domain/extensions/simulation.mjs",
            "logos-agent/integrations/sim-cli/src/sim/installations.py", "bin/logos", "install.sh"]
assert all(name in files for name in required)
assert not any(Path(name).name == ".env" or "node_modules" in Path(name).parts or ".venv" in Path(name).parts for name in files)
tar_path = output / (release + ".tar.gz")
zip_path = output / (release + ".zip")
with tarfile.open(tar_path, "w:gz") as archive:
    for name, data in sorted(files.items()):
        info = tarfile.TarInfo("logos-server/" + name)
        info.size = len(data)
        info.mode = 0o755 if name in ("bin/logos", "install.sh", "start.sh") else 0o644
        archive.addfile(info, io.BytesIO(data))
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
    for name, data in sorted(files.items()):
        info = zipfile.ZipInfo("logos-server/" + name)
        info.create_system = 3
        mode = 0o755 if name in ("bin/logos", "install.sh", "start.sh") else 0o644
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
