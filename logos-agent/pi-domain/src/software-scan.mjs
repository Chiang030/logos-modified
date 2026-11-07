import { readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const execute = promisify(execFile);
// Skip generated dependency trees, OS internals, and virtual filesystems.
const excluded = new Set(["node_modules", ".git", ".venv", "$recycle.bin", "system volume information", "windows", "proc", "sys", "dev"]);

async function localRoots(platform, env) {
  if (platform !== "win32") return ["/opt", "/srv", "/usr", "/Applications", "/snap", homedir(), "/mnt", "/media"];
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 10_000 });
  const drives = JSON.parse(stdout);
  const roots = (Array.isArray(drives) ? drives : [drives]).filter((drive) => typeof drive === "string" && /^[A-Z]:$/i.test(drive));
  if (!roots.length) throw new Error("未能获取本机磁盘列表，请稍后重试全局扫描。");
  return roots.map((drive) => `${drive}/`);
}

/** Scan local disks once for supported executable names, without launching them. */
export async function scanSoftware(products, { platform, env, roots, maxDirectories = 150_000, timeoutMs = 120_000 }) {
  const targets = roots ?? await localRoots(platform, env);
  const pending = [...new Set(targets)];
  const candidates = new Map(products.map((product) => [product.id, []]));
  const names = new Map();
  for (const product of products) {
    if (product.windowsOnly && platform !== "win32") continue;
    for (const name of product.names.flatMap((name) => platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`] : [name])) {
      names.set(platform === "win32" ? name.toLowerCase() : name, product.id);
    }
  }
  const deadline = Date.now() + timeoutMs;
  let visited = 0;
  let skipped = 0;
  while (visited < pending.length && visited < maxDirectories && Date.now() < deadline) {
    const batch = pending.slice(visited, Math.min(visited + 24, maxDirectories));
    visited += batch.length;
    await Promise.all(batch.map(async (directory) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { skipped++; return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name.toLowerCase())) pending.push(path);
        } else if (entry.isFile()) {
          const product = names.get(platform === "win32" ? entry.name.toLowerCase() : entry.name);
          if (!product) continue;
          try { await access(path, platform === "win32" ? constants.F_OK : constants.X_OK); candidates.get(product).push(path); }
          catch { /* Non-executable files are not usable installations. */ }
        }
      }
    }));
  }
  return { candidates, scan: { roots: targets, visited, skipped, limited: visited < pending.length, checkedAt: new Date().toISOString() } };
}
