import { EnvHttpProxyAgent, fetch } from "undici";

export class SearchError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function decode(value) {
  return value.replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Math.min(Number(decimal), 0x10ffff)))
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, name) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " })[name]);
}
function plain(value) { return decode(value.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim(); }

export function parseSearchResults(html, count = 5) {
  if (/anomaly\.js|anomaly-modal|challenge-form|captcha/i.test(html)) throw new SearchError("challenge", "搜索服务要求验证码，请稍后重试。");
  const blocks = [...html.matchAll(/<a\b[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)];
  const results = [];
  for (let index = 0; index < blocks.length && results.length < count; index++) {
    const match = blocks[index];
    const href = match[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let url;
    try {
      const parsed = new URL(decode(href), "https://duckduckgo.com");
      url = new URL(parsed.hostname.endsWith("duckduckgo.com") && parsed.searchParams.has("uddg") ? parsed.searchParams.get("uddg") : parsed.href);
    } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
    const tail = html.slice(match.index + match[0].length, blocks[index + 1]?.index ?? html.length);
    const snippet = tail.match(/<(?:a|div|span)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i)?.[1] ?? "";
    results.push({ title: plain(match[0]), url: url.href, snippet: plain(snippet), source: "DuckDuckGo" });
  }
  if (!results.length && !/no-results|No results found/i.test(html)) throw new SearchError("parse", "搜索页面格式无法识别，未把它视为零结果。");
  return results;
}

export async function webSearch({ query, count = 5 }, { signal, request = fetch, timeoutMs = 15000, env = process.env } = {}) {
  if (typeof query !== "string" || !query.trim()) throw new SearchError("input", "搜索词不能为空。");
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new SearchError("input", "结果数量必须为 1–10。");
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const dispatcher = new EnvHttpProxyAgent({ httpProxy: env.http_proxy ?? env.HTTP_PROXY, httpsProxy: env.https_proxy ?? env.HTTPS_PROXY, noProxy: env.no_proxy ?? env.NO_PROXY });
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`;
    const response = await request(url, { signal: combined, dispatcher, redirect: "error", headers: { Accept: "text/html", "User-Agent": "LOGOS-WebSearch/1.0" } });
    if (response.status === 429) { await response.body?.cancel(); throw new SearchError("rate_limit", "搜索服务限流（HTTP 429），请稍后重试。"); }
    if (response.status === 403) { await response.body?.cancel(); throw new SearchError("blocked", "搜索服务拒绝访问（HTTP 403）。"); }
    if (!response.ok) { await response.body?.cancel(); throw new SearchError("http", `搜索服务返回 HTTP ${response.status}。`); }
    const reader = response.body?.getReader();
    if (!reader) throw new SearchError("parse", "搜索服务返回空响应。");
    const decoder = new TextDecoder(); let html = "", bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new SearchError("size", "搜索响应超过大小限制。");
        html += decoder.decode(chunk.value, { stream: true });
      }
      html += decoder.decode();
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return { query: query.trim(), results: parseSearchResults(html, count), source: "DuckDuckGo" };
  } catch (error) {
    if (signal?.aborted) throw new SearchError("cancelled", "搜索已取消。");
    if (timeout.aborted || error.cause?.code === "UND_ERR_CONNECT_TIMEOUT") throw new SearchError("timeout", "搜索超时，请检查网络和代理。");
    if (error instanceof SearchError) throw error;
    throw new SearchError("network", "无法连接搜索服务，请检查网络、代理和证书。");
  } finally { await dispatcher.destroy(); }
}
