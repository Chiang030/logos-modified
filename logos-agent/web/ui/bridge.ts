import type { HostBridge } from "../../vscode-extension/webview-ui/src/hostBridge";
import type { ExtensionToWebviewMessage, ModelOption } from "../../vscode-extension/webview-ui/src/protocol";
import { api, type Conversation, type Project, type User } from "./api";

interface Run {id:string;status:string;error?:string;created:number;}
export class BrowserBridge implements HostBridge {
  listeners=new Set<(message:ExtensionToWebviewMessage)=>void>();
  project:Project;user:User;preview:boolean;version:string;notice:(message:string)=>void;openFile:(path:string)=>void;openAdmin:()=>void;
  active?:string;private models:ModelOption[]=[];private selected?:ModelOption;private thinking="off";
  private generation=0;private sequence=0;private timer?:number;private run?:Run;private healthy=false;
  constructor(project:Project,user:User,preview:boolean,version:string,notice:(message:string)=>void,openFile:(path:string)=>void,openAdmin:()=>void){
    this.project=project;this.user=user;this.preview=preview;this.version=version;this.notice=notice;this.openFile=openFile;this.openAdmin=openAdmin;
  }
  subscribe(listener:(message:ExtensionToWebviewMessage)=>void):()=>void{
    this.listeners.add(listener);return ()=>{this.listeners.delete(listener);if(!this.listeners.size){this.generation++;window.clearTimeout(this.timer);}};
  }
  emit(message:ExtensionToWebviewMessage):void{for(const listener of this.listeners)listener(message);}
  identity():void{this.emit({type:"identity/loaded",identity:{selected:this.user,members:[this.user],summaries:[],models:[],recordFile:""}});}
  postMessage(value:unknown):void{
    void this.command(value as Record<string,unknown>).catch((error:unknown)=>{
      const message=error instanceof Error?error.message:"操作失败";
      this.emit({type:"runtime/error",message,fatal:false});this.notice(message);
    });
  }
  async command(command:Record<string,unknown>):Promise<void>{
    switch(command.type){
      case "webview/ready":{
        this.identity();this.emit({type:"extension/info",version:this.version});this.emit({type:"session/loading",loading:false});
        await this.catalog();await this.history();
        if(this.active)await this.selectSession(this.active);else this.status();return;
      }
      case "identity/load":this.identity();this.notice("当前身份来自企业登录，用量按此账号记录");return;
      case "settings/load":if(this.user.admin && !this.preview)this.openAdmin();else this.notice("模型 API 由管理员统一设置，请联系管理员维护");return;
      case "software/scan":this.emit({type:"software/error",message:"工具在服务器隔离环境中运行"});this.notice("工具在服务器隔离环境中运行；可让助手检查当前任务可用的命令");return;
      case "diagnostics/open":this.notice(this.run?"任务状态："+this.run.status:"当前没有运行中的任务");return;
      case "link/open":{
        const href=String(command.href??"");
        if(/^https?:\/\//i.test(href)){window.open(href,"_blank","noopener,noreferrer");return;}
        if(/^[a-z][a-z\d+.-]*:/i.test(href)||href.startsWith("//"))throw new Error("该文件链接不支持打开");
        this.openFile(href.replace(/^\/workspace\//,"").replace(/^\.\//,""));return;
      }
      case "model/select":{
        const selected=this.models.find(m=>m.provider===command.provider && m.id===command.modelId);
        if(!selected)throw new Error("模型不可用");this.selected=selected;if(!selected.reasoning)this.thinking="off";
        localStorage.setItem("logos-model-"+this.user.id+"-"+this.project.id,JSON.stringify({provider:selected.provider,id:selected.id}));
        this.config();return;
      }
      case "thinking/select":this.thinking=String(command.level);this.config();return;
      case "session/new":{
        if(this.preview){this.emit({type:"session/reset"});return;}
        const result=await api<{session:Conversation}>("/api/sessions",{project:this.project.id});
        await this.selectSession(result.session.id);await this.history();return;
      }
      case "session/select":{
        const sessions=await this.history();if(!sessions.some(s=>s.id===command.sessionId))throw new Error("会话不存在");
        await this.selectSession(String(command.sessionId));await this.history();return;
      }
      case "chat/send":{
        if(this.preview)throw new Error("这是只读界面预览，没有提交任务");
        await this.catalog();if(!this.selected)throw new Error("管理员尚未开放模型，请先配置 API");
        if(!this.active){const result=await api<{session:Conversation}>("/api/sessions",{project:this.project.id});await this.selectSession(result.session.id);}
        const input={project:this.project.id,command:{type:"chat/send",text:command.text,session:this.active,connection:this.selected.provider,model:this.selected.id,thinking:this.thinking,requestKey:crypto.randomUUID()}};
        const submit=()=>api<{run:Run}>("/api/bridge",input);
        let result;try{result=await submit();}catch(error){if(!(error instanceof TypeError))throw error;result=await submit();}
        this.run=result.run;this.emit({type:"runtime/status",status:"starting",detail:"排队中"});
        await this.history();return;
      }
      case "chat/abort":if(this.run && ["queued","starting","running","cancelling"].includes(this.run.status)){await api("/api/cancel",{run:this.run.id});this.notice("正在停止任务");}return;
      case "session/rename":if(!this.preview){await api("/api/bridge",{project:this.project.id,command});await this.history();}return;
      default:this.notice("此功能不适用于网页工作台");
    }
  }
  async catalog():Promise<void>{
    if(this.preview){this.config();return;}
    const result=await api<{models:ModelOption[];ready:boolean}>("/api/models");this.models=result.models;this.healthy=result.ready;
    const previous=this.selected;
    let saved:{provider?:string;id?:string}={};try{saved=JSON.parse(localStorage.getItem("logos-model-"+this.user.id+"-"+this.project.id)??"{}");}catch{}
    this.selected=this.models.find(m=>m.provider===(previous?.provider??saved.provider)&&m.id===(previous?.id??saved.id))??this.models[0];
    this.config();
  }
  private config():void{this.emit({type:"runtime/config",config:{models:this.models,activeModel:this.selected,thinkingLevel:this.thinking,thinkingLevels:this.selected?.reasoning?["off","minimal","low","medium","high"]:["off"]}});}
  private status():void{
    const status=this.run?.status;
    this.emit({type:"runtime/status",status:status==="queued"||status==="starting"?"starting":status==="running"?"running":status==="cancelling"?"stopping":this.healthy?"ready":"idle",detail:status==="queued"?"排队中":this.healthy?"任务服务就绪":"任务服务暂不可用"});
  }
  private async selectSession(id:string):Promise<void>{
    window.clearTimeout(this.timer);const generation=++this.generation;
    this.active=id;this.sequence=0;this.run=undefined;this.emit({type:"session/reset"});this.emit({type:"session/loading",loading:true});
    await this.poll(generation);
  }
  private async poll(generation:number):Promise<void>{
    if(generation!==this.generation || !this.active)return;
    let delay=1000;
    try{
      const result=await api<{events:{seq:number;payload:ExtensionToWebviewMessage}[]}>("/api/events?"+new URLSearchParams({session:this.active,after:String(this.sequence)}));
      if(generation!==this.generation)return;
      for(const event of result.events){this.emit(event.payload);this.sequence=event.seq;if(event.payload.type==="run/settled")window.dispatchEvent(new Event("logos-files-refresh"));}
      if(result.events.length===500){delay=0;return;}
      const state=await api<{runs:Run[];ready:boolean}>("/api/runs?session="+encodeURIComponent(this.active));
      if(generation!==this.generation)return;
      this.run=state.runs.find(r=>["queued","starting","running","cancelling"].includes(r.status));this.healthy=state.ready;
      this.status();this.emit({type:"session/loading",loading:false});delay=this.run?600:2000;
    }catch(error){if(generation===this.generation){this.emit({type:"session/loading",loading:false});this.notice(error instanceof Error?error.message:"连接中断，正在重连");delay=3000;}}
    finally{if(generation===this.generation)this.timer=window.setTimeout(()=>void this.poll(generation),delay);}
  }
  async history():Promise<Conversation[]>{
    const sessions=this.preview?[]:(await api<{sessions:Conversation[]}>("/api/sessions?project="+encodeURIComponent(this.project.id))).sessions;
    this.active??=sessions[0]?.id;
    this.emit({type:"session/list",sessions:sessions.map(s=>({sessionId:s.id,title:s.title})),activeSessionId:this.active});return sessions;
  }
}
