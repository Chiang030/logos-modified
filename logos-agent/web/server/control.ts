import type { IncomingMessage,ServerResponse } from "node:http";
import type { Software } from "./software.ts";
import type { Store,User } from "./store.ts";
import { Models } from "./models.ts";
import { Jobs } from "./jobs.ts";
import { Meter,csv } from "./usage.ts";
import { body,json } from "./http.ts";
import { HttpError,text } from "./errors.ts";

export interface Control {store:Store;models:Models;jobs:Jobs;meter:Meter;software:Software;}
export async function control(s:Control,user:User,url:URL,req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const path=url.pathname,method=req.method;
  if(path.startsWith("/api/admin/") && !user.admin)throw new HttpError(403,"此功能仅管理员可用");
  if(path==="/api/admin/openai" && method==="GET"){json(res,s.models.openAi.status());return true;}
  if(path==="/api/admin/openai/login" && method==="POST"){json(res,await s.models.openAi.begin(user.id));return true;}
  if(path==="/api/admin/openai/login" && method==="GET"){json(res,s.models.openAi.progress(user.id,text(url.searchParams.get("id"),"授权请求")));return true;}
  if(path==="/api/admin/openai/callback" && method==="POST"){
    const input=await body(req);json(res,await s.models.openAi.complete(user.id,text(input.id,"授权请求"),text(input.callback,"授权回调地址",8192)));return true;
  }
  if(path==="/api/admin/openai/cancel" && method==="POST"){
    const input=await body(req);s.models.openAi.cancel(user.id,text(input.id,"授权请求"));json(res,{ok:true});return true;
  }
  if(path==="/api/admin/openai/logout" && method==="POST"){s.models.openAi.logout();json(res,{connected:false});return true;}
  if(path==="/api/admin/openai/models" && method==="POST"){json(res,{models:await s.models.openAi.listModels()});return true;}
  if(path==="/api/software" && method==="GET"){json(res,await s.software.status());return true;}
  if(path==="/api/software/scan" && method==="POST"){
    const input=await body(req);void s.software.scan(input.global===true);json(res,{scanning:true},202);return true;
  }
  if(path==="/api/software/path" && method==="POST"){
    const input=await body(req);
    if(typeof input.path!=="string")throw new HttpError(400,"程序路径无效");
    await s.software.setPath(text(input.product,"软件类型"),input.path);json(res,await s.software.status());return true;
  }
  if(path==="/api/models" && method==="GET"){
    json(res,{models:s.models.list().filter(c=>c.enabled && (c.authType!=="openai-chatgpt" || c.hasKey)).flatMap(c=>c.models.map(id=>({provider:c.id,id,name:id,connectionId:c.id,connectionName:c.name,contextWindow:c.contextWindow,reasoning:c.reasoning}))),...s.jobs.health()});return true;
  }
  if(path==="/api/runs" && method==="GET"){
    const session=url.searchParams.get("session")??undefined;if(session)s.store.session(user.id,session);
    json(res,{runs:s.jobs.list(user.id,session),...s.jobs.health()});return true;
  }
  if(path==="/api/events" && method==="GET"){
    const after=Number(url.searchParams.get("after")??0);if(!Number.isSafeInteger(after)||after<0)throw new HttpError(400,"事件序号无效");
    json(res,{events:s.jobs.events(user.id,text(url.searchParams.get("session"),"会话"),after)});return true;
  }
  if(path==="/api/cancel" && method==="POST"){const input=await body(req);s.jobs.cancel(user.id,text(input.run,"任务"));json(res,{ok:true});return true;}
  if(path==="/api/admin/models" && method==="GET"){json(res,{connections:s.models.list()});return true;}
  if(path==="/api/admin/models" && method==="POST"){json(res,{connection:s.models.save(await body(req))});return true;}
  if(path==="/api/admin/models/test" && method==="POST"){
    const input=await body(req),connection=s.models.get(text(input.id,"连接"));
    if(connection.authType==="openai-chatgpt"){
      try{json(res,{ok:true,models:await s.models.openAi.listModels(),message:"ChatGPT 账号连接成功，尚未调用模型生成内容"});}
      catch(error){json(res,{ok:false,message:error instanceof HttpError?error.message:"无法连接 OpenAI 服务，请检查服务器网络"});}return true;
    }
    const key=await s.models.accessToken(connection.id);
    const headers:Record<string,string>={Accept:"application/json"};
    if(connection.protocol==="anthropic-messages"){headers["x-api-key"]=key;headers["anthropic-version"]="2023-06-01";}else headers.Authorization="Bearer "+key;
    const suffix=connection.protocol==="anthropic-messages"?"/v1/models":"/models";
    const base=connection.protocol==="anthropic-messages"?connection.baseUrl.replace(/\/v1$/,""):connection.baseUrl;
    try{
      const response=await fetch(base+suffix,{headers,signal:AbortSignal.timeout(15000),redirect:"error"});
      if(!response.ok){await response.body?.cancel();json(res,{ok:false,message:"模型列表接口返回 HTTP "+response.status+"；请检查配置，或确认服务是否支持列举模型。"});return true;}
      const data=await response.json() as {data?:{id?:string}[]};
      json(res,{ok:true,models:Array.isArray(data.data)?data.data.map(m=>m.id).filter(id=>typeof id==="string").slice(0,500):[],message:"连接成功，尚未调用模型生成内容"});return true;
    }catch{json(res,{ok:false,message:"无法连接模型服务，请检查服务器网络和 API 地址"});return true;}
  }
  if((path==="/api/admin/usage" || path==="/api/admin/usage.csv") && method==="GET"){
    const start=day(url.searchParams.get("start"),new Date(Date.now()+8*3600000).toISOString().slice(0,8)+"01");
    const end=day(url.searchParams.get("end"),new Date(Date.now()+8*3600000).toISOString().slice(0,10))+86400000;
    if(end<=start || end-start>366*86400000)throw new HttpError(400,"日期范围须为 1–366 天");
    const report=s.meter.report(start,end,url.searchParams.get("user")??"",url.searchParams.get("model")??"");
    if(path.endsWith(".csv")){
      res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="logos-usage.csv"',"Cache-Control":"no-store"});
      res.end(csv((report as {rows:Record<string,unknown>[]}).rows));
    }else json(res,report);return true;
  }
  if(path==="/api/admin/status" && method==="GET"){
    json(res,{...s.jobs.health(),maxConcurrent:5,active:s.store.db.prepare("SELECT COUNT(*) count FROM runs WHERE status IN ('starting','running','cancelling')").get(),
      queued:s.store.db.prepare("SELECT COUNT(*) count FROM runs WHERE status='queued'").get()});return true;
  }
  return false;
}
function day(value:string|null,fallback:string):number {
  const date=value??fallback;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new HttpError(400,"日期格式无效");
  const result=Date.parse(date+"T00:00:00+08:00");if(!Number.isFinite(result))throw new HttpError(400,"日期无效");return result;
}
export function prompt(value:unknown):string {
  if(typeof value!=="string" || !value.trim() || value.length>20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new HttpError(400,"消息不能为空或超过 20000 字符");
  return value.trim();
}
