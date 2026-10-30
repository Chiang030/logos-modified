import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, type ConnectionEntry } from "./shared/protocol";

const fields = ["name", "reasoning", "thinkingLevelMap", "input", "inputLimits", "cost", "contextWindow", "maxTokens", "compat", "samplingParams", "samplingParamsByThinkingLevel"];

/** Reuse the shipped Pi catalog, but never copy upstream URLs or credentials. */
export async function modelDefinitions(domain: string, entry: ConnectionEntry): Promise<Record<string, unknown>[]> {
  let catalog: unknown;
  try { catalog = JSON.parse(await readFile(join(domain, "references", "model-capabilities.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const models = Array.isArray(catalog) ? catalog.filter(isRecord) : [];
  return [...new Set([entry.modelId, ...entry.modelIds])].filter(Boolean).map((id) => {
    const provider = entry.providerId === "zhipu" ? "zai-coding-cn" : entry.providerId === "openai-chatgpt" ? "openai" : entry.providerId;
    const candidates = models.filter((model) => model.id === id && model.api === entry.api);
    const known = candidates.find((model) => model.provider === provider)
      ?? candidates.find((model) => model.baseUrl === entry.baseUrl)
      ?? (candidates.length === 1 ? candidates[0] : undefined);
    const definition: Record<string, unknown> = { id };
    if (known) for (const key of fields) if (known[key] !== undefined) definition[key] = known[key];
    const override = entry.modelCapabilities?.[id]?.reasoning;
    if (override !== undefined) definition.reasoning = override;
    return definition;
  });
}
