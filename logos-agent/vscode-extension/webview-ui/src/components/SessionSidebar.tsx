import type { ReactElement } from "react";
import type { SessionListEntry } from "../protocol";

interface Props {
  sessionName?: string;
  onNew: () => void;
  sessions: SessionListEntry[];
  activeSessionId?: string;
  onSelect: (sessionId: string) => void;
}

export function SessionSidebar({ sessionName, onNew, sessions, activeSessionId, onSelect }: Props): ReactElement {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">L</span>
        <span>LOGOS</span>
      </div>
      <button type="button" className="new-session" onClick={onNew}>
        <span aria-hidden="true">＋</span> New session
      </button>
      <div className="session-list">
        <div className="session-heading">Current workspace</div>
        {sessions.length ? sessions.map((session) => <button type="button" className={`session-item ${session.sessionId === activeSessionId ? "active" : ""}`} key={session.sessionId} onClick={() => onSelect(session.sessionId)}>{session.title}</button>) : <div className="session-item active">{sessionName || "Untitled session"}</div>}
      </div>
      <div className="sidebar-footer">Local runtime</div>
    </aside>
  );
}
