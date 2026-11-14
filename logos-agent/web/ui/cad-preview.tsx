import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from "react";
import { binary } from "./api";

const ModelPreview = lazy(() => import("./model-preview"));

export function CadPreview({ project, path }: { project: string; path: string }): ReactElement {
  const [data, setData] = useState<ArrayBuffer>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  const preview = async (): Promise<void> => {
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError("");
    try { setData(await binary("/api/cad-preview", { project, path }, controller.signal)); }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "预览失败"); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return data ? <Suspense fallback={<div className="empty-note">正在加载 3D 查看器…</div>}><ModelPreview path={path} project={project} stl={data} /></Suspense> : <div className="empty-note">
    <p>STEP/STP 是 CAD 几何文件，可生成只读三维预览，也可下载原文件在 CAD 软件中打开。</p>
    <p>预览使用临时三角网格，不修改原始几何或求解网格；最大 32 MiB，转换限时 60 秒。</p>
    <button disabled={busy} onClick={() => void preview()}>{busy ? "正在转换 STEP…" : "生成 3D 预览"}</button>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
