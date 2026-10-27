import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Windows bundles the python.org embeddable distribution: self-contained and
// relocatable (no pyvenv.cfg home pointer), so it survives being staged in the
// payload and materialized under VS Code globalStorage. 3.11.9 is the last
// 3.11 release with official Windows binaries and matches the development venv;
// python.org publishes no machine-readable checksums, so the hash below is
// pinned from the official HTTPS download.
const EMBED_VERSION = "3.11.9";
const EMBED_ARCHIVE = `python-${EMBED_VERSION}-embed-amd64.zip`;
const EMBED_SHA256 = "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b";
const EMBED_URL = `https://www.python.org/ftp/python/${EMBED_VERSION}/${EMBED_ARCHIVE}`;
const GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";

// Linux bundles astral-sh/python-build-standalone: relocatable install_only
// archives, checksums published per release tag. The build host cannot run the
// target interpreter, so packages go in with uv's cross-environment install.
const PBS_TAG = "20261021";
const PBS_PYTHON_VERSION = "3.11.17";
const PBS_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}`;
const PBS_CHECKSUMS = "SHA256SUMS";
// The build must not depend on a machine-global pip.ini (mirrors may be
// unreachable from build hosts); PIP_INDEX_URL offers the standard override.
const PIP_INDEX = process.env.PIP_INDEX_URL ?? "https://pypi.org/simple";
const UV_VERSION = "0.13.5";
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`;
// linux-arm64 is not bundled: simparse publishes no aarch64 wheel and no
// available build host can cross-compile its C extension.
const TARGETS = {
  "win32-x64": { kind: "embeddable" },
  "linux-x64": {
    kind: "standalone",
    archive: `cpython-${PBS_PYTHON_VERSION}+${PBS_TAG}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
    uvPlatform: "x86_64-unknown-linux-gnu",
  },
  "linux-arm64": null,
};
// Bump when the assembly recipe changes so cached trees rebuild.
const SCRIPT_VERSION = 5;

/** Build (or reuse) the bundled sim runtime for a target and stage it into the payload. */
export async function prepareSimRuntime({ target, repositoryRoot, payloadDirectory, extensionDirectory }) {
  const definition = TARGETS[target];
  if (!definition) {
    // Drop a venv staged by another target: vsce packs runtime/ wholesale, so
    // a stale tree would ship a foreign interpreter.
    await rm(join(payloadDirectory, "logos-agent", "integrations"), { recursive: true, force: true });
    console.warn(`sim runtime not bundled for ${target}; the simulation tool falls back to LOGOS_SIM_COMMAND or sim on PATH`);
    return null;
  }
  const cacheDirectory = join(extensionDirectory, ".sim-runtime-cache", target);
  const tree = join(cacheDirectory, "tree");
  await mkdir(cacheDirectory, { recursive: true });
  const stamp = await computeStamp(repositoryRoot, definition);
  if (!(await treeIsCurrent(tree, stamp))) {
    await rm(tree, { recursive: true, force: true });
    if (definition.kind === "embeddable") await buildEmbeddableTree({ repositoryRoot, cacheDirectory, tree });
    else await buildStandaloneTree({ repositoryRoot, cacheDirectory, tree, definition });
    await writeFile(join(tree, ".stamp.json"), `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
    console.log(`Built bundled sim runtime for ${target} in ${relative(extensionDirectory, tree)}`);
  }
  const destination = join(payloadDirectory, "logos-agent", "integrations", ".venv");
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(tree, destination, { recursive: true });
  return summarize(destination);
}

async function buildEmbeddableTree({ repositoryRoot, cacheDirectory, tree }) {
  const scripts = join(tree, "Scripts");
  const archive = await downloadArchive(cacheDirectory, EMBED_URL, EMBED_ARCHIVE, EMBED_SHA256);
  await mkdir(scripts, { recursive: true });
  // Git Bash's GNU tar treats `C:\…` paths as remote hosts and cannot read
  // zip archives; the Windows bundled bsdtar handles both.
  run(bsdtar(), ["-xf", archive, "-C", scripts]);
  // The embeddable distribution pins sys.path to python311._pth and ignores
  // PYTHONPATH; enable site so package .pth files (pywin32) load and add the
  // site-packages directory pip installs into.
  await writeFile(join(scripts, "python311._pth"), "python311.zip\n.\nLib\\site-packages\n\nimport site\n", "utf8");
  const getPip = join(cacheDirectory, "get-pip.py");
  if (!existsSync(getPip)) await download(GET_PIP_URL, getPip, 60_000);
  const python = join(scripts, "python.exe");
  run(python, [getPip, "--no-warn-script-location", "-i", PIP_INDEX], { timeout: 300_000 });
  const integrations = join(repositoryRoot, "logos-agent", "integrations");
  // The embeddable interpreter's _pth file ignores PYTHONPATH, which breaks
  // pip's isolated build environments (BackendUnavailable: hatchling); all
  // three packages build with hatchling, so install it up front and build
  // without isolation. Non-editable installs register the plugin entry points
  // (sim.drivers, sim.skills, sim.plugins) from wheel metadata — how sim
  // discovers out-of-tree drivers; editable installs would point back here.
  run(python, ["-m", "pip", "install", "--no-input", "--no-warn-script-location", "--disable-pip-version-check",
    "-i", PIP_INDEX, "hatchling"], { timeout: 300_000 });
  run(python, ["-m", "pip", "install", "--no-input", "--no-warn-script-location", "--disable-pip-version-check",
    "-i", PIP_INDEX, "--no-build-isolation",
    join(integrations, "sim-cli"), join(integrations, "plugins", "mechanical"), join(integrations, "plugins", "workbench"),
  ], { timeout: 1_200_000 });
  await writeLicenses(tree, { sitePackages: join(tree, "Scripts", "Lib", "site-packages"),
    cpythonLicense: join(tree, "Scripts", "LICENSE.txt"),
    cpythonLabel: `CPython ${EMBED_VERSION} (python.org embeddable distribution)` });
  await writeManifest(tree, { sitePackages: join(tree, "Scripts", "Lib", "site-packages"),
    python: { version: EMBED_VERSION, archive: EMBED_ARCHIVE, sha256: EMBED_SHA256 } });
}

async function buildStandaloneTree({ repositoryRoot, cacheDirectory, tree, definition }) {
  const expected = await standaloneChecksum(cacheDirectory, definition.archive);
  const archive = await downloadArchive(cacheDirectory, `${PBS_URL}/${definition.archive}`, definition.archive, expected);
  // The install_only archive packs a single `python/` directory; its contents
  // become the .venv root so the adapter's `bin/python` default resolves.
  const extraction = join(cacheDirectory, "extract");
  await rm(extraction, { recursive: true, force: true });
  await mkdir(extraction, { recursive: true });
  await extractStandalone(archive, extraction);
  // Same volume: rename the archive's single `python/` root into place
  // instead of copying thousands of files.
  await rename(join(extraction, "python"), tree);
  const sitePackages = join(tree, "lib", "python3.11", "site-packages");
  await mkdir(sitePackages, { recursive: true });
  const uv = await downloadUv(cacheDirectory);
  const wheels = await buildWheels(uv, { repositoryRoot, cacheDirectory });
  // Cross-environment install: the host cannot run the target interpreter, so
  // resolve every dependency as a target-platform wheel and unpack directly.
  run(uv, ["pip", "install", "--target", sitePackages, "--python-version", "3.11",
    "--python-platform", definition.uvPlatform, "--only-binary=:all:", ...wheels], { timeout: 1_200_000, env: uvEnv(cacheDirectory) });
  await writeLicenses(tree, { sitePackages, cpythonLicense: join(tree, "lib", "python3.11", "LICENSE.txt"),
    cpythonLabel: `CPython ${PBS_PYTHON_VERSION} (astral python-build-standalone)` });
  await writeManifest(tree, { sitePackages,
    python: { version: PBS_PYTHON_VERSION, archive: definition.archive, sha256: expected } });
}

/** Resolve the wheel directory for the three pure-Python sim packages. */
async function buildWheels(uv, { repositoryRoot, cacheDirectory }) {
  const wheels = join(cacheDirectory, "wheels");
  await rm(wheels, { recursive: true, force: true });
  await mkdir(wheels, { recursive: true });
  const integrations = join(repositoryRoot, "logos-agent", "integrations");
  for (const source of [join(integrations, "sim-cli"), join(integrations, "plugins", "mechanical"), join(integrations, "plugins", "workbench")]) {
    run(uv, ["build", "--wheel", "--python", "3.11", "-o", wheels, source], { timeout: 600_000, env: uvEnv(cacheDirectory) });
  }
  // uv build also drops a .gitignore into the output directory; only the
  // wheels are requirements.
  return (await readdir(wheels)).filter((name) => name.endsWith(".whl")).map((name) => join(wheels, name));
}

async function standaloneChecksum(cacheDirectory, archive) {
  const sums = join(cacheDirectory, PBS_CHECKSUMS);
  if (!existsSync(sums)) await download(`${PBS_URL}/${PBS_CHECKSUMS}`, sums, 60_000);
  const line = (await readFile(sums, "utf8")).split(/\r?\n/).find((entry) => entry.trim().endsWith(` ${archive}`));
  if (!line) throw new Error(`${PBS_CHECKSUMS} does not list ${archive}`);
  return line.trim().split(/\s+/)[0];
}

async function downloadUv(cacheDirectory) {
  const expected = (await fetchText(`${UV_URL}.sha256`)).trim().split(/\s+/)[0];
  const archive = await downloadArchive(cacheDirectory, UV_URL, basename(UV_URL), expected);
  const binary = join(cacheDirectory, "uv.exe");
  if (!existsSync(binary)) {
    const extraction = join(cacheDirectory, "uv-extract");
    await rm(extraction, { recursive: true, force: true });
    await mkdir(extraction, { recursive: true });
    run(bsdtar(), ["-xf", archive, "-C", extraction]);
    await copyFile(join(extraction, "uv.exe"), binary);
    await rm(extraction, { recursive: true, force: true });
  }
  return binary;
}

/** uv build resolves a managed build interpreter; keep its downloads in the cache. */
function uvEnv(cacheDirectory) {
  return { ...process.env, UV_DEFAULT_INDEX: PIP_INDEX, UV_PYTHON_INSTALL_DIR: join(dirname(cacheDirectory), "uv-python") };
}

async function downloadArchive(cacheDirectory, url, name, sha256) {
  const archive = join(cacheDirectory, name);
  if (!existsSync(archive)) {
    console.log(`Downloading ${url} …`);
    await download(url, archive, 600_000);
  }
  const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
  if (actual !== sha256) {
    await rm(archive, { force: true });
    throw new Error(`Checksum mismatch for ${name}: expected ${sha256}, got ${actual}`);
  }
  return archive;
}

/**
 * Extract a build-standalone archive on Windows. bsdtar cannot materialize
 * the archive's ~1000 symlinks (terminfo aliases, devtool links) without
 * symlink privileges and exits non-zero; those links are irrelevant to the
 * runtime. Validate the real binary instead, then materialize the interpreter
 * names the adapter and package scripts expect as plain copies.
 */
async function extractStandalone(archive, extraction) {
  try { run(bsdtar(), ["-xf", archive, "-C", extraction]); } catch { /* Symlink members are expected to fail; validated below. */ }
  const python = join(extraction, "python");
  // Anchor checks keep a partially failed extraction (disk full, broken
  // download) from being stamped as a complete tree.
  await access(join(python, "bin", "python3.11"));
  await access(join(python, "lib", "python3.11", "os.py"));
  await access(join(python, "lib", "python3.11", "LICENSE.txt"));
  for (const name of ["python3", "python"]) {
    if (!existsSync(join(python, "bin", name))) await copyFile(join(python, "bin", "python3.11"), join(python, "bin", name));
  }
  const library = join(python, "lib", "libpython3.11.so.1.0");
  if (existsSync(library) && !existsSync(join(python, "lib", "libpython3.11.so"))) {
    await copyFile(library, join(python, "lib", "libpython3.11.so"));
  }
}

async function download(url, destination, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Cannot download ${url}: HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cannot fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

/** Collect the CPython license and every installed distribution's license. */
async function writeLicenses(tree, { sitePackages, cpythonLicense, cpythonLabel }) {
  const sections = [`${cpythonLabel}\n\n${await readFile(cpythonLicense, "utf8")}`];
  for (const { name, version, directory } of await installedDistributions(sitePackages)) {
    const license = await findLicenseFile(directory);
    if (license) sections.push(`${name} ${version}\n\n${await readFile(license, "utf8")}`);
  }
  await writeFile(join(tree, "THIRD_PARTY_LICENSES.txt"), `${sections.join("\n\n---\n\n")}\n`, "utf8");
}

async function writeManifest(tree, { sitePackages, python }) {
  const files = [];
  for (const path of await walk(tree)) {
    const data = await readFile(path);
    files.push({ path: relative(tree, path).replaceAll("\\", "/"), bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex") });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const packages = (await installedDistributions(sitePackages)).map(({ name, version }) => ({ name, version }));
  packages.sort((left, right) => left.name.localeCompare(right.name));
  // Compact JSON: the file list is machine-verified, never hand-read.
  const manifest = { schemaVersion: 1, python, packages, files };
  await writeFile(join(tree, "sim-manifest.json"), JSON.stringify(manifest), "utf8");
}

async function summarize(venv) {
  const bytes = await readFile(join(venv, "sim-manifest.json"));
  const manifest = JSON.parse(bytes);
  return { python: manifest.python, packages: manifest.packages, files: manifest.files.length,
    manifestSha256: createHash("sha256").update(bytes).digest("hex") };
}

async function installedDistributions(sitePackages) {
  const distributions = [];
  for (const entry of await readdir(sitePackages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
    const directory = join(sitePackages, entry.name);
    // The name/version separator is the last hyphen: normalized names use
    // underscores, so only the version side can contain hyphens and dots.
    const stem = entry.name.slice(0, -".dist-info".length);
    const separator = stem.lastIndexOf("-");
    distributions.push({ name: stem.slice(0, separator), version: stem.slice(separator + 1), directory });
  }
  return distributions;
}

async function findLicenseFile(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  // PEP 639 distributions keep licenses in a `licenses/` subdirectory.
  const candidates = entries.filter((entry) => entry.isFile() && isLicenseName(entry.name));
  if (candidates.length > 0) return join(directory, candidates[0].name);
  const subdirectory = entries.find((entry) => entry.isDirectory() && isLicenseName(entry.name));
  if (!subdirectory) return null;
  const nested = (await readdir(join(directory, subdirectory.name), { withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => join(directory, subdirectory.name, entry.name));
  return nested[0] ?? null;
}

function isLicenseName(name) {
  return /^(license|licence|licenses|licences|notice|copying|copyright|apache-license|mit-license)/i.test(name);
}

/** Rebuild when the recipe, the pinned interpreter, or the sim sources change. */
async function computeStamp(repositoryRoot, definition) {
  const integrations = join(repositoryRoot, "logos-agent", "integrations");
  const hash = createHash("sha256");
  for (const source of ["sim-cli", "plugins/mechanical", "plugins/workbench"]) {
    for (const path of await walk(join(integrations, ...source.split("/")), ["__pycache__", ".pytest_cache", ".venv", "node_modules"])) {
      hash.update(relative(integrations, path).replaceAll("\\", "/"));
      hash.update(await readFile(path));
    }
  }
  return { scriptVersion: SCRIPT_VERSION, kind: definition.kind,
    python: definition.kind === "embeddable"
      ? { version: EMBED_VERSION, archive: EMBED_ARCHIVE }
      : { version: PBS_PYTHON_VERSION, archive: definition.archive, uvVersion: UV_VERSION },
    sources: hash.digest("hex") };
}

async function treeIsCurrent(tree, stamp) {
  try {
    await access(join(tree, "sim-manifest.json"));
    return JSON.stringify(JSON.parse(await readFile(join(tree, ".stamp.json"), "utf8"))) === JSON.stringify(stamp);
  } catch {
    return false;
  }
}

async function walk(directory, excludes = []) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludes.includes(entry.name)) paths.push(...await walk(path, excludes));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths;
}

function bsdtar() {
  return existsSync("C:\\Windows\\System32\\tar.exe") ? "C:\\Windows\\System32\\tar.exe" : "tar";
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", windowsHide: true, ...options });
}
