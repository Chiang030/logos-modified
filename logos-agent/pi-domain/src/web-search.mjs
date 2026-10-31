import { EnvHttpProxyAgent, fetch } from "undici";

export class SearchError extends Error {
  constructor(code, message, attempts = []) { super(message); this.code = code; this.attempts = attempts; }
}

const providers = [
  { source: "DuckDuckGo", domain: "duckduckgo.com", endpoint: "https://html.duckduckgo.com/html/?q=", parse: parseSearchResults },
  { source: "Bing", domain: "bing.com", endpoint: "https://www.bing.com/search?format=rss&q=", parse: parseBingResults },
];

function checkChallenge(text) {
  if (/anomaly\.js|anomaly-modal|challenge-form|(?:id|src|action)=["'][^"']*(?:captcha|challenge)/i.test(text)) {
    throw new SearchError("challenge", "搜索服务要求验证码，请在浏览器中处理或稍后重试。");
  }
}

function decode(value) {
  return value.replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Math.min(Number(decimal), 0x10ffff)))
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, name) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " })[name]);
}
function plain(value) { return decode(value.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim(); }

export function parseSearchResults(html, count = 5) {
  checkChallenge(html);
  const blocks = [...html.matchAll(/<a\b[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)];
  const results = [];
  for (let index = 0; index < blocks.length && results.length < count; index++) {
    const match = blocks[index];
    const href = match[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let url;
    try {
      const parsed = new URL(decode(href), "https://duckduckgo.com");
      url = new URL((parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com")) && parsed.searchParams.has("uddg") ? parsed.searchParams.get("uddg") : parsed.href);
    } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
    const tail = html.slice(match.index + match[0].length, blocks[index + 1]?.index ?? html.length);
    const snippet = tail.match(/<(?:a|div|span)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i)?.[1] ?? "";
    results.push({ title: plain(match[0]), url: url.href, snippet: plain(snippet), source: "DuckDuckGo" });
  }
  if (!results.length && !/no-results|No results found/i.test(html)) throw new SearchError("parse", "搜索页面格式无法识别，未把它视为零结果。");
  return results;
}

export function parseBingResults(xml, count = 5) {
  checkChallenge(xml);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss\b[^>]*>[\s\S]*<channel\b[^>]*>[\s\S]*<\/channel>\s*<\/rss>/i.test(xml)) {
    throw new SearchError("parse", "搜索服务未返回有效的 RSS 结果，未把它视为零结果。");
  }
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  const results = [];
  for (const [, item] of items) {
    const title = plain(xmlValue(item, "title"));
    let url;
    try { url = new URL(xmlValue(item, "link")); } catch { continue; }
    if (!title || !["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
    if (results.some((result) => result.url === url.href)) continue;
    results.push({ title, url: url.href, snippet: plain(xmlValue(item, "description")), source: "Bing" });
    if (results.length >= count) break;
  }
  if (!results.length && /<item\b/i.test(xml)) throw new SearchError("parse", "搜索结果条目无法解析，未把它视为零结果。");
  return results;
}

function xmlValue(item, name) {
  const value = item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] ?? "";
  return decode(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

async function readBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new SearchError("parse", "搜索服务返回空响应。");
  const decoder = new TextDecoder(); let text = "", bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new SearchError("size", "搜索响应超过大小限制。");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function fetchPage(provider, query, request, signal, dispatcher) {
  let url = new URL(provider.endpoint + encodeURIComponent(query));
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const response = await request(url.href, { signal, dispatcher, redirect: "manual",
      headers: { Accept: "application/rss+xml, text/xml, text/html", "User-Agent": "LOGOS-WebSearch/1.0" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (!location || redirects >= 3) throw new SearchError("redirect", "搜索服务重定向异常。");
    try { url = new URL(location, url); } catch { throw new SearchError("redirect", "搜索服务返回无效重定向。"); }
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !(url.hostname === provider.domain || url.hostname.endsWith(`.${provider.domain}`))) {
      throw new SearchError("redirect", "搜索服务重定向到不支持的地址。");
    }
  }
}

async function searchProvider(provider, query, count, options) {
  const response = await fetchPage(provider, query, options.request, options.signal, options.dispatcher);
  if (response.status === 429) { await response.body?.cancel().catch(() => undefined); throw new SearchError("rate_limit", "搜索服务限流（HTTP 429），请稍后重试。"); }
  if (response.status === 403) {
    try { checkChallenge(await readBody(response)); }
    catch (error) { if (error instanceof SearchError && error.code === "challenge") throw error; }
    throw new SearchError("blocked", "搜索服务拒绝访问（HTTP 403）。");
  }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new SearchError("http", `搜索服务返回 HTTP ${response.status}。`); }
  return provider.parse(await readBody(response), count);
}

function searchFailure(error, signal, timeout) {
  if (signal?.aborted) return new SearchError("cancelled", "搜索已取消。");
  if (error instanceof SearchError) return error;
  if (timeout.aborted || error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT") return new SearchError("timeout", "连接或读取搜索服务超时。");
  return new SearchError("network", "无法连接搜索服务，请检查网络、代理和证书。");
}

export async function webSearch({ query, count = 5 }, { signal, request = fetch, timeoutMs = 15000, env = process.env } = {}) {
  if (typeof query !== "string" || !query.trim()) throw new SearchError("input", "搜索词不能为空。");
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new SearchError("input", "结果数量必须为 1–10。");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new SearchError("input", "搜索超时设置必须为正整数。");
  if (signal?.aborted) throw new SearchError("cancelled", "搜索已取消。");
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let dispatcher;
  try { dispatcher = new EnvHttpProxyAgent({ httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? "", httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? "", noProxy: env.no_proxy ?? env.NO_PROXY ?? "" }); }
  catch { throw new SearchError("proxy", "搜索代理配置无效，请检查 HTTP_PROXY、HTTPS_PROXY 或 VS Code 的代理设置。"); }
  const attempts = [];
  try {
    for (const [index, provider] of providers.entries()) {
      // Reserve time for the fallback while bounding both providers by one deadline.
      const attemptSignal = index === 0 ? AbortSignal.any([combined, AbortSignal.timeout(Math.max(1, Math.min(6000, Math.floor(timeoutMs / 2))))]) : combined;
      try {
        const results = await searchProvider(provider, query.trim(), count, { request, signal: attemptSignal, dispatcher });
        return { query: query.trim(), results, source: provider.source, ...(attempts.length ? { fallback: attempts[0] } : {}) };
      } catch (error) {
        const failure = searchFailure(error, signal, attemptSignal);
        attempts.push({ source: provider.source, code: failure.code, message: failure.message });
        if (failure.code === "cancelled") throw failure;
        if (index === providers.length - 1 || combined.aborted || !["timeout", "network"].includes(failure.code)) {
          throw new SearchError(failure.code, attempts.map((attempt) => `${attempt.source}：${attempt.message}`).join("\n"), attempts);
        }
      }
    }
  } finally { await dispatcher.destroy(); }
}
