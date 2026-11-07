import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, unlink, link, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./errors.ts";

export interface FileEntry { name: string; directory: boolean; size: number; modified: number; }

export function segments(value: string): string[] {
  if (value === "") return [];
  const parts = value.split("/");
  if (value.length > 2048 || parts.length > 32 || parts.some((p) => !p || p === "." || p === ".." || /[\\\u0000-\u001f]/.test(p) || p.length > 255)) {
    throw new HttpError(400, "文件路径无效");
  }
  return parts;
}

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPath = (handle: FileHandle, name = ""): string => "/proc/self/fd/" + handle.fd + (name ? "/" + name : "");

export class WorkspaceFiles {
  root: string;
  constructor(root: string) { this.root = root; }
  async home(user: string): Promise<string> {
    if (!/^[a-z0-9-]{1,64}$/i.test(user)) throw new HttpError(400, "用户标识无效");
    const path = join(this.root, user, "workspace");
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }
  /** Walk with held directory descriptors; never follow user-controlled symlinks. */
  async directory(user: string, relative = "", create = false): Promise<FileHandle> {
    const parts = segments(relative);
    let handle = await open(await this.home(user), directoryFlags);
    try {
      for (const part of parts) {
        const path = fdPath(handle, part);
        if (create) await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        const next = await open(path, directoryFlags);
        await handle.close(); handle = next;
      }
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async list(user: string, relative: string): Promise<FileEntry[]> {
    const handle = await this.directory(user, relative);
    try {
      const entries = await readdir(fdPath(handle), { withFileTypes: true });
      if (entries.length > 5000) throw new HttpError(413, "目录条目过多，请选择更小的子目录");
      const result: FileEntry[] = [];
      for (const item of entries) {
        if (item.name.startsWith(".logos-upload-")) continue;
        if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) continue;
        let child: FileHandle | undefined;
        try {
          child = await open(fdPath(handle, item.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = await child.stat();
          if (stat.isFile() || stat.isDirectory()) result.push({ name: item.name, directory: stat.isDirectory(), size: stat.size, modified: stat.mtimeMs });
        } catch (error) { if (!["ENOENT", "ELOOP", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        finally { await child?.close(); }
      }
      return result.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    } finally { await handle.close(); }
  }
  async folder(user: string, path: string): Promise<void> {
    if (!segments(path).length) throw new HttpError(400, "请输入文件夹名称");
    const handle = await this.directory(user, path, true); await handle.close();
  }
  async read(user: string, path: string): Promise<FileHandle> {
    const parts = segments(path), name = parts.pop();
    if (!name) throw new HttpError(400, "请选择文件");
    const parent = await this.directory(user, parts.join("/"));
    try {
      const handle = await open(fdPath(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!(await handle.stat()).isFile()) { await handle.close(); throw new HttpError(400, "只能打开普通文件"); }
      return handle;
    } finally { await parent.close(); }
  }
  async upload(user: string, path: string, source: AsyncIterable<Uint8Array>, limit: number): Promise<void> {
    const parts = segments(path), name = parts.pop();
    if (!name) throw new HttpError(400, "请选择上传目标");
    const parent = await this.directory(user, parts.join("/"), true);
    const temporary = ".logos-upload-" + randomUUID();
    let handle: FileHandle | undefined;
    try {
      handle = await open(fdPath(parent, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let size = 0;
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > limit) throw new HttpError(413, "文件超过上传大小限制");
        await handle.writeFile(chunk);
      }
      await handle.sync();
      // A hard link publishes the complete file atomically, without replacing a target.
      await link(fdPath(parent, temporary), fdPath(parent, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "同名文件已存在，请更名后上传");
      throw error;
    } finally {
      await handle?.close();
      await unlink(fdPath(parent, temporary)).catch(() => undefined);
      await parent.close();
    }
  }
}
