import type { Jobs, Run } from "../server/jobs.ts";
const obj=(v:unknown):Record<string,unknown>=>v && typeof v==="object"?v as Record<string,unknown>:{};
const text=(v:unknown):string=>typeof v==="string"?v:Array.isArray(v)?v.map(x=>typeof obj(x).text==="string"?obj(x).text:"").filter(Boolean).join("\n"):"";
export class Events {
  failed=false;settled=false;private sequence=0;private assistant?:string;private tools=new Map<string,Record<string,unknown>>();
  private readonly jobs:Jobs;private readonly run:Run;
  constructor(jobs:Jobs,run:Run){this.jobs=jobs;this.run=run;}
  record(record:Record<string,unknown>):void{
    const message=obj(record.message),type=record.type;
    if(type==="agent_start")this.emit({type:"runtime/status",status:"running"});
    if(type==="agent_settled"){this.settled=true;return;}
    if(type==="message_start" && message.role==="assistant"){this.assistant=this.run.id+"-assistant-"+(++this.sequence);this.emit({type:"message/started",id:this.assistant});}
    if(type==="message_update"){
      const event=obj(record.assistantMessageEvent);
      if(event.type==="text_delta" && typeof event.delta==="string"){
        this.assistant??=this.run.id+"-assistant-"+(++this.sequence);
        this.emit({type:"message/text_delta",id:this.assistant,delta:event.delta});
      }
    }
    if(type==="message_end" && message.role==="assistant"){
      const failed=message.stopReason==="error" || message.stopReason==="length" || typeof message.errorMessage==="string";
      this.failed ||= failed;
      const content=text(message.content) || (failed?String(message.errorMessage??"模型输出未完成"):"");
      this.emit({type:"message/completed",id:this.assistant??this.run.id+"-assistant-"+(++this.sequence),text:content,isError:failed});
      this.assistant=undefined;
    }
    if(typeof type==="string" && type.startsWith("tool_execution_")){
      const id=String(record.toolCallId??this.run.id+"-tool-"+(++this.sequence));
      const status=type==="tool_execution_end"?(record.isError?"error":"completed"):"running";
      const tool={...this.tools.get(id),id,name:String(record.toolName??"tool"),...(record.args!==undefined?{args:record.args}:{}),
        ...(record.result!==undefined || record.partialResult!==undefined?{output:record.result??record.partialResult}:{}),status,durationMs:record.durationMs};
      this.tools.set(id,tool);
      this.emit({type:type==="tool_execution_start"?"tool/started":type==="tool_execution_end"?"tool/completed":"tool/updated",tool});
    }
    if(type==="extension_error"){this.failed=true;this.emit({type:"runtime/error",message:String(record.error??"运行扩展失败"),fatal:false});}
  }
  private emit(payload:Record<string,unknown>):void{
    // Bound individual browser events; full tool output stays in the session transcript.
    if(JSON.stringify(payload).length>256*1024 && payload.tool){const tool=obj(payload.tool);payload={...payload,tool:{...tool,output:"工具输出过大，请查看项目文件。"}};}
    this.jobs.event(this.run.id,payload);
  }
}
