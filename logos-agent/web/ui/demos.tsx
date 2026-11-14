import { useEffect, useRef, useState, type ReactElement } from "react";
import { api, type Project } from "./api";

interface Demo { id: string; name: string; summary: string; limits: string; prompt: string; }
export function DemoGallery({ open }: { open: (project: Project) => void }): ReactElement {
  const [demos, setDemos] = useState<Demo[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    void api<{demos: Demo[]}>("/api/demos").then(value => { if (alive) setDemos(value.demos ?? []); }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "算例列表暂不可用"); });
    return () => { alive = false; mounted.current = false; };
  }, []);
  const create = async (id: string): Promise<void> => {
    setBusy(id); setError("");
    try { const result = await api<{project:Project}>("/api/demos", {id}); if (mounted.current) open(result.project); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "算例导入失败"); }
    finally { if (mounted.current) setBusy(""); }
  };
  return <section className="logos-feedback"><h2>标准算例 · 已有真实运行证据</h2><p>创建个人副本以查看模型、报告和脚本；不会自动调用模型、运行求解器或消耗许可。重跑前请阅读验证边界。</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="logos-feedback-boards">{demos.map(demo => <article key={demo.id}><h3>{demo.name}</h3><p>{demo.summary}</p><p>{demo.limits}</p><details><summary>建议演示指令</summary><p>{demo.prompt}</p></details><button disabled={Boolean(busy)} onClick={() => void create(demo.id)}>{busy === demo.id ? "正在创建副本…" : "创建个人示例项目"}</button></article>)}</div>
  </section>;
}
