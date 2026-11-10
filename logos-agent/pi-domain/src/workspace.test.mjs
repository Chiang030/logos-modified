import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectWorkspace } from "./workspace.mjs";
import { runSimulation } from "./simulation/runner.mjs";

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),"logos-layout-"));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function initialized(t) {
  const root=await fixture(t);await projectWorkspace(root,{action:"initialize",name:"Wing"});return root;
}
async function configured(root) {
  const info=(await projectWorkspace(root,{action:"list"})).studies[0];
  await mkdir(join(root,"models"),{recursive:true});await writeFile(join(root,"models/model.step"),"original-geometry");
  info.config.physics={type:"fluid",units:"SI"};info.config.solver.name="fixture";info.config.model="models/model.step";
  return projectWorkspace(root,{action:"save_study",study:"baseline",revision:info.revision,config:info.config});
}

test("empty project initializes on demand, legacy data is preserved, duplicate studies are rejected",async t=>{
  const root=await initialized(t),overview=await projectWorkspace(root,{action:"list"});
  assert.equal(overview.managed,true);assert.equal(overview.studies[0].config.id,"baseline");
  await assert.rejects(readFile(join(root,"models/anything")),/ENOENT/);
  await projectWorkspace(root,{action:"create_study",study:"wind-10",name:"Wind 10"});
  await assert.rejects(projectWorkspace(root,{action:"create_study",study:"wind-10",name:"Duplicate"}),/已存在/);
  const legacy=await fixture(t);await mkdir(join(legacy,"0-caseDict"));await writeFile(join(legacy,"0-caseDict/caseDict"),"original");
  await assert.rejects(projectWorkspace(legacy,{action:"initialize"}),/空目录/);
  assert.equal(await readFile(join(legacy,"0-caseDict/caseDict"),"utf8"),"original");
  assert.equal((await projectWorkspace(legacy,{action:"list"})).managed,false);
});

test("config revisions reject lost updates, malformed versions, and escaping input references",async t=>{
  const root=await initialized(t),info=(await projectWorkspace(root,{action:"list"})).studies[0];
  await configured(root);
  await assert.rejects(projectWorkspace(root,{action:"save_study",study:"baseline",revision:info.revision,config:info.config}),/已被修改/);
  for (const input of ["../outside","/etc/passwd","models/../outside","studies/other/scripts/a.py"]) {
    const current=(await projectWorkspace(root,{action:"list"})).studies[0];current.config.inputs=[input];
    await assert.rejects(projectWorkspace(root,{action:"save_study",study:"baseline",revision:current.revision,config:current.config}));
  }
  const current=(await projectWorkspace(root,{action:"list"})).studies[0];current.config.schemaVersion=2;
  await assert.rejects(projectWorkspace(root,{action:"save_study",study:"baseline",revision:current.revision,config:current.config}),/版本/);
});

test("run snapshots preserve input contents and are distinct across retries; execution records remain inspectable",async t=>{
  const root=await initialized(t);await configured(root);
  const a=await projectWorkspace(root,{action:"prepare_run",study:"baseline"});
  await writeFile(join(root,"models/model.step"),"changed-geometry");
  const b=await projectWorkspace(root,{action:"prepare_run",study:"baseline"});
  assert.notEqual(a.id,b.id);
  assert.equal(await readFile(join(root,a.path,"inputs/models/model.step"),"utf8"),"original-geometry");
  assert.equal(await readFile(join(root,b.path,"inputs/models/model.step"),"utf8"),"changed-geometry");
  assert.notEqual(a.inputs[1].sha256,b.inputs[1].sha256);
  await projectWorkspace(root,{action:"update_run",study:"baseline",run:a.id,status:"running",command:["solver","input"]});
  await projectWorkspace(root,{action:"update_run",study:"baseline",run:a.id,status:"failed",note:"Fixture failure"});
  await assert.rejects(projectWorkspace(root,{action:"update_run",study:"baseline",run:a.id,status:"running",command:["retry"]}),/新建/);
  const saved=JSON.parse(await readFile(join(root,a.path,"manifest.json"),"utf8"));
  assert.equal(saved.status,"failed");assert.equal(saved.acceptance,"not_evaluated");
});

test("snapshot rejects symlinks and leaves a visible preparation failure without reading outside the project",async t=>{
  const root=await initialized(t);await configured(root);
  const outside=await fixture(t);await writeFile(join(outside,"secret"),"not-project-data");
  const linkedInput = process.platform === "win32" ? "models/link/secret" : "models/link";
  if (process.platform === "win32") await symlink(outside,join(root,"models/link"),"junction");
  else await symlink(join(outside,"secret"),join(root,"models/link"));
  const info=(await projectWorkspace(root,{action:"list"})).studies[0];info.config.inputs=[linkedInput];
  await projectWorkspace(root,{action:"save_study",study:"baseline",revision:info.revision,config:info.config});
  await assert.rejects(projectWorkspace(root,{action:"prepare_run",study:"baseline"}));
  const overview=await projectWorkspace(root,{action:"list"});assert.equal(overview.studies[0].runs[0].status,"preparation_failed");
  await assert.rejects(projectWorkspace(root,{action:"create_study",study:"../escape",name:"Bad"}));
});

test("simulation execution uses its prepared run directory and records actual results",async t=>{
  const root=await initialized(t);await configured(root);
  await assert.rejects(runSimulation({action:"run"},{cwd:root,command:[process.execPath,"-e","process.exit(99)","--"]}),/requires study/);
  const run=await projectWorkspace(root,{action:"prepare_run",study:"baseline"});
  const script='const fs=require("node:fs");const input=fs.readFileSync("inputs/models/model.step","utf8");fs.writeFileSync("results/output.txt",input);console.log(JSON.stringify({transport_ok:true,script_ok:true}));';
  const result=await runSimulation({action:"run",study:"baseline",run_id:run.id},{cwd:root,command:[process.execPath,"-e",script,"--"]});
  assert.equal(result.script_ok,true);
  assert.equal(await readFile(join(root,run.path,"results/output.txt"),"utf8"),"original-geometry");
  const manifest=JSON.parse(await readFile(join(root,run.path,"manifest.json"),"utf8"));
  assert.equal(manifest.status,"completed");assert.equal(manifest.acceptance,"not_evaluated");
  assert.ok((await readFile(join(root,run.path,"logs/operation.json"),"utf8")).includes('"script_ok": true'));
});
