import { StudyPanel, fileLabel, type WorkspaceOverview } from "./workspace";
import { lazy, StrictMode, Suspense, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../vscode-extension/webview-ui/src/App";
import logo from "../../vscode-extension/resources/logos_full_restored_transparent.png";
import { BrowserBridge } from "./bridge";
import { installClipboardFallback } from "./browser";
import { previewKind } from "./preview-kind";
import { CadPreview } from "./cad-preview";
import { FileDownload } from "./file-download";
import { FeedbackPanel, HomeLeaderboards } from "./feedback";
import { DemoGallery } from "./demos";
import { AdminPanel } from "./admin";
import { SoftwareDialog } from "./software";
import { api, query, setCsrf, upload, type Bootstrap, type Entry, type Project, type Conversation } from "./api";

installClipboardFallback();
const ModelPreview = lazy(() => import("./model-preview").catch(() => ({ default: () => <div className="empty-note" role="alert">无法加载 3D 查看器，请刷新页面重试或下载文件。</div> })));
const demoProject: Project = { id: "preview-project", name: "机翼设计 · 示例项目", directory: "wing-study" };
const demoFiles: Entry[] = [
  { name: "geometry", directory: true, size: 0, modified: 0 },
  { name: "case.json", directory: false, size: 112, modified: 0 },
  { name: "notes.md", directory: false, size: 182, modified: 0 },
];
const demoText: Record<string, string> = {
  "case.json": JSON.stringify({ name: "机翼设计示例", status: "not-run", geometry: "geometry/wing.step", notes: "仅展示项目结构，未执行仿真" }, null, 2),
  "notes.md": "# 项目记录\n\n这是用于检查工作台布局的示例文件。\n\n- 左侧浏览项目资料\n- 中间复用 LOGOS 插件聊天界面\n- 右侧查看文件内容\n\n此预览没有连接模型，也没有运行仿真。",
};

function message(error: unknown): string { return error instanceof Error ? error.message : "操作失败"; }
function bytes(value: number): string { return value < 1024 ? value + " B" : value < 1048576 ? (value / 1024).toFixed(1) + " KB" : (value / 1048576).toFixed(1) + " MB"; }
function parent(path: string): string { return path.split("/").slice(0, -1).join("/"); }

function Workspace(): ReactElement {
  const [boot, setBoot] = useState<Bootstrap>(), [fatal, setFatal] = useState("");
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    void api<Bootstrap>("/api/bootstrap").then((value) => { setCsrf(value.csrf ?? ""); setBoot(value); setPreview(value.previewEnabled && new URLSearchParams(location.search).has("preview")); }).catch((error) => setFatal(message(error)));
  }, []);
  if (fatal) return <div className="welcome"><h1>暂时无法连接工作台</h1><p role="alert">{fatal}</p><button onClick={() => location.reload()}>重新连接</button></div>;
  if (!boot) return <div className="welcome"><p>正在连接 LOGOS…</p></div>;
  if (!boot.user && !preview) return <div className="login-page">
    <div className="login-brand"><img src={logo} alt="LOGOS" /><span>设计 · 仿真 · 工作空间</span></div>
    <div className="login-card"><div className="eyebrow">LOGOS WORKSPACE</div><h1>从一个项目开始。</h1><p>整理资料、探索方案，并在同一工作台中查看文件与对话。</p>
      {boot.feishuReady ? <a className="primary button" href="/auth/feishu">使用 {boot.identityLabel ?? "飞书"} 登录 →</a> : <><button className="primary" disabled>使用 {boot.identityLabel ?? "飞书"} 登录</button><p className="hint">{boot.identityLabel ?? "飞书"} 企业应用尚未配置，正式登录暂未开放。</p></>}
      <p className="hint">登录状态保留 30 天，再次打开工作台时自动续期；公共设备使用后请退出。</p>
      {boot.previewEnabled ? <button className="secondary" onClick={() => { history.replaceState(null, "", "/?preview=1"); setPreview(true); }}>查看只读界面预览</button> : null}
      <div className="login-foot">个人文件空间 · 项目会话 · 内网工作台</div>
    </div><div className="login-orbit" aria-hidden="true" />
  </div>;
  return <Workbench boot={boot} preview={preview} />;
}

function Workbench({ boot, preview }: { boot: Bootstrap; preview: boolean }): ReactElement {
  const user = useMemo(() => boot.user ?? { id: "preview", name: "界面预览", admin: false }, [boot.user]);
  const [projects, setProjects] = useState<Project[]>(preview ? [demoProject] : []);
  const [project, setProject] = useState<Project | undefined>(preview ? demoProject : undefined);
  const [fileLocation, setFileLocation] = useState<{ project: string; path: string; entries: Entry[] }>({ project: "", path: "", entries: [] });
  const [filesLoading, setFilesLoading] = useState(false), [filesLoaded, setFilesLoaded] = useState(false);
  const fileRequest = useRef(0), filePending = useRef(false);
  const folder = fileLocation.project === project?.id ? fileLocation.path : "";
  const entries = fileLocation.project === project?.id ? fileLocation.entries : [];
  const filesReady = filesLoaded && fileLocation.project === project?.id;
  const [tab, setTab] = useState("files"), [sessions, setSessions] = useState<Conversation[]>([]);
  const [overview, setOverview] = useState<WorkspaceOverview>(), [showInternal, setShowInternal] = useState(false), [organized, setOrganized] = useState(true);

  const [notice, setNotice] = useState(""), [selected, setSelected] = useState<string>();
  const [refresh, setRefresh] = useState(0), [picker, setPicker] = useState(false), [uploading, setUploading] = useState("");
  const [search, setSearch] = useState(""), [adminOpen, setAdminOpen] = useState(false), [feedbackOpen, setFeedbackOpen] = useState(false);
  const [softwareOpen,setSoftwareOpen]=useState<false|"load"|"scan">(false);
  useEffect(() => {
    let current = true;
    if (!project || preview) { setOverview(preview ? { managed:false,studies:[] } : undefined); return; }
    void api<WorkspaceOverview>("/api/workspace?project="+encodeURIComponent(project.id)).then(value=>{if(current)setOverview(value);}).catch(error=>{if(current)setNotice(message(error));});
    return ()=>{current=false;};
  }, [project, refresh, preview]);
  const fileInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const bridge = useMemo(() => project ? new BrowserBridge(project, user, preview, boot.version, setNotice, setSelected, () => setAdminOpen(true), () => setSoftwareOpen("scan")) : undefined, [project, user, preview, boot.version]);
  useEffect(() => { if (!preview) void api<{ projects: Project[] }>("/api/projects").then((r) => {
    setProjects(r.projects);
    setProject(current=>current??r.projects.find(p=>p.id===localStorage.getItem("logos-project-"+user.id)));
  }).catch((e) => setNotice(message(e))); }, [preview, refresh, user.id]);
  useEffect(() => {const update=():void=>setRefresh(n=>n+1);window.addEventListener("logos-files-refresh",update);return ()=>window.removeEventListener("logos-files-refresh",update);},[]);
  const loadFiles = async (target: Project, path: string): Promise<void> => {
    const request = ++fileRequest.current;
    filePending.current = true; setFilesLoading(true);
    try {
      const result = preview ? { entries: path ? [] : demoFiles }
        : await api<{ entries: Entry[] }>("/api/files?" + query(path, target.id));
      if (request !== fileRequest.current) return;
      // A breadcrumb and its entries must always describe the same successful read.
      setFileLocation({ project: target.id, path, entries: result.entries }); setFilesLoaded(true);
      setSearch("");
    } catch (error) {
      if (request !== fileRequest.current) return;
      setNotice(message(error));
      if (target.id === fileLocation.project && path === fileLocation.path) setFilesLoaded(false);
    } finally {
      if (request === fileRequest.current) { filePending.current = false; setFilesLoading(false); }
    }
  };
  useEffect(() => {
    if (project) void loadFiles(project, folder);
    return () => { fileRequest.current++; filePending.current = false; };
  }, [project, refresh, preview]);
  const navigateFiles = (path: string): void => {
    if (project && filesReady && !filePending.current) void loadFiles(project, path);
  };
  useEffect(() => {
    setSessions([]);
    return bridge?.subscribe((event) => {
      if (event.type === "session/list") setSessions(event.sessions.map((s) => ({ id: s.sessionId, title: s.title, project: project!.id })));
    });
  }, [bridge, project]);
  const select = (value: Project | undefined): void => { if (!preview) {if(value)localStorage.setItem("logos-project-"+user.id,value.id);else localStorage.removeItem("logos-project-"+user.id);} fileRequest.current++; filePending.current = false; setFilesLoaded(false); setFileLocation({ project: "", path: "", entries: [] }); if(value !== project)setOverview(undefined); setProject(value); if (value && value === project) void loadFiles(value, ""); setSelected(undefined); setNotice(""); setSearch(""); };
  const transfer = async (files: FileList | null): Promise<void> => {
    if (!files?.length || !project || preview || filePending.current || !filesReady) return;
    let completed = 0;
    try {
      for (const file of Array.from(files)) {
        setUploading("上传 " + (completed + 1) + "/" + files.length + " · " + file.name);
        await upload([project.directory, folder || (overview?.managed ? "assets" : ""), file.webkitRelativePath || file.name].filter(Boolean).join("/"), file);
        completed++;
      }
      setNotice("已上传 " + completed + " 个文件");
    } catch (error) { setNotice("已完成 " + completed + " 个文件；" + message(error)); }
    finally { setUploading(""); setRefresh((n) => n + 1); if (fileInput.current) fileInput.current.value = ""; if (folderInput.current) folderInput.current.value = ""; }
  };
  return <div className="web-shell">
    <header className="web-topbar"><button className="brand" aria-label="返回项目首页" onClick={() => select(undefined)}><img src={logo} alt="LOGOS" /></button>
      <span className="top-divider" /><span className="workspace-name">工作台</span><span className="crumb">/</span><strong>{project?.name ?? "我的项目"}</strong>
      <div className="top-right">{preview ? <span className="preview-badge">只读界面预览</span> : <span className="private-badge">个人空间</span>}
        {!preview ? <><button className="text-button" onClick={()=>setFeedbackOpen(true)}>问题 / 需求反馈</button><button className="text-button" onClick={()=>setSoftwareOpen("load")}>服务器工具</button></> : null}
        {user.admin && !preview ? <button className="text-button" onClick={()=>setAdminOpen(true)}>管理后台</button> : null}
        <span className="avatar">{user.name.slice(0, 1)}</span><span>{user.name}</span>
        <button className="text-button" onClick={() => { if (preview) { location.href = "/"; return; } void api("/api/logout", {}).then(() => { location.href = "/"; }).catch((e) => setNotice(message(e))); }}>退出</button>
      </div>
    </header>
    <div className="web-body">
      <aside className="explorer">
        <button className="open-folder" onClick={() => setPicker(true)}>＋ 打开文件夹 / 建立项目</button>
        <div className="section-label">我的项目 <span>{projects.length}</span></div>
        <div className="project-switcher">{projects.map((item) => <button key={item.id} className={project?.id === item.id ? "selected" : ""} onClick={() => select(item)}><span>◇</span><span>{item.name}</span></button>)}</div>
        {project ? <>
          <div className="explorer-tabs"><button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>文件</button><button className={tab === "studies" ? "active" : ""} onClick={() => setTab("studies")}>方案</button><button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>会话</button></div>
          {tab === "files" ? <>
            <div className="file-actions"><button title="上传文件" disabled={preview || Boolean(uploading) || filesLoading || !filesReady} onClick={() => fileInput.current?.click()}>↑ 文件</button><button title="上传文件夹" disabled={preview || Boolean(uploading) || filesLoading || !filesReady} onClick={() => folderInput.current?.click()}>↑ 文件夹</button><button title="刷新文件" aria-label="刷新文件" disabled={filesLoading} onClick={() => { filePending.current = true; setFilesLoading(true); setRefresh((n) => n + 1); }}>↻</button></div>
            <input hidden multiple type="file" ref={fileInput} onChange={(event) => void transfer(event.target.files)} />
            <input hidden multiple type="file" ref={folderInput} {...{ webkitdirectory: "" }} onChange={(event) => void transfer(event.target.files)} />
            <div className="file-view-options"><label><input type="checkbox" checked={showInternal} onChange={e=>setShowInternal(e.target.checked)}/>显示内部文件</label>{overview?.managed?<label><input type="checkbox" checked={organized} onChange={e=>setOrganized(e.target.checked)}/>中文分类</label>:null}</div>
            {overview?.managed && !folder ? <div className="asset-actions">{["assets","models","meshes","reports"].filter(name=>!entries.some(e=>e.name===name)).map(name=><button key={name} disabled={filesLoading || !filesReady || preview} onClick={()=>void api("/api/workspace",{project:project.id,action:"create_folder",name}).then(()=>setRefresh(n=>n+1)).catch(e=>setNotice(message(e)))}>＋{fileLabel("",name)}</button>)}</div>:null}
            <input className="file-search" aria-label="筛选当前目录文件" placeholder="查找当前目录文件…" value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="file-location"><button disabled={!folder || filesLoading || !filesReady} title="上一级" onClick={() => navigateFiles(parent(folder))}>←</button><span title={folder}>{folder || project.directory}</span></div>
            <div className="file-list" aria-busy={filesLoading}>{filesLoading ? <div className="empty-note" role="status">正在读取文件夹…</div> : !filesReady ? <div className="empty-note">目录尚未读取成功，请点击刷新重试。</div> : entries.filter((entry) => (showInternal || !entry.name.startsWith(".")) && (entry.name+" "+(overview?.managed ? fileLabel(folder,entry.name) : "")).toLowerCase().includes(search.toLowerCase())).map((entry) => <button key={entry.name} className={selected === [folder, entry.name].filter(Boolean).join("/") ? "selected" : ""} onClick={() => {
              if (filePending.current || !filesReady) return;
              const path = [folder, entry.name].filter(Boolean).join("/");
              if (entry.directory) navigateFiles(path); else setSelected(path);
            }}><span className={entry.directory ? "folder-icon" : "document-icon"}>{entry.directory ? "▸" : "≡"}</span><span title={entry.name}>{overview?.managed && organized ? fileLabel(folder,entry.name) : entry.name}</span><small>{entry.directory ? "" : bytes(entry.size)}</small></button>)}
              {!filesLoading && filesReady && !entries.some(e=>showInternal || !e.name.startsWith(".")) ? <div className="empty-note">此目录暂无可见文件<br />上传资料后即可在这里查看。</div> : null}</div>
          </> : tab === "studies" ? <StudyPanel key={project.id} project={project} overview={overview} refresh={()=>setRefresh(n=>n+1)} notice={setNotice} browse={(path,file)=>{if(file)setSelected(path);else{setTab("files");navigateFiles(path);}}}/> : <div className="session-list-web"><button className="new-session-button" onClick={() => bridge?.postMessage({ type: "session/new" })}>＋ 新建会话</button>{sessions.map((item) => <button key={item.id} onClick={() => bridge?.postMessage({ type: "session/select", sessionId: item.id })}>{item.title}</button>)}{!sessions.length ? <p className="empty-note">尚无历史会话</p> : null}</div>}
        </> : <div className="empty-note">先选择个人文件夹，再建立项目。<br />每个项目独立保存会话。</div>}
        <div className="explorer-footer"><span className="status-dot" />{preview ? "示例资料 · 不保存操作" : "文件列表 · 按登录账号显示"}</div>
      </aside>
      <section className="main-workspace">
        {preview ? <div className="stage-banner">界面预览：示例资料不属于真实账号，上传与模型调用未启用。</div> : <div className="stage-banner">{boot.executionReady ? "模型由管理员统一配置，用量按你的账号记录。全站最多同时运行 5 个任务。" : boot.executionReason}</div>}
        {notice || uploading ? <div className="notice" role="status"><span>{uploading || notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div> : null}
        {project && bridge ? <div className="workbench-panels"><div className="chat-panel"><App key={project.id} host={bridge} web /></div>{selected ? <FilePreview key={project.id + ":" + selected + ":" + refresh} path={selected} project={project} preview={preview} bridge={bridge} close={() => setSelected(undefined)} reference={() => {
          void navigator.clipboard.writeText(selected).then(() => setNotice("已复制项目相对路径，可粘贴到对话中引用")).catch(() => setNotice("请复制文件标签中的相对路径"));
        }} /> : null}</div> : <div className="project-home"><div className="eyebrow">YOUR WORKSPACE</div><h1>让设计与仿真，<br /><span>从这里开始。</span></h1><p>选择自己的文件夹，整理资料，建立项目。<br />项目文件和对话会保存在服务器个人空间中。</p><button className="primary" onClick={() => setPicker(true)}>打开文件夹 →</button><div className="home-projects">{projects.map((item) => <button key={item.id} onClick={() => select(item)}><span>◇</span><strong>{item.name}</strong><small>{item.directory}</small></button>)}</div>{!preview ? <><DemoGallery open={value=>{select(value);setRefresh(n=>n+1);}} /><HomeLeaderboards /></> : null}</div>}
      </section>
    </div>
    {feedbackOpen && !preview ? <div className="admin-shade"><section className="admin-panel" role="dialog" aria-modal="true" aria-label="问题与需求反馈"><header><h1>LOGOS 反馈</h1><button aria-label="关闭反馈" onClick={()=>setFeedbackOpen(false)}>×</button></header><FeedbackPanel user={user} projectId={project?.id} sessionId={bridge?.active} /></section></div> : null}
    {softwareOpen ? <SoftwareDialog scan={softwareOpen==="scan"} close={()=>setSoftwareOpen(false)} /> : null}
    {adminOpen && user.admin ? <AdminPanel close={()=>{setAdminOpen(false);void bridge?.catalog();}} /> : null}
    {picker ? <FolderPicker preview={preview} onClose={() => setPicker(false)} onSelect={(value) => { select(value); setPicker(false); setRefresh((n) => n + 1); }} /> : null}
  </div>;
}

function FolderPicker({ preview, onClose, onSelect }: { preview: boolean; onClose: () => void; onSelect: (project: Project) => void }): ReactElement {
  const [{ path, entries }, setLocation] = useState<{ path: string; entries: Entry[] }>({ path: "", entries: [] });
  const [name, setName] = useState(""), [projectName, setProjectName] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false);
  const request = useRef(0), pending = useRef(false);
  const load = async (nextPath: string): Promise<void> => {
    const current = ++request.current;
    pending.current = true; setLoading(true); setError("");
    try {
      const result = preview
        ? { entries: nextPath === "" ? [{ name: "wing-study", directory: true, size: 0, modified: 0 }] : nextPath === "wing-study" ? demoFiles : [] }
        : await api<{ entries: Entry[] }>("/api/files?" + query(nextPath));
      if (current !== request.current) return;
      // Commit the breadcrumb and its contents together, only after a successful read.
      setLocation({ path: nextPath, entries: result.entries }); setLoaded(true);
      if (nextPath !== path) setProjectName("");
    } catch (e) {
      if (current === request.current) { setError(message(e)); if (nextPath === path) setLoaded(false); }
    } finally {
      if (current === request.current) { pending.current = false; setLoading(false); }
    }
  };
  useEffect(() => { void load(""); return () => { request.current++; }; }, [preview]);
  const navigate = (nextPath: string): void => { if (!pending.current && !busy) void load(nextPath); };
  const create = async (): Promise<void> => {
    if (pending.current || busy || !loaded) return;
    setBusy(true); setError("");
    try { await api("/api/folders", { path: [path, name].filter(Boolean).join("/") }); setName(""); await load(path); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const choose = async (): Promise<void> => {
    if (pending.current || busy || !loaded || !path) return;
    if (preview) { onSelect(demoProject); return; }
    setBusy(true); setError("");
    try { const r = await api<{ project: Project }>("/api/projects", { name: projectName.trim() || path.split("/").at(-1), directory: path }); onSelect(r.project); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <div className="modal-shade"><section className="folder-dialog" role="dialog" aria-modal="true" aria-label="打开文件夹">
    <header><div><h2>打开文件夹</h2><p>选择个人空间内的目录，建立或打开项目。</p></div><button aria-label="关闭文件夹选择" onClick={onClose}>×</button></header>
    <div className="folder-path"><button disabled={!path || busy || loading} onClick={() => navigate(parent(path))}>← 上一级</button><span>我的空间 / {path}</span></div>
    <div className="folder-picker-list" aria-busy={loading}>
      {loading ? <p className="empty-note" role="status">正在读取文件夹…</p> : entries.filter((e) => e.directory).map((e) => <button key={e.name} disabled={busy || !loaded} onClick={() => navigate([path, e.name].filter(Boolean).join("/"))}>▸ {e.name}<span>打开 →</span></button>)}
      {!loading && loaded && !entries.some((e) => e.directory) ? <p className="empty-note">没有子文件夹，可使用当前目录。</p> : null}
    </div>
    <form className="new-folder-form" onSubmit={(e) => { e.preventDefault(); void create(); }}><input aria-label="新文件夹名称" placeholder="新文件夹名称" value={name} onChange={(e) => setName(e.target.value)} /><button disabled={preview || busy || loading || !loaded || !name.trim()}>新建文件夹</button></form>
    <label className="project-name">项目名称<input aria-label="项目名称" placeholder={path.split("/").at(-1) || "先选择一个文件夹"} value={projectName} onChange={(e) => setProjectName(e.target.value)} /></label>
    {error ? <div className="dialog-error"><p role="alert">{error}</p><button disabled={busy || loading} onClick={() => navigate(path)}>重新读取当前目录</button></div> : null}
    <footer><span>个人空间根目录不能直接注册为项目</span><button className="primary" disabled={!path || busy || loading || !loaded} onClick={() => void choose()}>{busy ? "处理中…" : "以此文件夹打开项目"}</button></footer>
  </section></div>;
}

function FilePreview({ path, project, preview, bridge, close, reference }: { path: string; project: Project; preview: boolean; bridge: BrowserBridge; close: () => void; reference: () => void }): ReactElement {
  const attachment = useRef<AbortController | undefined>(undefined);
  const [attaching, setAttaching] = useState(false);
  useEffect(() => {
    const cancel = (): void => { attachment.current?.abort(); attachment.current = undefined; setAttaching(false); };
    const changing = (event: Event): void => { if ((event as CustomEvent<{host?:unknown}>).detail?.host === bridge) cancel(); };
    window.addEventListener("logos-session-changing", changing);
    return () => { attachment.current?.abort(); attachment.current = undefined; window.removeEventListener("logos-session-changing", changing); };
  }, [bridge, path]);
  const [text, setText] = useState(""), [error, setError] = useState(""), [truncated, setTruncated] = useState(false), [loading, setLoading] = useState(true);
  const kind = previewKind(path);
  const url = "/api/file?" + query(path, project.id);
  const attachImage = async (): Promise<void> => {
    attachment.current?.abort();
    const controller = new AbortController(), session = bridge.active;
    attachment.current = controller; setAttaching(true);
    try {
      const response = await fetch(url, { credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error("图片读取失败，请刷新后重试");
      if (Number(response.headers.get("content-length")) > 4 * 1024 * 1024) { await response.body?.cancel(); throw new Error("视觉附件单张不能超过 4 MiB"); }
      const blob = await response.blob();
      if (controller.signal.aborted || attachment.current !== controller || bridge.active !== session) return;
      if (blob.size > 4 * 1024 * 1024) throw new Error("视觉附件单张不能超过 4 MiB");
      window.dispatchEvent(new CustomEvent("logos-attach-image", { detail: { host: bridge, file: new File([blob], path.split("/").at(-1) ?? "image.png", { type: blob.type }) } }));
    } catch (cause) { if (!controller.signal.aborted) setError(message(cause)); }
    finally { if (attachment.current === controller) { attachment.current = undefined; setAttaching(false); } }
  };
  useEffect(() => {
    let current = true;
    if (preview) { setText(demoText[path] ?? "这是示例文件，尚无内容。"); setLoading(false); return; }
    if (kind !== "text") { setLoading(false); return; }
    void api<{ text: string; truncated: boolean }>("/api/preview?" + query(path, project.id)).then((r) => {
      if (current) { setText(r.text); setTruncated(r.truncated); }
    }).catch((e) => { if (current) setError(message(e)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [path, project.id, preview, kind]);
  return <aside className="preview-panel" aria-label="文件预览">
    <header><div><span className="document-icon">≡</span><strong title={path}>{path.split("/").at(-1)}</strong></div><button aria-label="关闭文件预览" onClick={close}>×</button></header>
    <div className="preview-toolbar"><span title={path}>{path}</span><button onClick={reference}>引用路径</button>{!preview ? <FileDownload project={project.id} path={path} /> : null}{!preview && kind === "image" ? <button disabled={attaching} onClick={() => void attachImage()}>{attaching ? "正在添加图片…" : "添加到对话"}</button> : null}</div>
    {truncated ? <div className="preview-hint">只显示前 512 KB，完整内容请下载查看。</div> : null}
    {error ? <div className="empty-note" role="alert">{error}</div> : loading ? <div className="empty-note">正在读取文件…</div> : !preview && kind === "image" ? <div className="image-preview"><img src={url} alt={path} /></div> : !preview && kind === "pdf" ? <iframe className="pdf-preview" title={path} src={url} /> : !preview && (kind === "video" || kind === "audio") ? <MediaPreview kind={kind} url={url} path={path} /> : !preview && kind === "model" ? <Suspense fallback={<div className="empty-note" role="status">正在加载 3D 查看器…</div>}><ModelPreview path={path} project={project.id} /></Suspense> : !preview && /\.(step|stp)$/i.test(path) ? <CadPreview project={project.id} path={path} /> : !preview && kind === "cad" ? <div className="empty-note">此格式暂不支持直接预览。请将 CAD/网格导出为 STL、OBJ、PLY 或 GLB 后查看，也可以下载原文件。</div> : <div className="code-preview">{text.split("\n").map((line, index) => <div className="code-line" key={index}><span>{index + 1}</span><code>{line || " "}</code></div>)}</div>}
    <footer>只读预览 <span>{path.split(".").at(-1)?.toUpperCase() ?? "FILE"}</span></footer>
  </aside>;
}

function MediaPreview({ kind, url, path }: { kind: "video" | "audio"; url: string; path: string }): ReactElement {
  const [failed, setFailed] = useState(false);
  const props = { src: url, controls: true, preload: "metadata", onError: () => setFailed(true), "aria-label": path };
  return <div className="media-preview">
    {kind === "video" ? <video {...props} playsInline /> : <audio {...props} />}
    <div className="preview-hint" role={failed ? "alert" : undefined}>{failed ? "无法播放：文件不可访问或浏览器不支持此编码，请下载查看或转为 MP4（H.264/AAC）/ WebM。" : "使用播放器控制播放、音量和进度。能否播放取决于浏览器支持的编码。"}</div>
  </div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<StrictMode><Workspace /></StrictMode>);
