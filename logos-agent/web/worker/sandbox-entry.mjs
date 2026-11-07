// Runs inside the isolated namespace. The only outbound channel is this run's Unix socket.
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
const proxy=createServer((incoming,outgoing)=>{
  const forward=request({socketPath:"/run/model.sock",path:incoming.url,method:incoming.method,headers:incoming.headers},response=>{
    outgoing.writeHead(response.statusCode??502,response.headers);response.pipe(outgoing);
  });
  forward.on("error",()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});
  outgoing.on("close",()=>forward.destroy());incoming.pipe(forward);
});
await new Promise(resolve=>proxy.listen(19231,"127.0.0.1",resolve));
const child=spawn("/opt/bin/node",[
  "--import","/opt/pi/packages/coding-agent/src/experimental/source-resolver.ts",
  "/opt/pi/packages/coding-agent/src/cli.ts",...process.argv.slice(2),
],{cwd:"/workspace",env:process.env,stdio:"inherit"});
child.on("error",()=>process.exit(1));
child.on("exit",code=>{proxy.closeAllConnections();proxy.close(()=>process.exit(code??1));});
