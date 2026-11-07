import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../server/store.ts";
import { Models } from "../server/models.ts";
import { Jobs } from "../server/jobs.ts";
import { Meter } from "../server/usage.ts";
import { probe } from "./sandbox.ts";
import { executeRun } from "./runner.ts";
process.umask(0o077);
const data=resolve(process.env.LOGOS_WEB_DATA_DIR??join(homedir(),".local/share/logos-web"));
const repo=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
mkdirSync(join(data,"state"),{recursive:true,mode:0o700});
const store=new Store(join(data,"state/application.sqlite")),models=new Models(store,join(data,"state")),jobs=new Jobs(store),meter=new Meter(store);
const running=new Set<string>();
jobs.recover();meter.recover();
let readiness=await probe(),lastProbe=Date.now(),busy=false;
async function tick():Promise<void>{
  if(busy)return;busy=true;
  try{
    if(Date.now()-lastProbe>30000){readiness=await probe();lastProbe=Date.now();}
    jobs.heartbeat(readiness.ready,readiness.reason);
    if(readiness.ready){
      let next;while(running.size<5 && (next=jobs.claim(5))){
        const run=next;running.add(run.id);
        void executeRun(repo,data,jobs,models,meter,run).catch(()=>jobs.finish(run.id,"failed","运行服务异常")).finally(()=>running.delete(run.id));
      }
    }
  }finally{busy=false;}
}
await tick();
setInterval(()=>{void tick().catch(()=>{jobs.heartbeat(false,"运行服务出现异常");});},1000);
console.log("LOGOS task service started; maximum 5 tasks, one per user and project.");
