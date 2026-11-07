import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/store.ts";
import { Models } from "../../server/models.ts";
import { Jobs, type Run } from "../../server/jobs.ts";
import { Meter,normalize,csv } from "../../server/usage.ts";
import { UsageObserver } from "../../server/broker.ts";

test("central configuration encrypts keys, keeps edits explicit and exposes no secret",async()=>{
  const root=await mkdtemp(join(tmpdir(),"logos-models-")),store=new Store(join(root,"db"));
  try{
    const models=new Models(store,root);
    const entry=models.save({name:"Admin provider",baseUrl:"https://models.example.test/v1",protocol:"openai-completions",models:["fixture"],apiKey:"secret-value"});
    assert.equal(models.secret(entry.id),"secret-value");
    assert.equal(JSON.stringify(models.list()).includes("secret-value"),false);
    assert.equal(JSON.stringify(store.db.prepare("SELECT * FROM model_connections").all()).includes("secret-value"),false);
    assert.throws(()=>models.save({...entry,baseUrl:"https://another.example.test/v1"}),/重新填写密钥/);
    models.save({...entry,name:"Renamed"});
    assert.equal(models.secret(entry.id),"secret-value");
    assert.equal(models.get(entry.id).version,2);
    assert.throws(()=>models.save({...entry,baseUrl:"file:///etc/passwd"}),/HTTP/);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test("queue enforces five global slots, per-user serialization, deduplication and ownership",async()=>{
  const root=await mkdtemp(join(tmpdir(),"logos-queue-")),store=new Store(join(root,"db"));
  try{
    const models=new Models(store,root),jobs=new Jobs(store);
    const connection=models.save({name:"Fixture",baseUrl:"https://models.example.test",protocol:"openai-completions",models:["fixture"],apiKey:"fixture"});
    jobs.heartbeat(true,"ready");
    const runs:Run[]=[];
    for(let i=0;i<6;i++){
      const u=store.user("user-"+i,"User "+i),p=store.createProject(u.id,"Project","project"),s=store.createSession(u.id,p.id);
      const run=jobs.submit(u.id,p.id,s.id,connection,"fixture","prompt","key-"+i);runs.push(run);
      assert.equal(jobs.submit(u.id,p.id,s.id,connection,"fixture","prompt","key-"+i).id,run.id);
      assert.throws(()=>jobs.submit(u.id,p.id,s.id,connection,"fixture","other","key-"+i),/不同任务/);
    }
    const first=runs[0],extra=store.createSession(first.owner,first.project);
    const queued=jobs.submit(first.owner,first.project,extra.id,connection,"fixture","extra","extra");
    for(let i=0;i<5;i++)assert.ok(jobs.claim());
    assert.equal(jobs.claim(),undefined);
    assert.equal(jobs.get(queued.owner,queued.id).status,"queued");
    assert.throws(()=>jobs.cancel(runs[1].owner,first.id),/不存在/);
    jobs.finish(first.id,"completed");assert.ok(jobs.claim());
    jobs.cancel(queued.owner,queued.id);
    jobs.recover();assert.equal(jobs.get(runs[1].owner,runs[1].id).status,"interrupted");
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test("usage uses provider semantics, deduplicates streaming snapshots and preserves unknown failures",async()=>{
  assert.deepEqual(normalize("openai-completions",{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:30}})?.total,120);
  const a=normalize("anthropic-messages",{input_tokens:10,output_tokens:5,cache_read_input_tokens:20,cache_creation_input_tokens:30})!;
  assert.equal(a.input,60);assert.equal(a.total,65);
  assert.equal(normalize("openai-responses",{}),undefined);
  const root=await mkdtemp(join(tmpdir(),"logos-meter-")),store=new Store(join(root,"db"));
  try{
    const models=new Models(store,root),jobs=new Jobs(store),meter=new Meter(store);
    const c=models.save({name:"Provider",baseUrl:"https://models.example.test",protocol:"openai-completions",models:["fixture"],apiKey:"fixture"});
    const u=store.user("owner","=formula"),p=store.createProject(u.id,"Project","project"),s=store.createSession(u.id,p.id);
    jobs.heartbeat(true,"ready");const run=jobs.submit(u.id,p.id,s.id,c,"fixture","prompt","key");
    const id=meter.start(run,c.name,c.protocol,c.version),observer=new UsageObserver(c.protocol,meter,id);
    const event='data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n';
    observer.push(event.slice(0,17));observer.push(event.slice(17));observer.push(event);
    assert.equal(observer.completed,false);observer.push('data: {"choices":[{"finish_reason":"stop"}]}\n\n');assert.equal(observer.completed,true);
    meter.finish(id,"completed");
    const failed=meter.start(run,c.name,c.protocol,c.version);meter.finish(failed,"failed");
    const report=meter.report(0,Date.now()+1000) as {rows:Record<string,unknown>[]};
    assert.equal(report.rows[0].calls,2);assert.equal(report.rows[0].total,15);assert.equal(report.rows[0].unknown,1);
    assert.match(csv(report.rows),/"'=formula"/);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
