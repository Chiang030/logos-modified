import { useState, type ReactElement } from "react";
import { api, type Project } from "./api";

export interface StudyConfig {
  schemaVersion: number; id: string; name: string; physics: Record<string, unknown>;
  materials: unknown[]; boundaries: unknown[]; model: string | null; mesh: string | null;
  solver: { name: string; settings: Record<string, unknown> }; execution: Record<string, unknown>; outputs: unknown[]; inputs: string[];
}
interface RunRecord { id: string; path: string; status: string; created: string; acceptance: string; note?: string; error?: string; }
interface Study { config: StudyConfig; revision: string; runs: RunRecord[]; }
export interface WorkspaceOverview { managed: boolean; studies: Study[]; errors?: string[]; }

const labels: Record<string,string> = { "project.md":"项目说明", assets:"原始资料", models:"几何模型", meshes:"网格", studies:"计算方案", reports:"报告" };
export function fileLabel(folder: string, name: string): string {
  if (!folder) return labels[name] ?? name;
  if (/^studies\/[^/]+$/.test(folder)) return ({ "study.json":"方案配置", scripts:"执行脚本", runs:"运行记录", analysis:"后处理" } as Record<string,string>)[name] ?? name;
  if (/^studies\/[^/]+\/runs\/[^/]+$/.test(folder)) return ({ "manifest.json":"运行详情", inputs:"本次输入", logs:"运行日志", results:"计算结果" } as Record<string,string>)[name] ?? name;
  return name;
}
export const runLabels: Record<string,string> = { prepared:"准备就绪", running:"运行中", completed:"执行完成", failed:"执行失败", cancelled:"已取消", interrupted:"已中断", preparation_failed:"准备失败" };

export function StudyPanel({ project, overview, refresh, browse, notice }: {
  project: Project; overview?: WorkspaceOverview; refresh: () => void;
  browse: (path: string, file?: boolean) => void; notice: (message: string) => void;
}): ReactElement {
  const [id,setId]=useState(""),[name,setName]=useState(""),[busy,setBusy]=useState(false);
  const [editing,setEditing]=useState<Study>(),[draft,setDraft]=useState(""),[error,setError]=useState("");
  const perform=async (input: Record<string,unknown>): Promise<boolean> => {
    if(busy)return false; setBusy(true);setError("");
    try { await api("/api/workspace",{project:project.id,...input}); refresh();return true; }
    catch(e){setError(e instanceof Error?e.message:"操作失败");return false;}
    finally{setBusy(false);}
  };
  if(!overview)return <p className="empty-note">正在读取计算方案…</p>;
  if(!overview.managed)return <div className="empty-note">此项目保留原有文件结构。<br/>新建空文件夹并建立项目，即可使用计算方案和运行记录。</div>;
  return <div className="study-panel">
    <p className="hint">每个方案独立配置，每次运行保留输入和结果。</p><button onClick={refresh} disabled={busy}>刷新方案与运行记录</button>
    <form onSubmit={e=>{e.preventDefault();void perform({action:"create_study",study:id,name:name.trim()||id}).then(ok=>{if(ok){setId("");setName("");}});}}>
      <input aria-label="方案标识" placeholder="方案标识，例如 wind-10" pattern="[a-z0-9][a-z0-9_-]{0,63}" maxLength={64} required value={id} onChange={e=>setId(e.target.value)} disabled={busy}/>
      <input aria-label="方案名称" placeholder="显示名称，例如 风速 10 m/s" maxLength={80} value={name} onChange={e=>setName(e.target.value)} disabled={busy}/>
      <button disabled={busy||!id.trim()}>＋ 新建方案</button>
    </form>
    {error?<p role="alert" className="dialog-error">{error}</p>:null}
    {overview.errors?.map(e=><p key={e} role="alert" className="dialog-error">{e}</p>)}
    {overview.studies.map(study=><section className="study-card" key={study.config.id}>
      <strong>{study.config.name}</strong><small>{study.config.id} · {study.config.solver.name||"待配置求解器"}</small>
      <div className="study-actions">
        <button onClick={()=>{setEditing(study);setDraft(JSON.stringify(study.config,null,2));setError("");}}>编辑配置</button>
        <button onClick={()=>browse("studies/"+study.config.id)}>查看文件</button>
        <button disabled={busy} onClick={()=>void perform({action:"prepare_run",study:study.config.id}).then(ok=>{if(ok)notice("输入快照已保存，求解器尚未启动。可在对话中指定方案并请求运行。");})}>准备运行</button>
      </div>
      <p className="hint">准备运行只保存快照；执行完成不代表结果已验证。</p>
      {!study.runs.length?<p className="hint">尚无运行记录</p>:study.runs.map(run=><div className="study-run" key={run.id}>
        <strong>{runLabels[run.status]??run.status}</strong><small>{run.id}</small>
        <div className="study-actions">
          <button onClick={()=>browse(run.path+"/manifest.json",true)}>详情</button>
          <button onClick={()=>browse(run.path+"/inputs")}>输入</button>
          <button onClick={()=>browse(run.path+"/logs")}>日志</button>
          <button onClick={()=>browse(run.path+"/results")}>结果</button>
        </div>
        {run.error?<p className="hint">{run.error}</p>:null}
      </div>)}
    </section>)}
    {editing?<div className="modal-shade"><section className="study-editor" role="dialog" aria-modal="true" aria-label="编辑计算方案">
      <header><h2>{editing.config.name} · 配置</h2><button disabled={busy} aria-label="关闭方案配置" onClick={()=>setEditing(undefined)}>×</button></header>
      <p>填写物理条件、求解设置及项目相对文件路径。inputs 必须列出本次求解需要的脚本和其他输入文件；模型和网格会自动纳入快照。</p>
      <textarea aria-label="方案 JSON 配置" spellCheck={false} value={draft} onChange={e=>setDraft(e.target.value)} disabled={busy}/>
      {error?<p role="alert" className="dialog-error">{error}</p>:null}
      <footer><button disabled={busy} onClick={()=>setEditing(undefined)}>取消</button><button className="primary" disabled={busy} onClick={()=>{
        let config: unknown;try{config=JSON.parse(draft);}catch{setError("JSON 格式有误，请检查括号、逗号和引号");return;}
        void perform({action:"save_study",study:editing.config.id,revision:editing.revision,config}).then(ok=>{if(ok)setEditing(undefined);});
      }}>保存配置</button></footer>
    </section></div>:null}
  </div>;
}
