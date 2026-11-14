import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store, User } from "./store.ts";
import type { WorkspaceFiles } from "./files.ts";
import { body, json } from "./http.ts";
import { HttpError } from "./errors.ts";

const evidenceRoot = fileURLToPath(new URL("../../examples/validated-demos/", import.meta.url));
interface Demo { id: string; name: string; summary: string; limits: string; prompt: string; files: [string, string][]; }
const demos: Demo[] = [
  { id: "structure", name: "结构 · 钢悬臂梁", summary: "真实 MAPDL BEAM188 求解，位移误差 0.124%，支座力/力矩平衡通过。", limits: "一维梁单元，不是三维实体或 Workbench GUI 验收；未提取实体应力场。",
    prompt: "先阅读 DEMO.md 和 README.md，检查公开结果与解析解。若要求重跑，先核实软件和许可，在新目录执行单核算例，不覆盖已有证据；将新的结果、日志和验收报告复制回本项目，再提供项目内下载链接。",
    files: ["README.md", "structure_demo.dat", "structure_demo.sh", "structure_demo.py", "results/results.csv", "results/comparison.json", "results/solve.txt", "attempts/wrong-section/results.csv", "attempts/wrong-section/solve.txt"].map(name => ["structure/" + name, name] as [string,string]) },
  { id: "air-pipe", name: "气动 · 低速空气管流", summary: "真实 Fluent 双网格求解，细网格压降误差 0.043%，两网格差 0.130%。", limits: "二维轴对称低马赫内部层流，不是翼型升阻力算例，也不是三网格 GCI 认证。",
    prompt: "先阅读 DEMO.md 和 README.md，核对粗细网格报告和失败尝试说明。若要求重跑，先核实 Fluent/PyFluent 入口和许可，使用新目录、单核和记录中的稳定求解控制，不改几何与物性；完成后核对残差、质量守恒及解析压降，并将产物保存回本项目。",
    files: ["README.md", "fluent_air_pipe.py", "check_cfd_reports.py", ...["strict", "fine-stable"].flatMap(grid => ["pipe.msh", "reports.json", "run.txt"].map(name => `results/${grid}/${name}`)), "attempts/fine-failed/reports.json", "attempts/fine-failed/run.txt"].map(name => ["air-pipe/" + name, name] as [string,string]) },
  { id: "kicad-led", name: "KiCad · 5V LED 小板", summary: "真实原理图 ERC、网表、PCB 一致性/DRC、Gerber、钻孔和 STEP 导出通过。", limits: "自定义演示封装，默认 DRC 未涵盖所有制造规则；STEP 为板体，不是元件装配。",
    prompt: "先阅读 DEMO.md 和 README.md，查看 results 中原理图、PCB、ERC/DRC 与网表，确认 LED 1=K、2=A。若要求重跑，在新目录执行生成、检查及制造导出，保留完整报告；不把演示封装当量产设计，也不覆盖已有证据。",
    files: ["README.md", "kicad_led.py", "kicad_full.py", "check_kicad_full.py", "run_kicad.sh", ...["led.kicad_sch", "led.kicad_pcb", "led.kicad_pro", "sym-lib-table", "expected-nets.json", "led.xml", "erc.json", "drc-parity.json", "led.step", "drill/led.drl", "gerbers/led-F_Cu.gtl", "gerbers/led-B_Cu.gbl", "gerbers/led-F_Mask.gts", "gerbers/led-B_Mask.gbs", "gerbers/led-F_Silkscreen.gto", "gerbers/led-Edge_Cuts.gm1"].map(name => "results/" + name), "attempts/erc-first.json", "attempts/drc-parity.json"].map(name => ["kicad-led/" + name, name] as [string,string]) },
];

/** Curated successful examples only; imports never run solvers or copy private server configuration. */
export class Demos {
  private readonly importing = new Set<string>();
  private readonly lastImport = new Map<string, number>();
  catalog(): Omit<Demo, "files">[] { return demos.map(({files: _files, ...demo}) => demo); }
  async create(id: unknown, user: User, store: Store, files: WorkspaceFiles): Promise<unknown> {
    const demo = demos.find(item => item.id === id);
    if (!demo) throw new HttpError(400, "未知的标准算例");
    if (this.importing.has(user.id) || Date.now() - (this.lastImport.get(user.id) ?? 0) < 30_000) throw new HttpError(429, "请等待当前算例导入完成，30 秒后再创建");
    this.importing.add(user.id);
    this.lastImport.set(user.id, Date.now());
    try {
      // Validate the whole curated bundle before creating a user-visible directory.
      const content: { path: string; bytes: Buffer }[] = []; let size = 0;
      for (const [source, path] of demo.files) {
        const target = join(evidenceRoot, source), info = await stat(target);
        if (!info.isFile() || size + info.size > 32 * 1024 * 1024) throw new HttpError(503, "标准算例包缺失或过大，请管理员检查部署");
        const bytes = await readFile(target); size += bytes.length;
        if (size > 32 * 1024 * 1024) throw new HttpError(503, "标准算例包超过限制，请管理员检查部署");
        content.push({ path, bytes });
      }
      const directory = "demos/" + demo.id + "-" + randomUUID();
      await files.folder(user.id, directory);
      const intro = `# ${demo.name}\n\n${demo.summary}\n\n## 验证边界\n${demo.limits}\n\n这是 2026-11-12 在 Linux 环境实际运行的公开证据副本，不是本次新运行。导入不会调用模型或启动求解器。日志已去除机器标识；机器相关的原生求解数据库不分发，请按 README 重跑生成。\n\n## 对话演示指令\n${demo.prompt}\n\n只在新的输出目录重跑；不要覆写本包的参考结果。成功记录位于 results/，已知失败尝试位于 attempts/；同一目录中的 README.md 说明复跑步骤与验收边界。\n`;
      for (const item of [{path:"DEMO.md",bytes:Buffer.from(intro)}, ...content]) await files.upload(user.id, directory + "/" + item.path, (async function*(){yield item.bytes;})(), 32 * 1024 * 1024);
      this.lastImport.set(user.id, Date.now());
      return store.createProject(user.id, demo.name, directory);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "标准算例导入未完成，请管理员检查资源包与磁盘空间；本次未注册项目，可在文件夹中检查保留的部分副本");
    } finally { this.importing.delete(user.id); }
  }
}
export async function demoRoute(resource: Demos, store: Store, files: WorkspaceFiles, user: User, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (url.pathname !== "/api/demos") return false;
  if (req.method === "GET") { json(res, { demos: resource.catalog() }); return true; }
  if (req.method === "POST") { const input = await body(req); json(res, { project: await resource.create(input.id, user, store, files) }, 201); return true; }
  return false;
}
