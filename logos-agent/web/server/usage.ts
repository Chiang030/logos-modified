import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { Run } from "./jobs.ts";
import type { Protocol } from "./models.ts";

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; raw: Record<string,unknown>; }
const count=(v:unknown): number => typeof v==="number" && Number.isSafeInteger(v) && v>=0 ? v : 0;
const object=(v:unknown): Record<string,unknown> => v && typeof v==="object" && !Array.isArray(v) ? v as Record<string,unknown> : {};
export function normalize(protocol:Protocol,value:Record<string,unknown>): Usage | undefined {
  const hasInput=typeof value.input_tokens==="number" || typeof value.prompt_tokens==="number";
  const hasOutput=typeof value.output_tokens==="number" || typeof value.completion_tokens==="number";
  if(!hasInput || !hasOutput) return undefined;
  let input=count(value.input_tokens ?? value.prompt_tokens),output=count(value.output_tokens ?? value.completion_tokens);
  const read=protocol==="anthropic-messages" ? count(value.cache_read_input_tokens) : count(object(value.input_tokens_details ?? value.prompt_tokens_details).cached_tokens);
  const write=protocol==="anthropic-messages" ? count(value.cache_creation_input_tokens) : 0;
  if(protocol==="anthropic-messages") input+=read+write;
  return {input,output,cacheRead:read,cacheWrite:write,total:typeof value.total_tokens==="number"?count(value.total_tokens):input+output,raw:value};
}
export class Meter {
  readonly store: Store;
  constructor(store:Store) {
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS model_requests(
      id TEXT PRIMARY KEY,owner TEXT NOT NULL,project TEXT NOT NULL,session TEXT NOT NULL,run TEXT NOT NULL,
      connection TEXT NOT NULL,connection_name TEXT NOT NULL,model TEXT NOT NULL,protocol TEXT NOT NULL,config_version INTEGER NOT NULL,
      created INTEGER NOT NULL,finished INTEGER,status TEXT NOT NULL,known INTEGER NOT NULL DEFAULT 0,
      input INTEGER NOT NULL DEFAULT 0,output INTEGER NOT NULL DEFAULT 0,cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,raw TEXT);
      CREATE INDEX IF NOT EXISTS usage_owner_date ON model_requests(owner,created);`);
  }
  start(run:Run,name:string,protocol:Protocol,version:number):string {
    const id=randomUUID();
    this.store.db.prepare("INSERT INTO model_requests(id,owner,project,session,run,connection,connection_name,model,protocol,config_version,created,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'started')")
      .run(id,run.owner,run.project,run.session,run.id,run.connection,name,run.model,protocol,version,Date.now());return id;
  }
  update(id:string,usage:Usage):void {
    this.store.db.prepare("UPDATE model_requests SET known=1,input=?,output=?,cache_read=?,cache_write=?,total=?,raw=? WHERE id=?").run(usage.input,usage.output,usage.cacheRead,usage.cacheWrite,usage.total,JSON.stringify(usage.raw),id);
  }
  finish(id:string,status:string):void {this.store.db.prepare("UPDATE model_requests SET status=?,finished=? WHERE id=?").run(status,Date.now(),id);}
  recover():void {this.store.db.prepare("UPDATE model_requests SET status='interrupted',finished=? WHERE status='started'").run(Date.now());}
  report(start:number,end:number,owner="",model=""):unknown {
    const where="r.created>=? AND r.created<? AND (?='' OR r.owner=?) AND (?='' OR r.model=?)";
    const params=[start,end,owner,owner,model,model];
    const rows=this.store.db.prepare(`SELECT r.owner,u.name,r.connection_name,r.model,COUNT(*) calls,
      SUM(CASE WHEN r.status IN ('failed','cancelled','interrupted') THEN 1 ELSE 0 END) failures,
      SUM(CASE WHEN r.known=0 THEN 1 ELSE 0 END) unknown,SUM(r.input) input,SUM(r.output) output,
      SUM(r.cache_read) cacheRead,SUM(r.cache_write) cacheWrite,SUM(r.total) total
      FROM model_requests r JOIN users u ON u.id=r.owner WHERE ${where}
      GROUP BY r.owner,r.connection_name,r.model ORDER BY total DESC`).all(...params);
    const requests=this.store.db.prepare(`SELECT r.id,r.owner,u.name,r.project,r.session,r.run,r.connection_name,r.model,r.created,r.status,r.known,r.input,r.output,r.cache_read,r.cache_write,r.total FROM model_requests r JOIN users u ON u.id=r.owner WHERE ${where} ORDER BY r.created DESC LIMIT 500`).all(...params);
    const users=this.store.db.prepare("SELECT id,name FROM users ORDER BY name").all();
    return {rows,requests,users,start,end};
  }
}
export function csv(rows:Record<string,unknown>[]):string {
  const fields=["name","owner","connection_name","model","calls","failures","unknown","input","output","cacheRead","cacheWrite","total"];
  const cell=(value:unknown):string => { let s=String(value??"");if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'; };
  return "\uFEFF"+[fields.map(cell).join(","),...rows.map(row=>fields.map(key=>cell(row[key])).join(","))].join("\r\n");
}
