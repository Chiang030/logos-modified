// Browser contract test: caller supplies a Playwright page and a built local origin.
// All APIs mocked; never calls a model. Exercises ClipboardEvent, not clipboard.read.
export default async function verifyImageAttachments(page, origin) {
  let submitted;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    let data = {};
    if (url.pathname === "/api/bootstrap") data = { user: { id: "images", name: "Image Test", admin: false }, csrf: "fixture", previewEnabled: false, version: "test", executionReady: true };
    else if (url.pathname === "/api/projects") data = { projects: [{ id: "images", name: "Image Project", directory: "images" }] };
    else if (url.pathname === "/api/leaderboards") data = {usageMetric:"fixture",feedbackMetric:"fixture",usage:[],feedback:[]};
    else if (url.pathname === "/api/files") data = {entries:[]};
    else if (url.pathname === "/api/models") data = {models:[{provider:"fixture",id:"vision",name:"Vision"}],ready:true};
    else if (url.pathname === "/api/sessions") data = route.request().method() === "GET" ? {sessions:[]} : {session:{id:"session",project:"images",title:"Images"}};
    else if (url.pathname === "/api/events") data = {events:[]};
    else if (url.pathname === "/api/runs") data = {runs:[],ready:true};
    else if (url.pathname === "/api/bridge") { submitted = route.request().postDataJSON(); data = {run:{id:"run",status:"queued"}}; }
    await route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
  });
  await page.goto(origin);
  await page.locator(".project-switcher").getByRole("button",{name:"Image Project",exact:false}).click();
  const paste = async () => page.getByRole("textbox",{name:"Message LOGOS"}).evaluate(node => {
    const canvas=document.createElement("canvas");canvas.width=100;canvas.height=60;canvas.getContext("2d").fillRect(0,0,100,60);
    const data=atob(canvas.toDataURL("image/png").split(",")[1]);const bytes=Uint8Array.from(data,c=>c.charCodeAt(0));
    const clipboardData=new DataTransfer();clipboardData.items.add(new File([bytes],"paste.png",{type:"image/png"}));
    node.dispatchEvent(new ClipboardEvent("paste",{clipboardData,bubbles:true,cancelable:true}));
  });
  await paste(); await page.getByAltText("待发送图片 1").waitFor();
  await page.getByRole("button",{name:"移除图片 1"}).click();
  if(await page.getByAltText("待发送图片 1").count()) throw new Error("Removal failed");
  await paste(); await page.getByRole("button",{name:"编辑",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.logos-image-editor canvas')?.width===100);
  await page.getByRole("button",{name:"旋转 90°"}).click();
  if(await page.locator('.logos-image-editor canvas').evaluate(node=>node.width)!==60) throw new Error("Rotation failed");
  await page.getByRole("button",{name:"应用编辑"}).click();
  await page.getByRole("textbox",{name:"Message LOGOS"}).fill("Inspect image");
  await page.getByRole("button",{name:"Send",exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.logos-image-list img'));
  if(submitted?.command.images?.[0]?.type!=="image" || !submitted.command.images[0].data || submitted.command.images[0].mimeType!=="image/png") throw new Error("Missing inline image content");
  return {images:submitted.command.images.length,inline:true};
}
