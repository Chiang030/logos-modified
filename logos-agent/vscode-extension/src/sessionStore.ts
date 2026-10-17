import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PersistedSession {
  sessionFile?: string;
  sessionId?: string;
  updatedAt: string;
}
export interface SessionEntry extends PersistedSession { title: string; }
interface SessionIndex { active?: SessionEntry; sessions: SessionEntry[]; }

export class SessionStore {
  private readonly filePath: string;

  constructor(storageDirectory: string) {
    this.filePath = join(storageDirectory, "session.json");
  }

  async load(): Promise<PersistedSession | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (isSessionIndex(parsed)) return parsed.active;
      if (isPersistedSession(parsed)) return parsed;
      return undefined;
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async save(session: Omit<PersistedSession, "updatedAt"> & { title?: string }): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const current = await this.readIndex();
    const entry: SessionEntry = { ...session, title: session.title ?? session.sessionId ?? "Untitled session", updatedAt: new Date().toISOString() };
    const sessions = [entry, ...current.sessions.filter((item) => item.sessionId !== entry.sessionId)].slice(0, 50);
    await writeFile(this.filePath, `${JSON.stringify({ active: entry, sessions }, null, 2)}\n`, "utf8");
  }

  async clear(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const current = await this.readIndex();
    await writeFile(this.filePath, `${JSON.stringify({ sessions: current.sessions }, null, 2)}\n`, "utf8");
  }

  async list(): Promise<SessionEntry[]> { return (await this.readIndex()).sessions; }

  private async readIndex(): Promise<SessionIndex> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (isSessionIndex(parsed)) return parsed;
      if (isPersistedSession(parsed)) return { active: { ...parsed, title: parsed.sessionId ?? "Untitled session" }, sessions: parsed.sessionId ? [{ ...parsed, title: parsed.sessionId }] : [] };
    } catch (error) { if (!isMissingFile(error)) throw error; }
    return { sessions: [] };
  }

}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.sessionFile === undefined || typeof record.sessionFile === "string") &&
    (record.sessionId === undefined || typeof record.sessionId === "string") &&
    (record.updatedAt === undefined || typeof record.updatedAt === "string")
  );
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSessionIndex(value: unknown): value is SessionIndex {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.sessions) && record.sessions.every(isSessionEntry) && (record.active === undefined || isSessionEntry(record.active));
}

function isSessionEntry(value: unknown): value is SessionEntry {
  return isPersistedSession(value) && typeof (value as unknown as Record<string, unknown>).title === "string";
}
