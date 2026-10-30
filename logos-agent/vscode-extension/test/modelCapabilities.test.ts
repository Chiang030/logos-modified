import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelDefinitions } from "../src/modelCapabilities";
import type { ConnectionEntry } from "../src/shared/protocol";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
it("preserves catalog reasoning mappings and wire compatibility without leaking endpoints", async () => {
  const domain = await mkdtemp(join(tmpdir(), "logos-models-")); directories.push(domain);
  await mkdir(join(domain, "references"));
  await writeFile(join(domain, "references", "model-capabilities.json"), JSON.stringify([
    { id: "reasoner", api: "openai-completions", provider: "deepseek", baseUrl: "https://upstream", reasoning: true,
      thinkingLevelMap: { low: "low", high: "high" }, compat: { thinkingFormat: "deepseek" } },
  ]));
  const entry: ConnectionEntry = { id: "a", name: "test", providerId: "deepseek", api: "openai-completions", baseUrl: "https://proxy", modelId: "reasoner", modelIds: ["reasoner", "unknown"] };
  expect(await modelDefinitions(domain, entry)).toEqual([
    { id: "reasoner", reasoning: true, thinkingLevelMap: { low: "low", high: "high" }, compat: { thinkingFormat: "deepseek" } }, { id: "unknown" },
  ]);
  entry.modelCapabilities = { unknown: { reasoning: true }, reasoner: { reasoning: false } };
  expect(await modelDefinitions(domain, entry)).toEqual(expect.arrayContaining([expect.objectContaining({ id: "unknown", reasoning: true }), expect.objectContaining({ id: "reasoner", reasoning: false })]));
});
