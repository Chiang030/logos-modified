import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { RpcClient } from "../../vscode-extension/src/rpcClient.ts";
import type { Jobs, Run } from "../server/jobs.ts";
import type { Models } from "../server/models.ts";
import type { Meter } from "../server/usage.ts";
import { modelBroker, type Broker } from "../server/broker.ts";
import { launch } from "./sandbox.ts";
import { Events } from "./events.ts";

export async function executeRun(repo:string,data:string,jobs:Jobs,models:Models,meter:Meter,run:Run):Promise<void>{
  let child:ChildProcessWithoutNullStreams|undefined,broker:Broker|undefined,timer:ReturnType<typeof setInterval>|undefined;
  let cancelled=false,finished=false,stderr="",failure:Error|undefined;
  let socketDirectory:string|undefined;
  const events=new Events(jobs,run);
  try{
    const connection=models.get(run.connection);
    if(!connection.enabled || !connection.models.includes(run.model))throw new Error("管理员已停用此模型，请重新选择");
    const key=models.secret(run.connection);
    const project=jobs.store.project(run.owner,run.project);
    const root=await realpath(join(data,"users",run.owner,"workspace"));
    const directory=await realpath(join(root,project.directory));
    if(!directory.startsWith(root+"/") || !(await stat(directory)).isDirectory())throw new Error("项目目录不可访问");
    const directoryInfo=await stat(directory);
    const state=join(data,"state/sessions",run.session),home=join(state,"home"),transcripts=join(state,"transcripts");
    // Unix socket paths must remain short regardless of the configured data directory.
    socketDirectory=await mkdtemp(join(tmpdir(),"logos-run-"));
    const socket=join(socketDirectory,"model.sock");
    broker=await modelBroker(socket,connection,key,run,meter);
    child=await launch({repo,directory,home,transcripts,socket,run,connection});
    // Recheck the pinned project path before accepting model work.
    const check=await stat(directory);if(check.ino!==directoryInfo.ino || check.dev!==directoryInfo.dev)throw new Error("项目目录发生变化");
    const rpc=new RpcClient(child);
    let complete:()=>void=()=>{};
    const settled=new Promise<void>(resolve=>{complete=resolve;});
    rpc.onRecord(record=>{events.record(record);if(events.settled)complete();});
    rpc.onStderr(value=>{stderr=(stderr+value).slice(-4000);});
    rpc.onProtocolError(()=>{failure=new Error("运行协议异常");complete();});
    rpc.onExit(()=>{if(!finished && !events.settled && !cancelled)failure=new Error("运行进程意外退出");complete();});
    const deadline=Date.now()+60*60_000;
    timer=setInterval(()=>{
      cancelled=jobs.get(run.owner,run.id).status==="cancelling";
      if(cancelled || Date.now()>deadline){if(!cancelled)failure=new Error("任务超过 60 分钟时限，已停止");complete();}
    },300);
    await rpc.getState();
    if(jobs.get(run.owner,run.id).status==="cancelling"){cancelled=true;complete();}
    else{jobs.running(run.id);await rpc.prompt(run.prompt);}
    await settled;
    if(failure)throw failure;
    finished=true;
    await terminate(child);
    await broker.close();broker=undefined;
    jobs.finish(run.id,cancelled?"cancelled":events.failed?"failed":"completed");
  }catch(error){
    finished=true;if(child)await terminate(child);if(broker){await broker.close();broker=undefined;}
    const detail=error instanceof Error?error.message:"任务执行失败";
    // Runtime diagnostics never contain the real model key, which remains in the broker.
    jobs.finish(run.id,cancelled?"cancelled":"failed",cancelled?undefined:detail+(stderr?"；"+stderr.slice(-1200):""));
  }finally{if(timer)clearInterval(timer);if(broker)await broker.close();if(socketDirectory)await rm(socketDirectory,{recursive:true,force:true});}
}
async function terminate(child:ChildProcessWithoutNullStreams):Promise<void>{
  if(child.exitCode!==null || child.signalCode!==null)return;
  await new Promise<void>(resolve=>{
    const force=setTimeout(()=>{try{if(child.pid)process.kill(-child.pid,"SIGKILL");}catch{}},1500);
    child.once("close",()=>{clearTimeout(force);resolve();});
    try{if(child.pid)process.kill(-child.pid,"SIGTERM");}catch{clearTimeout(force);resolve();}
  });
}
