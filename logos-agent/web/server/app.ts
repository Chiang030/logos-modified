import { projectWorkspace, WorkspaceError } from "../../pi-domain/src/workspace.mjs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Store, LOGIN_MAX_AGE_SECONDS } from "./store.ts";
import { WorkspaceFiles, segments } from "./files.ts";
import { beginLogin, completeLogin, cookie, cookies, equal, ready, identityName, type Config } from "./auth.ts";
import { HttpError, text } from "./errors.ts";
import { body, failure, json, sendFile } from "./http.ts";

import { Models } from "./models.ts";
import { Jobs } from "./jobs.ts";
import { Meter } from "./usage.ts";
import { control, prompt, type Control } from "./control.ts";
import { Software } from "./software.ts";
import { asset } from "./assets.ts";
import { CadPreview } from "./cad-preview.ts";
import { Feedback, feedbackRoute } from "./feedback.ts";
import { Demos, demoRoute } from "./demos.ts";

const productVersion: string = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version;

export interface Services { config: Config; store: Store; files: WorkspaceFiles; assets: string; }
export function createHandler(services: Services): (req: IncomingMessage, res: ServerResponse) => void {
  const software = new Software(services.config.data);
  const resources = { ...services, models: new Models(services.store, join(services.config.data,"state")), jobs: new Jobs(services.store), meter: new Meter(services.store), software, cad: new CadPreview(services.config.data, undefined, software), feedback: new Feedback(services.store), demos: new Demos() };
  return (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; frame-src 'self' blob:; connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    void route(resources, request, response).catch((error: unknown) => failure(response, error));
  };
}
async function route(s: Services & Control & { cad: CadPreview; feedback: Feedback; demos: Demos }, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config, store } = s;
  if (req.headers.host !== new URL(config.publicUrl).host) throw new HttpError(421, "访问地址不匹配");
  const url = new URL(req.url ?? "/", config.publicUrl), method = req.method ?? "GET";
  if (url.pathname === "/api/bootstrap" && method === "GET") {
    let identity: ReturnType<Store["authenticate"]> | undefined;
    try { identity = store.refreshLogin(cookies(req).logos_session); res.setHeader("Set-Cookie", cookie(config, "logos_session", cookies(req).logos_session!, LOGIN_MAX_AGE_SECONDS)); } catch (error) { if (!(error instanceof HttpError) || error.status !== 401) throw error; }
    json(res, { user: identity?.user ?? null, csrf: identity?.csrf, feishuReady: ready(config), identityLabel: identityName(config), previewEnabled: config.preview,
      version: productVersion, executionReady: s.jobs.health().ready, executionReason: s.jobs.health().reason });
    return;
  }
  if (url.pathname === "/auth/feishu" && method === "GET") {
    const login = beginLogin(config, store); res.writeHead(302, { Location: login.location, "Set-Cookie": login.cookie, "Cache-Control": "no-store" }); res.end(); return;
  }
  if (url.pathname === "/auth/feishu/callback" && method === "GET") {
    if (!ready(config)) throw new HttpError(503, identityName(config) + "应用尚未配置");
    const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
    if (!state || !equal(state, cookies(req).logos_oauth ?? "") || !store.consumeState(state) || !code) throw new HttpError(400, "登录请求已过期，请重新登录");
    const user = await completeLogin(config, store, code), session = store.login(user);
    res.writeHead(302, { Location: "/", "Set-Cookie": [cookie(config, "logos_session", session.token, LOGIN_MAX_AGE_SECONDS), cookie(config, "logos_oauth", "", 0)], "Cache-Control": "no-store" }); res.end(); return;
  }
  if (url.pathname === "/favicon.ico" && method === "GET") { res.writeHead(204); res.end(); return; }
  if (!url.pathname.startsWith("/api/")) { await asset(s.assets, url.pathname, req, res); return; }
  const auth = store.authenticate(cookies(req).logos_session);
  if (method !== "GET" && (req.headers.origin !== config.publicUrl || !equal(String(req.headers["x-csrf-token"] ?? ""), auth.csrf))) throw new HttpError(403, "请求验证失败，请刷新后重试");
  if (url.pathname === "/api/logout" && method === "POST") {
    store.logout(cookies(req).logos_session ?? ""); res.setHeader("Set-Cookie", cookie(config, "logos_session", "", 0)); json(res, { ok: true }); return;
  }
  if (url.pathname === "/api/workspace" && ["GET", "POST"].includes(method)) {
    const input = method === "GET" ? { project: url.searchParams.get("project"), action: "list" } : await body(req);
    const project = store.project(auth.user.id, text(input.project, "项目"));
    const handle = await s.files.directory(auth.user.id, project.directory);
    try { json(res, await projectWorkspace(handle, input)); }
    catch (error) { if (error instanceof WorkspaceError) throw new HttpError(error.status, error.message); throw error; }
    finally { await handle.close(); }
    return;
  }
  if (await demoRoute(s.demos,store,s.files,auth.user,url,req,res)) return;
  if (await feedbackRoute(s.feedback,auth.user,url,req,res)) return;
  if (await control(s,auth.user,url,req,res)) return;
  if (url.pathname === "/api/projects" && method === "GET") { json(res, { projects: store.projects(auth.user.id).map(project=>({...project,absolutePath:join(config.data,"users",auth.user.id,"workspace",project.directory)})) }); return; }
  if (url.pathname === "/api/projects" && method === "POST") {
    const input = await body(req), directory = text(input.directory, "目录", 2048);
    const handle = await s.files.directory(auth.user.id, directory); await handle.close();
    const existing = store.projects(auth.user.id).some(p => p.directory === directory);
    const project=store.createProject(auth.user.id,text(input.name,"项目名称",80),directory);
    if (!existing && !(await s.files.list(auth.user.id, directory)).length) {
      const root = await s.files.directory(auth.user.id, directory);
      try { await projectWorkspace(root, { action: "initialize", name: project.name }); }
      finally { await root.close(); }
    }
    json(res,{project:{...project,absolutePath:join(config.data,"users",auth.user.id,"workspace",project.directory)}},201); return;
  }
  if (url.pathname === "/api/files" && method === "GET") { json(res, { entries: await s.files.list(auth.user.id, scopedPath(s, auth.user.id, url)) }); return; }
  if (url.pathname === "/api/folders" && method === "POST") {
    const input = await body(req);
    await s.files.folder(auth.user.id, text(input.path, "目录", 2048)); json(res, { ok: true }, 201); return;
  }
  if (url.pathname === "/api/upload" && method === "PUT") {
    const length = req.headers["content-length"];
    if (length && Number(length) > config.uploadLimit) throw new HttpError(413, "文件超过上传大小限制");
    await s.files.upload(auth.user.id, scopedPath(s, auth.user.id, url), req, config.uploadLimit); json(res, { ok: true }, 201); return;
  }
  if (url.pathname === "/api/file" && method === "GET") {
    const path = scopedPath(s, auth.user.id, url), handle = await s.files.read(auth.user.id, path);
    await sendFile(req, res, handle, path, url.searchParams.has("download")); return;
  }
  if (url.pathname === "/api/cad-preview" && method === "POST") {
    const input = await body(req), project = store.project(auth.user.id, text(input.project, "项目"));
    const path = text(input.path, "文件路径", 2048); segments(path);
    const handle = await s.files.read(auth.user.id, project.directory + "/" + path);
    const controller = new AbortController(), abort = (): void => { if (!res.writableEnded) controller.abort(); };
    res.once("close", abort);
    if (res.destroyed) controller.abort();
    const deadline = setTimeout(() => controller.abort(), 65_000);
    try {
      const result = await s.cad.render(auth.user.id, handle, path, controller.signal);
      res.writeHead(200, { "Content-Type": "model/stl", "Content-Length": result.length, "Cache-Control": "no-store" }); res.end(result);
    } finally { clearTimeout(deadline); res.off("close", abort); await handle.close(); }
    return;
  }
  if (url.pathname === "/api/preview" && method === "GET") {
    const handle = await s.files.read(auth.user.id, scopedPath(s, auth.user.id, url));
    try {
      const size = (await handle.stat()).size, buffer = Buffer.alloc(Math.min(size, 512 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).includes(0)) throw new HttpError(415, "二进制文件请下载后打开");
      json(res, { text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: size > buffer.length, size });
    } finally { await handle.close(); }
    return;
  }
  if (url.pathname === "/api/sessions" && method === "GET") { json(res, { sessions: store.sessions(auth.user.id, url.searchParams.get("project") ?? "") }); return; }
  if (url.pathname === "/api/sessions" && method === "POST") {
    const input = await body(req); json(res, { session: store.createSession(auth.user.id, text(input.project, "项目")) }, 201); return;
  }
  if (url.pathname === "/api/bridge" && method === "POST") {
    const input = await body(req, 12 * 1024 * 1024), project = store.project(auth.user.id, text(input.project, "项目"));
    const command = input.command as Record<string, unknown> | undefined;
    if (!command || typeof command.type !== "string") throw new HttpError(400, "命令无效");
    if (command.type === "session/rename") {
      const session = store.session(auth.user.id, text(command.sessionId, "会话"));
      if (session.project !== project.id) throw new HttpError(404, "会话不存在");
      store.renameSession(auth.user.id, session.id, text(command.title, "会话标题", 100));
      json(res, { ok: true }); return;
    }
    if (command.type === "chat/send") {
      if (!s.jobs.health().ready) throw new HttpError(503,s.jobs.health().reason);
      const connection=s.models.get(text(command.connection,"模型连接"));
      const thinking=typeof command.thinking==="string"?command.thinking:"off";
      if (!["off","minimal","low","medium","high"].includes(thinking) || (!connection.reasoning && thinking!=="off")) throw new HttpError(400,"思考档位无效");
      const run=s.jobs.submit(auth.user.id,project.id,text(command.session,"会话"),connection,text(command.model,"模型"),prompt((typeof command.text === "string" && command.text.trim()) || (Array.isArray(command.images) && command.images.length ? "请分析所附图片。" : command.text)),text(command.requestKey,"提交标识",80),thinking,command.images);
      const { images: _images, ...summary } = run;
      json(res,{run:summary},202);return;
    }
    throw new HttpError(400, "此操作尚未启用");
  }
  throw new HttpError(404, "接口不存在");
}
function scopedPath(s: Services, user: string, url: URL): string {
  const path = url.searchParams.get("path") ?? ""; segments(path);
  const project = url.searchParams.get("project");
  return project ? [s.store.project(user, project).directory, path].filter(Boolean).join("/") : path;
}
