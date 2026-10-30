import { isAbsolute, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export type LinkTarget = { kind: "external"; url: string } | { kind: "file"; path: string; line?: number };

/** Resolve message links without dispatching VS Code command URIs. */
export function resolveMessageLink(href: string, workspace: string): LinkTarget {
  let value = href.trim();
  if (!value || /[\u0000-\u001f]/.test(value)) throw new Error("无效的文件链接。");
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new Error("链接不能包含登录凭据。");
    return { kind: "external", url: url.toString() };
  }
  const suffix = value.match(/(?::(\d+)(?::\d+)?|#L?(\d+))$/);
  const line = suffix ? Number(suffix[1] ?? suffix[2]) : undefined;
  if (suffix) value = value.slice(0, -suffix[0].length);
  if (/^file:/i.test(value)) {
    const url = new URL(value);
    if (url.hostname && url.hostname !== "localhost") throw new Error("不支持网络共享文件链接。");
    value = fileURLToPath(url);
  }
  else {
    if (/^[a-z][\w+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error("仅支持文件和 HTTP/HTTPS 链接。");
    value = decodeURIComponent(value);
  }
  if (/^[a-z][\w+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error("不支持的链接协议。");
  if (/^[\\/]{2}|[\u0000-\u001f]/.test(value)) throw new Error("无效的本地文件路径。");
  return { kind: "file", path: win32.isAbsolute(value) || isAbsolute(value) ? value : resolve(workspace, value), line };
}
