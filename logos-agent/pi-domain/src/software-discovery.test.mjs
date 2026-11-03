import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSoftware, discoveryEnvironment, SOFTWARE } from "./software-discovery.mjs";

test("discovers every supported integration off PATH and selects versions/configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "logos-software-"));
  try {
    const overrides = {};
    for (const product of SOFTWARE) {
      const path = join(root, product.id, product.names[0] + ".exe");
      await mkdir(join(root, product.id), { recursive: true }); await writeFile(path, "fixture"); overrides[product.id] = path;
    }
    const cacheFile = join(root, "cache.json");
    const result = await discoverSoftware({ overrides, cacheFile, platform: "win32", env: {}, roots: [], registry: async () => [] });
    assert.equal(result.products.length, 10); assert.ok(result.products.every((item) => item.status === "installed" && item.connection === "not-checked"));
    assert.equal(discoveryEnvironment(result, {}).KICAD_CLI, overrides.kicad);
    await rm(overrides.blender);
    const stale = await discoverSoftware({ overrides, cacheFile, platform: "win32", env: {}, roots: [], registry: async () => [] });
    assert.equal(stale.products[0].status, "invalid-path"); assert.equal(stale.products[0].selected, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("scans versioned standard directories without running binaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "logos-versions-"));
  try {
    for (const version of ["4.2", "5.0"]) { const directory = join(root, `Blender ${version}`); await mkdir(directory); await writeFile(join(directory, "blender.exe"), "not executable"); }
    const result = await discoverSoftware({ platform: "win32", env: {}, roots: [root], registry: async () => [] });
    assert.match(result.products[0].selected, /5\.0/);
    const linux = await discoverSoftware({ platform: "linux", env: {}, roots: [], registry: async () => [] });
    assert.equal(linux.products.find((item) => item.product === "spaceclaim").status, "unsupported");
    assert.equal(linux.products[0].status, "missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("global scans find custom nested locations and retain them after refresh and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "logos-global-"));
  try {
    const directory = join(root, "自定义软件", "engineering", "tools", "release", "application", "bin");
    await mkdir(directory, { recursive: true });
    const executable = join(directory, "BLENDER.EXE");
    await writeFile(executable, "not executable; discovery must never launch this");
    const options = { platform: "win32", env: {}, roots: [], registry: async () => [], cacheFile: join(root, "cache.json") };
    assert.equal((await discoverSoftware(options)).products[0].status, "missing");
    const result = await discoverSoftware({ ...options, global: true, scanOptions: { roots: [root] } });
    assert.equal(result.products[0].selected, executable);
    assert.equal(result.products[0].candidates[0].source, "global-scan");
    assert.equal(result.globalScan.limited, false);
    const refreshed = await discoverSoftware({ ...options, refresh: true });
    assert.equal(refreshed.products[0].selected, executable);
    assert.equal(refreshed.globalScan.checkedAt, result.globalScan.checkedAt);
    assert.equal(discoveryEnvironment(refreshed, {}).BLENDER_PATH, executable);
    await rm(executable);
    assert.equal((await discoverSoftware({ ...options, refresh: true })).products[0].status, "missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("global scans report incomplete coverage, skip dependencies and honor manual overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "logos-scan-limit-"));
  try {
    const manual = join(root, "blender.exe"); await writeFile(manual, "fixture");
    await mkdir(join(root, "node_modules")); await writeFile(join(root, "node_modules", "gmsh.exe"), "fixture");
    await mkdir(join(root, "extra")); await writeFile(join(root, "extra", "blender.exe"), "fixture");
    const options = { platform: "win32", env: {}, roots: [], registry: async () => [], global: true };
    const limited = await discoverSoftware({ ...options, scanOptions: { roots: [root], maxDirectories: 1 } });
    assert.equal(limited.globalScan.limited, true);
    assert.equal(limited.globalScan.visited, 1);
    const result = await discoverSoftware({ ...options, overrides: { blender: manual }, scanOptions: { roots: [root, join(root, "absent")] } });
    assert.equal(result.products[0].selected, manual);
    assert.equal(result.products[0].candidates.length, 2);
    assert.equal(result.products.find((product) => product.product === "gmsh").status, "missing");
    assert.equal(result.globalScan.skipped, 1);
    const invalid = await discoverSoftware({ ...options, overrides: { blender: join(root, "absent.exe") }, scanOptions: { roots: [root] } });
    assert.equal(invalid.products[0].status, "invalid-path");
    assert.equal(invalid.products[0].selected, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
