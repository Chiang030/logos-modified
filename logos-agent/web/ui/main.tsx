import { StrictMode, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../vscode-extension/webview-ui/src/App";
import logo from "../../vscode-extension/resources/logos_full_restored_transparent.png";
import { BrowserBridge } from "./bridge";
import { AdminPanel } from "./admin";
import { api, query, setCsrf, upload, type Bootstrap, type Entry, type Project, type Conversation } from "./api";

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
  const [folder, setFolder] = useState(""), [entries, setEntries] = useState<Entry[]>([]);
  const [tab, setTab] = useState("files"), [sessions, setSessions] = useState<Conversation[]>([]);
  const [notice, setNotice] = useState(""), [selected, setSelected] = useState<string>();
  const [refresh, setRefresh] = useState(0), [picker, setPicker] = useState(false), [uploading, setUploading] = useState("");
  const [search, setSearch] = useState(""), [adminOpen, setAdminOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const bridge = useMemo(() => project ? new BrowserBridge(project, user, preview, boot.version, setNotice, setSelected, () => setAdminOpen(true)) : undefined, [project, user, preview, boot.version]);
  useEffect(() => { if (!preview) void api<{ projects: Project[] }>("/api/projects").then((r) => {
    setProjects(r.projects);
    setProject(current=>current??r.projects.find(p=>p.id===localStorage.getItem("logos-project-"+user.id)));
  }).catch((e) => setNotice(message(e))); }, [preview, refresh, user.id]);
  useEffect(() => {const update=():void=>setRefresh(n=>n+1);window.addEventListener("logos-files-refresh",update);return ()=>window.removeEventListener("logos-files-refresh",update);},[]);
  useEffect(() => {
    let current = true;
    if (!project) { setEntries([]); return; }
    if (preview) { setEntries(folder ? [] : demoFiles); return; }
    void api<{ entries: Entry[] }>("/api/files?" + query(folder, project.id)).then((r) => { if (current) setEntries(r.entries); }).catch((e) => { if (current) setNotice(message(e)); });
    return () => { current = false; };
  }, [project, folder, refresh, preview]);
  useEffect(() => {
    setSessions([]);
    return bridge?.subscribe((event) => {
      if (event.type === "session/list") setSessions(event.sessions.map((s) => ({ id: s.sessionId, title: s.title, project: project!.id })));
    });
  }, [bridge, project]);
  const select = (value: Project | undefined): void => { if (!preview) {if(value)localStorage.setItem("logos-project-"+user.id,value.id);else localStorage.removeItem("logos-project-"+user.id);} setProject(value); setFolder(""); setSelected(undefined); setNotice(""); setSearch(""); };
  const transfer = async (files: FileList | null): Promise<void> => {
    if (!files?.length || !project || preview) return;
    let completed = 0;
    try {
      for (const file of Array.from(files)) {
        setUploading("上传 " + (completed + 1) + "/" + files.length + " · " + file.name);
        await upload([project.directory, folder, file.webkitRelativePath || file.name].filter(Boolean).join("/"), file);
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
          <div className="explorer-tabs"><button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>文件</button><button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>会话</button></div>
          {tab === "files" ? <>
            <div className="file-actions"><button title="上传文件" disabled={preview || Boolean(uploading)} onClick={() => fileInput.current?.click()}>↑ 文件</button><button title="上传文件夹" disabled={preview || Boolean(uploading)} onClick={() => folderInput.current?.click()}>↑ 文件夹</button><button title="刷新文件" aria-label="刷新文件" onClick={() => setRefresh((n) => n + 1)}>↻</button></div>
            <input hidden multiple type="file" ref={fileInput} onChange={(event) => void transfer(event.target.files)} />
            <input hidden multiple type="file" ref={folderInput} {...{ webkitdirectory: "" }} onChange={(event) => void transfer(event.target.files)} />
            <input className="file-search" aria-label="筛选当前目录文件" placeholder="查找当前目录文件…" value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="file-location"><button disabled={!folder} title="上一级" onClick={() => setFolder(parent(folder))}>←</button><span title={folder}>{folder || project.directory}</span></div>
            <div className="file-list">{entries.filter((entry) => entry.name.toLowerCase().includes(search.toLowerCase())).map((entry) => <button key={entry.name} className={selected === [folder, entry.name].filter(Boolean).join("/") ? "selected" : ""} onClick={() => {
              const path = [folder, entry.name].filter(Boolean).join("/");
              if (entry.directory) { setFolder(path); setSearch(""); } else setSelected(path);
            }}><span className={entry.directory ? "folder-icon" : "document-icon"}>{entry.directory ? "▸" : "≡"}</span><span>{entry.name}</span><small>{entry.directory ? "" : bytes(entry.size)}</small></button>)}
              {!entries.length ? <div className="empty-note">此目录为空<br />上传资料后即可在这里查看。</div> : null}</div>
          </> : <div className="session-list-web"><button className="new-session-button" onClick={() => bridge?.postMessage({ type: "session/new" })}>＋ 新建会话</button>{sessions.map((item) => <button key={item.id} onClick={() => bridge?.postMessage({ type: "session/select", sessionId: item.id })}>{item.title}</button>)}{!sessions.length ? <p className="empty-note">尚无历史会话</p> : null}</div>}
        </> : <div className="empty-note">先选择个人文件夹，再建立项目。<br />每个项目独立保存会话。</div>}
        <div className="explorer-footer"><span className="status-dot" />{preview ? "示例资料 · 不保存操作" : "个人文件 · 仅当前账号可见"}</div>
      </aside>
      <section className="main-workspace">
        {preview ? <div className="stage-banner">界面预览：示例资料不属于真实账号，上传与模型调用未启用。</div> : <div className="stage-banner">{boot.executionReady ? "模型由管理员统一配置，用量按你的账号记录。全站最多同时运行 5 个任务。" : boot.executionReason}</div>}
        {notice || uploading ? <div className="notice" role="status"><span>{uploading || notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div> : null}
        {project && bridge ? <div className="workbench-panels"><div className="chat-panel"><App key={project.id} host={bridge} web /></div>{selected ? <FilePreview key={project.id + ":" + selected + ":" + refresh} path={selected} project={project} preview={preview} close={() => setSelected(undefined)} reference={() => {
          void navigator.clipboard.writeText(selected).then(() => setNotice("已复制项目相对路径，可粘贴到对话中引用")).catch(() => setNotice("请复制文件标签中的相对路径"));
        }} /> : null}</div> : <div className="project-home"><div className="eyebrow">YOUR WORKSPACE</div><h1>让设计与仿真，<br /><span>从这里开始。</span></h1><p>选择自己的文件夹，整理资料，建立项目。<br />项目文件和对话会保存在服务器个人空间中。</p><button className="primary" onClick={() => setPicker(true)}>打开文件夹 →</button><div className="home-projects">{projects.map((item) => <button key={item.id} onClick={() => select(item)}><span>◇</span><strong>{item.name}</strong><small>{item.directory}</small></button>)}</div></div>}
      </section>
    </div>
    {adminOpen && user.admin ? <AdminPanel close={()=>{setAdminOpen(false);void bridge?.catalog();}} /> : null}
    {picker ? <FolderPicker preview={preview} onClose={() => setPicker(false)} onSelect={(value) => { select(value); setPicker(false); setRefresh((n) => n + 1); }} /> : null}
  </div>;
}

function FolderPicker({ preview, onClose, onSelect }: { preview: boolean; onClose: () => void; onSelect: (project: Project) => void }): ReactElement {
  const [path, setPath] = useState(""), [entries, setEntries] = useState<Entry[]>([]);
  const [name, setName] = useState(""), [projectName, setProjectName] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    if (preview) { setEntries(path ? demoFiles : [{ name: "wing-study", directory: true, size: 0, modified: 0 }]); return; }
    void api<{ entries: Entry[] }>("/api/files?" + query(path)).then((r) => { if (current) setEntries(r.entries); }).catch((e) => { if (current) setError(message(e)); });
    return () => { current = false; };
  }, [path, preview, revision]);
  const create = async (): Promise<void> => {
    setBusy(true); setError("");
    try { await api("/api/folders", { path: [path, name].filter(Boolean).join("/") }); setName(""); setRevision((n) => n + 1); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const choose = async (): Promise<void> => {
    if (preview) { onSelect(demoProject); return; }
    setBusy(true); setError("");
    try { const r = await api<{ project: Project }>("/api/projects", { name: projectName.trim() || path.split("/").at(-1), directory: path }); onSelect(r.project); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <div className="modal-shade"><section className="folder-dialog" role="dialog" aria-modal="true" aria-label="打开文件夹">
    <header><div><h2>打开文件夹</h2><p>选择个人空间内的目录，建立或打开项目。</p></div><button aria-label="关闭文件夹选择" onClick={onClose}>×</button></header>
    <div className="folder-path"><button disabled={!path || busy} onClick={() => setPath(parent(path))}>← 上一级</button><span>我的空间 / {path}</span></div>
    <div className="folder-picker-list">{entries.filter((e) => e.directory).map((e) => <button key={e.name} disabled={busy} onClick={() => { setPath([path, e.name].filter(Boolean).join("/")); setProjectName(""); }}>▸ {e.name}<span>打开 →</span></button>)}{!entries.some((e) => e.directory) ? <p className="empty-note">没有子文件夹，可使用当前目录。</p> : null}</div>
    <form className="new-folder-form" onSubmit={(e) => { e.preventDefault(); void create(); }}><input aria-label="新文件夹名称" placeholder="新文件夹名称" value={name} onChange={(e) => setName(e.target.value)} /><button disabled={preview || busy || !name.trim()}>新建文件夹</button></form>
    <label className="project-name">项目名称<input aria-label="项目名称" placeholder={path.split("/").at(-1) || "先选择一个文件夹"} value={projectName} onChange={(e) => setProjectName(e.target.value)} /></label>
    {error ? <p className="dialog-error" role="alert">{error}</p> : null}
    <footer><span>个人空间根目录不能直接注册为项目</span><button className="primary" disabled={!path || busy} onClick={() => void choose()}>{busy ? "处理中…" : "以此文件夹打开项目"}</button></footer>
  </section></div>;
}

function FilePreview({ path, project, preview, close, reference }: { path: string; project: Project; preview: boolean; close: () => void; reference: () => void }): ReactElement {
  const [text, setText] = useState(""), [error, setError] = useState(""), [truncated, setTruncated] = useState(false), [loading, setLoading] = useState(true);
  const image = /\.(png|jpe?g|gif|webp)$/i.test(path), pdf = /\.pdf$/i.test(path);
  const url = "/api/file?" + query(path, project.id);
  useEffect(() => {
    let current = true;
    if (preview) { setText(demoText[path] ?? "这是示例文件，尚无内容。"); setLoading(false); return; }
    if (image || pdf) { setLoading(false); return; }
    void api<{ text: string; truncated: boolean }>("/api/preview?" + query(path, project.id)).then((r) => {
      if (current) { setText(r.text); setTruncated(r.truncated); }
    }).catch((e) => { if (current) setError(message(e)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [path, project.id, preview, image, pdf]);
  return <aside className="preview-panel" aria-label="文件预览">
    <header><div><span className="document-icon">≡</span><strong title={path}>{path.split("/").at(-1)}</strong></div><button aria-label="关闭文件预览" onClick={close}>×</button></header>
    <div className="preview-toolbar"><span title={path}>{path}</span><button onClick={reference}>引用路径</button>{!preview ? <a href={url + "&download=1"}>下载</a> : null}</div>
    {truncated ? <div className="preview-hint">只显示前 512 KB，完整内容请下载查看。</div> : null}
    {error ? <div className="empty-note" role="alert">{error}</div> : loading ? <div className="empty-note">正在读取文件…</div> : image && !preview ? <div className="image-preview"><img src={url} alt={path} /></div> : pdf && !preview ? <iframe className="pdf-preview" title={path} src={url} /> : <div className="code-preview">{text.split("\n").map((line, index) => <div className="code-line" key={index}><span>{index + 1}</span><code>{line || " "}</code></div>)}</div>}
    <footer>只读预览 <span>{path.split(".").at(-1)?.toUpperCase() ?? "FILE"}</span></footer>
  </aside>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<StrictMode><Workspace /></StrictMode>);
