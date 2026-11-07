import { useEffect, useRef, type ReactElement } from "react";
import { SoftwarePanel } from "../../vscode-extension/webview-ui/src/components/SoftwarePanel";
import type { SoftwareDiscovery } from "../../pi-domain/src/software-discovery.mjs";
import { api } from "./api";
interface State {result?:SoftwareDiscovery;scanning:boolean;error:string;}
export function SoftwareDialog({scan,close}:{scan:boolean;close:()=>void}):ReactElement{
  const alive=useRef(true),timer=useRef<number|undefined>(undefined);
  const emit=(data:unknown):void=>{if(alive.current)window.dispatchEvent(new MessageEvent("message",{data}));};
  const show=(state:State):void=>{
    if(!alive.current)return;
    window.clearTimeout(timer.current);
    if(state.result)emit({type:"software/result",result:state.result});
    if(state.error)emit({type:"software/error",message:state.error});
    if(state.scanning){emit({type:"software/scanning"});timer.current=window.setTimeout(()=>void load().catch(fail),1000);}
  };
  const fail=(error:unknown):void=>emit({type:"software/error",message:error instanceof Error?error.message:"软件扫描失败"});
  const load=async():Promise<void>=>{const state=await api<State>("/api/software");if(alive.current)show(state);};
  const post=(value:unknown):void=>{
    const command=value as {type:string;refresh?:boolean;product?:string;path?:string};
    void (async()=>{
      if(command.type==="software/path"){show(await api<State>("/api/software/path",{product:command.product,path:command.path}));return;}
      if(command.type==="software/scan" || command.refresh){emit({type:"software/scanning"});await api("/api/software/scan",{global:command.type==="software/scan"});}
      await load();
    })().catch(fail);
  };
  useEffect(()=>{alive.current=true;if(scan)post({type:"software/scan"});return()=>{alive.current=false;window.clearTimeout(timer.current);};},[]);
  return <div className="admin-shade"><section className="admin-panel software-dialog" role="dialog" aria-modal="true" aria-label="服务器工具">
    <header><div><h1>服务器工具</h1><p>使用服务器账户的软件、网络和工具环境。路径配置由所有网页用户共用。</p></div><button onClick={close} aria-label="关闭服务器工具">×</button></header>
    <div className="software-content"><SoftwarePanel busy={false} post={post} expanded /></div>
  </section></div>;
}
