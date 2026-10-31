import { useEffect, useState, type ReactElement } from "react";
import { MEMBERS, type IdentityView, type UsageSummary } from "../../../src/shared/members";
import type { ExtensionToWebviewMessage } from "../../../src/shared/protocol";

interface Props { busy: boolean; post: (message: unknown) => void; }

export function IdentityPanel({ busy, post }: Props): ReactElement {
  const [identity, setIdentity] = useState<IdentityView>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const receive = (event: MessageEvent<ExtensionToWebviewMessage>): void => {
      if (event.data.type === "identity/loaded") { setIdentity(event.data.identity); setPending(false); setError(""); }
      if (event.data.type === "identity/error") { setPending(false); setError(event.data.message); }
    };
    window.addEventListener("message", receive);
    post({ type: "identity/load" });
    return () => window.removeEventListener("message", receive);
  }, []);
  return <section className="identity-panel" aria-label="使用者与 API 用量">
    <label>使用者<select aria-label="使用者" value={identity?.selected?.id ?? ""} disabled={busy || pending || !identity}
      onChange={(event) => { setPending(true); setError(""); post({ type: "identity/select", memberId: event.target.value }); }}>
      <option value="" disabled>请选择你的姓名</option>
      {MEMBERS.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
    </select></label>
    <p className="settings-hint">首次使用请选择本人。切换人员后请新建会话，历史归属不变。这是使用登记，不是身份认证。</p>
    {pending ? <p role="status">正在保存使用者…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <details><summary>每人 API 用量 · 本机当前工作区</summary>
      <p className="settings-hint">从登记后开始累计。响应次数包含 Agent 连续调用和失败响应，不等同于服务商请求总数。未返回或全零的用量标为未知，费用以服务商账单为准。</p>
      <div className="settings-actions"><button type="button" disabled={pending} onClick={() => { setPending(true); post({ type: "identity/load" }); }}>刷新统计</button>
        <button type="button" disabled={!identity?.selected} onClick={() => post({ type: "identity/openRecords" })}>打开记录文件</button></div>
      {identity ? <div className="usage-table-wrap"><table className="usage-table">
        <thead><tr><th>使用者</th><th>会话</th><th>响应</th><th>输入</th><th>输出</th><th>缓存读 / 写</th><th>总 token</th><th>未知用量</th><th>失败 / 中止</th></tr></thead>
        <tbody>{identity.summaries.map((summary) => <tr key={summary.member.id}><th scope="row">{summary.member.name}</th><UsageCells summary={summary} /></tr>)}</tbody>
      </table></div> : <p>正在加载统计…</p>}
      {identity?.models.length ? <details><summary>按使用者和模型查看</summary><div className="usage-table-wrap"><table className="usage-table">
        <thead><tr><th>使用者 / 模型</th><th>响应</th><th>输入</th><th>输出</th><th>缓存读 / 写</th><th>总 token</th><th>未知用量</th><th>失败 / 中止</th></tr></thead>
        <tbody>{identity.models.map((summary) => <tr key={JSON.stringify([summary.member.id, summary.provider, summary.model])}>
          <th scope="row">{summary.member.name}<br />{summary.model}<br /><span className="settings-hint">{summary.provider}</span></th>
          <UsageCells summary={summary} hideSessions />
        </tr>)}</tbody>
      </table></div></details> : null}
      <p className="settings-hint">记录保存在本机，不会自动汇总其他电脑。文件：{identity?.recordFile ?? "加载中…"}</p>
    </details>
  </section>;
}

function UsageCells({ summary, hideSessions }: { summary: UsageSummary; hideSessions?: boolean }): ReactElement {
  const format = (value: number): string => value.toLocaleString("zh-CN");
  const tokens = (value: number): string => summary.responses > 0 && summary.responses === summary.unknownUsage ? "—" : format(value);
  return <>{!hideSessions ? <td>{format(summary.sessions)}</td> : null}<td>{format(summary.responses)}</td>
    <td>{tokens(summary.input)}</td><td>{tokens(summary.output)}</td><td>{tokens(summary.cacheRead)} / {tokens(summary.cacheWrite)}</td>
    <td>{tokens(summary.total)}{summary.unknownUsage > 0 && summary.responses > summary.unknownUsage ? "+" : ""}</td>
    <td>{format(summary.unknownUsage)}</td><td>{format(summary.failed)}</td></>;
}
