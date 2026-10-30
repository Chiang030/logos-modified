import { useEffect, useState, type ReactElement } from "react";
import type { SettingsView, ConnectionEntry, ApiProtocol, ExtensionToWebviewMessage } from "../../../src/shared/protocol";
import { DEFAULT_PROVIDER_ID, PROVIDER_PRESETS, presetById, type ProviderId } from "../../../src/shared/providerPresets";
import { SoftwarePanel } from "./SoftwarePanel";

type Props = { open: boolean; busy: boolean; onOpen: () => void; onClose: () => void; post: (message: unknown) => void };

type LoginPhase = "" | "waiting" | "exchanging";

/** 选预设：自动填 baseUrl/协议并重置为兜底模型列表；选自定义：仅切换标记，保留现值。 */
function presetSelection(modelId: string, id: ProviderId): Partial<ConnectionEntry> {
  const preset = presetById(id);
  if (!preset) return { providerId: "custom" };
  const modelIds = [...preset.fallbackModels];
  return { providerId: id, baseUrl: preset.baseUrl, api: preset.api,
    modelIds, modelId: modelIds.includes(modelId) ? modelId : modelIds[0] };
}

function newId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `conn-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function draftEntry(): ConnectionEntry {
  return { id: newId(), name: "", modelId: "", ...presetSelection("", DEFAULT_PROVIDER_ID) } as ConnectionEntry;
}

function presetLabel(entry: ConnectionEntry): string {
  return entry.providerId === "custom" ? "自定义" : presetById(entry.providerId)?.label ?? "自定义";
}

export function SettingsPanel({ open, busy, onOpen, onClose, post }: Props): ReactElement | null {
  const [settings, setSettings] = useState<SettingsView>();
  const [editing, setEditing] = useState<ConnectionEntry>();
  const [isNew, setIsNew] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [deleteKey, setDeleteKey] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [modelSource, setModelSource] = useState<"upstream" | "fallback">("upstream");
  const [loginPhase, setLoginPhase] = useState<LoginPhase>("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualModel, setManualModel] = useState("");
  useEffect(() => {
    const receive = (event: MessageEvent<ExtensionToWebviewMessage>): void => {
      const message = event.data;
      if (message.type === "settings/loaded") {
        setSettings(message.settings); setApiKey(""); setDeleteKey(false); setLoginPhase(""); setManualUrl(""); setModelSource("upstream");
        // 已保存的编辑项用最新数据同步；新建草稿不在列表里，保留现场。
        setEditing((current) => current
          ? message.settings.connections.find((entry) => entry.id === current.id) ?? current
          : current);
        if (!message.settings.connections.length) { setEditing((current) => current ?? draftEntry()); setIsNew(true); onOpen(); }
      } else if (message.type === "settings/models") {
        setEditing((current) => current ? { ...current, modelIds: message.modelIds,
          modelId: message.modelIds.includes(current.modelId) ? current.modelId : message.modelIds[0] } : current);
        setModelSource(message.source); setPending(false);
        setNotice(message.source === "fallback"
          ? "上游模型接口不可用，已显示预设模型列表（可手动输入其他模型 ID）。"
          : `已获取 ${message.modelIds.length} 个模型，保存后都会出现在左下角模型切换器里。`);
      } else if (message.type === "settings/openaiLoginStatus") {
        if (message.phase === "done") { setLoginPhase(""); setNotice("ChatGPT 登录完成，请保存该配置。"); }
        else setLoginPhase(message.phase);
      } else if (message.type === "settings/saved") {
        setPending(false); setNotice("已应用到本地配置。");
        setEditing(undefined); setIsNew(false);
      } else if (message.type === "settings/error") { setPending(false); setLoginPhase(""); setNotice(message.message); }
    };
    window.addEventListener("message", receive);
    post({ type: "settings/load" });
    return () => window.removeEventListener("message", receive);
  }, []);
  if (!open) return null;
  if (!settings) return <section className="logos-settings" aria-label="LOGOS 设置">
    <div className="settings-heading"><strong>LOGOS 设置</strong><button onClick={onClose} aria-label="关闭设置">×</button></div>
    <p>正在加载本地配置…</p>
  </section>;

  if (editing) {
    const entry = editing;
    const update = (value: Partial<ConnectionEntry>): void => { setEditing((current) => current ? { ...current, ...value } : current); setNotice(""); };
    const selectProvider = (id: ProviderId): void => { setApiKey(""); setDeleteKey(false); update(presetSelection(entry.modelId, id)); };
    const openAi = entry.providerId === "openai-chatgpt";
    const providerValue = entry.providerId === "custom" && !entry.baseUrl ? DEFAULT_PROVIDER_ID : entry.providerId;
    const addManualModel = (): void => {
      const id = manualModel.trim();
      if (!id) return;
      const modelIds = entry.modelIds.includes(id) ? entry.modelIds : [...entry.modelIds, id];
      setManualModel("");
      update({ modelIds, modelId: entry.modelId || id });
    };
    return <section className="logos-settings" aria-label="LOGOS API 配置">
      <div className="settings-heading"><strong>{isNew ? "新建 API 配置" : "编辑 API 配置"}</strong><button onClick={onClose} aria-label="关闭设置">×</button></div>
      <p>保存后，该配置的全部模型会出现在左下角模型切换器里。</p>
      <label>配置名称（留空自动取名）<input value={entry.name} placeholder="例如：DeepSeek 官方" onChange={(e) => update({ name: e.target.value })} /></label>
      <label>模型服务
        <select value={providerValue} onChange={(e) => selectProvider(e.target.value as ProviderId)}>
          {PROVIDER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          <option value="custom">自定义</option>
        </select>
      </label>
      {openAi ? <>
        <p>API URL：https://api.openai.com/v1（由 ChatGPT 登录自动配置）</p>
        <p>API 协议：OpenAI Responses（由 ChatGPT 登录自动配置）</p>
        {settings.hasOpenAiLogin
          ? <div className="settings-actions">
            <p>已登录 ChatGPT，访问令牌保存在本机凭据存储中。</p>
            <button onClick={() => post({ type: "settings/openaiLogout" })}>退出登录</button>
          </div>
          : <div className="settings-actions">
            {loginPhase === "waiting"
              ? <>
                <p>请在浏览器中完成 OpenAI 登录…</p>
                <label>若浏览器未完成跳转，请粘贴最终回调 URL
                  <input value={manualUrl} placeholder="http://127.0.0.1:1455/auth/callback?..." onChange={(e) => setManualUrl(e.target.value)} />
                </label>
                <button disabled={!manualUrl.trim()} onClick={() => post({ type: "settings/openaiManualCallback", url: manualUrl.trim() })}>提交回调 URL</button>
                <button onClick={() => post({ type: "settings/openaiCancelLogin" })}>取消登录</button>
              </>
              : loginPhase === "exchanging" ? <p>正在换取访问令牌…</p>
                : <button onClick={() => post({ type: "settings/openaiLogin" })}>登录 ChatGPT</button>}
          </div>}
        <p className="settings-hint">需要可访问 auth.openai.com / api.openai.com 的网络环境；长时间使用后遇到 401，请重启运行时以刷新令牌。</p>
      </> : <>
        <label>API URL<input value={entry.baseUrl} placeholder="https://example.com/v1" onChange={(e) => update({ baseUrl: e.target.value, providerId: "custom", modelIds: [] })} /></label>
        <label>API 协议<select value={entry.api} onChange={(e) => update({ api: e.target.value as ApiProtocol, modelIds: [] })}>
          <option value="openai-completions">OpenAI Chat Completions / 兼容服务</option><option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option>
        </select></label>
        <label>API Key<input type="password" autoComplete="off" value={apiKey} placeholder={settings.hasApiKeyByConnection[entry.id] ? "已保存，留空保留原 Key" : "输入 API Key（本地无认证服务可留空）"} onChange={(e) => { setApiKey(e.target.value); setDeleteKey(false); }} /></label>
        {settings.hasApiKeyByConnection[entry.id] && !isNew ? <label className="settings-check"><input type="checkbox" checked={deleteKey} onChange={(e) => setDeleteKey(e.target.checked)} />删除已保存的 API Key</label> : null}
      </>}
      <button disabled={pending || !entry.baseUrl.trim()} onClick={() => { setPending(true); setNotice("正在向上游获取模型…"); post({ type: "settings/models", baseUrl: entry.baseUrl, api: entry.api, apiKey: openAi || deleteKey ? "" : apiKey || undefined }); }}>获取上游模型</button>
      {entry.modelIds.length ? <label>默认模型{modelSource === "fallback" ? <span className="settings-badge">预设列表</span> : null}<select value={entry.modelId} onChange={(e) => update({ modelId: e.target.value })}><option value="">请选择</option>{entry.modelIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label> : null}
      <label>手动添加模型 ID<input value={manualModel} placeholder="输入模型 ID 后点击添加" onChange={(e) => setManualModel(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManualModel(); } }} /></label>
      <button disabled={!manualModel.trim()} onClick={addManualModel}>添加模型</button>
      <details><summary>模型思考能力（默认读取内置模型目录）</summary>{entry.modelIds.map((id) => <label key={id}>{id}<select
        value={entry.modelCapabilities?.[id]?.reasoning === undefined ? "auto" : String(entry.modelCapabilities[id].reasoning)}
        onChange={(event) => update({ modelCapabilities: { ...entry.modelCapabilities, [id]: { reasoning: event.target.value === "auto" ? undefined : event.target.value === "true" } } })}>
        <option value="auto">自动识别；未知时禁用</option><option value="true">此模型支持思考</option><option value="false">此模型不支持思考</option>
      </select></label>)}<p>手动启用前，请确认该服务支持所选 API 协议的推理参数。</p></details>
      {entry.modelIds.length ? <p className="settings-hint">该配置共 {entry.modelIds.length} 个模型，保存后全部进入左下角切换器。</p> : null}
      <div className="settings-actions">
        <button className="settings-save" disabled={pending || busy} onClick={() => { setPending(true); setNotice("正在保存…"); post({ type: "connection/save", entry, apiKey, deleteApiKey: deleteKey }); }}>{isNew ? "保存新配置" : "保存修改"}</button>
        <button onClick={() => { setEditing(undefined); setIsNew(false); setNotice(""); }}>返回列表</button>
      </div>
      {busy ? <p>请先停止当前任务，再保存设置。</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>;
  }

  const updateGlobal = (value: Partial<SettingsView>): void => { setSettings((current) => current ? { ...current, ...value } : current); setNotice(""); };
  return <section className="logos-settings" aria-label="LOGOS 设置">
    <div className="settings-heading"><strong>LOGOS 设置</strong><button onClick={onClose} aria-label="关闭设置">×</button></div>
    <SoftwarePanel busy={busy} post={post} />
    <div className="settings-list-head"><strong>已保存的 API 配置</strong><button onClick={() => { setEditing(draftEntry()); setIsNew(true); setNotice(""); }}>＋ 新建</button></div>
    {settings.connections.length
      ? <ul className="settings-connections">{settings.connections.map((entry) => <li key={entry.id} className="settings-connection">
        <div className="settings-connection-info">
          <strong>{entry.name}</strong>
          <span>{presetLabel(entry)} · {entry.providerId === "openai-chatgpt" ? "ChatGPT 登录" : entry.baseUrl}</span>
          <span>{entry.modelIds.length} 个模型{settings.activeConnectionId === entry.id && settings.activeModelId ? ` · 当前使用 ${settings.activeModelId}` : ""}
            {entry.providerId === "openai-chatgpt"
              ? <span className="settings-badge">{settings.hasOpenAiLogin ? "已登录" : "未登录"}</span>
              : <span className="settings-badge">{settings.hasApiKeyByConnection[entry.id] ? "已存 Key" : "无 Key"}</span>}</span>
        </div>
        <div className="settings-connection-actions">
          <button onClick={() => { setEditing(entry); setIsNew(false); setNotice(""); }}>编辑</button>
          <button onClick={() => { if (window.confirm(`删除配置「${entry.name}」？同时删除其保存的 Key。`)) post({ type: "connection/delete", connectionId: entry.id }); }}>删除</button>
        </div>
      </li>)}</ul>
      : <p>还没有 API 配置。点击「＋ 新建」添加一个模型服务，保存后即可在左下角切换模型。</p>}
    <details><summary>系统提示词</summary><label>系统提示词<textarea rows={9} value={settings.systemPrompt} onChange={(e) => updateGlobal({ systemPrompt: e.target.value })} /></label><label>附加提示词<textarea rows={7} value={settings.appendPrompt} onChange={(e) => updateGlobal({ appendPrompt: e.target.value })} /></label></details>
    <details><summary>Skills（{settings.bundledSkills.length} 个内置技能）</summary>
      <label className="settings-check"><input type="checkbox" checked={settings.skillsEnabled} onChange={(e) => updateGlobal({ skillsEnabled: e.target.checked })} />启用内置 Logos skills</label>
      <ul>{settings.bundledSkills.map((skill) => <li key={skill}>{skill}</li>)}</ul>
      <label>额外 skills 目录（每行一个，相对路径以工作区为基准）<textarea rows={3} value={settings.skillPaths.join("\n")} onChange={(e) => updateGlobal({ skillPaths: e.target.value.split("\n") })} /></label>
    </details>
    <details><summary>本地文件位置</summary><p>配置：{settings.configDirectory}</p><p>Logos：{settings.domainDirectory}</p><p>API Key 保存在 VS Code 本机凭据存储中，每条配置独立保存。</p></details>
    <div className="settings-actions">
      <button className="settings-save" disabled={pending || busy} onClick={() => { setPending(true); setNotice("正在保存…"); post({ type: "settings/save", systemPrompt: settings.systemPrompt, appendPrompt: settings.appendPrompt, skillsEnabled: settings.skillsEnabled, skillPaths: settings.skillPaths }); }}>保存全局设置</button>
      <button onClick={onClose}>返回聊天</button>
    </div>
    {busy ? <p>请先停止当前任务，再保存设置。</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
