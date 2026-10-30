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
