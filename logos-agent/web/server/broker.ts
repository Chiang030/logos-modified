import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { chmod, unlink } from "node:fs/promises";
import { once } from "node:events";
import type { Connection, Protocol } from "./models.ts";
import type { Run } from "./jobs.ts";
import { Meter, normalize } from "./usage.ts";

const object=(v:unknown):Record<string,unknown>=>v && typeof v==="object" && !Array.isArray(v)?v as Record<string,unknown>:{};
export class UsageObserver {
  private pending=""; private raw:Record<string,unknown>={};
  failed=false;completed=false;
  private readonly protocol:Protocol; private readonly meter:Meter; private readonly requestId:string;
  constructor(protocol:Protocol,meter:Meter,requestId:string) {this.protocol=protocol;this.meter=meter;this.requestId=requestId;}
  accept(value:unknown):void {
    const event=object(value),message=object(event.message),response=object(event.response);
    if(event.error || event.type==="error" || event.type==="response.failed")this.failed=true;
    if(event.type==="response.completed" || event.type==="message_stop" || (Array.isArray(event.choices) && event.choices.some(choice=>object(choice).finish_reason!=null)))this.completed=true;
    const usage=object(event.usage ?? message.usage ?? response.usage);
    if(!Object.keys(usage).length)return;
    this.raw={...this.raw,...usage};
    const normalized=normalize(this.protocol,this.raw);
    if(normalized)this.meter.update(this.requestId,normalized);
  }
  push(text:string):void {
    this.pending+=text;
    if(this.pending.length>2*1024*1024)throw new Error("Upstream event too large");
    let newline:number;
    while((newline=this.pending.indexOf("\n"))>=0){
      const line=this.pending.slice(0,newline).trim();this.pending=this.pending.slice(newline+1);
      if(line==="data: [DONE]")this.completed=true;
      if(line.startsWith("data:") && line.slice(5).trim()!=="[DONE]"){
        try{this.accept(JSON.parse(line.slice(5).trim()));}catch(error){if(!(error instanceof SyntaxError))throw error;}
      }
    }
  }
  finish():void {if(this.pending)this.push("\n");}
}
export interface Broker { close():Promise<void>; }
export async function modelBroker(socket:string,connection:Connection,key:string,run:Run,meter:Meter):Promise<Broker> {
  const controllers=new Set<AbortController>();
  const server=createServer((request,response)=>{
    void handle(request,response).catch(()=>{if(!response.headersSent)response.writeHead(502,{"Content-Type":"application/json"});response.end('{"error":{"message":"模型代理请求失败，请检查管理员配置"}}');});
  });
  async function handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    const expected=connection.protocol==="anthropic-messages"?"/v1/messages":connection.protocol==="openai-responses"?"/responses":"/chat/completions";
    if(req.method!=="POST" || req.url!==expected){res.writeHead(404);res.end();return;}
    const chunks:Buffer[]=[];let size=0;
    for await(const piece of req){const chunk=Buffer.from(piece);size+=chunk.length;if(size>16*1024*1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    let input:Record<string,unknown>;try{input=object(JSON.parse(Buffer.concat(chunks).toString()));}catch{res.writeHead(400);res.end();return;}
    if(input.model!==run.model){res.writeHead(403);res.end('{"error":{"message":"模型不属于当前任务"}}');return;}
    if(connection.protocol==="openai-completions" && input.stream===true)input.stream_options={...object(input.stream_options),include_usage:true};
    const id=meter.start(run,connection.name,connection.protocol,connection.version),observer=new UsageObserver(connection.protocol,meter,id);
    const controller=new AbortController();controllers.add(controller);
    const timeout=setTimeout(()=>controller.abort(),15*60_000);
    res.on("close",()=>{if(!res.writableEnded)controller.abort();});
    try{
      const headers:Record<string,string>={"Content-Type":"application/json",Accept:"application/json, text/event-stream"};
      if(connection.protocol==="anthropic-messages"){headers["x-api-key"]=key;headers["anthropic-version"]="2023-06-01";}
      else headers.Authorization="Bearer "+key;
      const base=connection.protocol==="anthropic-messages"?connection.baseUrl.replace(/\/v1$/,""):connection.baseUrl;
      const upstream=await fetch(base+expected,{method:"POST",headers,body:JSON.stringify(input),signal:controller.signal,redirect:"error"});
      const contentType=upstream.headers.get("content-type")??"application/json";
      if(!upstream.ok){
        // Error bodies can echo upstream credentials. Never return them to sandbox code.
        meter.finish(id,"failed");await upstream.body?.cancel();
        res.writeHead(upstream.status,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{message:"上游模型请求失败（HTTP "+upstream.status+"），请管理员检查连接、模型与额度"}}));return;
      }
      res.writeHead(200,{"Content-Type":contentType,"Cache-Control":"no-store"});
      if(!upstream.body)throw new Error("Missing provider body");
      const stream=contentType.includes("text/event-stream"),decoder=new TextDecoder();
      let jsonText="";
      for await(const bytes of upstream.body as unknown as AsyncIterable<Uint8Array>){
        const part=decoder.decode(bytes,{stream:true});
        if(stream)observer.push(part);else{jsonText+=part;if(jsonText.length>16*1024*1024)throw new Error("Provider body too large");}
        if(!res.write(bytes))await once(res,"drain",{signal:controller.signal});
      }
      if(stream){observer.push(decoder.decode());observer.finish();}else observer.accept(JSON.parse(jsonText+decoder.decode()));
      meter.finish(id,observer.failed?"failed":"completed");res.end();
    }catch{meter.finish(id,observer.failed?"failed":observer.completed?"completed":controller.signal.aborted?"cancelled":"failed");if(!res.headersSent)res.writeHead(502);res.destroy();}
    finally{clearTimeout(timeout);controllers.delete(controller);}
  }
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socket,()=>{server.off("error",reject);resolve();});});
  try{await chmod(socket,0o600);}catch(error){await stop(server);await unlink(socket).catch(()=>undefined);throw error;}
  return {async close(){for(const controller of controllers)controller.abort();await stop(server);await unlink(socket).catch(()=>undefined);}};
}
async function stop(server:Server):Promise<void>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
