import { constants } from "node:fs";
import { open, mkdir, readdir, rename, unlink, rmdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";

const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_JSON = 1024 * 1024, MAX_SNAPSHOT = 2 * 1024 ** 3;
const statuses = ["prepared", "running", "completed", "failed", "cancelled", "interrupted"];
export class WorkspaceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function parts(path) {
  if (typeof path !== "string" || path.length > 2048) throw new WorkspaceError("项目路径无效");
  const result = path.split("/");
  if (result.some(p => !p || p === "." || p === ".." || /[\\\x00-\x1f]/.test(p)) || result.length > 32) throw new WorkspaceError("请使用项目内的相对路径");
  return result;
}
function identifier(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new WorkspaceError("标识请使用小写字母、数字、短横线或下划线（最多 64 字符）");
  return value;
}
const object = value => value && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(value).digest("hex");
function validate(config, id) {
  if (!object(config) || config.schemaVersion !== 1 || config.id !== id || typeof config.name !== "string" || !config.name.trim() || config.name.length > 80) throw new WorkspaceError("方案版本、标识或名称无效");
  for (const key of ["physics", "solver", "execution"]) if (!object(config[key])) throw new WorkspaceError(key + " 必须是对象");
  if (typeof config.solver.name !== "string") throw new WorkspaceError("solver.name 必须是字符串");
  for (const key of ["materials", "boundaries", "outputs", "inputs"]) if (!Array.isArray(config[key])) throw new WorkspaceError(key + " 必须是数组");
  for (const value of [...config.inputs, config.model, config.mesh].filter(v => v !== null)) {
    const path = parts(value);
    if (!["assets", "models", "meshes"].includes(path[0]) && !(path[0] === "studies" && path[1] === id && path[2] === "scripts")) throw new WorkspaceError("输入只能引用 assets、models、meshes 或当前方案 scripts 中的文件");
  }
  if (config.inputs.length > 1000) throw new WorkspaceError("一次最多记录 1000 个输入文件");
  return config;
}
function template(id, name) {
  return { schemaVersion: 1, id, name, physics: {}, materials: [], boundaries: [], model: null, mesh: null,
    solver: { name: "", settings: {} }, execution: {}, outputs: [], inputs: [] };
}

/** Linux project operations use held directory descriptors, never traverse symlinks. */
class Files {
  constructor(root) { this.root = root; }
  async directory(path = "", create = false) {
    let handle = await open("/proc/self/fd/" + this.root.fd, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      for (const part of path ? parts(path) : []) {
        const next = "/proc/self/fd/" + handle.fd + "/" + part;
        if (create) await mkdir(next, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
        const child = await open(next, flags); await handle.close(); handle = child;
      }
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async parent(path, create, callback) {
    const names = parts(path), name = names.pop(), handle = await this.directory(names.join("/"), create);
    try { return await callback("/proc/self/fd/" + handle.fd + "/" + name); }
    finally { await handle.close(); }
  }
  async list(path = "") {
    const handle = await this.directory(path);
    try { return await readdir("/proc/self/fd/" + handle.fd, { withFileTypes: true }); }
    finally { await handle.close(); }
  }
  async read(path) {
    return this.parent(path, false, async target => {
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_JSON) throw new WorkspaceError("配置或记录必须是小于 1 MiB 的普通文件");
        return await file.readFile("utf8");
      } finally { await file.close(); }
    });
  }
  async json(path) { return JSON.parse(await this.read(path)); }
  async write(path, content, replace = false) {
    return this.parent(path, true, async target => {
      const temporary = target + ".tmp-" + randomUUID();
      const file = await open(replace ? temporary : target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(content); await file.sync(); }
      finally { await file.close(); }
      if (replace) try { await rename(temporary, target); } finally { await unlink(temporary).catch(e => { if (e.code !== "ENOENT") throw e; }); }
    });
  }
  async save(path, data, replace = false) { await this.write(path, JSON.stringify(data, null, 2) + "\n", replace); }
  async lock(path, action) {
    return this.parent(path, true, async target => {
      try { await mkdir(target, { mode: 0o700 }); }
      catch (error) { if (error.code === "EEXIST") throw new WorkspaceError("该项目正在更新，请稍后重试", 409); throw error; }
      try { return await action(); } finally { await rmdir(target); }
    });
  }
  async copy(source, destination, budget) {
    return this.parent(source, false, async target => {
      const input = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await input.stat();
        if (!before.isFile() || before.size > budget) throw new WorkspaceError("输入必须是普通文件，单次快照总量上限为 2 GiB");
        return await this.parent(destination, true, async output => {
          const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let size = 0;
          try {
            while (true) {
              const { bytesRead } = await input.read(buffer);
              if (!bytesRead) break;
              size += bytesRead; if (size > budget) throw new WorkspaceError("输入快照超过 2 GiB");
              const chunk = buffer.subarray(0, bytesRead); digest.update(chunk); await file.writeFile(chunk);
            }
            await file.sync();
          } finally { await file.close(); }
          const after = await input.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new WorkspaceError("输入文件正在变化，请停止修改后重试", 409);
          return { source, snapshot: destination, size, sha256: digest.digest("hex") };
        });
      } finally { await input.close(); }
    });
  }
}
async function managed(files) {
  try {
    const marker = await files.json(".logos/project.json");
    if (marker.schemaVersion !== 1 || marker.layout !== "logos") throw new WorkspaceError("不支持的项目布局版本");
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function study(files, id) {
  identifier(id); const raw = await files.read("studies/" + id + "/study.json");
  return { config: validate(JSON.parse(raw), id), revision: hash(raw) };
}
async function createStudy(files, id, name) {
  identifier(id); const config = validate(template(id, name), id);
  const path = "studies/" + id + "/study.json";
  try { await files.save(path, config); }
  catch (error) { if (error.code === "EEXIST") throw new WorkspaceError("方案已存在", 409); throw error; }
  return study(files, id);
}
async function overview(files) {
  if (!await managed(files)) return { managed: false, studies: [] };
  const studies = [], errors = [];
  let entries;
  try { entries = await files.list("studies"); } catch (e) { if (e.code !== "ENOENT") throw e; entries = []; }
  for (const entry of entries.filter(e => e.isDirectory() && !e.name.startsWith(".")).slice(0, 100)) {
    try {
      const info = await study(files, entry.name), runs = [];
      let records;
      try { records = await files.list("studies/" + entry.name + "/runs"); } catch (e) { if (e.code !== "ENOENT") throw e; records = []; }
      for (const run of records.filter(e => e.isDirectory() && !e.name.startsWith(".")).sort((a,b)=>b.name.localeCompare(a.name)).slice(0,100)) {
        try { runs.push(await files.json("studies/" + entry.name + "/runs/" + run.name + "/manifest.json")); }
        catch { errors.push(entry.name + "/" + run.name + ": 运行记录无法读取"); }
      }
      studies.push({ ...info, runs });
    } catch (error) { errors.push(entry.name + ": " + error.message); }
  }
  return { managed: true, studies, errors };
}
async function prepare(files, id) {
  const { config, revision } = await study(files, id);
  if (!config.solver.name.trim() || !Object.keys(config.physics).length) throw new WorkspaceError("请先填写物理问题和求解器；准备运行不会启动求解器");
  const runId = new Date().toISOString().replace(/[^0-9]/g,"").slice(0,17) + "-" + randomUUID().slice(0,8);
  const path = "studies/" + id + "/runs/" + runId;
  const record = { schemaVersion: 1, id: runId, study: id, status: "prepared", created: new Date().toISOString(), path,
    studyRevision: revision, inputs: [], acceptance: "not_evaluated", command: null, software: null };
  try {
    await files.save(path + "/inputs/study.json", config);
    record.inputs.push({ source: "studies/" + id + "/study.json", snapshot: path + "/inputs/study.json", sha256: hash(JSON.stringify(config, null, 2) + "\n") });
    let bytes = 0;
    for (const source of new Set([...config.inputs, config.model, config.mesh].filter(Boolean))) {
      const input = await files.copy(source, path + "/inputs/" + source, MAX_SNAPSHOT - bytes); bytes += input.size; record.inputs.push(input);
    }
    for (const name of ["logs", "results"]) { const handle = await files.directory(path + "/" + name, true); await handle.close(); }
    await files.save(path + "/manifest.json", record);
    return record;
  } catch (error) {
    await files.save(path + "/manifest.json", { ...record, status: "preparation_failed", error: error.message });
    throw error;
  }
}
async function updateRun(files, request) {
  const id = identifier(request.study), run = identifier(request.run);
  const base = "studies/" + id + "/runs/" + run;
  return files.lock(base + "/.update-lock", async () => {
    const record = await files.json(base + "/manifest.json");
    if (record.id !== run || record.study !== id || record.path !== base) throw new WorkspaceError("运行记录路径不匹配");
    const next = request.status;
    if (!statuses.includes(next) || !["prepared","running"].includes(record.status) || (record.status === "prepared" && !["running","cancelled"].includes(next)) || (record.status === "running" && !["completed","failed","cancelled","interrupted"].includes(next))) throw new WorkspaceError("运行状态转换无效；重试请新建运行记录",409);
    if (next === "running" && (!Array.isArray(request.command) || !request.command.length || request.command.some(v => typeof v !== "string"))) throw new WorkspaceError("开始运行必须记录真实命令");
    record.status = next;
    if (next === "running") { record.started = new Date().toISOString(); record.taskId = process.env.LOGOS_TASK_ID ?? null; record.command = request.command; record.software = request.software ?? null; }
    else { record.finished = new Date().toISOString(); record.note = typeof request.note === "string" ? request.note.slice(0,4000) : ""; }
    await files.save(base + "/manifest.json",record,true);
    return record;
  });
}

/** Shared by the web API and project_workspace Agent tool; no solver is launched. */
export async function projectWorkspace(root, request) {
  if (process.platform !== "linux") throw new WorkspaceError("此服务器项目管理功能需要 Linux");
  const owned = typeof root === "string", handle = owned ? await open(root, flags) : root;
  const files = new Files(handle);
  try {
    if (request.action === "list") return await overview(files);
    if (request.action === "initialize") {
      if (await managed(files)) return await overview(files);
      if ((await files.list()).length) throw new WorkspaceError("只初始化空目录；已有项目保留原目录结构",409);
      await files.write("project.md", "# " + (request.name || "新项目") + "\n\n## 目标\n\n待补充。\n\n## 约束和验收标准\n\n待补充。\n");
      await createStudy(files,"baseline","默认方案");
      await files.save(".logos/project.json",{ schemaVersion:1,layout:"logos",created:new Date().toISOString() });
      return await overview(files);
    }
    if (!await managed(files)) throw new WorkspaceError("当前是已有文件项目，尚未采用 LOGOS 项目布局",409);
    if (request.action === "create_study") return await createStudy(files,request.study,request.name);
    if (request.action === "save_study") {
      const id = identifier(request.study); validate(request.config,id);
      if (Buffer.byteLength(JSON.stringify(request.config)) > MAX_JSON) throw new WorkspaceError("方案配置过大");
      return await files.lock("studies/" + id + "/.update-lock",async () => {
        const current = await study(files,id);
        if (current.revision !== request.revision) throw new WorkspaceError("方案已被修改，请重新加载后保存",409);
        await files.save("studies/" + id + "/study.json",request.config,true);
        return study(files,id);
      });
    }
    if (request.action === "prepare_run") return await prepare(files,identifier(request.study));
    if (request.action === "update_run") return await updateRun(files,request);
    if (request.action === "record_operation") {
      const id = identifier(request.study), run = identifier(request.run), result = request.result;
      const base = "studies/" + id + "/runs/" + run;
      if (!object(result)) throw new WorkspaceError("缺少执行结果");
      await files.write(base + "/logs/stdout.txt", String(result.stdout ?? ""));
      await files.write(base + "/logs/stderr.txt", String(result.stderr ?? ""));
      await files.save(base + "/logs/operation.json", result);
      const status = result.error?.type === "Cancelled" ? "cancelled" : result.error?.type === "Timeout" ? "interrupted"
        : result.exit_code !== 0 || !result.transport_ok || result.script_ok === false || result.error ? "failed" : "completed";
      return await updateRun(files, { study:id,run,status,note:"Execution evidence saved in logs/operation.json; scientific acceptance has not been evaluated." });
    }
    if (request.action === "create_folder") {
      if (!["assets","models","meshes","reports"].includes(request.name)) throw new WorkspaceError("不支持的项目分类");
      const dir = await files.directory(request.name,true); await dir.close(); return { path:request.name };
    }
    throw new WorkspaceError("不支持的项目操作");
  } finally { if (owned) await handle.close(); }
}
