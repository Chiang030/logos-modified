import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "./errors.ts";

export interface User { id: string; name: string; admin: boolean; }
export interface Project { id: string; owner: string; name: string; directory: string; created: number; }
export interface Session { id: string; owner: string; project: string; title: string; created: number; }
interface UserRow { id: string; name: string; admin: number; }
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, name TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS auth_sessions(hash TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, directory TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(owner,directory));
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), project TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      PRAGMA user_version=1;
    `);
  }
  close(): void { this.db.close(); }
  user(identity: string, name: string, admin = false): User {
    this.db.prepare("INSERT INTO users VALUES(?,?,?,?) ON CONFLICT(identity) DO UPDATE SET name=excluded.name,admin=excluded.admin")
      .run(randomUUID(), identity, name, Number(admin));
    const row = this.db.prepare("SELECT id,name,admin FROM users WHERE identity=?").get(identity) as unknown as UserRow;
    return { ...row, admin: Boolean(row.admin) };
  }
  login(user: User): { token: string; csrf: string } {
    const token = randomBytes(32).toString("hex"), csrf = randomBytes(24).toString("hex");
    this.db.prepare("DELETE FROM auth_sessions WHERE expires<?").run(Date.now());
    this.db.prepare("INSERT INTO auth_sessions VALUES(?,?,?,?)").run(digest(token), user.id, csrf, Date.now() + 12 * 3600_000);
    return { token, csrf };
  }
  authenticate(token: string | undefined): { user: User; csrf: string } {
    const row = token && this.db.prepare("SELECT u.id,u.name,u.admin,s.csrf FROM auth_sessions s JOIN users u ON u.id=s.owner WHERE s.hash=? AND s.expires>?")
      .get(digest(token), Date.now()) as unknown as (UserRow & { csrf: string }) | undefined;
    if (!row) throw new HttpError(401, "请先登录");
    return { user: { id: row.id, name: row.name, admin: Boolean(row.admin) }, csrf: row.csrf };
  }
  logout(token: string): void { this.db.prepare("DELETE FROM auth_sessions WHERE hash=?").run(digest(token)); }
  saveState(state: string): void {
    this.db.prepare("DELETE FROM oauth_states WHERE expires<?").run(Date.now());
    this.db.prepare("INSERT INTO oauth_states VALUES(?,?)").run(digest(state), Date.now() + 600_000);
  }
  consumeState(state: string): boolean {
    const row = this.db.prepare("DELETE FROM oauth_states WHERE hash=? AND expires>? RETURNING hash").get(digest(state), Date.now());
    return Boolean(row);
  }
  projects(owner: string): Project[] {
    return this.db.prepare("SELECT * FROM projects WHERE owner=? ORDER BY created DESC").all(owner) as unknown as Project[];
  }
  project(owner: string, id: string): Project {
    const value = this.db.prepare("SELECT * FROM projects WHERE id=? AND owner=?").get(id, owner) as unknown as Project | undefined;
    if (!value) throw new HttpError(404, "项目不存在");
    return value;
  }
  createProject(owner: string, name: string, directory: string): Project {
    const existing = this.projects(owner).find((p) => p.directory === directory);
    if (existing) return existing;
    if (this.projects(owner).some((p) => p.directory.startsWith(directory + "/") || directory.startsWith(p.directory + "/"))) {
      throw new HttpError(409, "项目目录不能与已有项目相互嵌套");
    }
    const id = randomUUID(), created = Date.now();
    this.db.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run(id, owner, name, directory, created);
    return { id, owner, name, directory, created };
  }
  sessions(owner: string, project: string): Session[] {
    this.project(owner, project);
    return this.db.prepare("SELECT * FROM conversations WHERE owner=? AND project=? ORDER BY created DESC").all(owner, project) as unknown as Session[];
  }
  createSession(owner: string, project: string): Session {
    this.project(owner, project);
    const row = { id: randomUUID(), owner, project, title: "新会话", created: Date.now() };
    this.db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?)").run(row.id, owner, project, row.title, row.created);
    return row;
  }
  session(owner: string, id: string): Session {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id=? AND owner=?").get(id, owner) as unknown as Session | undefined;
    if (!row) throw new HttpError(404, "会话不存在");
    return row;
  }
  renameSession(owner: string, id: string, title: string): void {
    this.session(owner, id);
    this.db.prepare("UPDATE conversations SET title=? WHERE id=? AND owner=?").run(title, id, owner);
  }
}
