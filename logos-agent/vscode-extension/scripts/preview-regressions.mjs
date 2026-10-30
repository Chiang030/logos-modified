// Local, credential-free fixture for exercising the actual compiled webview UI.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const dist = new URL("../dist/", import.meta.url);
const bootstrap = `
window.sent = [];
window.deliver = (data) => window.dispatchEvent(new MessageEvent('message', {data}));
window.sessions = Array.from({length: 60}, (_, i) => ({sessionId: String(i), title: '测试会话 ' + i}));
window.acquireVsCodeApi = () => ({postMessage: (message) => {
  window.sent.push(message);
  if (message.type === 'webview/ready') setTimeout(() => {
    deliver({type:'session/list',sessions:window.sessions,activeSessionId:'0'});
    deliver({type:'session/restore',messages:[{id:'1',role:'user',text:'记住项目代号：海燕。'},{id:'2',role:'assistant',text:'已记录。请打开 [项目说明](docs/项目说明.md:12) 或 [KiCad](https://www.kicad.org)。\\n\\n可用鼠标选择这段文字并复制。'}]});
    deliver({type:'runtime/status',status:'ready'}); deliver({type:'session/loading',loading:false});
    deliver({type:'runtime/config',config:{models:[{id:'fixture',provider:'fixture',reasoning:true}],activeModel:{id:'fixture',provider:'fixture',reasoning:true},thinkingLevel:'off',thinkingLevels:['off','low','medium','high']}});
  }, 10);
  if (message.type === 'session/rename') { window.sessions=window.sessions.map(s=>s.sessionId===message.sessionId?{...s,title:message.title}:s); deliver({type:'session/list',sessions:window.sessions,activeSessionId:'0'}); }
  if (message.type === 'thinking/select') deliver({type:'runtime/config',config:{models:[{id:'fixture',provider:'fixture',reasoning:true}],activeModel:{id:'fixture',provider:'fixture',reasoning:true},thinkingLevel:message.level,thinkingLevels:['off','low','medium','high']}});
}});`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/webview.js" || request.url === "/webview.css") {
      response.setHeader("Content-Type", request.url.endsWith("js") ? "text/javascript" : "text/css");
      response.end(await readFile(fileURLToPath(new URL(request.url.slice(1), dist)))); return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/webview.css"></head><body><div id="root"></div><script>${bootstrap}</script><script src="/webview.js"></script></body></html>`);
  } catch { response.writeHead(500); response.end("Fixture error"); }
});
server.listen(0, "127.0.0.1", () => console.log(`UI fixture: http://127.0.0.1:${server.address().port}`));
