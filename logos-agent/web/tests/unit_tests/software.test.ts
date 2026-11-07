import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Software } from "../../server/software.ts";

test("selected tool paths win over another application's bundled executable",async()=>{
  const root=await mkdtemp(join(tmpdir(),"logos-tools-"));
  try{
    const cad=join(root,"cad"),mesh=join(root,"mesh with ' quote"),bin=join(root,"profile/tools");
    await mkdir(cad);await mkdir(mesh);
    await writeFile(join(cad,"freecad"),"#!/bin/sh\nexit 0\n",{mode:0o755});
    await writeFile(join(cad,"gmsh"),"#!/bin/sh\necho wrong-bundled-version\n",{mode:0o755});
    await writeFile(join(mesh,"gmsh"),'#!/bin/sh\nprintf "selected-version %s\\n" "$*"\n',{mode:0o755});
    const software=new Software(root);
    await software.setPath("freecad",join(cad,"freecad"));await software.setPath("gmsh",join(mesh,"gmsh"));
    const env=await software.runtimeEnvironment(bin);
    const result=await promisify(execFile)("/bin/sh",["-c","gmsh --version"],{env});
    assert.equal(result.stdout.trim(),"selected-version --version");
    assert.equal(env.GMSH_PATH,join(mesh,"gmsh"));
  }finally{await rm(root,{recursive:true,force:true});}
});
