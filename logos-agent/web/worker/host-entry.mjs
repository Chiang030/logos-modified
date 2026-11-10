// Run under the server account. The local proxy preserves centralized usage accounting.
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [socket,repo,profile,...args]=process.argv.slice(2);
const proxy=createServer((incoming,outgoing)=>{
  const forward=request({socketPath:socket,path:incoming.url,method:incoming.method,headers:incoming.headers},response=>{
    outgoing.writeHead(response.statusCode??502,response.headers);response.pipe(outgoing);
  });
  forward.on("error",()=>{
    if(outgoing.destroyed)return;
    if(outgoing.headersSent){outgoing.destroy();return;}
    outgoing.writeHead(502,{"Content-Type":"application/json","Cache-Control":"no-store"});
    outgoing.end(JSON.stringify({error:{message:"模型内部转发连接失败，请重试或联系管理员检查任务服务"}}));
  });
  outgoing.on("close",()=>forward.destroy());incoming.pipe(forward);
});
await new Promise((resolve,reject)=>{proxy.once("error",reject);proxy.listen(0,"127.0.0.1",resolve);});
const config=JSON.parse(await readFile(join(profile,"models.json"),"utf8"));
for(const provider of Object.values(config.providers))provider.baseUrl="http://127.0.0.1:"+proxy.address().port;
await writeFile(join(profile,"models.json"),JSON.stringify(config),{mode:0o600});
const child=spawn(process.execPath,[
  "--import",join(repo,"vendor/pi/packages/coding-agent/src/experimental/source-resolver.ts"),
  join(repo,"vendor/pi/packages/coding-agent/src/cli.ts"),...args,
],{cwd:process.cwd(),env:process.env,stdio:"inherit"});
child.on("error",()=>process.exit(1));
child.on("exit",code=>{proxy.closeAllConnections();proxy.close(()=>process.exit(code??1));});
