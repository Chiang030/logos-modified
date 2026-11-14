import React, { useEffect, useState } from "react";
import { api, type User } from "./api.ts";
import "./feedback.css";

interface Item { id: string; owner: string; kind: "bug" | "feature"; title: string; description: string; project: string | null; session: string | null; status: string; note: string; created: number; }
interface Page { items: Item[]; hasMore: boolean; }
interface Board { usageMetric: string; feedbackMetric: string; usage: { name: string; count: number }[]; feedback: { name: string; count: number }[]; }
const labels: Record<string, string> = { pending: "待审核", accepted: "已受理", resolved: "已解决", duplicate: "重复", rejected: "不受理" };
const message = (error: unknown): string => error instanceof Error ? error.message : "请求失败，请重试";

/** Render inside the authenticated home view; does not fetch session contents. */
export function HomeLeaderboards(): React.JSX.Element {
  const [data, setData] = useState<Board | null>(null), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => { let active = true; setError(""); void api<Board>("/api/leaderboards").then(value => { if (!Array.isArray(value.usage) || !Array.isArray(value.feedback)) throw new Error("排行榜数据暂不可用，请刷新重试"); if (active) setData(value); }).catch(err => { if (active) setError(message(err)); }); return () => { active = false; }; }, [revision]);
  return <section className="logos-feedback"><h2>社区排行榜</h2><p>仅展示姓名与计数，不公开会话、项目、提示词或费用。北京时间近30天，最多展示前20名。</p>
    <button type="button" onClick={() => setRevision(n => n + 1)}>刷新榜单</button>{error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">正在加载榜单…</p>}
    {data && <div className="logos-feedback-boards">{([['使用榜', data.usageMetric, data.usage], ['反馈贡献榜', data.feedbackMetric, data.feedback]] as const).map(([title, metric, rows]) => <section key={title}><h3>{title}</h3><p>{metric}</p>{rows.length ? <ol>{rows.map((row, index) => <li key={index}><span>{row.name}</span><strong>{row.count}{title === "使用榜" ? " 天" : " 条"}</strong></li>)}</ol> : <p>暂无符合条件的记录</p>}</section>)}</div>}
  </section>;
}

export interface FeedbackPanelProps { user: User; projectId?: string; sessionId?: string; }
/** Optional IDs are explicitly opt-in references, never copied conversation text. */
export function FeedbackPanel({ user, projectId, sessionId }: FeedbackPanelProps): React.JSX.Element {
  const [kind, setKind] = useState("bug"), [title, setTitle] = useState(""), [description, setDescription] = useState("");
  const [attach, setAttach] = useState(false), [admin, setAdmin] = useState(false), [status, setStatus] = useState(""), [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => { setAttach(false); }, [projectId, sessionId]);
  useEffect(() => {
    let active = true; setPage(null); setError("");
    const query = new URLSearchParams({ limit: "20", offset: String(offset), status });
    void api<Page>((admin && user.admin ? "/api/admin/feedback?" : "/api/feedback?") + query).then(value => { if (active) setPage(value); }).catch(err => { if (active) setError(message(err)); });
    return () => { active = false; };
  }, [admin, user.id, user.admin, status, offset, revision]);
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault(); if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await api("/api/feedback", { kind, title, description, ...(attach ? { project: projectId, session: sessionId } : {}) }); setTitle(""); setDescription(""); setAttach(false); setOffset(0); setRevision(n => n + 1); setNotice("反馈已提交，审核状态可在下方查看。"); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <section className="logos-feedback"><h2>问题反馈与功能需求</h2><p>请勿填写密码、密钥或敏感数据。只发送你填写的内容；引用不会自动附带会话正文。每24小时最多10条，相同内容不能重复提交。</p>
    <form onSubmit={event => void submit(event)}><label>类型<select value={kind} onChange={event => setKind(event.target.value)}><option value="bug">问题（Bug）</option><option value="feature">功能需求</option></select></label>
      <label>标题<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>描述<textarea required maxLength={5000} rows={5} value={description} onChange={event => setDescription(event.target.value)} placeholder="请描述复现步骤、实际结果与期望结果，或需求的使用场景。" /></label>
      {(projectId || sessionId) && <label className="logos-feedback-check"><input type="checkbox" checked={attach} onChange={event => setAttach(event.target.checked)} />附带当前{sessionId ? "会话及项目" : "项目"}引用（仅标识，不包含正文）</label>}
      <button disabled={busy} type="submit">{busy ? "正在提交…" : "提交反馈"}</button>
    </form>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="logos-feedback-tools"><h3>{admin ? "管理员审核" : "我的反馈"}</h3>{user.admin && <button type="button" onClick={() => { setAdmin(value => !value); setOffset(0); }}>{admin ? "查看我的反馈" : "审核全部反馈"}</button>}
      <label>状态<select value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }}><option value="">全部</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" onClick={() => setRevision(n => n + 1)}>刷新</button></div>
    {!page && !error && <p role="status">正在加载反馈…</p>}{page && !page.items.length && <p>暂无反馈</p>}
    {page?.items.map(item => <article key={item.id}><h4>{item.kind === "bug" ? "问题" : "需求"} · {item.title}</h4><p>{labels[item.status]} · {new Date(item.created).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）</p><p className="logos-feedback-description">{item.description}</p>
      {(item.project || item.session) && <p>已附带{item.session ? "会话和项目" : "项目"}引用（未读取正文）</p>}{item.note && <p className="logos-feedback-description">审核说明：{item.note}</p>}
      {admin && user.admin && <Review item={item} self={item.owner === user.id} onSaved={() => setRevision(n => n + 1)} />}</article>)}
    <nav aria-label="反馈分页"><button type="button" disabled={offset === 0 || !page} onClick={() => setOffset(n => Math.max(0, n - 20))}>上一页</button><span>第 {Math.floor(offset / 20) + 1} 页</span><button type="button" disabled={!page?.hasMore} onClick={() => setOffset(n => n + 20)}>下一页</button></nav>
  </section>;
}
function Review({ item, self, onSaved }: { item: Item; self: boolean; onSaved: () => void }): React.JSX.Element {
  const [status, setStatus] = useState(item.status === "pending" ? "accepted" : item.status), [note, setNote] = useState(item.note), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(): Promise<void> {
    setBusy(true); setError("");
    try { await api("/api/admin/feedback/" + encodeURIComponent(item.id), { status, note }, "PATCH"); onSaved(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  if (self) return <p>不能审核自己的反馈，请由其他管理员审核。</p>;
  return <div className="logos-feedback-review"><label>审核结果<select value={status} onChange={event => setStatus(event.target.value)}>{Object.entries(labels).filter(([value]) => value !== "pending").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>审核说明（提交者可见）<textarea maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></label><button type="button" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存审核"}</button>{error && <p role="alert">{error}</p>}</div>;
}
