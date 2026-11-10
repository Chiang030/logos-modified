import { Type } from "@earendil-works/pi-ai";
import { projectWorkspace } from "../src/workspace.mjs";

export function registerProjectWorkspace(pi) {
  pi.registerTool({
    name: "project_workspace", label: "项目与计算方案",
    description: "Manage LOGOS projects, studies and immutable run input snapshots. list reads configuration, revisions and run manifests. initialize accepts empty projects only. save_study requires the revision from list; prepare_run snapshots declared input files without launching a solver. update_run records actual execution, never scientific validation. Existing legacy projects remain unchanged.",
    parameters: Type.Object({
      action: Type.Union(["list","initialize","create_study","save_study","prepare_run","update_run","create_folder"].map(v=>Type.Literal(v))),
      study: Type.Optional(Type.String()), name: Type.Optional(Type.String()),
      config: Type.Optional(Type.Unknown()), revision: Type.Optional(Type.String()),
      run: Type.Optional(Type.String()), status: Type.Optional(Type.String()),
      command: Type.Optional(Type.Array(Type.String())), software: Type.Optional(Type.String()), note: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      try { const result=await projectWorkspace(ctx.cwd,params); return {content:[{type:"text",text:JSON.stringify(result)}],details:result}; }
      catch(error) { return {isError:true,content:[{type:"text",text:error.message}]}; }
    },
  });
}
