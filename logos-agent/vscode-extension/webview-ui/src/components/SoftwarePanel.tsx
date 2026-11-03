import { useEffect, useState, type ReactElement } from "react";
import type { SoftwareDiscovery } from "../../../../pi-domain/src/software-discovery.mjs";
import type { ExtensionToWebviewMessage } from "../protocol";

export function SoftwarePanel({ busy, post, expanded = false }: { busy: boolean; post: (message: unknown) => void; expanded?: boolean }): ReactElement {
  const [result, setResult] = useState<SoftwareDiscovery>();
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const receive = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      if (event.data.type === "software/result") { setResult(event.data.result); setPaths({}); setPending(false); setError(""); }
      if (event.data.type === "software/scanning") { setPending(true); setError(""); }
      if (event.data.type === "software/error") { setError(event.data.message); setPending(false); }
    };
    window.addEventListener("message", receive); post({ type: "software/load" });
    return () => window.removeEventListener("message", receive);
  }, []);
  return <details open={expanded || undefined}><summary>软件发现与路径配置</summary>
    <p>检测运行时所在主机的软件。找到程序不代表许可证、SDK 或 MCP 已连接。</p>
    <div className="settings-actions">
      <button disabled={pending || busy} onClick={() => { setPending(true); post({ type: "software/scan" }); }}>全局扫描软件</button>
      <button disabled={pending || busy} onClick={() => { setPending(true); post({ type: "software/load", refresh: true }); }}>快速重新检测</button>
    </div>
    <p className="settings-hint">全局扫描本机磁盘中的受支持软件，跳过系统目录、依赖目录和链接目录。扫描结果自动保存在这里，可重新扫描、选择版本或手动更新路径。</p>
    {pending && <p role="status">正在检测软件，请稍候；全局扫描约需 2 分钟…</p>}{error && <p role="alert">{error}</p>}
    {result && <p>主机：{result.host} · {result.platform}</p>}
    {result && <p role="status">已找到 {result.products.filter((item) => item.status === "installed").length} / {result.products.filter((item) => item.status !== "unsupported").length} 类软件 · 更新于 {new Date(result.checkedAt).toLocaleString()}</p>}
    {result?.globalScan && <p className="settings-hint">最近全局扫描：{new Date(result.globalScan.checkedAt).toLocaleString()} · {result.globalScan.roots.join("、")} · 已检查 {result.globalScan.visited} 个目录。
      {result.globalScan.limited ? "已达到扫描时间或目录数量上限，结果可能不完整；未找到的软件可手动填写路径。" : "扫描范围已检查完毕。"}
      {result.globalScan.skipped > 0 ? ` ${result.globalScan.skipped} 个目录无法读取。` : ""}</p>}
    {result?.products.map((item) => <div key={item.product} className="software-entry">
      <strong>{item.product}</strong> · {({ installed: "已找到", missing: "未找到", unsupported: "当前平台不支持", "invalid-path": "配置路径无效" })[item.status]}
      <p className="software-path">{item.selected ?? "尚无可用路径"}</p>
      <label>程序路径<input disabled={busy || pending} value={paths[item.product] ?? item.selected ?? ""} onChange={(event) => setPaths((current) => ({ ...current, [item.product]: event.target.value }))} /></label>
      {item.candidates.length > 1 && <select disabled={busy || pending} aria-label={`${item.product} 已发现版本`} value={paths[item.product] ?? item.selected ?? ""} onChange={(event) => setPaths((current) => ({ ...current, [item.product]: event.target.value }))}>
        {item.candidates.map((candidate) => <option key={candidate.path} value={candidate.path}>{candidate.version ?? "版本未知"} · {candidate.path}</option>)}
      </select>}
      <button disabled={busy || pending || item.status === "unsupported"} onClick={() => { setPending(true); post({ type: "software/path", product: item.product, path: paths[item.product] ?? item.selected ?? "" }); }}>保存路径</button>
      <button disabled={busy || pending} onClick={() => { setPending(true); setPaths((current) => ({ ...current, [item.product]: "" })); post({ type: "software/path", product: item.product, path: "" }); }}>恢复自动发现</button>
      <p>依赖：未验证 · 连接：未验证</p>
    </div>)}
  </details>;
}
