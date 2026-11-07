import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,rm,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve,dirname } from "node:path";
import { pathToFileURL,fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { Store } from "../../server/store.ts";
import { Models } from "../../server/models.ts";
import { Jobs } from "../../server/jobs.ts";
import { Meter } from "../../server/usage.ts";
import { probe } from "../../worker/sandbox.ts";

test("real Pi sandbox executes a tool through the metered broker and retains conversation", {timeout:60000},async t=>{
  if(!(await probe()).ready){t.skip("Administrator sandbox installation is unavailable");return;}
  const root=await mkdtemp(join(tmpdir(),"logos-runner-long-data-directory-regression-"+"x".repeat(80)));
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),"../../../..");
  const store=new Store(join(root,"state/application.sqlite")),models=new Models(store,join(root,"state")),jobs=new Jobs(store),meter=new Meter(store);
  let calls=0;const prompts:Record<string,unknown>[]=[];
  const provider=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const piece of req)chunks.push(Buffer.from(piece));
    assert.equal(req.headers.authorization,"Bearer private-provider-secret");
    const input=JSON.parse(Buffer.concat(chunks).toString());prompts.push(input);calls++;
    const base={id:"completion-"+calls,object:"chat.completion.chunk",created:1,model:"fixture-model"};
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    if(calls===1){
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{role:"assistant",tool_calls:[{index:0,id:"write-call",type:"function",function:{name:"write",arguments:JSON.stringify({path:"result.txt",content:"sandbox tool success"})}}]},finish_reason:null}]})+"\n\n");
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"tool_calls"}]})+"\n\n");
    }else{
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{role:"assistant",content:"The file was written."},finish_reason:null}]})+"\n\n");
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"stop"}]})+"\n\n");
    }
    res.write("data: "+JSON.stringify({...base,choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,prompt_tokens_details:{cached_tokens:2}}})+"\n\n");
    // A client may close after the terminal event while the upstream socket stays open.
    if(calls===2)res.write("data: [DONE]\n\n");else res.end("data: [DONE]\n\n");
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
    assert.equal(calls,2);
    assert.deepEqual(store.db.prepare("SELECT status FROM model_requests WHERE run=?").all(run.id).map(row=>row.status),["completed","completed"]);
    const report=meter.report(0,Date.now()+1000) as {rows:{calls:number;total:number;unknown:number}[]};
    assert.equal(report.rows[0].calls,2);assert.equal(report.rows[0].total,30);assert.equal(report.rows[0].unknown,0);
    assert.ok(jobs.events(user.id,session.id,0).some(e=>e.payload.type==="tool/completed"));
    const follow=jobs.submit(user.id,project.id,session.id,c,"fixture-model","What did you write?","second");
    assert.ok(jobs.claim());await executeRun(repo,root,jobs,models,meter,follow);
    assert.equal(jobs.get(user.id,follow.id).status,"completed",jobs.get(user.id,follow.id).error??"followup failed");
    assert.ok(JSON.stringify(prompts.at(-1)).includes("sandbox tool success"));
  }finally{
    provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));
    store.close();await rm(root,{recursive:true,force:true});
  }
});

test("cancelling an isolated task stops the provider request and records unknown consumption", {timeout:30000},async t=>{
  if(!(await probe()).ready){t.skip("Administrator sandbox installation is unavailable");return;}
  const root=await mkdtemp(join(tmpdir(),"logos-cancel-"));
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),"../../../..");
  const store=new Store(join(root,"state/application.sqlite")),models=new Models(store,join(root,"state")),jobs=new Jobs(store),meter=new Meter(store);
  let received:()=>void=()=>{};
  const requestStarted=new Promise<void>(resolve=>{received=resolve;});
  const provider=createServer(async(req,_res)=>{for await(const _chunk of req){}received();});
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
  }finally{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));store.close();await rm(root,{recursive:true,force:true});}
});
