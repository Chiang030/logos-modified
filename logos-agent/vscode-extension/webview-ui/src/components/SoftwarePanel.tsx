import { useEffect, useState, type ReactElement } from "react";
import type { SoftwareDiscovery } from "../../../../pi-domain/src/software-discovery.mjs";
import type { ExtensionToWebviewMessage } from "../protocol";

export function SoftwarePanel({ busy, post }: { busy: boolean; post: (message: unknown) => void }): ReactElement {
  const [result, setResult] = useState<SoftwareDiscovery>();
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const receive = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      if (event.data.type === "software/result") { setResult(event.data.result); setPending(false); setError(""); }
      if (event.data.type === "software/error") { setError(event.data.message); setPending(false); }
    };
    window.addEventListener("message", receive); post({ type: "software/load" });
    return () => window.removeEventListener("message", receive);
  }, []);
  return <details><summary>软件发现与路径配置</summary>
    <p>检测运行时所在主机的软件。找到程序不代表许可证、SDK 或 MCP 已连接。</p>
    <button disabled={pending || busy} onClick={() => { setPending(true); post({ type: "software/load", refresh: true }); }}>重新检测</button>
    {pending && <p role="status">正在检测…</p>}{error && <p role="alert">{error}</p>}
    {result && <p>主机：{result.host} · {result.platform}</p>}
    {result?.products.map((item) => <div key={item.product} className="software-entry">
      <strong>{item.product}</strong> · {({ installed: "已找到", missing: "未找到", unsupported: "当前平台不支持", "invalid-path": "配置路径无效" })[item.status]}
      <p>{item.selected ?? "尚无可用路径"}</p>
      <label>程序路径<input value={paths[item.product] ?? item.selected ?? ""} onChange={(event) => setPaths((current) => ({ ...current, [item.product]: event.target.value }))} /></label>
      {item.candidates.length > 1 && <select aria-label={`${item.product} 已发现版本`} value={paths[item.product] ?? item.selected ?? ""} onChange={(event) => setPaths((current) => ({ ...current, [item.product]: event.target.value }))}>
        {item.candidates.map((candidate) => <option key={candidate.path} value={candidate.path}>{candidate.version ?? "版本未知"} · {candidate.path}</option>)}
      </select>}
      <button disabled={busy || pending || item.status === "unsupported"} onClick={() => { setPending(true); post({ type: "software/path", product: item.product, path: paths[item.product] ?? item.selected ?? "" }); }}>保存路径</button>
      <button disabled={busy || pending} onClick={() => { setPending(true); setPaths((current) => ({ ...current, [item.product]: "" })); post({ type: "software/path", product: item.product, path: "" }); }}>恢复自动发现</button>
      <p>依赖：未验证 · 连接：未验证</p>
    </div>)}
  </details>;
}
