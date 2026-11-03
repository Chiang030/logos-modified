import { useEffect, useState, type ReactElement } from "react";
import { validMemberName, type IdentityView } from "../../../src/shared/members";
import type { ExtensionToWebviewMessage } from "../../../src/shared/protocol";

interface Props { busy: boolean; post: (message: unknown) => void; }

export function IdentityPanel({ busy, post }: Props): ReactElement {
  const [identity, setIdentity] = useState<IdentityView>();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const receive = (event: MessageEvent<ExtensionToWebviewMessage>): void => {
      if (event.data.type === "identity/loaded") { setIdentity(event.data.identity); setName(""); setPending(false); setError(""); }
      if (event.data.type === "identity/error") { setPending(false); setError(event.data.message); }
    };
    window.addEventListener("message", receive);
    post({ type: "identity/load" });
    return () => window.removeEventListener("message", receive);
  }, []);
  const add = (): void => {
    if (busy || pending || !identity || !validMemberName(name)) return;
    setPending(true); setError(""); post({ type: "identity/add", name: name.trim() });
  };
  return <section className="identity-panel" aria-label="使用者">
    <label>添加姓名<input aria-label="添加姓名" value={name} maxLength={80} placeholder="输入你的名字"
      disabled={busy || pending || !identity} onChange={(event) => setName(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} /></label>
    <button type="button" disabled={busy || pending || !identity || !validMemberName(name)} onClick={add}>添加并使用</button>
    <label>选择已添加的姓名<select aria-label="使用者" value={identity?.selected?.id ?? ""} disabled={busy || pending || !identity?.members.length}
      onChange={(event) => { setPending(true); setError(""); post({ type: "identity/select", memberId: event.target.value }); }}>
      <option value="" disabled>{identity?.members.length ? "请选择你的姓名" : "请先添加姓名"}</option>
      {identity?.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
    </select></label>
    <p className="settings-hint">姓名保存在本机当前工作区，下次可直接选择。切换人员后请新建会话。</p>
    {pending ? <p role="status">正在保存使用者…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
