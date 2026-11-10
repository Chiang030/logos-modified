import { useEffect, useState, type ReactElement } from "react";
import { api } from "./api";

interface Progress { id: string; phase: string; url?: string; message?: string; connected: boolean; }
export function OpenAiLogin({ onModels }: { onModels(models: string[]): void }): ReactElement {
  const [connected,setConnected]=useState(false),[attempt,setAttempt]=useState<Progress>(),[callback,setCallback]=useState("");
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState("");
  useEffect(()=>{void api<{connected:boolean}>("/api/admin/openai").then(result=>setConnected(result.connected)).catch(()=>setNotice("无法读取账号状态"));},[]);
  useEffect(()=>{
    if(!attempt || !["waiting","exchanging"].includes(attempt.phase))return;
    const timer=window.setInterval(()=>{void api<Progress>("/api/admin/openai/login?id="+encodeURIComponent(attempt.id)).then(result=>{
      setAttempt(result);setConnected(result.connected);if(result.message)setNotice(result.message);
    }).catch(error=>setNotice((error as Error).message));},2000);
    return ()=>window.clearInterval(timer);
  },[attempt?.id,attempt?.phase]);
  const perform=async(action:()=>Promise<void>):Promise<void>=>{setBusy(true);setNotice("");try{await action();}catch(error){setNotice((error as Error).message);}finally{setBusy(false);}};
  const models=async():Promise<void>=>{
    const result=await api<{models:string[]}>("/api/admin/openai/models",{});onModels(result.models);
    setNotice(result.models.length?"已获取账号可用的对话模型，请检查下方模型列表并保存配置。":"账号已连接，但没有返回当前版本支持的对话模型，请检查账号权限。");
  };
  const complete=async():Promise<void>=>{
    const result=await api<Progress>("/api/admin/openai/callback",{id:attempt?.id,callback});setCallback("");setAttempt(result);setConnected(result.connected);
    if(result.phase!=="completed")throw new Error(result.message??"授权尚未完成，请重新登录");
    await models();
  };
  return <section className="admin-openai" aria-label="ChatGPT 账号授权">
    <p><strong>管理员 ChatGPT 账号</strong> · {connected?"已授权":"未登录"}</p>
    <p>管理员授权后供工作台统一调用，用量仍按飞书用户统计。</p>
    <div className="admin-buttons">
      <button type="button" disabled={busy} onClick={()=>void perform(async()=>{setCallback("");setAttempt(await api<Progress>("/api/admin/openai/login",{}));})}>{connected?"重新登录 ChatGPT":"登录 ChatGPT"}</button>
      {connected?<><button type="button" disabled={busy} onClick={()=>void perform(models)}>获取账号可用模型</button><button type="button" disabled={busy} onClick={()=>void perform(async()=>{await api("/api/admin/openai/logout",{});setConnected(false);setAttempt(undefined);setCallback("");})}>退出账号</button></>:null}
    </div>
    {attempt?.phase==="waiting"?<div>
      <p><a href={attempt.url} target="_blank" rel="noopener noreferrer">打开 ChatGPT 授权页面</a></p>
      <p>完成授权后，复制浏览器地址栏中以 http://127.0.0.1:1455/auth/callback 开头的完整地址，粘贴到下方。该页面显示无法访问时也可复制地址。</p>
      <label>授权后的完整回调地址<textarea value={callback} onChange={event=>setCallback(event.target.value)} autoComplete="off" spellCheck={false} rows={2} /></label>
      <div className="admin-buttons"><button type="button" disabled={busy||!callback.trim()} onClick={()=>void perform(complete)}>完成账号连接</button><button type="button" disabled={busy} onClick={()=>void perform(async()=>{await api("/api/admin/openai/cancel",{id:attempt.id});setAttempt(undefined);setCallback("");})}>取消授权</button></div>
    </div>:null}
    {attempt?.phase==="exchanging"?<p role="status">正在完成授权…</p>:null}
    {attempt?.phase==="failed"?<p role="alert">{attempt.message??"登录失败，请重试"}</p>:null}
    {notice?<p role="status">{notice}</p>:null}
  </section>;
}
