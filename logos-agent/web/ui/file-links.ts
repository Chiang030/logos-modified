import type { Project } from "./api.ts";

/** Resolve model-generated file links without treating server paths as web routes. */
export function projectFileLink(href: string, project: Pick<Project, "id" | "absolutePath">): string {
  let path = href.trim();
  if (/^file:\/\//i.test(path)) {
    const url = new URL(path);
    if (url.host && url.host !== "localhost") throw new Error("不能打开其他主机的文件链接");
    path = url.pathname;
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new Error("该链接不是项目文件，请使用项目内相对路径");
  }
  // Decode URL escapes exactly once; a literal percent in an ordinary filename is valid.
  path = path.replace(/#(?:L\d+(?:-L?\d+)?|\d+(?:-\d+)?)$/, "");
  try { path = decodeURIComponent(path); } catch { /* Preserve literal percent filenames. */ }
  const root = project.absolutePath?.replace(/\/$/, "");
  if (root && path.startsWith(root + "/")) path = path.slice(root.length + 1);
  else if (path.startsWith("/workspace/")) path = path.slice("/workspace/".length);
  else if (path.startsWith("/")) throw new Error("此文件不在当前项目内，请让 LOGOS 将产物保存到项目目录后再下载");
  while (path.startsWith("./")) path = path.slice(2);
  const parts = path.split("/");
  if (!path || path.length > 2048 || parts.length > 32 || parts.some(part => !part || part === "." || part === ".." || part.length > 255 || /[\\\u0000-\u001f]/.test(part))) {
    throw new Error("文件链接路径无效，请从左侧文件列表选择产物");
  }
  return path;
}
