import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, copyFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export type RunOutcome = "running" | "completed" | "failed" | "aborted" | "interrupted";
export interface PersistedSession {
  sessionFile?: string;
  sessionId?: string;
  updatedAt: string;
  outcome?: RunOutcome;
}
export interface SessionEntry extends PersistedSession { title: string; manualTitle?: boolean; }
interface SessionIndex { version?: number; active?: SessionEntry; sessions: SessionEntry[]; }
const queues = new Map<string, Promise<unknown>>();

export class SessionStore {
  private readonly filePath: string;
  readonly diagnostics: string[] = [];
  constructor(storageDirectory: string) { this.filePath = join(storageDirectory, "session.json"); }

  async load(): Promise<SessionEntry | undefined> {
    await queues.get(this.filePath);
    return (await this.readIndex()).active;
  }
  async list(): Promise<SessionEntry[]> {
    await queues.get(this.filePath);
    return (await this.readIndex()).sessions;
  }
  save(session: Omit<PersistedSession, "updatedAt"> & { title?: string }): Promise<void> {
    return this.change((index) => {
      if (!session.sessionId) return;
      const old = index.sessions.find((item) => item.sessionId === session.sessionId);
      const entry: SessionEntry = { ...old, ...session, title: old?.manualTitle ? old.title : session.title ?? old?.title ?? session.sessionId,
        updatedAt: new Date().toISOString() };
      index.sessions = [entry, ...index.sessions.filter((item) => item.sessionId !== entry.sessionId)];
      index.active = entry;
    });
  }
  clear(): Promise<void> { return this.change((index) => { index.active = undefined; }); }
  rename(sessionId: string, title: string): Promise<void> {
    if (!title.trim()) return Promise.reject(new Error("会话名称不能为空。"));
    return this.change((index) => {
      const entry = index.sessions.find((item) => item.sessionId === sessionId);
      if (!entry) throw new Error("会话不存在，请刷新历史列表。");
      entry.title = title.trim(); entry.manualTitle = true;
      if (index.active?.sessionId === sessionId) index.active = entry;
    });
  }
  setOutcome(sessionId: string, outcome: RunOutcome): Promise<void> {
    return this.change((index) => {
      const entry = index.sessions.find((item) => item.sessionId === sessionId);
      if (entry) entry.outcome = outcome;
      if (index.active?.sessionId === sessionId) index.active = entry;
    });
  }
  /** Reconcile transcripts without rewriting their authoritative contents. */
  reconcile(sessionDirectory: string): Promise<void> {
    return this.change(async (index) => {
      for (const entry of index.sessions) if (entry.outcome === "running") entry.outcome = "interrupted";
      let files: string[];
      try { files = await readdir(sessionDirectory); } catch (error) { if (isMissing(error)) return; throw error; }
      for (const name of files.filter((file) => file.endsWith(".jsonl"))) await this.recoverFile(index, join(sessionDirectory, name));
      if (index.active) index.active = index.sessions.find((item) => item.sessionId === index.active?.sessionId);
    });
  }
  private async recoverFile(index: SessionIndex, path: string): Promise<void> {
    try {
      const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
      const header: unknown = JSON.parse(lines[0]);
      if (!record(header) || header.type !== "session" || typeof header.id !== "string") throw new Error("Invalid session header");
      const existing = index.sessions.find((item) => item.sessionId === header.id);
      if (existing) existing.sessionFile = path;
      else index.sessions.push({ sessionId: header.id, sessionFile: path, title: header.id,
        updatedAt: typeof header.timestamp === "string" ? header.timestamp : new Date().toISOString() });
      for (const line of lines.slice(1)) JSON.parse(line);
    } catch (error) { this.warn(`会话文件已保留，但无法完整读取 ${path}: ${String(error)}`); }
  }
  private change(update: (index: SessionIndex) => void | Promise<void>): Promise<void> {
    const next = (queues.get(this.filePath) ?? Promise.resolve()).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const index = await this.readIndex();
      await update(index);
      await this.writeIndex(index);
    });
    queues.set(this.filePath, next.catch(() => undefined));
    return next;
  }
  private async writeIndex(index: SessionIndex): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const previous = await readFile(this.filePath, "utf8").catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
      if (previous) {
        try { parseIndex(previous); await copyFile(this.filePath, `${this.filePath}.bak`); }
        catch (error) { if (!(error instanceof SyntaxError) && !(error instanceof InvalidIndex)) throw error; }
      }
      await writeFile(temporary, `${JSON.stringify({ ...index, version: 2 }, null, 2)}\n`, { mode: 0o600, flush: true });
      await rename(temporary, this.filePath);
    } finally { await rm(temporary, { force: true }); }
  }
  private async readIndex(): Promise<SessionIndex> {
    try { return parseIndex(await readFile(this.filePath, "utf8")); }
    catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError) && !(error instanceof InvalidIndex)) throw error;
      if (!isMissing(error)) {
        const saved = `${this.filePath}.corrupt-${randomUUID()}`;
        await copyFile(this.filePath, saved);
        this.warn(`会话索引损坏，原文件已保留：${saved}`);
      }
      try { return parseIndex(await readFile(`${this.filePath}.bak`, "utf8")); }
      catch (backupError) {
        if (!isMissing(backupError)) this.warn(`会话备份不可读：${String(backupError)}`);
        return { sessions: [] };
      }
    }
  }
  private warn(message: string): void { if (!this.diagnostics.includes(message)) this.diagnostics.push(message); }
}
class InvalidIndex extends Error {}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isMissing(error: unknown): boolean { return record(error) && error.code === "ENOENT"; }
function isEntry(value: unknown): value is SessionEntry {
  return record(value) && typeof value.sessionId === "string" && typeof value.title === "string"
    && (value.sessionFile === undefined || typeof value.sessionFile === "string");
}
function parseIndex(text: string): SessionIndex {
  const value: unknown = JSON.parse(text);
  if (record(value) && Array.isArray(value.sessions) && value.sessions.every(isEntry)
    && (value.active === undefined || isEntry(value.active))) return value as unknown as SessionIndex;
  if (record(value) && typeof value.sessionId === "string") {
    const entry: SessionEntry = { sessionId: value.sessionId, title: value.sessionId,
      sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : undefined,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString() };
    return { active: entry, sessions: [entry] };
  }
  throw new InvalidIndex("Invalid LOGOS session index");
}
