import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,rm,readFile,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join,resolve,dirname } from "node:path";
import { pathToFileURL,fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { Store } from "../../server/store.ts";
import { Models } from "../../server/models.ts";
import { Jobs } from "../../server/jobs.ts";
import { Meter } from "../../server/usage.ts";
import { probe } from "../../worker/runtime.ts";

test("real host Pi executes tools through the metered broker and retains conversation", {timeout:60000},async t=>{
  if(!(await probe()).ready){t.skip("Host runtime is unavailable");return;}
  const root=await mkdtemp(join(tmpdir(),"logos-runner-long-data-directory-regression-"+"x".repeat(80)));
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),"../../../..");
  const store=new Store(join(root,"state/application.sqlite")),models=new Models(store,join(root,"state")),jobs=new Jobs(store),meter=new Meter(store);
  await writeFile(join(root,"host-file.txt"),"host-access-ok");
  let calls=0,overlapping=0;const prompts:Record<string,unknown>[]=[];
  let release:()=>void=()=>{};const overlap=new Promise<void>(resolve=>{release=resolve;});
  const provider=createServer(async(req,res)=>{
    if(req.url==="/host-probe"){res.end("network-access-ok");return;}
    const chunks:Buffer[]=[];for await(const piece of req)chunks.push(Buffer.from(piece));
    assert.equal(req.headers.authorization,"Bearer private-provider-secret");
    const input=JSON.parse(Buffer.concat(chunks).toString());prompts.push(input);calls++;
    if(JSON.stringify(input.messages).includes("parallel-host-check")){if(++overlapping===2)release();await overlap;}
    const base={id:"completion-"+calls,object:"chat.completion.chunk",created:1,model:"fixture-model"};
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    if(calls===1){
      const command="node -e '"+'console.log(require("node:fs").readFileSync('+JSON.stringify(join(root,"host-file.txt"))+',"utf8"));fetch("http://127.0.0.1:'+(provider.address() as AddressInfo).port+'/host-probe").then(r=>r.text()).then(console.log)'+"'";
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{role:"assistant",tool_calls:[{index:0,id:"host-call",type:"function",function:{name:"bash",arguments:JSON.stringify({command})}}]},finish_reason:null}]})+"\n\n");
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"tool_calls"}]})+"\n\n");
    }else if(calls===2){
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{role:"assistant",tool_calls:[{index:0,id:"write-call",type:"function",function:{name:"write",arguments:JSON.stringify({path:"result.txt",content:"sandbox tool success"})}}]},finish_reason:null}]})+"\n\n");
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"tool_calls"}]})+"\n\n");
    }else{
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{role:"assistant",content:"The file was written."},finish_reason:null}]})+"\n\n");
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"stop"}]})+"\n\n");
    }
    res.write("data: "+JSON.stringify({...base,choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,prompt_tokens_details:{cached_tokens:2}}})+"\n\n");
    // A client may close after the terminal event while the upstream socket stays open.
    if(calls===3)res.write("data: [DONE]\n\n");else res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  try{
    const bundle=join(root,"runner.mjs");
    await build({entryPoints:[join(repo,"logos-agent/web/worker/runner.ts")],bundle:true,platform:"node",format:"esm",outfile:bundle,packages:"external"});
    const {executeRun}=await import(pathToFileURL(bundle).href) as {executeRun:typeof import("../../worker/runner.ts").executeRun};
    const user=store.user("runner-owner","Runner"),project=store.createProject(user.id,"Test","case"),session=store.createSession(user.id,project.id);
    await mkdir(join(root,"users",user.id,"workspace/case"),{recursive:true});
    const c=models.save({name:"Test API",baseUrl:"http://127.0.0.1:"+(provider.address() as AddressInfo).port+"/v1",protocol:"openai-completions",models:["fixture-model"],apiKey:"private-provider-secret"});
    jobs.heartbeat(true,"ready");
    const run=jobs.submit(user.id,project.id,session.id,c,"fixture-model","Write result.txt using the write tool.","first");
    assert.ok(jobs.claim());await executeRun(repo,root,jobs,models,meter,run);
    const done=jobs.get(user.id,run.id);assert.equal(done.status,"completed",done.error??"run failed");
    assert.equal(await readFile(join(root,"users",user.id,"workspace/case/result.txt"),"utf8"),"sandbox tool success");
    assert.equal(calls,3);
    for(const name of ["software_discover","simulation_discover","simulation","web_search","project_workspace"])assert.ok(JSON.stringify(prompts[0].tools).includes(name),"Missing tool: "+name);
    assert.ok(JSON.stringify(prompts[1]).includes("host-access-ok"));assert.ok(JSON.stringify(prompts[1]).includes("network-access-ok"));
    assert.deepEqual(store.db.prepare("SELECT status FROM model_requests WHERE run=?").all(run.id).map(row=>row.status),["completed","completed","completed"]);
    const report=meter.report(0,Date.now()+1000) as {rows:{calls:number;total:number;unknown:number}[]};
    assert.equal(report.rows[0].calls,3);assert.equal(report.rows[0].total,45);assert.equal(report.rows[0].unknown,0);
    assert.ok(jobs.events(user.id,session.id,0).some(e=>e.payload.type==="tool/completed"));
    const follow=jobs.submit(user.id,project.id,session.id,c,"fixture-model","What did you write?","second");
    assert.ok(jobs.claim());await executeRun(repo,root,jobs,models,meter,follow);
    assert.equal(jobs.get(user.id,follow.id).status,"completed",jobs.get(user.id,follow.id).error??"followup failed");
    assert.ok(JSON.stringify(prompts.at(-1)).includes("sandbox tool success"));
    const concurrent=await Promise.all([1,2].map(async i=>{
      const u=store.user("parallel-"+i,"Parallel "+i),p=store.createProject(u.id,"Parallel","case"),s=store.createSession(u.id,p.id);
      await mkdir(join(root,"users",u.id,"workspace/case"),{recursive:true});
      return jobs.submit(u.id,p.id,s.id,c,"fixture-model","parallel-host-check","parallel-"+i);
    }));
    await Promise.all(concurrent.map(run=>executeRun(repo,root,jobs,models,meter,run)));
    assert.equal(overlapping,2);
    for(const run of concurrent)assert.equal(jobs.get(run.owner,run.id).status,"completed");
    const ports=await Promise.all(concurrent.map(async run=>{
      const config=JSON.parse(await readFile(join(root,"state/sessions",run.session,"home/.pi/agent/models.json"),"utf8"));
      return new URL(config.providers["logos-admin"].baseUrl).port;
    }));
    assert.notEqual(ports[0],ports[1]);
  }finally{
    provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));
    store.close();await rm(root,{recursive:true,force:true});
  }
});

test("cancelling a host task stops the provider request and records unknown consumption", {timeout:30000},async t=>{
  if(!(await probe()).ready){t.skip("Host runtime is unavailable");return;}
  const root=await mkdtemp(join(tmpdir(),"logos-cancel-"));
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),"../../../..");
  const store=new Store(join(root,"state/application.sqlite")),models=new Models(store,join(root,"state")),jobs=new Jobs(store),meter=new Meter(store);
  let received:()=>void=()=>{};
  const requestStarted=new Promise<void>(resolve=>{received=resolve;});
  let shellMode=false;const pidFile=join(root,"shell-pids");
  const provider=createServer(async(req,res)=>{
    for await(const _chunk of req){}received();
    if(!shellMode)return;
    const command="sleep 60 & sleeper=$!; echo \"$$ $sleeper\" > "+pidFile+"; wait \"$sleeper\"";
    const base={id:"cancel-shell",object:"chat.completion.chunk",created:1,model:"fixture-model"};
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{role:"assistant",tool_calls:[{index:0,id:"shell",type:"function",function:{name:"bash",arguments:JSON.stringify({command})}}]},finish_reason:null}]})+"\n\n");
    res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"tool_calls"}]})+"\n\n");
    res.write("data: "+JSON.stringify({...base,choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+"\n\n");
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  try{
    const bundle=join(root,"runner.mjs");
    await build({entryPoints:[join(repo,"logos-agent/web/worker/runner.ts")],bundle:true,platform:"node",format:"esm",outfile:bundle,packages:"external"});
    const {executeRun}=await import(pathToFileURL(bundle).href) as {executeRun:typeof import("../../worker/runner.ts").executeRun};
    const user=store.user("cancel-owner","Owner"),project=store.createProject(user.id,"Case","case"),session=store.createSession(user.id,project.id);
    await mkdir(join(root,"users",user.id,"workspace/case"),{recursive:true});
    const c=models.save({name:"Slow API",baseUrl:"http://127.0.0.1:"+(provider.address() as AddressInfo).port+"/v1",protocol:"openai-completions",models:["fixture-model"],apiKey:"fixture"});
    jobs.heartbeat(true,"ready");
    const run=jobs.submit(user.id,project.id,session.id,c,"fixture-model","Wait for the model","cancel-request");
    assert.ok(jobs.claim());const execution=executeRun(repo,root,jobs,models,meter,run);
    await requestStarted;jobs.cancel(user.id,run.id);await execution;
    assert.equal(jobs.get(user.id,run.id).status,"cancelled");
    const report=meter.report(0,Date.now()+1000) as {rows:{unknown:number;calls:number}[]};
    assert.equal(report.rows[0].calls,1);assert.equal(report.rows[0].unknown,1);
    const request=store.db.prepare("SELECT status FROM model_requests WHERE run=?").get(run.id) as {status:string};
    assert.equal(request.status,"cancelled");
    shellMode=true;
    const shellRun=jobs.submit(user.id,project.id,session.id,c,"fixture-model","Cancel a shell tool","cancel-shell");
    assert.ok(jobs.claim());const shellExecution=executeRun(repo,root,jobs,models,meter,shellRun);
    let pids:number[]=[];
    for(let attempt=0;attempt<200;attempt++){
      try{pids=(await readFile(pidFile,"utf8")).trim().split(/\s+/).map(Number);break;}catch{await delay(25);}
    }
    jobs.cancel(user.id,shellRun.id);await shellExecution;
    assert.equal(pids.length,2,"The real shell and its child must have started");
    assert.equal(jobs.get(user.id,shellRun.id).status,"cancelled");
    for(const pid of pids){
      try{const status=await readFile("/proc/"+pid+"/stat","utf8");assert.match(status,/\) Z /,"A cancelled shell child is still running");}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    }
  }finally{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));store.close();await rm(root,{recursive:true,force:true});}
});
