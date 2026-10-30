import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname, homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const execute = promisify(execFile);
export const SOFTWARE = [
  { id: "blender", names: ["blender"], env: ["BLENDER_PATH", "BLENDER_EXECUTABLE"], match: /blender/i },
  { id: "kicad", names: ["kicad-cli"], env: ["KICAD_CLI", "KICAD_PATH"], match: /kicad/i },
  { id: "freecad", names: ["FreeCADCmd", "freecadcmd", "freecad"], env: ["FREECAD_CMD", "FREECAD_PATH"], match: /freecad/i },
  { id: "gmsh", names: ["gmsh"], env: ["GMSH_PATH"], match: /gmsh/i },
  { id: "solidcraft", names: ["solidcraft-cli", "solidcraft"], env: ["SOLIDCRAFT_PATH"], match: /solidcraft/i },
  { id: "fluent", names: ["fluent"], env: ["SIM_FLUENT_ROOT", "FLUENT_ROOT"], match: /ansys|fluent/i },
  { id: "mechanical", names: ["AnsysWBU"], env: ["SIM_MECHANICAL_ROOT"], match: /ansys/i },
  { id: "workbench", names: ["RunWB2", "runwb2", "runwb2.sh"], env: ["SIM_WORKBENCH_ROOT"], match: /ansys/i },
  { id: "hfss", names: ["ansysedt"], env: ["ANSYSEM_ROOT", "SIM_HFSS_ROOT"], match: /ansys|aedt|electronics/i },
  { id: "spaceclaim", names: ["SpaceClaim", "Discovery"], env: ["SIM_SPACECLAIM_ROOT"], match: /ansys|spaceclaim|discovery/i, windowsOnly: true },
];
const relativeBins = ["", "bin", "bin/win64", "bin/Win64", "aisol/bin/winx64", "aisol/bin/linx64", "Framework/bin/Win64", "Framework/bin/Linux64", "fluent/ntbin/win64", "fluent/bin", "SpaceClaim", "Discovery", "AnsysEM", "Linux64"];
const queue = new Map();

async function file(path, platform) {
  try { if (!(await stat(path)).isFile()) return false; await access(path, platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
  catch { return false; }
}

async function installedRoots(platform) {
  if (platform !== "win32") return [];
  const roots = [];
  for (const key of ["HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"]) {
    try {
      const { stdout } = await execute("reg.exe", ["query", key, "/s"], { windowsHide: true, timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
      for (const block of stdout.split(/\r?\n(?=HKEY_)/)) {
        if (!SOFTWARE.some((product) => product.match.test(block))) continue;
        const location = block.match(/InstallLocation\s+REG_\w+\s+([^\r\n]+)/i)?.[1]?.trim();
        if (location) roots.push(location.replace(/^"|"$/g, ""));
      }
    } catch { /* Registry access is optional; PATH and standard directories remain usable. */ }
  }
  return [...new Set(roots)];
}

function versionOf(path) {
  const ansys = path.match(/[\\/]v(\d{2})(\d)(?:[\\/]|$)/i);
  if (ansys) return `${ansys[1]}.${ansys[2]}`;
  return path.match(/(?:blender|kicad|freecad|gmsh|solidcraft|ansysem|aedt)[\s_/-]*(\d+(?:\.\d+){0,3})/i)?.[1];
}

/** Bounded, read-only discovery. Never launches an application or claims a license. */
export async function discoverSoftware({ overrides = {}, cacheFile, refresh = false, platform = process.platform, env = process.env,
  roots, registry = installedRoots, host = hostname() } = {}) {
  let cached = [];
  try { cached = JSON.parse(await readFile(cacheFile, "utf8")).products ?? []; } catch { /* First run or stale cache. */ }
  const registryRoots = await registry(platform);
  const standard = roots ?? (platform === "win32"
    ? [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"), "C:/ANSYS Inc", "D:/Program Files", "D:/ANSYS Inc"].filter(Boolean)
    : ["/usr/bin", "/usr/local/bin", "/opt", "/usr/ansys_inc", "/ansys_inc", join(homedir(), ".local", "bin"), "/snap/bin"]);
  const products = [];
  for (const product of SOFTWARE) {
    if (product.windowsOnly && platform !== "win32") { products.push({ product: product.id, host, platform, status: "unsupported", candidates: [], dependency: "unknown", connection: "not-checked" }); continue; }
    const candidates = new Map();
    const names = product.names.flatMap((name) => platform === "win32" ? [name + ".exe", name + ".cmd", name] : [name]);
    const add = async (path, source) => {
      if (!await file(path, platform)) return;
      const key = platform === "win32" ? path.toLowerCase() : path;
      if (!candidates.has(key)) candidates.set(key, { path, source, version: versionOf(path), versionSource: "path-hint" });
    };
    const inspect = async (path, source) => {
      if (!path) return;
      if (await file(path, platform)) { await add(path, source); return; }
      for (const relative of relativeBins) for (const name of names) await add(join(path, relative, name), source);
    };
    await inspect(overrides[product.id], "configured");
    const old = cached.find((item) => item.product === product.id && item.host === host && item.platform === platform);
    if (!refresh) for (const item of old?.candidates ?? []) await inspect(item.path, "cache");
    for (const key of product.env) await inspect(env[key], `environment:${key}`);
    if (["fluent", "mechanical", "workbench", "hfss", "spaceclaim"].includes(product.id)) {
      for (const [key, path] of Object.entries(env)) if (/^(AWP_ROOT\d+|ANSYSEM_ROOT\d+|ANSYS_ROOT)$/.test(key)) await inspect(path, `environment:${key}`);
    }
    for (const directory of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean)) for (const name of names) await add(join(directory, name), "PATH");
    let visited = 0;
    const scan = async (path, source, depth) => {
      if (visited++ > 150 || depth > 3) return;
      await inspect(path, source);
      let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
      for (const item of entries) {
        if (!item.isDirectory() || item.isSymbolicLink()) continue;
        if (depth > 0 && !/^(v?\d|blender|kicad|freecad|gmsh|solidcraft|ansys|aedt|fluent|spaceclaim|discovery)/i.test(item.name)) continue;
        if (depth === 0 && !product.match.test(item.name) && !/^v?\d/.test(item.name)) continue;
        await scan(join(path, item.name), source, depth + 1);
      }
    };
    for (const root of registryRoots) if (product.match.test(root)) await scan(root, "registry", 0);
    for (const root of standard) await scan(root, "standard-directory", 0);
    const found = [...candidates.values()].sort((a, b) => (b.version ?? "").localeCompare(a.version ?? "", undefined, { numeric: true }) || a.path.localeCompare(b.path));
    const explicit = found.find((item) => item.source === "configured");
    const selected = overrides[product.id] ? explicit : found.find((item) => item.path === old?.selected) ?? found[0];
    products.push({ product: product.id, host, platform, status: overrides[product.id] && !explicit ? "invalid-path" : selected ? "installed" : "missing",
      selected: selected?.path, candidates: found, dependency: "unknown", connection: "not-checked" });
  }
  const result = { host, platform, checkedAt: new Date().toISOString(), products };
  if (cacheFile) {
    const next = (queue.get(cacheFile) ?? Promise.resolve()).then(async () => {
      await mkdir(dirname(cacheFile), { recursive: true });
      const temporary = `${cacheFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(result), { mode: 0o600 }); await rename(temporary, cacheFile);
    });
    queue.set(cacheFile, next.catch(() => undefined)); await next;
  }
  return result;
}

export function discoveryEnvironment(result, original = process.env) {
  const env = { ...original };
  const paths = [];
  for (const item of result.products) {
    if (!item.selected || item.status !== "installed") continue;
    const definition = SOFTWARE.find((entry) => entry.id === item.product);
    env[definition.env[0]] = item.selected;
    paths.push(dirname(item.selected));
  }
  // Only the child process receives these paths; the user's global PATH is unchanged.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = [...new Set([...paths, env[pathKey] ?? ""])].join(delimiter);
  return env;
}
