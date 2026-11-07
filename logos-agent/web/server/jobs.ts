import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { Connection } from "./models.ts";
import { HttpError } from "./errors.ts";

export type RunStatus = "queued" | "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";
export interface Run { id: string; owner: string; project: string; session: string; connection: string; model: string; thinking: string; prompt: string; status: RunStatus; created: number; started: number | null; finished: number | null; error: string | null; request_key: string; }
export interface Event { seq: number; payload: Record<string, unknown>; }
export class Jobs {
  readonly store: Store;
  constructor(store: Store) {
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS runs(
      id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),project TEXT NOT NULL REFERENCES projects(id),
      session TEXT NOT NULL REFERENCES conversations(id),connection TEXT NOT NULL,model TEXT NOT NULL,thinking TEXT NOT NULL,
      prompt TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,started INTEGER,finished INTEGER,error TEXT,
      request_key TEXT NOT NULL,UNIQUE(owner,request_key));
      CREATE INDEX IF NOT EXISTS runs_status ON runs(status,created);
      CREATE TABLE IF NOT EXISTS run_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,session TEXT NOT NULL,run TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON run_events(owner,session,seq);
      CREATE TABLE IF NOT EXISTS worker_state(id INTEGER PRIMARY KEY CHECK(id=1),heartbeat INTEGER NOT NULL,ready INTEGER NOT NULL,reason TEXT NOT NULL);`);
  }
  health(): { ready: boolean; reason: string } {
    const row = this.store.db.prepare("SELECT * FROM worker_state WHERE id=1").get() as { heartbeat: number; ready: number; reason: string } | undefined;
    if (!row || Date.now()-row.heartbeat>15000) return { ready: false, reason: "任务服务尚未启动或正在重启" };
    return { ready: Boolean(row.ready), reason: row.reason };
  }
  heartbeat(ready: boolean, reason: string): void { this.store.db.prepare("INSERT INTO worker_state VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat,ready=excluded.ready,reason=excluded.reason").run(Date.now(),Number(ready),reason); }
  submit(owner: string, project: string, session: string, model: Connection, modelId: string, prompt: string, key: string, thinking = "off"): Run {
    const conversation = this.store.session(owner,session);
    if (conversation.project !== project) throw new HttpError(404,"会话不存在");
    const prior = this.store.db.prepare("SELECT * FROM runs WHERE owner=? AND request_key=?").get(owner,key) as unknown as Run | undefined;
    if (prior) {
      if (prior.project!==project || prior.session!==session || prior.prompt!==prompt || prior.connection!==model.id || prior.model!==modelId) throw new HttpError(409,"提交标识已用于不同任务");
      return prior;
    }
    if (!this.health().ready) throw new HttpError(503,this.health().reason);
    if (!model.enabled || !model.models.includes(modelId)) throw new HttpError(400,"模型未开放");
    if (this.store.db.prepare("SELECT id FROM runs WHERE session=? AND status IN ('queued','starting','running','cancelling')").get(session)) throw new HttpError(409,"此会话已有任务，请等待或停止后再发送");
    if (Number((this.store.db.prepare("SELECT COUNT(*) n FROM runs WHERE owner=? AND status='queued'").get(owner) as {n:number}).n)>=10) throw new HttpError(429,"排队任务过多，请稍后再试");
    const id=randomUUID();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)").run(id,owner,project,session,model.id,modelId,thinking,prompt,"queued",Date.now(),key);
      this.event(id,{type:"message/user",id:"user-"+id,text:prompt,userName:(this.store.db.prepare("SELECT name FROM users WHERE id=?").get(owner) as {name:string}).name});
      if (conversation.title==="新会话") this.store.renameSession(owner,session,prompt.replace(/\s+/g," ").slice(0,40));
      this.store.db.exec("COMMIT");
    } catch(error) {this.store.db.exec("ROLLBACK");throw error;}
    return this.get(owner,id);
  }
  get(owner: string,id: string): Run {
    const row=this.store.db.prepare("SELECT * FROM runs WHERE owner=? AND id=?").get(owner,id) as unknown as Run | undefined;
    if (!row) throw new HttpError(404,"任务不存在");return row;
  }
  list(owner: string, session?: string): Run[] {
    return (session ? this.store.db.prepare("SELECT * FROM runs WHERE owner=? AND session=? ORDER BY created DESC LIMIT 100").all(owner,session)
      : this.store.db.prepare("SELECT * FROM runs WHERE owner=? ORDER BY created DESC LIMIT 100").all(owner)) as unknown as Run[];
  }
  claim(limit=5): Run | undefined {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const active=this.store.db.prepare("SELECT * FROM runs WHERE status IN ('starting','running','cancelling')").all() as unknown as Run[];
      const queued=this.store.db.prepare("SELECT r.* FROM runs r LEFT JOIN (SELECT owner,MAX(started) last_start FROM runs GROUP BY owner) u ON u.owner=r.owner WHERE r.status='queued' ORDER BY COALESCE(u.last_start,0),r.created").all() as unknown as Run[];
      const row=active.length<limit ? queued.find(r=>!active.some(a=>a.owner===r.owner || a.project===r.project)) : undefined;
      if(row) this.store.db.prepare("UPDATE runs SET status='starting',started=? WHERE id=? AND status='queued'").run(Date.now(),row.id);
      this.store.db.exec("COMMIT");
      return row ? this.get(row.owner,row.id) : undefined;
    } catch(error){this.store.db.exec("ROLLBACK");throw error;}
  }
  event(run: string,payload: Record<string,unknown>): void {
    const r=this.store.db.prepare("SELECT owner,session FROM runs WHERE id=?").get(run) as {owner:string;session:string};
    this.store.db.prepare("INSERT INTO run_events(owner,session,run,payload) VALUES(?,?,?,?)").run(r.owner,r.session,run,JSON.stringify(payload));
  }
  events(owner:string,session:string,after:number): Event[] {
    this.store.session(owner,session);
    return (this.store.db.prepare("SELECT seq,payload FROM run_events WHERE owner=? AND session=? AND seq>? ORDER BY seq LIMIT 500").all(owner,session,after) as {seq:number;payload:string}[]).map(r=>({seq:r.seq,payload:JSON.parse(r.payload)}));
  }
  running(id:string): void {this.store.db.prepare("UPDATE runs SET status='running' WHERE id=? AND status='starting'").run(id);}
  cancel(owner:string,id:string): void {
    const run=this.get(owner,id);
    if(run.status==="queued") this.finish(id,"cancelled");
    else this.store.db.prepare("UPDATE runs SET status='cancelling' WHERE id=? AND status IN ('starting','running')").run(id);
  }
  finish(id:string,status:RunStatus,error?:string): void {
    this.store.db.prepare("UPDATE runs SET status=?,finished=?,error=? WHERE id=?").run(status,Date.now(),error??null,id);
    if(error) this.event(id,{type:"runtime/error",message:error,fatal:false});
    this.event(id,{type:"run/settled",aborted:status==="cancelled",outcome:status==="cancelled"?"aborted":status==="interrupted"?"interrupted":status==="completed"?"completed":"failed"});
  }
  recover(): void {
    const rows=this.store.db.prepare("SELECT id FROM runs WHERE status IN ('starting','running','cancelling')").all() as {id:string}[];
    for(const row of rows) this.finish(row.id,"interrupted","运行服务曾中断，本轮未自动重跑；已生成文件保留。");
  }
}
