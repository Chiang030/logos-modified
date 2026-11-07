import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Connection } from "../server/models.ts";
import type { Run } from "../server/jobs.ts";

const execute=promisify(execFile);
export const launcher="/usr/local/libexec/logos-web-bwrap";
export function baseArgs(node:string):string[]{
  return ["--unshare-all","--die-with-parent","--new-session","--cap-drop","ALL",
    "--ro-bind","/usr","/usr","--ro-bind","/lib","/lib","--ro-bind","/lib64","/lib64",
    "--symlink","usr/bin","/bin","--symlink","usr/sbin","/sbin","--proc","/proc","--dev","/dev","--tmpfs","/tmp",
    "--dir","/etc","--ro-bind","/etc/ssl/certs","/etc/ssl/certs",
    "--ro-bind",node,"/opt/bin/node","--clearenv","--setenv","PATH","/opt/bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv","HOME","/home/agent","--setenv","LANG","C.UTF-8","--setenv","PI_CODING_AGENT_DIR","/home/agent/.pi/agent",
    "--setenv","OMP_NUM_THREADS","4","--setenv","OPENBLAS_NUM_THREADS","4","--setenv","MKL_NUM_THREADS","4"];
}
export async function probe():Promise<{ready:boolean;reason:string}>{
  try{
    const info=await stat(launcher);
    if(info.uid!==0 || (info.mode & 0o022)!==0)throw new Error("Launcher must be root-owned");
    await execute(launcher,[...baseArgs(await realpath(process.execPath)),"/usr/bin/true"],{timeout:5000});
    return {ready:true,reason:"任务服务就绪"};
  }catch{return {ready:false,reason:"服务器执行隔离尚未就绪，请管理员检查 LOGOS sandbox 配置"};}
}
export async function launch(options:{repo:string;directory:string;home:string;transcripts:string;socket:string;run:Run;connection:Connection}):Promise<ChildProcessWithoutNullStreams>{
  const {repo,directory,home,transcripts,socket,run,connection}=options;
  // Retain provider-specific request formatting when the base URL is replaced by our proxy.
  const hostname=new URL(connection.baseUrl).hostname.toLowerCase();
  const provider=connection.protocol==="openai-completions" && (hostname==="deepseek.com" || hostname.endsWith(".deepseek.com"))?"deepseek":"logos-admin";
  const profile=join(home,".pi/agent");await mkdir(profile,{recursive:true,mode:0o700});await mkdir(transcripts,{recursive:true,mode:0o700});
  await writeFile(join(profile,"models.json"),JSON.stringify({providers:{[provider]:{
    baseUrl:"http://127.0.0.1:19231",api:connection.protocol,apiKey:"isolated-broker",
    models:[{id:run.model,name:run.model,reasoning:connection.reasoning,input:["text"],contextWindow:connection.contextWindow,maxTokens:connection.maxTokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
  }}}),{mode:0o600});
  const args=[...baseArgs(await realpath(process.execPath)),
    "--bind",directory,"/workspace","--bind",home,"/home/agent","--bind",transcripts,"/sessions",
    "--ro-bind",join(repo,"vendor/pi"),"/opt/pi",
    "--ro-bind",join(repo,"logos-agent/pi-domain"),"/opt/domain",
    "--ro-bind",resolve(repo,"logos-agent/web/worker/sandbox-entry.mjs"),"/opt/sandbox-entry.mjs",
    "--dir","/run","--bind",socket,"/run/model.sock","--chdir","/workspace",
    "/opt/bin/node","/opt/sandbox-entry.mjs","--mode","rpc","--session-dir","/sessions","--session-id",run.session,
    "--provider",provider,"--model",run.model,"--thinking",run.thinking,
    "--no-extensions","--no-prompt-templates","--no-themes","--no-approve","--offline",
    "--system-prompt","/opt/domain/prompts/system.md","--append-system-prompt","/opt/domain/prompts/append.md",
    "--no-skills","--skill","/opt/domain/skills"];
  return spawn(launcher,args,{env:{PATH:"/usr/bin:/bin"},stdio:"pipe",detached:true});
}
