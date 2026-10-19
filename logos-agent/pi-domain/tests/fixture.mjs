import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime }
  from "../../../vendor/pi/packages/coding-agent/dist/index.js";
import { AuthStorage } from "../../../vendor/pi/packages/coding-agent/dist/core/auth-storage.js";
import { registerObservability } from "../extensions/observability.mjs";
import { demoResponse, registerDemoTools } from "./demo.mjs";

export async function piFixture(runtime, config, extra = () => {}, options = {}) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the synthetic prompt. */ }
    calls++;
    res.writeHead(200, { "Content-Type": "text/event-stream", "x-request-id": `synthetic-${calls}` });
    const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({
      id: `synthetic-${calls}`, object: "chat.completion.chunk", model: "logos-synthetic",
      choices: [{ index: 0, delta, finish_reason }], usage,
    })}\n\n`);
    chunk({ role: "assistant" });
    const demo = options.demo ? demoResponse((calls - 1) % 3) : undefined;
    if (demo) {
      chunk({ reasoning_content: demo.reasoning_content });
      if (demo.tool) chunk({ tool_calls: [{ index: 0, id: `tool-${calls}`, type: "function",
        function: { name: demo.tool, arguments: JSON.stringify(demo.args) } }] });
      else chunk({ content: demo.content });
    } else if (calls % 2 === 1) {
      chunk({ tool_calls: [{ index: 0, id: `tool-${calls}`, type: "function",
        function: { name: "observability_echo", arguments: '{"text":"synthetic"}' } }] });
    } else chunk({ content: "Synthetic observability check completed." });
    chunk({}, (demo ? demo.tool : calls % 2 === 1) ? "tool_calls" : "stop", { prompt_tokens: 360, completion_tokens: 80, total_tokens: 440,
      prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 30 } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "logos-observability-"));
  const agentDir = join(directory, "agent"); await mkdir(agentDir);
  const modelDefinition = { id: "logos-synthetic", name: "Synthetic local fixture", api: "openai-completions",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } };
  const modelsPath = join(agentDir, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { "logos-test": {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-local-key",
    models: [modelDefinition],
  } } }));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath,
    modelsStorePath: join(agentDir, "models-cache"), refreshOnCreate: false });
  let controller;
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager,
    noExtensions: true, disabledBuiltinExtensions: ["mcp", "codemode"], noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, systemPrompt: options.demo
      ? "遥测验收演示：先用 demo_material_lookup 查询密度，再用 demo_mass_calculate 计算质量，最后给出带单位的回答。所有材料数据和模型响应均为合成测试。"
      : "Synthetic observability test. Use observability_echo once, then answer.",
    additionalExtensionPaths: options.loadDomain ? [fileURLToPath(new URL("../", import.meta.url))] : [],
    extensionFactories: [async (pi) => {
      controller = await registerObservability(pi, { runtime, config });
      if (options.demo) registerDemoTools(pi);
      pi.registerTool({ name: "observability_echo", label: "Echo", description: "Synthetic echo for telemetry tests",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        async execute(_id, args, signal, _update, ctx) {
          if (options.execute) await options.execute(ctx, signal);
          return { content: [{ type: "text", text: args.text }], details: { synthetic: true } };
        } });
      extra(pi);
    }],
  });
  try {
    await resourceLoader.reload();
    if (resourceLoader.getExtensions().errors.length) throw new Error(JSON.stringify(resourceLoader.getExtensions().errors));
    const { session } = await createAgentSession({ cwd: directory, agentDir, settingsManager, modelRuntime,
      model: modelRuntime.getModel("logos-test", "logos-synthetic"), thinkingLevel: "off",
      sessionManager: SessionManager.inMemory(directory), resourceLoader,
      tools: options.demo ? ["demo_material_lookup", "demo_mass_calculate"]
        : options.loadDomain ? ["observability_echo", "observability_child", "simulation", "simulation_discover"] : ["observability_echo"] });
    await session.bindExtensions({ onError: (error) => { throw new Error(`Fixture extension error: ${error.error}`); } });
    return { session, get controller() { return controller; }, get calls() { return calls; },
      async close() { controller?.dispose(); session.dispose();
        await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
