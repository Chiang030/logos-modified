// Browser acceptance without authorizing a real account or mutating live APIs.
export default async function verifyOpenAiAccount(page,origin) {
  const check=(condition,message)=>{if(!condition)throw new Error(message);};
  let connected=false,phase="waiting",saved;
  const connection={id:"account-fixture",name:"ChatGPT",authType:"openai-chatgpt",baseUrl:"https://api.openai.com/v1",protocol:"openai-responses",models:["fixture-chat"],enabled:true,reasoning:false,contextWindow:128000,maxTokens:8192,version:1,hasKey:true};
  await page.route("**/api/**",async route=>{
    const request=route.request(),url=new URL(request.url());let data={};
    if(url.pathname==="/api/bootstrap")data={user:{id:"admin-fixture",name:"Admin",admin:true},csrf:"fixture",previewEnabled:false,version:"0.3.15",executionReady:true};
    else if(url.pathname==="/api/projects")data={projects:[{id:"project-fixture",name:"Project",directory:"fixture"}]};
    else if(url.pathname==="/api/files")data={entries:[]};
    else if(url.pathname==="/api/models")data={models:[],ready:true};
    else if(url.pathname==="/api/sessions")data={sessions:[]};
    else if(url.pathname==="/api/runs")data={runs:[],ready:true};
    else if(url.pathname==="/api/events")data={events:[]};
    else if(url.pathname==="/api/admin/status")data={ready:true,reason:"ready",active:{count:0},queued:{count:0}};
    else if(url.pathname==="/api/admin/models"){
      if(request.method()==="POST"){saved=request.postDataJSON();data={connection};}else data={connections:saved?[connection]:[]};
    }else if(url.pathname==="/api/admin/openai")data={connected};
    else if(url.pathname==="/api/admin/openai/login")data={id:"login-fixture",phase,url:"https://auth.openai.com/authorize?state=fixture",connected};
    else if(url.pathname==="/api/admin/openai/callback"){connected=true;phase="completed";data={id:"login-fixture",phase,connected};}
    else if(url.pathname==="/api/admin/openai/models")data={models:["fixture-chat"]};
    else if(url.pathname==="/api/admin/openai/logout"){connected=false;data={connected};}
    await route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
  });
  try {
    await page.goto(origin);
    await page.getByRole("button",{name:"管理后台",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"管理员控制台"});
    await dialog.getByRole("button",{name:"＋ ChatGPT 账号连接",exact:true}).click();
    check(await dialog.getByLabel("API Key",{exact:true}).count()===0,"Account mode must not ask for an API key");
    check(await dialog.getByLabel(/^API 地址/).inputValue()==="https://api.openai.com/v1","Account endpoint must be official");
    check(await dialog.getByLabel(/^API 地址/).getAttribute("readonly")!==null,"Account endpoint must be read-only");
    await dialog.getByRole("button",{name:"登录 ChatGPT",exact:true}).click();
    await dialog.getByRole("link",{name:"打开 ChatGPT 授权页面",exact:true}).waitFor();
    await dialog.getByLabel("授权后的完整回调地址").fill("http://127.0.0.1:1455/auth/callback?state=fixture&code=fixture&client_id=fixture");
    await dialog.getByRole("button",{name:"完成账号连接",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.admin-panel textarea[placeholder^="每行一个模型 ID"]')?.value==="fixture-chat");
    await dialog.getByRole("button",{name:"保存配置",exact:true}).click();
    await dialog.getByText("配置已保存。密钥不会返回浏览器；正在运行的任务继续使用启动时的配置。",{exact:true}).waitFor();
    check(saved?.authType==="openai-chatgpt"&&!saved?.apiKey,"Saved account configuration must contain no account token");
    await dialog.getByRole("button",{name:"退出账号",exact:true}).click();
    await dialog.getByRole("button",{name:"登录 ChatGPT",exact:true}).waitFor();
    await page.screenshot({path:"/tmp/logos-openai-account-admin.png",fullPage:true});
    return {passed:true,remoteCallback:true,officialEndpoint:true,noTokenInConfig:true,logout:true};
  } finally {await page.unroute("**/api/**");}
}
