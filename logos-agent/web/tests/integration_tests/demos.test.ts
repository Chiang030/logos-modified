import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Demos } from "../../server/demos.ts";
import { Store } from "../../server/store.ts";
import { WorkspaceFiles } from "../../server/files.ts";
import { Jobs } from "../../server/jobs.ts";
import { Meter } from "../../server/usage.ts";

// Imports the actual curated bundles, not mock manifests. Each successful import
// reads every manifest source and pins every destination via WorkspaceFiles.
test("all three real demo bundles import privately without scheduling solver/model work", { skip: process.platform !== "linux" ? "WorkspaceFiles requires Linux /proc/self/fd pinning" : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "logos-demo-import-"));
  const store = new Store(join(root, "state/db")), files = new WorkspaceFiles(join(root, "users")), demos = new Demos();
  new Jobs(store); new Meter(store);
  try {
    const catalog = demos.catalog();
    assert.deepEqual(catalog.map(item => item.id).sort(), ["air-pipe", "kicad-led", "structure"]);
    assert.ok(catalog.every(item => !("files" in item)), "Catalog must not expose server source paths");
    const outsider = store.user("outsider", "Other user");
    const essential: Record<string, string[]> = {
      structure: ["README.md", "structure_demo.dat", "results/comparison.json", "results/results.csv", "results/solve.txt", "attempts/wrong-section/results.csv"],
      "air-pipe": ["README.md", "fluent_air_pipe.py", "results/strict/pipe.msh", "results/strict/reports.json", "results/strict/run.txt", "results/fine-stable/reports.json", "attempts/fine-failed/reports.json"],
      "kicad-led": ["README.md", "run_kicad.sh", "kicad_full.py", "results/led.kicad_sch", "results/led.kicad_pcb", "results/led.xml", "results/erc.json", "results/drc-parity.json", "results/drill/led.drl", "results/gerbers/led-F_Cu.gtl"],
    };
    for (const demo of catalog) {
      const owner = store.user("demo-" + demo.id, demo.name);
      await assert.rejects(demos.create("../../private", owner, store, files), { status: 400 });
      assert.equal(store.projects(owner.id).length, 0);
      const project = await demos.create(demo.id, owner, store, files) as { id: string; owner: string; directory: string };
      assert.equal(project.owner, owner.id);
      assert.equal(store.project(owner.id, project.id).id, project.id);
      assert.throws(() => store.project(outsider.id, project.id), { status: 404 });
      await assert.rejects(files.read(outsider.id, project.directory + "/DEMO.md"));
      const intro = await files.read(owner.id, project.directory + "/DEMO.md");
      try { assert.match(await intro.readFile("utf8"), /导入不会调用模型或启动求解器/); } finally { await intro.close(); }
      for (const path of essential[demo.id]) {
        const handle = await files.read(owner.id, project.directory + "/" + path);
        try { assert.ok((await handle.stat()).size > 0, "Missing/empty real demo artifact: " + demo.id + "/" + path); } finally { await handle.close(); }
      }
      await assert.rejects(demos.create(demo.id, owner, store, files), { status: 429 });
      assert.equal(store.projects(owner.id).length, 1, "Rate-limited import must not create another project");
    }
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as {n:number}).n, 0, "Import must not enqueue a solver/model task");
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get() as {n:number}).n, 0, "Import must not create provider usage");
  } finally { store.close(); await rm(root, {recursive:true,force:true}); }
});
