import { useEffect, useRef, useState, type ReactElement } from "react";
import { query } from "./api";

/** Report HTTP failures instead of navigating away to a JSON error document. */
export function FileDownload({ project, path }: { project: string; path: string }): ReactElement {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const url = "/api/file?" + query(path, project) + "&download=1";
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => pending.current?.abort(), [url]);
  const download = async (): Promise<void> => {
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError("");
    try {
      const response = await fetch(url, { credentials: "same-origin", signal: controller.signal });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error ?? "下载失败（HTTP " + response.status + "）");
      }
      const size = Number(response.headers.get("content-length"));
      if (size > 64 * 1024 * 1024) {
        await response.body?.cancel();
        const link = document.createElement("a"); link.href = url; link.download = path.split("/").at(-1) ?? "download";
        link.click(); return;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("下载响应为空");
      const parts: ArrayBuffer[] = []; let total = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        total += next.value.byteLength;
        if (total > 64 * 1024 * 1024) { await reader.cancel(); throw new Error("下载数据超出预期大小，请刷新文件列表后重试"); }
        parts.push(next.value.slice().buffer);
      }
      const blob = new Blob(parts, { type: response.headers.get("content-type") ?? "application/octet-stream" });
      if (!blob.size) throw new Error("文件为空，请等待 LOGOS 完成生成或检查执行日志");
      const objectUrl = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = objectUrl; link.download = path.split("/").at(-1) ?? "download";
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "下载连接中断，请重试"); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <span className="file-download"><button disabled={busy} onClick={() => void download()}>{busy ? "正在下载…" : "下载原文件"}</button>{error ? <span role="alert">{error}</span> : null}</span>;
}
