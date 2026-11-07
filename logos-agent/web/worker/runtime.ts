import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import type { Connection } from "../server/models.ts";
import type { Run } from "../server/jobs.ts";
import { hostEnvironment, Software } from "../server/software.ts";

export async function probe():Promise<{ready:boolean;reason:string}>{
  try{await access(process.execPath);await hostEnvironment();return {ready:true,reason:"任务服务就绪 · 服务器账户执行"};}
  catch{return {ready:false,reason:"服务器账户执行环境不可用，请检查 Node 和登录 shell"};}
}
export async function launch(options:{repo:string;directory:string;home:string;transcripts:string;socket:string;run:Run;connection:Connection;data?:string}):Promise<ChildProcessWithoutNullStreams>{
  const {repo,directory,home,transcripts,socket,run,connection}=options;
  const hostname=new URL(connection.baseUrl).hostname.toLowerCase();
  const provider=connection.protocol==="openai-completions" && (hostname==="deepseek.com" || hostname.endsWith(".deepseek.com"))?"deepseek":"logos-admin";
  const profile=join(home,".pi/agent");
  await mkdir(profile,{recursive:true,mode:0o700});await mkdir(transcripts,{recursive:true,mode:0o700});
  const source=options.data?await new Software(options.data).runtimeEnvironment(join(profile,"tools")):await hostEnvironment();
  // Match the CLI environment while keeping model selection and accounting under web control.
  try{Object.assign(source,parseEnv(await readFile(join(repo,"logos-agent/.env"),"utf8")));}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const sharedMcp=join(source.PI_CODING_AGENT_DIR??join(homedir(),".pi/agent"),"mcp.json");
  try{await copyFile(sharedMcp,join(profile,"mcp.json"));}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await rm(join(profile,"mcp.json"),{force:true});}
  const env:NodeJS.ProcessEnv={...source,PATH:dirname(process.execPath)+":"+source.PATH,PI_CODING_AGENT_DIR:profile};
  for(const name of Object.keys(env))if(/^(LARK_|FEISHU_|LOGOS_WEB_)/.test(name))delete env[name];
  await writeFile(join(profile,"models.json"),JSON.stringify({providers:{[provider]:{
    baseUrl:"http://127.0.0.1:0",api:connection.protocol,apiKey:"web-metered-broker",
    models:[{id:run.model,name:run.model,reasoning:connection.reasoning,input:["text"],contextWindow:connection.contextWindow,maxTokens:connection.maxTokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
  }}}),{mode:0o600});
  const domain=join(repo,"logos-agent/pi-domain");
  const args=[join(repo,"logos-agent/web/worker/host-entry.mjs"),socket,repo,profile,
    "--mode","rpc","--session-dir",transcripts,"--session-id",run.session,
    "--provider",provider,"--model",run.model,"--thinking",run.thinking,
    "--no-extensions","--no-prompt-templates","--no-themes","--no-approve","--offline",
    "-e",join(domain,"extensions/index.mjs"),
    "--system-prompt",join(domain,"prompts/system.md"),"--append-system-prompt",join(domain,"prompts/append.md"),
    "--no-skills","--skill",join(domain,"skills")];
  return spawn(process.execPath,args,{cwd:directory,env,stdio:"pipe",detached:true});
}
