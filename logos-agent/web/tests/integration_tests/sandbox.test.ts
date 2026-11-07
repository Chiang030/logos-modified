import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,rm,realpath,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { probe,baseArgs,launcher } from "../../worker/sandbox.ts";

test("real sandbox blocks foreign files, environment, host network and system writes",async t=>{
  if(!(await probe()).ready){t.skip("Administrator sandbox installation is unavailable");return;}
  const root=await mkdtemp(join(tmpdir(),"logos-isolation-"));
  const server=createServer();
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    const owned=join(root,"owned");await import("node:fs/promises").then(fs=>fs.mkdir(owned));
    const secret=join(root,"neighbor-secret");await writeFile(secret,"not-shared");
    await symlink(secret,join(owned,"escape"));
    const code=`const fs=require("node:fs");const net=require("node:net");
      for(const p of [${JSON.stringify(secret)},"/workspace/escape","/home/jiangjincheng/.config/logos-web-pilot/server.env"]){try{fs.readFileSync(p);throw Error("LEAK");}catch(e){if(e.message==="LEAK")throw e;}}
      if(process.env.LOGOS_TEST_SECRET)throw Error("ENV LEAK");
      try{fs.writeFileSync("/usr/logos-write-test","bad");throw Error("SYSTEM WRITE");}catch(e){if(e.message==="SYSTEM WRITE")throw e;}
      fs.writeFileSync("/workspace/output.txt","isolated");
      const s=net.connect(${(server.address() as AddressInfo).port},"127.0.0.1");
      s.on("connect",()=>{throw Error("HOST NETWORK");});s.on("error",()=>{console.log("isolated");});s.setTimeout(1000,()=>{s.destroy();console.log("isolated");});`;
    const result=await promisify(execFile)(launcher,[...baseArgs(await realpath(process.execPath)),"--bind",owned,"/workspace","/opt/bin/node","-e",code],{timeout:8000,env:{PATH:"/usr/bin:/bin",LOGOS_TEST_SECRET:"must-not-inherit"}});
    assert.match(result.stdout,/isolated/);
    assert.equal(await import("node:fs/promises").then(fs=>fs.readFile(join(owned,"output.txt"),"utf8")),"isolated");
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
