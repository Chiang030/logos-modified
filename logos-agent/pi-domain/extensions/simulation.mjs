import { Type } from "typebox";
import { ACTIONS, runSimulation } from "../src/simulation/runner.mjs";

export function registerSimulationTool(pi) {
  pi.registerTool({
    name: "simulation_discover", label: "仿真软件探测",
    description: "Discover Mechanical or Workbench installations on the target host. Return installation IDs, executable paths, platform, version evidence and sources without launching software. Pass the chosen installation ID to simulation launch/probe; discovery is not runtime verification.",
    parameters: Type.Object({
      product: Type.Union([Type.Literal("mechanical"), Type.Literal("workbench")]),
      path: Type.Optional(Type.String({ description: "Explicit installation root or executable on the target host" })),
      host: Type.Optional(Type.String()),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = [params.product];
      if (params.path) args.push("--path", params.path);
      const result = await runSimulation({ action: "discover", args, host: params.host, port: params.port }, { cwd: ctx.cwd, signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: "simulation", label: "Simulation",
    description: "Call the configured sim CLI for solver discovery, diagnostics, sessions, inspection and bounded execution. Use help first to check installed commands. No automatic retries or backend fallback. Transport success does not prove script success or physical acceptance. Attached sessions must not be closed by disconnect; verify backend ownership semantics first.",
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map((value) => Type.Literal(value))),
      args: Type.Optional(Type.Array(Type.String(), { description: "CLI arguments as separate tokens, not shell text. Use installed CLI help to confirm syntax." })),
      host: Type.Optional(Type.String()),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
      session: Type.Optional(Type.String({ description: "Explicit sim session ID for multi-session routing" })),
      installation: Type.Optional(Type.String({ description: "Installation ID returned by simulation_discover, for launch or probe" })),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 3600000 })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = [...(params.args ?? [])];
      if (params.installation) {
        if (!["launch", "probe"].includes(params.action)) throw new Error("installation is only supported by launch/probe");
        args.push("--installation", params.installation);
      }
      const result = await runSimulation({ ...params, args }, { cwd: ctx.cwd, signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
