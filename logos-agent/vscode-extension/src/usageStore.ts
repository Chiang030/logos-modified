import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./shared/protocol";
import { validMemberName, type IdentityView, type MemberIdentity, type ModelUsageSummary, type TokenUsage, type UsageSummary } from "./shared/members";

interface SessionIdentity { sessionId: string; member: MemberIdentity; createdAt: string; }
interface UsageEntry {
  id: string;
  sessionId: string;
  member: MemberIdentity;
  provider: string;
  model: string;
  recordedAt: string;
  failed: boolean;
  tokens?: TokenUsage;
}
interface Ledger {
  version: 1;
  members: MemberIdentity[];
  selectedId?: string;
  sessions: SessionIdentity[];
  usage: UsageEntry[];
}
const queues = new Map<string, Promise<unknown>>();
const zeroTokens = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

/** Workspace-local attribution and observed model usage; never stores prompts or API keys. */
export class UsageStore {
  readonly filePath: string;
  constructor(private readonly directory: string) { this.filePath = join(directory, "session-identities.json"); }

  async selected(): Promise<MemberIdentity | undefined> {
    const ledger = await this.read();
    return ledger.members.find((member) => member.id === ledger.selectedId);
  }

  /** Add a local name, or select the existing entry when the name matches. */
  add(name: string): Promise<void> {
    if (!validMemberName(name)) return Promise.reject(new Error("请输入 1–80 个字符的姓名，不含控制字符。"));
    return this.change((ledger) => {
      const normalized = name.trim().normalize("NFC");
      let member = ledger.members.find((entry) => entry.name.normalize("NFC") === normalized);
      if (!member) { member = { id: randomUUID(), name: normalized }; ledger.members.push(member); }
      ledger.selectedId = member.id;
    });
  }

  select(id: string): Promise<void> {
    return this.change((ledger) => {
      if (!ledger.members.some((member) => member.id === id)) throw new Error("请选择已添加的姓名。");
      ledger.selectedId = id;
    });
  }

  async owner(sessionId: string): Promise<MemberIdentity | undefined> {
    return (await this.read()).sessions.find((entry) => entry.sessionId === sessionId)?.member;
  }

  bind(sessionId: string, member: MemberIdentity): Promise<void> {
    return this.change((ledger) => {
      const registered = ledger.members.find((entry) => entry.id === member.id);
      if (!sessionId || !registered) throw new Error("无效的会话或使用者。");
      const previous = ledger.sessions.find((entry) => entry.sessionId === sessionId);
      if (previous && previous.member.id !== member.id) throw new Error(`当前会话属于 ${previous.member.name}，请新建会话后使用。`);
      if (!previous) ledger.sessions.push({ sessionId, member: { ...registered }, createdAt: new Date().toISOString() });
    });
  }

  /** Stable response fingerprints make live events and transcript recovery idempotent. */
  record(sessionId: string, messages: Record<string, unknown>[]): Promise<void> {
    const responses = messages.filter((message) => message.role === "assistant" && typeof message.provider === "string"
      && typeof message.model === "string" && typeof message.timestamp === "number" && Number.isFinite(message.timestamp));
    if (!responses.length) return Promise.resolve();
    return this.change((ledger) => {
      const owner = ledger.sessions.find((entry) => entry.sessionId === sessionId)?.member;
      if (!owner) return;
      const ids = new Set(ledger.usage.map((entry) => entry.id));
      for (const message of responses) {
        const entry = usageEntry(sessionId, owner, message);
        if (entry && !ids.has(entry.id)) { ledger.usage.push(entry); ids.add(entry.id); }
      }
    });
  }

  async view(): Promise<IdentityView> {
    const ledger = await this.read();
    const summaries = ledger.members.map((member) => summarize(member, ledger.sessions, ledger.usage));
    const models = new Map<string, ModelUsageSummary>();
    for (const entry of ledger.usage) {
      const key = JSON.stringify([entry.member.id, entry.provider, entry.model]);
      if (!models.has(key)) models.set(key, { ...summarize(entry.member, [], []), provider: entry.provider, model: entry.model });
      accumulate(models.get(key)!, entry);
    }
    return { selected: ledger.members.find((member) => member.id === ledger.selectedId), members: ledger.members,
      summaries, models: [...models.values()], recordFile: this.filePath };
  }

  private async read(): Promise<Ledger> {
    await queues.get(this.filePath);
    return this.readFile();
  }

  private async readFile(): Promise<Ledger> {
    try { return parseLedger(await readFile(this.filePath, "utf8")); }
    catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return { version: 1, members: [], sessions: [], usage: [] };
      throw error;
    }
  }

  private change(update: (ledger: Ledger) => void): Promise<void> {
    const next = (queues.get(this.filePath) ?? Promise.resolve()).then(async () => {
      const ledger = await this.readFile();
      update(ledger);
      await mkdir(this.directory, { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flush: true });
        await rename(temporary, this.filePath);
      } finally { await rm(temporary, { force: true }); }
    });
    queues.set(this.filePath, next.catch(() => undefined));
    return next;
  }
}

function usageEntry(sessionId: string, member: MemberIdentity, message: Record<string, unknown>): UsageEntry | undefined {
  if (message.role !== "assistant" || typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return undefined;
  const fingerprint = message.responseId || [message.timestamp, message.content, message.usage, message.stopReason];
  const id = createHash("sha256").update(JSON.stringify([sessionId, message.provider, message.model, fingerprint])).digest("hex");
  return { id, sessionId, member: { ...member }, provider: message.provider, model: message.model,
    recordedAt: new Date().toISOString(), failed: ["error", "aborted"].includes(String(message.stopReason)), tokens: tokensFromUsage(message.usage) };
}

function validCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

function tokensFromUsage(usage: unknown): TokenUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const { input, output, cacheRead, cacheWrite } = usage;
  if (!validCount(input) || !validCount(output) || !validCount(cacheRead) || !validCount(cacheWrite)) return undefined;
  const total = input + output + cacheRead + cacheWrite;
  // Pi initializes missing upstream usage to zero; it does not prove a free response.
  return total > 0 && Number.isSafeInteger(total) ? { input, output, cacheRead, cacheWrite, total } : undefined;
}

function summarize(member: MemberIdentity, sessions: SessionIdentity[], usage: UsageEntry[]): UsageSummary {
  const result: UsageSummary = { member: { ...member }, sessions: sessions.filter((entry) => entry.member.id === member.id).length,
    responses: 0, failed: 0, unknownUsage: 0, ...zeroTokens() };
  for (const entry of usage) if (entry.member.id === member.id) accumulate(result, entry);
  return result;
}

function accumulate(summary: UsageSummary, entry: UsageEntry): void {
  summary.responses += 1;
  if (entry.failed) summary.failed += 1;
  if (!entry.tokens) { summary.unknownUsage += 1; return; }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) summary[key] += entry.tokens[key];
}

function isMember(value: unknown): value is MemberIdentity {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

function isSession(value: unknown): boolean {
  return isRecord(value) && typeof value.sessionId === "string" && isMember(value.member) && typeof value.createdAt === "string";
}

function isUsage(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.sessionId === "string" && isMember(value.member)
    && typeof value.provider === "string" && typeof value.model === "string" && typeof value.recordedAt === "string" && typeof value.failed === "boolean"
    && (value.tokens === undefined || isTokens(value.tokens));
}

function isTokens(value: unknown): boolean {
  return isRecord(value) && ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => validCount(value[key]));
}

function parseLedger(text: string): Ledger {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1 || (value.selectedId !== undefined && typeof value.selectedId !== "string")
    || (value.members !== undefined && (!Array.isArray(value.members) || !value.members.every(isMember)))
    || !Array.isArray(value.sessions) || !value.sessions.every(isSession) || !Array.isArray(value.usage) || !value.usage.every(isUsage)) {
    throw new Error("使用记录文件格式无效，请检查 session-identities.json；原文件未被覆盖。");
  }
  // Old preset selections are cleared; historical session owners remain intact.
  if (value.members === undefined) { value.members = []; delete value.selectedId; }
  const ledger = value as unknown as Ledger;
  if (ledger.selectedId && !ledger.members.some((member) => member.id === ledger.selectedId)) delete ledger.selectedId;
  return ledger;
}
