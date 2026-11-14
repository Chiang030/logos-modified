import { useEffect,useState,type ReactElement } from "react";
import { api } from "./api";
import { OpenAiLogin } from "./openai";
interface Connection {id?:string;name:string;baseUrl:string;protocol:string;models:string[];visionModels?:string[];enabled:boolean;contextWindow:number;maxTokens:number;reasoning:boolean;version?:number;hasKey?:boolean;authType?:"api-key"|"openai-chatgpt";}
interface UsageRow {owner:string;name:string;connection_name:string;model:string;calls:number;failures:number;unknown:number;input:number;output:number;cacheRead:number;cacheWrite:number;total:number;}
interface RequestRow {id:string;name:string;model:string;run:string;created:number;status:string;known:number;total:number;}
interface Report {rows:UsageRow[];requests:RequestRow[];users:{id:string;name:string}[];}
const empty=():Connection=>({name:"",baseUrl:"",protocol:"openai-completions",models:[],enabled:true,contextWindow:128000,maxTokens:8192,reasoning:false,authType:"api-key"});
const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const number=(n:number)=>n.toLocaleString("zh-CN");
export function AdminPanel({close}:{close:()=>void}):ReactElement {
  const [tab,setTab]=useState("models"),[connections,setConnections]=useState<Connection[]>([]),[entry,setEntry]=useState<Connection>(empty);
  const [key,setKey]=useState(""),[modelText,setModelText]=useState(""),[visionText,setVisionText]=useState(""),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
  const [start,setStart]=useState(today().slice(0,8)+"01"),[end,setEnd]=useState(today()),[user,setUser]=useState(""),[model,setModel]=useState(""),[report,setReport]=useState<Report>();
  const [status,setStatus]=useState<{ready:boolean;reason:string;active:{count:number};queued:{count:number}}>();
  const parameters=()=>new URLSearchParams({start,end,user,model}).toString();
  const load=async():Promise<void>=>{setConnections((await api<{connections:Connection[]}>("/api/admin/models")).connections);setStatus(await api("/api/admin/status"));};
  useEffect(()=>{void load().catch(e=>setNotice(e.message));},[]);
  const select=(c:Connection):void=>{setEntry(c);setModelText(c.models.join("\n"));setVisionText((c.visionModels ?? []).join("\n"));setKey("");setNotice("");};
  const usage=async():Promise<void>=>{setBusy(true);try{setReport(await api("/api/admin/usage?"+parameters()));}catch(e){setNotice((e as Error).message);}finally{setBusy(false);}};
  const save=async():Promise<void>=>{
    setBusy(true);setNotice("");
    try{
      const result=await api<{connection:Connection}>("/api/admin/models",{...entry,models:modelText.split(/[\n,]/).map(s=>s.trim()).filter(Boolean),visionModels:visionText.split(/[\n,]/).map(s=>s.trim()).filter(Boolean),...(key?{apiKey:key}:{})});
      select(result.connection);await load();setNotice("配置已保存。密钥不会返回浏览器；正在运行的任务继续使用启动时的配置。");
    }catch(e){setNotice((e as Error).message);}finally{setBusy(false);}
  };
  const check=async():Promise<void>=>{
    if(!entry.id)return;setBusy(true);
    try{const r=await api<{ok:boolean;message:string;models?:string[]}>("/api/admin/models/test",{id:entry.id});setNotice(r.message+(r.models?.length?"；可用模型："+r.models.join("、"):""));}
    catch(e){setNotice((e as Error).message);}finally{setBusy(false);}
  };
  return <div className="admin-shade"><section className="admin-panel" role="dialog" aria-modal="true" aria-label="管理员控制台">
    <header><div><h1>管理员控制台</h1><p>统一模型配置 · 按账号统计用量</p></div><button onClick={close} aria-label="关闭管理员控制台">×</button></header>
    <div className="admin-status">{status?.reason??"读取服务状态…"}<span>运行 {status?.active.count??0} / 5 · 排队 {status?.queued.count??0}</span></div>
    <nav><button className={tab==="models"?"active":""} onClick={()=>setTab("models")}>模型 API</button><button className={tab==="usage"?"active":""} onClick={()=>{setTab("usage");void usage();}}>用户用量</button></nav>
    {notice?<p className="admin-notice" role="status">{notice}</p>:null}
    {tab==="models"?<div className="admin-models"><aside><button className="primary" onClick={()=>select(empty())}>＋ 新建连接</button><button onClick={()=>select({...empty(),name:"ChatGPT",authType:"openai-chatgpt",baseUrl:"https://api.openai.com/v1",protocol:"openai-responses"})}>＋ ChatGPT 账号连接</button>{connections.map(c=><button key={c.id} className={entry.id===c.id?"selected":""} onClick={()=>select(c)}><strong>{c.name}</strong><small>{c.enabled?"已开放":"已停用"} · {c.models.length} 个模型</small></button>)}</aside>
      <form onSubmit={e=>{e.preventDefault();void save();}}>
        <label>连接名称<input required value={entry.name} onChange={e=>setEntry({...entry,name:e.target.value})} placeholder="例如：公司模型服务" /></label>
        <label>身份验证<select value={entry.authType??"api-key"} onChange={e=>{setKey("");setEntry({...entry,authType:e.target.value as Connection["authType"],...(e.target.value==="openai-chatgpt"?{baseUrl:"https://api.openai.com/v1",protocol:"openai-responses"}:{})});}}><option value="api-key">API Key</option><option value="openai-chatgpt">ChatGPT 账号授权</option></select></label>
        {entry.authType==="openai-chatgpt"?<OpenAiLogin key={entry.id??"new-account"} onModels={ids=>{setModelText(ids.slice(0,3).join("\n"));}} />:null}
        <label>接口协议<select disabled={entry.authType==="openai-chatgpt"} value={entry.protocol} onChange={e=>setEntry({...entry,protocol:e.target.value})}><option value="openai-completions">OpenAI 兼容 Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
        <label>API 地址<input required readOnly={entry.authType==="openai-chatgpt"} type="url" value={entry.baseUrl} onChange={e=>setEntry({...entry,baseUrl:e.target.value})} placeholder="填写服务商提供的 API Base URL" /><small>{entry.authType==="openai-chatgpt"?"账号授权直接连接 OpenAI 官方接口。":"OpenAI 兼容接口通常包含 /v1；Anthropic 填服务根地址。"}</small></label>
        {entry.authType!=="openai-chatgpt"?<label>API Key<input type="password" autoComplete="new-password" value={key} onChange={e=>setKey(e.target.value)} placeholder={entry.hasKey?"已保存；留空保留原密钥":"填写 API Key"} /></label>:null}
        <label>开放的模型 ID<textarea required rows={4} value={modelText} onChange={e=>setModelText(e.target.value)} placeholder="每行一个模型 ID，以服务商提供的名称为准" /></label>
        <label>额外声明支持图片的模型 ID<textarea rows={2} value={visionText} onChange={e=>setVisionText(e.target.value)} placeholder="仅填写服务商已确认支持图像输入的开放模型 ID" /><small>已收录的模型按本机能力目录识别；私有模型或自定义别名需要明确声明。勾选并不能让纯文本模型获得视觉能力。</small></label>
        <div className="admin-form-row"><label>上下文窗口<input type="number" min={1024} max={4000000} value={entry.contextWindow} onChange={e=>setEntry({...entry,contextWindow:Number(e.target.value)})} /></label><label>最大输出 tokens<input type="number" min={128} max={200000} value={entry.maxTokens} onChange={e=>setEntry({...entry,maxTokens:Number(e.target.value)})} /></label></div>
        <div className="admin-checks"><label><input type="checkbox" checked={entry.enabled} onChange={e=>setEntry({...entry,enabled:e.target.checked})} />允许用户使用</label><label><input type="checkbox" checked={entry.reasoning} onChange={e=>setEntry({...entry,reasoning:e.target.checked})} />支持思考档位</label></div>
        <div className="admin-buttons"><button className="primary" disabled={busy}>{busy?"处理中…":"保存配置"}</button><button type="button" disabled={busy||!entry.id} onClick={()=>void check()}>检查连接 / 列出模型</button></div>
      </form></div>:<div className="admin-usage">
        <div className="usage-filters"><label>开始日期<input type="date" value={start} onChange={e=>setStart(e.target.value)} /></label><label>结束日期<input type="date" value={end} onChange={e=>setEnd(e.target.value)} /></label>
          <label>用户<select value={user} onChange={e=>setUser(e.target.value)}><option value="">全部用户</option>{report?.users.map(u=><option value={u.id} key={u.id}>{u.name}</option>)}</select></label><label>模型<input value={model} onChange={e=>setModel(e.target.value)} placeholder="全部模型" /></label>
          <button className="primary" disabled={busy} onClick={()=>void usage()}>查询</button><a className="admin-export" href={"/api/admin/usage.csv?"+parameters()}>导出 CSV</a></div>
        <p className="usage-note">日期按北京时间。输入包含缓存 tokens，缓存列是其中的分类，不再重复加入总量；缺失上游用量的请求单独标为未知。</p>
        <div className="usage-table"><table><thead><tr>{["用户","连接 / 模型","请求","失败 / 中断","未知用量","输入","输出","缓存读取","缓存写入","总 tokens"].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{report?.rows.map((r,i)=><tr key={i}><td>{r.name}</td><td>{r.connection_name}<small>{r.model}</small></td>{[r.calls,r.failures,r.unknown,r.input,r.output,r.cacheRead,r.cacheWrite,r.total].map((n,j)=><td key={j}>{number(n)}</td>)}</tr>)}</tbody></table>{!report?.rows.length?<p className="empty-note">此时间范围暂无模型用量。</p>:null}</div>
        <details><summary>最近请求明细（最多 500 条）</summary><div className="usage-table"><table><thead><tr><th>时间</th><th>用户</th><th>模型</th><th>状态</th><th>tokens</th><th>任务 ID</th></tr></thead><tbody>{report?.requests.map(r=><tr key={r.id}><td>{new Date(r.created).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</td><td>{r.name}</td><td>{r.model}</td><td>{r.status}</td><td>{r.known?number(r.total):"未知"}</td><td>{r.run}</td></tr>)}</tbody></table></div></details>
      </div>}
  </section></div>;
}
