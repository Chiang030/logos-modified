import { useEffect, useState, type ReactElement } from "react";
import type { SettingsView, ApiProtocol, ExtensionToWebviewMessage } from "../../../src/shared/protocol";
import { DEFAULT_PROVIDER_ID, PROVIDER_PRESETS, presetById, type ProviderId } from "../../../src/shared/providerPresets";

type Props = { open: boolean; busy: boolean; onOpen: () => void; onClose: () => void; post: (message: unknown) => void };

type LoginPhase = "" | "waiting" | "exchanging";

/** 选预设：自动填 baseUrl/协议并重置为兜底模型列表；选自定义：仅切换标记，保留现值。 */
function presetSelection(modelId: string, id: ProviderId): Partial<SettingsView> {
  const preset = presetById(id);
  if (!preset) return { providerId: "custom" };
  const modelIds = [...preset.fallbackModels];
  return { providerId: id, baseUrl: preset.baseUrl, api: preset.api,
    modelIds, modelId: modelIds.includes(modelId) ? modelId : modelIds[0] };
}

export function SettingsPanel({ open, busy, onOpen, onClose, post }: Props): ReactElement | null {
  const [settings, setSettings] = useState<SettingsView>();
  const [apiKey, setApiKey] = useState("");
  const [deleteKey, setDeleteKey] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [modelSource, setModelSource] = useState<"upstream" | "fallback">("upstream");
  const [loginPhase, setLoginPhase] = useState<LoginPhase>("");
  const [manualUrl, setManualUrl] = useState("");
  useEffect(() => {
    const receive = (event: MessageEvent<ExtensionToWebviewMessage>): void => {
      const message = event.data;
      if (message.type === "settings/loaded") {
        setSettings(message.settings); setApiKey(""); setDeleteKey(false); setLoginPhase(""); setManualUrl(""); setModelSource("upstream");
        if (!message.settings.baseUrl) {
          setSettings({ ...message.settings, ...presetSelection(message.settings.modelId, DEFAULT_PROVIDER_ID) });
          onOpen();
        }
      } else if (message.type === "settings/models") {
        setSettings((current) => current ? { ...current, modelIds: message.modelIds,
          modelId: message.modelIds.includes(current.modelId) ? current.modelId : message.modelIds[0] } : current);
        setModelSource(message.source); setPending(false);
        setNotice(message.source === "fallback"
          ? "上游模型接口不可用，已显示预设模型列表（可手动输入其他模型 ID）。"
          : `已获取 ${message.modelIds.length} 个模型，请选择后保存。`);
      } else if (message.type === "settings/openaiLoginStatus") {
        if (message.phase === "done") { setLoginPhase(""); setNotice("ChatGPT 登录完成，请选择模型后保存。"); }
        else setLoginPhase(message.phase);
      } else if (message.type === "settings/saved") {
        setPending(false); setNotice("已保存到本地，运行时将使用此配置。");
      } else if (message.type === "settings/error") { setPending(false); setLoginPhase(""); setNotice(message.message); }
    };
    window.addEventListener("message", receive);
    post({ type: "settings/load" });
    return () => window.removeEventListener("message", receive);
  }, []);
  if (!open) return null;
  const update = (value: Partial<SettingsView>): void => { setSettings((current) => current ? { ...current, ...value } : current); setNotice(""); };
  const selectProvider = (id: ProviderId): void => { setApiKey(""); setDeleteKey(false); update(presetSelection(settings?.modelId ?? "", id)); };
  if (!settings) return <section className="logos-settings" aria-label="LOGOS 设置">
    <div className="settings-heading"><strong>LOGOS 设置</strong><button onClick={onClose} aria-label="关闭设置">×</button></div>
    <p>正在加载本地配置…</p>
  </section>;
  const providerValue = settings.providerId === "custom" && !settings.baseUrl ? DEFAULT_PROVIDER_ID : settings.providerId;
  const openAi = settings.providerId === "openai-chatgpt";
  return <section className="logos-settings" aria-label="LOGOS 设置">
    <div className="settings-heading"><strong>LOGOS 设置</strong><button onClick={onClose} aria-label="关闭设置">×</button></div>
    <>
      <p>选择模型服务，配置后选择模型并保存。</p>
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
        <label>API URL<input value={settings.baseUrl} placeholder="https://example.com/v1" onChange={(e) => update({ baseUrl: e.target.value, providerId: "custom", modelIds: [] })} /></label>
        <label>API 协议<select value={settings.api} onChange={(e) => update({ api: e.target.value as ApiProtocol, modelIds: [] })}>
          <option value="openai-completions">OpenAI Chat Completions / 兼容服务</option><option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option>
        </select></label>
        <label>API Key<input type="password" autoComplete="off" value={apiKey} placeholder={settings.hasApiKey ? "已保存，留空保留原 Key" : "输入 API Key（本地无认证服务可留空）"} onChange={(e) => { setApiKey(e.target.value); setDeleteKey(false); }} /></label>
        {settings.hasApiKey ? <label className="settings-check"><input type="checkbox" checked={deleteKey} onChange={(e) => setDeleteKey(e.target.checked)} />删除已保存的 API Key</label> : null}
      </>}
      <button disabled={pending || !settings.baseUrl.trim()} onClick={() => { setPending(true); setNotice("正在向上游获取模型…"); post({ type: "settings/models", baseUrl: settings.baseUrl, api: settings.api, apiKey: openAi || deleteKey ? "" : apiKey || undefined }); }}>获取上游模型</button>
      {settings.modelIds.length ? <label>选择模型{modelSource === "fallback" ? <span className="settings-badge">预设列表</span> : null}<select value={settings.modelId} onChange={(e) => update({ modelId: e.target.value })}><option value="">请选择</option>{settings.modelIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label> : null}
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
    </>
  </section>;
}
