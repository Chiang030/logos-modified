// Browser regression: all API requests are mocked, including mutations. No solver/model calls.
export default async function verifyImageContextRaces(page, origin) {
  const errors = [], submissions = [], heldSubmissions = [];
  page.on("pageerror", error => errors.push(error.message));
  const projects = [{id:"alpha",name:"Alpha",directory:"alpha"},{id:"beta",name:"Beta",directory:"beta"}];
  const sessions = {alpha:[{id:"a1",project:"alpha",title:"Alpha one"},{id:"a2",project:"alpha",title:"Alpha two"}],beta:[]};
  let serial=0, pendingFile, holdFile=false;
  const png = Buffer.from(await page.evaluate(()=>{const canvas=document.createElement("canvas");canvas.width=8;canvas.height=6;canvas.getContext("2d").fillRect(0,0,8,6);return canvas.toDataURL("image/png").split(",")[1];}), "base64");
  await page.route("**/api/**", async route => {
    const request=route.request(),url=new URL(request.url()); let data={};
    if(url.pathname==="/api/bootstrap") data={user:{id:"owner",name:"Race Test",admin:false},csrf:"fixture",version:"test",executionReady:true};
    else if(url.pathname==="/api/projects") data={projects};
    else if(url.pathname==="/api/leaderboards") data={usage:[],feedback:[]};
    else if(url.pathname==="/api/demos") data={demos:[]};
    else if(url.pathname==="/api/files") data={entries:[{name:"drawing.png",directory:false,size:png.length,modified:0}]};
    else if(url.pathname==="/api/workspace") data={managed:false,studies:[]};
    else if(url.pathname==="/api/models") data={models:[{provider:"fixture",id:"vision",name:"Vision"}],ready:true};
    else if(url.pathname==="/api/sessions") {
      if(request.method()==="GET") data={sessions:sessions[url.searchParams.get("project")]};
      else { const project=request.postDataJSON().project; const session={id:`new-${++serial}`,project,title:`New ${serial}`};sessions[project].push(session);data={session}; }
    }
    else if(url.pathname==="/api/events") data={events:[]};
    else if(url.pathname==="/api/runs") data={runs:[],ready:true};
    else if(url.pathname==="/api/file") {
      if(holdFile && request.resourceType()==="fetch") {
        await new Promise(resolve=>{pendingFile=resolve;});
        try {await route.fulfill({contentType:"image/png",body:png});} catch { /* Expected if context cancellation already aborted this request. */ }
        return;
      }
      await route.fulfill({contentType:"image/png",body:png});return;
    }
    else if(url.pathname==="/api/bridge") {
      submissions.push(request.postDataJSON());
      const result=await new Promise(resolve=>heldSubmissions.push(resolve));
      await route.fulfill({status:result.status,contentType:"application/json",body:JSON.stringify(result.data)});return;
    }
    await route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
  });
  const project = async name => { await page.locator(".project-switcher").getByRole("button",{name,exact:false}).click(); await page.waitForFunction(()=>!document.querySelector('p[role=status]')?.textContent?.includes('恢复会话')); };
  const paste = async () => {
    await page.getByRole("textbox",{name:"Message LOGOS"}).evaluate(node=>{
      const canvas=document.createElement("canvas");canvas.width=8;canvas.height=6;canvas.getContext("2d").fillRect(0,0,8,6);
      const bytes=Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]),c=>c.charCodeAt(0));
      const data=new DataTransfer();data.items.add(new File([bytes],"draft.png",{type:"image/png"}));node.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));
    });
    await page.getByAltText("待发送图片 1").waitFor();
  };
  const noDraft = async () => {await page.getByAltText("待发送图片 1").waitFor({state:"detached"});};
  const settleFrame = async () => page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const attach = async () => {
    await page.getByRole("button",{name:"文件",exact:true}).click();
    await page.locator(".file-list").getByRole("button",{name:/drawing.png/}).click();
    holdFile=true;
    const requested=page.waitForRequest(request=>new URL(request.url()).pathname==="/api/file" && request.resourceType()==="fetch");
    await page.getByRole("button",{name:"添加到对话",exact:true}).click();await requested;
  };
  await page.goto(origin);await project("Alpha");
  await paste();await page.getByRole("button",{name:"会话",exact:true}).click();
  await page.locator(".session-list-web").getByRole("button",{name:"Alpha two",exact:true}).click();await noDraft();
  await paste();await page.locator(".session-list-web").getByRole("button",{name:"＋ 新建会话",exact:true}).click();await noDraft();
  await attach();await page.getByRole("button",{name:"会话",exact:true}).click();
  await page.locator(".session-list-web").getByRole("button",{name:"Alpha one",exact:true}).click();
  pendingFile();holdFile=false;await settleFrame();await noDraft();
  await attach();await project("Beta");pendingFile();holdFile=false;await settleFrame();await noDraft();

  // The first send creates a session: preserve the image draft until submission succeeds.
  await paste();await page.getByRole("textbox",{name:"Message LOGOS"}).fill("first image");
  let requested=page.waitForRequest(request=>new URL(request.url()).pathname==="/api/bridge");
  await page.getByRole("button",{name:"Send",exact:true}).click();await requested;
  if(await page.getByAltText("待发送图片 1").count()!==1 || submissions[0].command.images?.length!==1) throw new Error("Auto-created session discarded its first image");
  let response=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/bridge");
  heldSubmissions.shift()({status:400,data:{error:"fixture rejection"}});await response;await settleFrame();
  if(await page.getByAltText("待发送图片 1").count()!==1) throw new Error("Rejected first submission lost its image draft");

  // Accepting the old host's send must not clear another project's pending draft.
  requested=page.waitForRequest(request=>new URL(request.url()).pathname==="/api/bridge");
  await page.getByRole("button",{name:"Send",exact:true}).click();await requested;
  await project("Alpha");await paste();await page.getByRole("textbox",{name:"Message LOGOS"}).fill("current image");
  requested=page.waitForRequest(request=>new URL(request.url()).pathname==="/api/bridge");
  await page.getByRole("button",{name:"Send",exact:true}).click();await requested;
  response=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/bridge");
  heldSubmissions.shift()({status:202,data:{run:{id:"old",status:"queued"}}});await response;await settleFrame();
  if(await page.getByAltText("待发送图片 1").count()!==1) throw new Error("Old project acceptance cleared current pending images");
  heldSubmissions.shift()({status:202,data:{run:{id:"current",status:"queued"}}});await noDraft();

  // Even the same host must reject acceptance from a previous session/send.
  await page.getByRole("button",{name:"会话",exact:true}).click();
  await page.locator(".session-list-web").getByRole("button",{name:"Alpha two",exact:true}).click();
  await paste();await page.getByRole("textbox",{name:"Message LOGOS"}).fill("older session image");
  requested=page.waitForRequest(request=>new URL(request.url()).pathname==="/api/bridge");
  await page.getByRole("button",{name:"Send",exact:true}).click();await requested;
  await page.locator(".session-list-web").getByRole("button",{name:"Alpha one",exact:true}).click();await noDraft();
  await paste();await page.getByRole("textbox",{name:"Message LOGOS"}).fill("newer session image");
  requested=page.waitForRequest(request=>new URL(request.url()).pathname==="/api/bridge");
  await page.getByRole("button",{name:"Send",exact:true}).click();await requested;
  response=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/bridge");
  heldSubmissions.shift()({status:202,data:{run:{id:"older-session",status:"queued"}}});await response;await settleFrame();
  if(await page.getByAltText("待发送图片 1").count()!==1) throw new Error("Old session acceptance cleared a newer pending image");
  heldSubmissions.shift()({status:202,data:{run:{id:"newer-session",status:"queued"}}});await noDraft();
  if(errors.length) throw new Error(errors.join("\n"));
  return {sidebarSessionClearsDraft:true,lateFileSessionGuard:true,lateFileProjectGuard:true,firstSessionPreservesImage:true,rejectedSendPreservesImage:true,oldHostAcceptanceIgnored:true,oldSessionAcceptanceIgnored:true,submissions:submissions.length};
}
