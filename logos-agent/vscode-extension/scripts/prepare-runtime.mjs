import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_TARGETS,
  NODE_DIST_URL,
  NODE_RUNTIME_VERSION,
  parseTargetArgument,
  targetDefinition,
} from "./package-targets.mjs";

const PI_COMMIT = "abe508e1b89912adde45528136c3221eb69acdd7";
const PI_VERSION = "1.1.0";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(extensionDirectory, "..", "..");
const piDirectory = join(repositoryRoot, "vendor", "pi");
const payloadDirectory = join(extensionDirectory, "runtime");
const runtimeDirectory = join(payloadDirectory, "vendor", "pi");
const npmCli = process.env.npm_execpath;
const skipInstall = process.argv.includes("--skip-install");
const skipBuild = process.argv.includes("--skip-build");

const targetArgument = parseTargetArgument(process.argv);
if (!targetArgument) {
  throw new Error(`--target is required; expected one of: ${BUILD_TARGETS.join(", ")}`);
}
const target = targetDefinition(targetArgument);

const head = run("git", ["rev-parse", "HEAD"], piDirectory, true).trim();
if (head !== PI_COMMIT) {
  throw new Error(`Pi core must be at ${PI_COMMIT}; found ${head}`);
}

if (!skipInstall) {
  runNpm(["ci", "--no-audit", "--no-fund"], piDirectory);
}
if (!skipBuild) await installFixedModelCatalog();
if (!skipBuild) {
  runNpm(["run", "build:offline"], piDirectory);
}

await rm(runtimeDirectory, { recursive: true, force: true });
await rm(join(payloadDirectory, "core"), { recursive: true, force: true });
await mkdir(runtimeDirectory, { recursive: true });
await copyPiRuntime();
await ensureEsbuildPlatformPackage();
const dependencies = await copyRuntimeDependencies();
await writeThirdPartyNotices(dependencies);
await writeRuntimeManifest(dependencies);
await prepareLogosPayload();

console.log(`Prepared LOGOS core ${PI_VERSION} (${PI_COMMIT.slice(0, 8)}) for ${targetArgument} with Node.js ${NODE_RUNTIME_VERSION} in ${runtimeDirectory}`);

async function installFixedModelCatalog() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "logos-pi-models-"));
  try {
    const archiveOutput = runNpm(
      ["pack", `@earendil-works/pi-ai@${PI_VERSION}`, "--pack-destination", temporaryDirectory, "--silent"],
      piDirectory,
      true,
    );
    const archiveName = archiveOutput.trim().split(/\r?\n/).at(-1);
    if (!archiveName) throw new Error("npm pack did not return an archive name");
    run("tar", ["-xf", archiveName], temporaryDirectory);
    const source = join(temporaryDirectory, "package", "dist", "providers", "data");
    const destination = join(piDirectory, "packages", "ai", "src", "providers", "data");
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function copyPiRuntime() {
  const codingAgent = join(piDirectory, "packages", "coding-agent");
  await copyPath(join(codingAgent, "dist", "bundle"), join(runtimeDirectory, "dist", "bundle"));
  await copyPath(join(codingAgent, "dist", "modes", "interactive", "theme"), join(runtimeDirectory, "dist", "modes", "interactive", "theme"));
  await copyPath(join(codingAgent, "dist", "modes", "interactive", "assets"), join(runtimeDirectory, "dist", "modes", "interactive", "assets"));
  await copyPath(join(codingAgent, "dist", "core", "export-html"), join(runtimeDirectory, "dist", "core", "export-html"));
  await copyPath(join(codingAgent, "docs"), join(runtimeDirectory, "docs"));
  for (const file of ["package.json", "README.md", "CHANGELOG.md"]) {
    await copyPath(join(codingAgent, file), join(runtimeDirectory, file));
  }
  await copyPath(join(piDirectory, "LICENSE"), join(runtimeDirectory, "PI_LICENSE"));
  await writeFile(
    join(runtimeDirectory, "cli.js"),
    "#!/usr/bin/env node\nimport \"./dist/bundle/cli.js\";\n",
    "utf8",
  );
}

async function copyRuntimeDependencies() {
  const definitions = [
    { name: "@earendil-works/chord", entries: ["package.json", "dist"] },
    { name: "@silvia-odwyer/photon-node", entries: ["package.json", "LICENSE.md", "photon_rs.js", "photon_rs_bg.js", "photon_rs_bg.wasm"] },
    { name: "jiti", entries: ["package.json", "LICENSE", "lib", "dist"] },
    { name: "quickjs-wasi", entries: ["package.json", "LICENSE", "quickjs.wasm", "dist", "extensions"] },
    { name: "esbuild", entries: ["package.json", "LICENSE.md", "lib", "bin"] },
    { name: target.esbuildPackage, entries: ["package.json", "README.md", target.esbuildBinary] },
  ];
  const dependencies = [];
  for (const definition of definitions) {
    const source = join(piDirectory, "node_modules", ...definition.name.split("/"));
    const destination = join(runtimeDirectory, "node_modules", ...definition.name.split("/"));
    const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    dependencies.push({ name: definition.name, version: metadata.version, license: metadata.license ?? "UNKNOWN" });
    for (const entry of definition.entries) {
      await copyPath(join(source, entry), join(destination, entry), true);
    }
  }
  return dependencies;
}

async function copyPath(source, destination, optional = false) {
  try {
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  } catch (error) {
    if (optional && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function writeThirdPartyNotices(dependencies) {
  const sections = [
    `LOGOS bundled core\nPi ${PI_VERSION}, commit ${PI_COMMIT}\nLicense: MIT\nSource: https://github.com/earendil-works/pi`,
    ...dependencies.map((dependency) => `${dependency.name} ${dependency.version}\nLicense: ${dependency.license}`),
  ];
  await writeFile(join(runtimeDirectory, "THIRD_PARTY_NOTICES.txt"), `${sections.join("\n\n---\n\n")}\n`, "utf8");
}

async function writeRuntimeManifest(dependencies) {
  const files = [];
  for (const path of await walk(runtimeDirectory)) {
    const data = await readFile(path);
    files.push({
      path: relative(runtimeDirectory, path).replaceAll("\\", "/"),
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: 1,
    platform: targetArgument,
    pi: { version: PI_VERSION, commit: PI_COMMIT },
    dependencies,
    files,
  };
  await writeFile(join(runtimeDirectory, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

function run(command, args, cwd, capture = false) {
  const result = execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    windowsHide: true,
  });
  return typeof result === "string" ? result : "";
}

function runNpm(args, cwd, capture = false) {
  if (npmCli) return run(process.execPath, [npmCli, ...args], cwd, capture);
  return run("npm", args, cwd, capture);
}


async function prepareLogosPayload() {
  await installNodeRuntime();
  const domain = join(payloadDirectory, "logos-agent", "pi-domain");
  await rm(domain, { recursive: true, force: true });
  const excluded = new Set(["node_modules", ".venv", "__pycache__", ".git", ".pytest_cache", ".env"]);
  await cp(join(repositoryRoot, "logos-agent", "pi-domain"), domain, {
    recursive: true, filter: (source) => !relative(join(repositoryRoot, "logos-agent", "pi-domain"), source).split(/[\\/]/).some((part) => excluded.has(part)),
  });
  // Bundle the domain extension's imports so the target needs no npm install.
  // The domain's own dependencies (observability stack) resolve from its lockfile install.
  const domainSource = join(repositoryRoot, "logos-agent", "pi-domain");
  runNpm(["ci"], domainSource);
  const { build } = await import("esbuild");
  await build({ entryPoints: [join(domainSource, "extensions", "index.mjs")],
    outfile: join(domain, "extensions", "index.mjs"), bundle: true, platform: "node", format: "esm",
    nodePaths: [join(piDirectory, "node_modules"), join(domainSource, "node_modules")],
  });
  const files = [];
  for (const path of await walk(payloadDirectory)) {
    if (path === join(payloadDirectory, "payload-manifest.json")) continue;
    const data = await readFile(path);
    files.push({ path: relative(payloadDirectory, path).replaceAll("\\", "/"), bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex") });
  }
  await writeFile(join(payloadDirectory, "payload-manifest.json"), JSON.stringify({ platform: targetArgument, node: NODE_RUNTIME_VERSION, files }, null, 2));
}

/** Download the pinned official Node.js distribution for the target platform and stage vendor/node. */
async function installNodeRuntime() {
  const cacheDirectory = join(extensionDirectory, ".node-dist-cache");
  await mkdir(cacheDirectory, { recursive: true });
  const archivePath = join(cacheDirectory, target.archive);
  const expected = (await fetchText(`${NODE_DIST_URL}/v${NODE_RUNTIME_VERSION}/SHASUMS256.txt`))
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(` ${target.archive}`))
    ?.trim()
    .split(/\s+/)[0];
  if (!expected) throw new Error(`SHASUMS256.txt does not list ${target.archive}`);
  let archive;
  try {
    archive = await readFile(archivePath);
  } catch {
    console.log(`Downloading ${NODE_DIST_URL}/v${NODE_RUNTIME_VERSION}/${target.archive} …`);
    const response = await fetch(`${NODE_DIST_URL}/v${NODE_RUNTIME_VERSION}/${target.archive}`, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw new Error(`Cannot download Node.js distribution: HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
    await writeFile(archivePath, archive);
  }
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    await rm(archivePath, { force: true });
    throw new Error(`Node.js distribution checksum mismatch for ${target.archive}: expected ${expected}, got ${actual}`);
  }
  // Extract with a basename operand from the cache directory: GNU tar treats
  // absolute Windows paths (`C:\…`) as remote-host specs, and it cannot read
  // zip archives at all, so zips go through PowerShell's built-in expander.
  const extractionRoot = join(cacheDirectory, target.archive.replace(/\.(tar\.xz|zip)$/, ""));
  const extractedBinary = join(extractionRoot, ...target.nodeEntry.split("/").slice(1));
  try {
    await access(extractedBinary);
  } catch {
    extractArchive(target.archive, cacheDirectory, [target.nodeEntry, `${target.archive.replace(/\.(tar\.xz|zip)$/, "")}/${target.nodeLicense}`]);
    try {
      await access(extractedBinary);
    } catch {
      throw new Error(`Extraction did not produce ${target.nodeEntry}`);
    }
  }
  const nodeDirectory = join(payloadDirectory, "vendor", "node");
  await rm(nodeDirectory, { recursive: true, force: true });
  await mkdir(nodeDirectory, { recursive: true });
  await copyPath(extractedBinary, join(nodeDirectory, target.nodeBinary));
  await copyPath(join(extractionRoot, target.nodeLicense), join(nodeDirectory, "LICENSE"), true);
}

/** Make the esbuild platform package for the build target available in Pi's node_modules. */
async function ensureEsbuildPlatformPackage() {
  const packageDirectory = join(piDirectory, "node_modules", ...target.esbuildPackage.split("/"));
  try {
    await access(join(packageDirectory, "package.json"));
    return;
  } catch {
    // The host usually only has its own platform's package; fetch the target's below.
  }
  let version;
  try {
    version = JSON.parse(await readFile(join(piDirectory, "node_modules", "esbuild", "package.json"), "utf8")).version;
  } catch {
    throw new Error("Cannot read Pi's esbuild version; run prepare:runtime without --skip-install first");
  }
  console.log(`Fetching ${target.esbuildPackage}@${version} for ${targetArgument} …`);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "logos-esbuild-"));
  try {
    const archiveOutput = runNpm(
      ["pack", `${target.esbuildPackage}@${version}`, "--pack-destination", temporaryDirectory, "--silent"],
      piDirectory,
      true,
    );
    const archiveName = archiveOutput.trim().split(/\r?\n/).at(-1);
    if (!archiveName) throw new Error("npm pack did not return an archive name");
    run("tar", ["-xf", archiveName], temporaryDirectory);
    await cp(join(temporaryDirectory, "package"), packageDirectory, { recursive: true });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cannot fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

/** Extract an archive by basename into the directory that contains it. */
function extractArchive(archiveName, directory, includes = []) {
  if (process.platform === "win32") {
    // Git Bash's GNU tar cannot exec xz and treats absolute paths as remote
    // hosts; the Windows bundled bsdtar reads zip, tar, and tar.xz alike.
    // Linux Node tarballs carry symlinks (bin/npm …) that Windows cannot
    // materialize, so extract only the entries we stage.
    const bsdtar = "C:\\Windows\\System32\\tar.exe";
    const args = ["-xf", archiveName];
    for (const pattern of includes) args.push("--include", pattern);
    run(existsSync(bsdtar) ? bsdtar : "tar", args, directory);
    return;
  }
  if (archiveName.endsWith(".zip")) {
    run("unzip", ["-o", archiveName], directory);
    return;
  }
  run("tar", ["-xf", archiveName], directory);
}
