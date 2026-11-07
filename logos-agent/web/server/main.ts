import { createServer } from "node:http";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { Store } from "./store.ts";
import { WorkspaceFiles } from "./files.ts";
import { createHandler } from "./app.ts";
import type { Config } from "./auth.ts";

process.umask(0o077);
const port = Number(process.env.LOGOS_WEB_PORT ?? 18880), host = process.env.LOGOS_WEB_HOST ?? "127.0.0.1";
const publicUrl = (process.env.LOGOS_WEB_PUBLIC_URL ?? "http://127.0.0.1:" + port).replace(/\/$/, "");
const platform = process.env.LOGOS_WEB_IDENTITY_PLATFORM ?? "feishu";
if (platform !== "feishu" && platform !== "lark") throw new Error("Identity platform must be feishu or lark");
const credentialPrefix = platform === "lark" ? "LARK" : "FEISHU";
const config: Config = {
  platform,
  host, port, publicUrl, data: resolve(process.env.LOGOS_WEB_DATA_DIR ?? join(homedir(), ".local/share/logos-web")),
  preview: process.env.LOGOS_WEB_PREVIEW === "1",
  appId: process.env[credentialPrefix + "_APP_ID"] ?? "", appSecret: process.env[credentialPrefix + "_APP_SECRET"] ?? "",
  tenant: process.env[credentialPrefix + "_TENANT_KEY"] ?? "", admins: (process.env.LOGOS_WEB_ADMIN_OPEN_IDS ?? "").split(",").filter(Boolean),
  uploadLimit: 64 * 1024 * 1024,
};
const address = new URL(publicUrl);
if (address.pathname !== "/" || address.search || address.hash || address.username || address.password) throw new Error("PUBLIC_URL must be an origin");
const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
if (config.preview && (!loopback || !["127.0.0.1", "[::1]", "localhost"].includes(address.hostname))) throw new Error("Preview is loopback-only");
if (!loopback && address.protocol !== "https:") throw new Error("Network deployment requires an HTTPS public URL");
mkdirSync(config.data, { recursive: true, mode: 0o700 });
const store = new Store(join(config.data, "state/application.sqlite"));
const server = createServer(createHandler({ config, store, files: new WorkspaceFiles(join(config.data, "users")), assets: fileURLToPath(new URL("../dist/", import.meta.url)) }));
server.requestTimeout = 120_000; server.headersTimeout = 15_000;
server.listen(port, host, () => console.log("LOGOS Web listening at " + publicUrl + (config.preview ? " (read-only UI preview enabled)" : "")));
const stop = (): void => { server.close(() => { store.close(); process.exit(0); }); server.closeIdleConnections(); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
