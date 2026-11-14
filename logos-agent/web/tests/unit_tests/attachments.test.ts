import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateImages, MAX_IMAGE_BYTES } from "../../server/attachments.ts";
import { Store } from "../../server/store.ts";
import { Models } from "../../server/models.ts";
import { Jobs } from "../../server/jobs.ts";
import { modelInput } from "../../worker/runtime.ts";
const png = {type:"image",mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X8AAAAASUVORK5CYII="};
test("inline images reject paths, URLs, SVG, spoofed MIME and invalid/oversize base64", () => {
  assert.deepEqual(validateImages([png]), [png]);
  for (const value of [[{...png,data:"/tmp/photo.png"}],[{...png,data:"https://test/image.png"}],[{...png,mimeType:"image/jpeg"}],[{...png,data:"PHN2Zz4="}],[{...png,data:png.data+"="}],Array(5).fill(png),[{...png,data:Buffer.alloc(MAX_IMAGE_BYTES+1).toString("base64")}]] ) assert.throws(() => validateImages(value));
});
test("attachments persist through queue claims and are part of idempotency identity", async () => {
  const root=await mkdtemp(join(tmpdir(),"logos-images-")),store=new Store(join(root,"db"));
  try {
    const models=new Models(store,root),jobs=new Jobs(store);
    const connection=models.save({name:"Fixture",baseUrl:"https://fixture.invalid",protocol:"openai-responses",models:["fixture"],visionModels:["fixture"],apiKey:"fixture"});
    assert.deepEqual(models.get(connection.id).visionModels,["fixture"]);
    const user=store.user("image-user","User"),project=store.createProject(user.id,"Project","project"),session=store.createSession(user.id,project.id);
    jobs.heartbeat(true,"ready");
    const run=jobs.submit(user.id,project.id,session.id,connection,"fixture","Look","image-key","off",[png]);
    assert.deepEqual(JSON.parse(jobs.claim()!.images!),[png]);
    assert.equal(jobs.submit(user.id,project.id,session.id,connection,"fixture","Look","image-key","off",[png]).id,run.id);
    assert.throws(()=>jobs.submit(user.id,project.id,session.id,connection,"fixture","Look","image-key"),/不同任务/);
    assert.deepEqual(await modelInput(resolve("../.."),connection,"fixture"),["text","image"]);
    assert.deepEqual(await modelInput(resolve("../.."),{...connection,visionModels:[]},"fixture"),["text"]);
    assert.deepEqual(await modelInput(resolve("../.."),{...connection,baseUrl:"https://api.openai.com/v1",visionModels:[]},"gpt-4.1"),["text","image"]);
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});
