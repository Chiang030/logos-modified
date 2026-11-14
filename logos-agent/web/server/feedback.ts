import { randomUUID, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store, User } from "./store.ts";
import { HttpError } from "./errors.ts";
import { body, json } from "./http.ts";

export type FeedbackStatus = "pending" | "accepted" | "resolved" | "duplicate" | "rejected";
export interface FeedbackItem { id: string; owner: string; kind: "bug" | "feature"; title: string; description: string; project: string | null; session: string | null; status: FeedbackStatus; note: string; created: number; updated: number; }
export interface FeedbackPage { items: FeedbackItem[]; limit: number; offset: number; hasMore: boolean; }
export interface LeaderboardRow { name: string; count: number; }
const DAY = 86400000;
const statuses = ["pending", "accepted", "resolved", "duplicate", "rejected"];
function field(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new HttpError(400, `${label}不能为空，且不得超过 ${max} 字符或包含控制字符`);
  return value.trim();
}
function reference(value: unknown): string | null { return value === undefined || value === null || value === "" ? null : field(value, "引用", 128); }
function integer(value: string | null, fallback: number, max: number, min = 0): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new HttpError(400, "分页参数无效");
  return Number(value);
}
function administrator(user: User): void { if (!user.admin) throw new HttpError(403, "此功能仅管理员可用"); }

/** Owns only feedback tables. Construct after Jobs and Meter initialize their tables. */
export class Feedback {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS feedback(
      id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('bug','feature')),
      title TEXT NOT NULL, description TEXT NOT NULL, project TEXT, session TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','resolved','duplicate','rejected')),
      note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      UNIQUE(owner,fingerprint));
      CREATE INDEX IF NOT EXISTS feedback_owner_created ON feedback(owner,created);
      CREATE INDEX IF NOT EXISTS feedback_status_created ON feedback(status,created);
      CREATE TABLE IF NOT EXISTS feedback_reviews(id INTEGER PRIMARY KEY AUTOINCREMENT, feedback TEXT NOT NULL REFERENCES feedback(id),
        reviewer TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, note TEXT NOT NULL, created INTEGER NOT NULL);`);
  }
  submit(user: User, input: Record<string, unknown>, now = Date.now()): FeedbackItem {
    if (input.kind !== "bug" && input.kind !== "feature") throw new HttpError(400, "请选择问题或需求");
    const title = field(input.title, "标题", 120), description = field(input.description, "描述", 5000);
    let project = reference(input.project); const session = reference(input.session);
    if (project) this.store.project(user.id, project);
    if (session) {
      const conversation = this.store.session(user.id, session);
      if (project && conversation.project !== project) throw new HttpError(400, "项目与会话不匹配");
      project = conversation.project;
      this.store.project(user.id, project);
    }
    const fingerprint = createHash("sha256").update([input.kind, title, description].map(v => v.normalize("NFKC").toLowerCase().replace(/\s+/g, " ")).join("\n")).digest("hex");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.store.db.prepare("SELECT id FROM feedback WHERE owner=? AND fingerprint=?").get(user.id, fingerprint)) throw new HttpError(409, "已提交相同反馈，请查看原条目状态");
      const recent = this.store.db.prepare("SELECT COUNT(*) n FROM feedback WHERE owner=? AND created>=?").get(user.id, now - DAY) as { n: number };
      if (recent.n >= 10) throw new HttpError(429, "24 小时内最多提交 10 条反馈，请稍后再试");
      const item: FeedbackItem = { id: randomUUID(), owner: user.id, kind: input.kind, title, description, project, session, status: "pending", note: "", created: now, updated: now };
      this.store.db.prepare("INSERT INTO feedback(id,owner,kind,title,description,project,session,status,note,created,updated,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(item.id, item.owner, item.kind, title, description, project, session, item.status, "", now, now, fingerprint);
      this.store.db.exec("COMMIT"); return item;
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  list(user: User, query: URLSearchParams, admin = false): FeedbackPage {
    if (admin) administrator(user);
    const limit = integer(query.get("limit"), 20, 100, 1), offset = integer(query.get("offset"), 0, 100000);
    const status = query.get("status") ?? "";
    if (status && !statuses.includes(status)) throw new HttpError(400, "反馈状态无效");
    const rows = this.store.db.prepare(`SELECT id,owner,kind,title,description,project,session,status,note,created,updated FROM feedback
      WHERE (?=1 OR owner=?) AND (?='' OR status=?) ORDER BY created DESC,id DESC LIMIT ? OFFSET ?`)
      .all(Number(admin), user.id, status, status, limit + 1, offset) as unknown as FeedbackItem[];
    return { items: rows.slice(0, limit), limit, offset, hasMore: rows.length > limit };
  }
  review(user: User, id: string, input: Record<string, unknown>, now = Date.now()): FeedbackItem {
    administrator(user);
    if (typeof input.status !== "string" || !statuses.includes(input.status) || input.status === "pending") throw new HttpError(400, "审核状态无效");
    const note = input.note === undefined || input.note === "" ? "" : field(input.note, "审核说明", 1000);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.store.db.prepare("SELECT owner FROM feedback WHERE id=?").get(id) as { owner: string } | undefined;
      if (!row) throw new HttpError(404, "反馈不存在");
      if (row.owner === user.id) throw new HttpError(403, "不能审核自己的反馈，请由其他管理员审核");
      this.store.db.prepare("UPDATE feedback SET status=?,note=?,updated=? WHERE id=?").run(input.status, note, now, id);
      this.store.db.prepare("INSERT INTO feedback_reviews(feedback,reviewer,status,note,created) VALUES(?,?,?,?,?)").run(id, user.id, input.status, note, now);
      const item = this.store.db.prepare("SELECT id,owner,kind,title,description,project,session,status,note,created,updated FROM feedback WHERE id=?").get(id) as unknown as FeedbackItem;
      this.store.db.exec("COMMIT"); return item;
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  leaderboards(now = Date.now()): { start: number; end: number; timezone: string; usageMetric: string; feedbackMetric: string; usage: LeaderboardRow[]; feedback: LeaderboardRow[] } {
    // Today plus 29 preceding Beijing calendar days, through the current instant.
    const start = Math.floor((now + 8 * 3600000) / DAY) * DAY - 8 * 3600000 - 29 * DAY;
    const usage = this.store.db.prepare(`SELECT u.name,COUNT(DISTINCT date(r.finished/1000,'unixepoch','+8 hours')) count
      FROM runs r JOIN users u ON u.id=r.owner WHERE r.status='completed' AND r.finished>=? AND r.finished<=?
      AND EXISTS(SELECT 1 FROM model_requests m WHERE m.run=r.id AND m.owner=r.owner AND m.project=r.project AND m.session=r.session
        AND m.status='completed' AND m.known=1 AND (m.input>0 OR m.output>0) AND m.finished<=r.finished)
      GROUP BY u.id ORDER BY count DESC,u.name COLLATE NOCASE,u.id LIMIT 20`).all(start, now) as unknown as LeaderboardRow[];
    const feedback = this.store.db.prepare(`SELECT u.name,COUNT(*) count FROM feedback f JOIN users u ON u.id=f.owner
      WHERE f.created>=? AND f.created<=? AND f.status IN ('accepted','resolved')
      GROUP BY u.id ORDER BY count DESC,u.name COLLATE NOCASE,u.id LIMIT 20`).all(start, now) as unknown as LeaderboardRow[];
    return { start, end: now, timezone: "Asia/Shanghai", usageMetric: "近30个自然日（含今天）的有效活跃天数：当天至少完成一次有真实已知非零用量的成功任务，每日最多计1天。", feedbackMetric: "近30个自然日内提交、当前由其他管理员受理或解决的非重复反馈数；重复、拒绝和待审核不计入。", usage, feedback };
  }
}

/** Call ONLY after createHandler's authentication and Origin/CSRF checks. */
export async function feedbackRoute(resource: Feedback, user: User, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = url.pathname;
  if (path === "/api/leaderboards" && req.method === "GET") { json(res, resource.leaderboards()); return true; }
  if (path === "/api/feedback" && req.method === "GET") { json(res, resource.list(user, url.searchParams)); return true; }
  if (path === "/api/feedback" && req.method === "POST") { json(res, { item: resource.submit(user, await body(req)) }, 201); return true; }
  if (path === "/api/admin/feedback" && req.method === "GET") { json(res, resource.list(user, url.searchParams, true)); return true; }
  const match = /^\/api\/admin\/feedback\/([^/]+)$/.exec(path);
  if (match && req.method === "PATCH") { administrator(user); json(res, { item: resource.review(user, match[1], await body(req)) }); return true; }
  return false;
}
