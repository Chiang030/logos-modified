import { useState, type ReactElement } from "react";
import type { SessionListEntry, WebviewToExtensionMessage } from "../protocol";

export function HistoryMenu({ sessions, active, busy, post }: {
  sessions: SessionListEntry[]; active?: string; busy: boolean; post: (message: WebviewToExtensionMessage) => void;
}): ReactElement {
  const [limit, setLimit] = useState(25);
  const [editing, setEditing] = useState<string>();
  const [title, setTitle] = useState("");
  return <div className="history-list" role="menu">
    <button disabled={busy} onClick={() => post({ type: "session/new" })}>＋ 新建会话</button>
    {sessions.slice(0, limit).map((session) => <div key={session.sessionId} className="history-row">
      {editing === session.sessionId ? <form onSubmit={(event) => {
        event.preventDefault(); if (!title.trim()) return;
        post({ type: "session/rename", sessionId: session.sessionId, title }); setEditing(undefined);
      }}><input autoFocus aria-label="会话名称" value={title} onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditing(undefined); } }} />
        <button disabled={!title.trim()}>保存</button><button type="button" onClick={() => setEditing(undefined)}>取消</button></form>
        : <><button disabled={busy} className={active === session.sessionId ? "active" : ""}
          onClick={() => post({ type: "session/select", sessionId: session.sessionId })}>{session.title}</button>
          <button aria-label={`重命名 ${session.title}`} onClick={() => { setEditing(session.sessionId); setTitle(session.title); }}>重命名</button></>}
    </div>)}
    {!sessions.length && <p>暂无历史会话</p>}
    {sessions.length > limit && <button onClick={() => setLimit((value) => value + 25)}>加载更多</button>}
  </div>;
}
