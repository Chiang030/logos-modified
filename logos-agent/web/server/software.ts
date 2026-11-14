import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { discoverSoftware, discoveryEnvironment, SOFTWARE, type SoftwareDiscovery } from "../../pi-domain/src/software-discovery.mjs";
import { HttpError } from "./errors.ts";

const execute=promisify(execFile);
let environment:Promise<NodeJS.ProcessEnv>|undefined;
export function hostEnvironment():Promise<NodeJS.ProcessEnv>{
  environment??=execute("/bin/bash",["-lc","env -0"],{timeout:10000,maxBuffer:2*1024*1024}).then(({stdout})=>{
    const env:NodeJS.ProcessEnv={...process.env};
    for(const entry of stdout.split("\0")){const at=entry.indexOf("=");if(at>0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0,at)))env[entry.slice(0,at)]=entry.slice(at+1);}
    return env;
  }).catch(error=>{environment=undefined;throw error;});
  return environment.then(env=>({...env}));
}
export class Software {
  private result?:SoftwareDiscovery;
  private pending?:Promise<void>;
  private error="";
  readonly directory:string;
  constructor(data:string){this.directory=join(data,"state");}
  async status():Promise<{result?:SoftwareDiscovery;scanning:boolean;error:string}>{
    if(!this.result)await (this.pending ?? this.scan(false));
    return {result:this.result,scanning:Boolean(this.pending),error:this.error};
  }
  scan(global:boolean):Promise<void>{
    if(this.pending)return this.pending;
    this.error="";
    this.pending=this.discover(global).then(result=>{this.result=result;}).catch(()=>{this.error="软件扫描失败，请检查服务器目录和配置";}).finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  private async overrides():Promise<Record<string,string>>{
    try{return JSON.parse(await readFile(join(this.directory,"software-paths.json"),"utf8"));}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {};throw error;}
  }
  private async discover(global:boolean):Promise<SoftwareDiscovery>{
    return discoverSoftware({overrides:await this.overrides(),cacheFile:join(this.directory,"software-cache.json"),env:await hostEnvironment(),refresh:true,global});
  }
  async setPath(product:string,path:string):Promise<void>{
    if(!SOFTWARE.some(item=>item.id===product))throw new HttpError(400,"未知的软件类型");
    if(path.includes("\0") || path.length>4096)throw new HttpError(400,"程序路径无效");
    if(this.pending)await this.pending;
    const overrides=await this.overrides();if(path.trim())overrides[product]=path.trim();else delete overrides[product];
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const target=join(this.directory,"software-paths.json"),temporary=target+"."+randomUUID()+".tmp";
    await writeFile(temporary,JSON.stringify(overrides),{mode:0o600});await rename(temporary,target);await this.scan(false);
  }
  async runtimeEnvironment(binDirectory:string):Promise<NodeJS.ProcessEnv>{
    const result=await this.discover(false),env=discoveryEnvironment(result,await hostEnvironment());
    await rm(binDirectory,{recursive:true,force:true});
    await mkdir(binDirectory,{recursive:true,mode:0o700});
    for(const item of result.products){
      if(item.status!=="installed" || !item.selected)continue;
      const quoted="'"+item.selected.replace(/'/g,"'\\''")+"'";
      await writeFile(join(binDirectory,basename(item.selected)),"#!/bin/sh\nexec "+quoted+' "$@"\n',{mode:0o700});
    }
    return {...env,PATH:binDirectory+":"+env.PATH,LOGOS_SOFTWARE_CONFIG:join(this.directory,"software-paths.json"),LOGOS_SOFTWARE_CACHE:join(this.directory,"software-cache.json")};
  }
}
