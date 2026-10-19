import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const dependencies = await copyRuntimeDependencies();
await writeThirdPartyNotices(dependencies);
await writeRuntimeManifest(dependencies);
await prepareLogosPayload();

console.log(`Prepared LOGOS core ${PI_VERSION} (${PI_COMMIT.slice(0, 8)}) in ${runtimeDirectory}`);

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
    run("tar", ["-xf", join(temporaryDirectory, archiveName), "-C", temporaryDirectory], piDirectory);
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
    { name: "@esbuild/win32-x64", entries: ["package.json", "README.md", "esbuild.exe"] },
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
    platform: "win32-x64",
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
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build this package on Windows x64");
  await copyPath(process.execPath, join(payloadDirectory, "vendor", "node", "node.exe"));
  const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
  if (!nodeLicense.ok) throw new Error(`Cannot fetch Node license: HTTP ${nodeLicense.status}`);
  await writeFile(join(payloadDirectory, "vendor", "node", "LICENSE"), await nodeLicense.text());
  const domain = join(payloadDirectory, "logos-agent", "pi-domain");
  await rm(domain, { recursive: true, force: true });
  const excluded = new Set(["node_modules", ".venv", "__pycache__", ".git", ".pytest_cache", ".env"]);
  await cp(join(repositoryRoot, "logos-agent", "pi-domain"), domain, {
    recursive: true, filter: (source) => !relative(join(repositoryRoot, "logos-agent", "pi-domain"), source).split(/[\\/]/).some((part) => excluded.has(part)),
  });
  // Bundle the domain extension's imports so the target needs no npm install.
  const { build } = await import("esbuild");
  await build({ entryPoints: [join(repositoryRoot, "logos-agent", "pi-domain", "extensions", "index.mjs")],
    outfile: join(domain, "extensions", "index.mjs"), bundle: true, platform: "node", format: "esm",
    nodePaths: [join(piDirectory, "node_modules")],
  });
  const files = [];
  for (const path of await walk(payloadDirectory)) {
    if (path === join(payloadDirectory, "payload-manifest.json")) continue;
    const data = await readFile(path);
    files.push({ path: relative(payloadDirectory, path).replaceAll("\\", "/"), bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex") });
  }
  await writeFile(join(payloadDirectory, "payload-manifest.json"), JSON.stringify({ node: process.version, files }, null, 2));
}
