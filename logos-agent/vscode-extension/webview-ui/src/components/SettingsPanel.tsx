import { useEffect, useState, type ReactElement } from "react";
import type { SettingsView, ApiProtocol, ExtensionToWebviewMessage } from "../../../src/shared/protocol";

type Props = { open: boolean; busy: boolean; onOpen: () => void; onClose: () => void; post: (message: unknown) => void };

export function SettingsPanel({ open, busy, onOpen, onClose, post }: Props): ReactElement | null {
  const [settings, setSettings] = useState<SettingsView>();
  const [apiKey, setApiKey] = useState("");
  const [deleteKey, setDeleteKey] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const receive = (event: MessageEvent<ExtensionToWebviewMessage>): void => {
      const message = event.data;
      if (message.type === "settings/loaded") {
        setSettings(message.settings); setApiKey(""); setDeleteKey(false);
        if (!message.settings.baseUrl) onOpen();
      } else if (message.type === "settings/models") {
        setSettings((current) => current ? { ...current, modelIds: message.modelIds,
          modelId: message.modelIds.includes(current.modelId) ? current.modelId : message.modelIds[0] } : current);
        setPending(false); setNotice(`已获取 ${message.modelIds.length} 个模型，请选择后保存。`);
      } else if (message.type === "settings/saved") {
        setPending(false); setNotice("已保存到本地，运行时将使用此配置。");
      } else if (message.type === "settings/error") { setPending(false); setNotice(message.message); }
    };
    window.addEventListener("message", receive);
    post({ type: "settings/load" });
    return () => window.removeEventListener("message", receive);
  }, []);
  if (!open) return null;
  const update = (value: Partial<SettingsView>): void => { setSettings((current) => current ? { ...current, ...value } : current); setNotice(""); };
  return <section className="logos-settings" aria-label="LOGOS 设置">
    <div className="settings-heading"><strong>LOGOS 设置</strong><button onClick={onClose} aria-label="关闭设置">×</button></div>
    {!settings ? <p>正在加载本地配置…</p> : <>
      <p>连接模型服务，选择模型后点击保存。</p>
      <label>API URL<input value={settings.baseUrl} placeholder="https://example.com/v1" onChange={(e) => update({ baseUrl: e.target.value, modelIds: [] })} /></label>
      <label>API 协议<select value={settings.api} onChange={(e) => update({ api: e.target.value as ApiProtocol, modelIds: [] })}>
        <option value="openai-completions">OpenAI Chat Completions / 兼容服务</option><option value="openai-responses">OpenAI Responses</option>
        <option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option>
      </select></label>
      <label>API Key<input type="password" autoComplete="off" value={apiKey} placeholder={settings.hasApiKey ? "已保存，留空保留原 Key" : "输入 API Key（本地无认证服务可留空）"} onChange={(e) => { setApiKey(e.target.value); setDeleteKey(false); }} /></label>
      {settings.hasApiKey ? <label className="settings-check"><input type="checkbox" checked={deleteKey} onChange={(e) => setDeleteKey(e.target.checked)} />删除已保存的 API Key</label> : null}
      <button disabled={pending || !settings.baseUrl.trim()} onClick={() => { setPending(true); setNotice("正在向上游获取模型…"); post({ type: "settings/models", baseUrl: settings.baseUrl, api: settings.api, apiKey: deleteKey ? "" : apiKey || undefined }); }}>获取上游模型</button>
      {settings.modelIds.length ? <label>选择模型<select value={settings.modelId} onChange={(e) => update({ modelId: e.target.value })}><option value="">请选择</option>{settings.modelIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label> : null}
      <label>模型 ID（也可手动填写）<input value={settings.modelId} onChange={(e) => update({ modelId: e.target.value })} /></label>
      <details><summary>系统提示词</summary><label>系统提示词<textarea rows={9} value={settings.systemPrompt} onChange={(e) => update({ systemPrompt: e.target.value })} /></label><label>附加提示词<textarea rows={7} value={settings.appendPrompt} onChange={(e) => update({ appendPrompt: e.target.value })} /></label></details>
      <details><summary>Skills（{settings.bundledSkills.length} 个内置技能）</summary>
        <label className="settings-check"><input type="checkbox" checked={settings.skillsEnabled} onChange={(e) => update({ skillsEnabled: e.target.checked })} />启用内置 Logos skills</label>
        <ul>{settings.bundledSkills.map((skill) => <li key={skill}>{skill}</li>)}</ul>
        <label>额外 skills 目录（每行一个，相对路径以工作区为基准）<textarea rows={3} value={settings.skillPaths.join("\n")} onChange={(e) => update({ skillPaths: e.target.value.split("\n") })} /></label>
      </details>
      <details><summary>本地文件位置</summary><p>配置：{settings.configDirectory}</p><p>Logos：{settings.domainDirectory}</p><p>API Key 保存在 VS Code 本机凭据存储中。</p></details>
      <div className="settings-actions"><button className="settings-save" disabled={pending || busy} onClick={() => { setPending(true); setNotice("正在保存…"); post({ type: "settings/save", settings, apiKey, deleteApiKey: deleteKey }); }}>保存并应用</button><button onClick={onClose}>返回聊天</button></div>
      {busy ? <p>请先停止当前任务，再保存设置。</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </>}
  </section>;
}
