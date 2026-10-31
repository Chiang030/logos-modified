import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseBingResults, parseSearchResults, webSearch } from "./web-search.mjs";

const page = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">A &amp; B</a><a class="result__snippet">A <b>useful</b> page</a>';
const rss = '<rss version="2.0"><channel><title>Search</title><item><title><![CDATA[北京天气 &amp; 预报]]></title><link>https://example.com/weather?a=1&amp;b=2</link><description>今天 &lt;b&gt;天气&lt;/b&gt;</description></item><item><title>Second</title><link>https://example.com/second</link></item></channel></rss>';
test("parses titles, decoded destination links and snippets", () => {
  assert.deepEqual(parseSearchResults(page), [{ title: "A & B", url: "https://example.com/doc", snippet: "A useful page", source: "DuckDuckGo" }]);
  assert.deepEqual(parseSearchResults('<div class="no-results">No results found</div>'), []);
  assert.equal(parseSearchResults(page.replace('A &amp; B', 'CAPTCHA documentation'))[0].title, 'CAPTCHA documentation');
});
test("distinguishes challenge and parse failures from no results", () => {
  assert.throws(() => parseSearchResults('<form id="challenge-form">'), { code: "challenge" });
  assert.throws(() => parseSearchResults("unexpected page"), { code: "parse" });
});
test("search is bounded, proxy-aware and returns actual results", async () => {
  let called = false;
  const result = await webSearch({ query: "测试 query", count: 1 }, { env: {}, request: async (url, options) => {
    called = true; assert.ok(url.includes(encodeURIComponent("测试 query"))); assert.ok(options.dispatcher); assert.ok(options.signal);
    return new Response(page);
  } });
  assert.ok(called); assert.equal(result.results.length, 1);
});
test("reports HTTP errors, cancellation, timeout and network failures", async () => {
  for (const [status, code] of [[429, "rate_limit"], [403, "blocked"], [500, "http"]]) {
    await assert.rejects(webSearch({ query: "test" }, { request: async () => new Response("", { status }) }), { code });
  }
  const signal = AbortSignal.abort();
  await assert.rejects(webSearch({ query: "test" }, { signal, request: async () => { throw new Error("abort"); } }), { code: "cancelled" });
  await assert.rejects(webSearch({ query: "test" }, { request: async () => { throw new Error("network"); } }), { code: "network" });
  await assert.rejects(webSearch({ query: "test" }, { timeoutMs: 5, request: async (_url, { signal }) => {
    await new Promise((resolve) => setTimeout(resolve, 20)); signal.throwIfAborted();
  } }), { code: "timeout" });
});
test("routes HTTPS through the configured proxy without contacting the search service", async () => {
  const destinations = [];
  const proxy = createServer();
  proxy.on("connect", (request, socket) => { destinations.push(request.url); socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n"); });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(webSearch({ query: "proxy test" }, { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "" } }), { code: "network" });
    assert.deepEqual(destinations, ["html.duckduckgo.com:443", "www.bing.com:443"]);
  } finally { await new Promise((resolve) => proxy.close(resolve)); }
});

test("parses RSS snippets, CDATA and safe destination links with a result limit", () => {
  assert.deepEqual(parseBingResults(rss, 1), [{ title: "北京天气 & 预报", url: "https://example.com/weather?a=1&b=2", snippet: "今天 天气", source: "Bing" }]);
  assert.deepEqual(parseBingResults('<rss><channel><title>No results</title></channel></rss>'), []);
  for (const invalid of ['<html>unexpected</html>', '<!DOCTYPE rss><rss><channel></channel></rss>',
    '<rss><channel><item><title>Unsafe</title><link>javascript:alert(1)</link></item></channel></rss>']) {
    assert.throws(() => parseBingResults(invalid), { code: "parse" });
  }
  assert.throws(() => parseBingResults('<div id="b_captcha">'), { code: "challenge" });
  assert.equal(parseBingResults(rss.replace('北京天气 &amp; 预报', 'How CAPTCHA works'))[0].title, 'How CAPTCHA works');
});

test("falls back on connection failure, preserves the query and reports the actual source", async () => {
  const urls = [], dispatchers = [];
  const query = "北京天气 今天 2026年10月31日";
  const result = await webSearch({ query, count: 1 }, { env: {}, request: async (url, options) => {
    urls.push(url); dispatchers.push(options.dispatcher);
    if (urls.length === 1) throw Object.assign(new Error("connect"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    return new Response(rss);
  } });
  assert.equal(new URL(urls[1]).searchParams.get("q"), query);
  assert.equal(new URL(urls[1]).hostname, "www.bing.com");
  assert.equal(dispatchers[0], dispatchers[1]);
  assert.equal(result.source, "Bing"); assert.equal(result.results.length, 1);
  assert.equal(result.fallback.source, "DuckDuckGo"); assert.equal(result.fallback.code, "timeout");
});

test("does not switch providers to bypass challenges, HTTP restrictions or parsing failures", async () => {
  for (const [body, status, code] of [['<form id="challenge-form">', 202, 'challenge'], ['', 429, 'rate_limit'],
    ['', 403, 'blocked'], ['<div id="b_captcha">', 403, 'challenge'], ['broken markup', 200, 'parse']]) {
    let requests = 0;
    await assert.rejects(webSearch({ query: "test" }, { request: async () => { requests++; return new Response(body, { status }); } }), { code });
    assert.equal(requests, 1);
  }
  let requests = 0;
  const empty = await webSearch({ query: "test" }, { request: async () => { requests++; return new Response('<div class="no-results">No results found</div>'); } });
  assert.deepEqual(empty.results, []); assert.equal(requests, 1);
});

test("reserves time for the fallback and respects cancellation during it", async () => {
  let requests = 0;
  const result = await webSearch({ query: "test" }, { timeoutMs: 200, request: async (_url, { signal }) => {
    if (++requests === 1) await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return new Response(rss);
  } });
  assert.equal(result.source, "Bing"); assert.equal(requests, 2);
  const controller = new AbortController(); requests = 0;
  await assert.rejects(webSearch({ query: "test" }, { signal: controller.signal, request: async (_url, { signal }) => {
    if (++requests === 1) throw new Error("connect");
    controller.abort(); signal.throwIfAborted();
  } }), { code: "cancelled" });
  assert.equal(requests, 2);
});

test("does not hide an HTTP restriction behind a body failure or elapsed attempt budget", async () => {
  let requests = 0;
  await assert.rejects(webSearch({ query: "test" }, { request: async () => {
    requests++;
    const body = new ReadableStream({ start(controller) { controller.error(new Error("connection lost")); } });
    return new Response(body, { status: 403 });
  } }), { code: "blocked" });
  assert.equal(requests, 1); requests = 0;
  await assert.rejects(webSearch({ query: "test" }, { timeoutMs: 100, request: async () => {
    requests++; await new Promise((resolve) => setTimeout(resolve, 60)); return new Response("", { status: 429 });
  } }), { code: "rate_limit" });
  assert.equal(requests, 1);
});

test("bounds the total timeout across providers and retains both failures", async () => {
  let requests = 0;
  // Keep the event loop alive while AbortSignal.timeout's unref'ed timers run.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    await assert.rejects(webSearch({ query: "test" }, { timeoutMs: 80, request: async (_url, { signal }) => {
      requests++;
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } }), (error) => {
      assert.equal(error.code, "timeout");
      assert.deepEqual(error.attempts.map(({ source }) => source), ["DuckDuckGo", "Bing"]);
      assert.match(error.message, /DuckDuckGo/); assert.match(error.message, /Bing/); return true;
    });
    assert.equal(requests, 2);
  } finally { clearTimeout(keepAlive); }
});

test("follows bounded HTTPS redirects within the selected provider only", async () => {
  const urls = [];
  const result = await webSearch({ query: "test" }, { request: async (url) => {
    urls.push(url);
    if (urls.length === 1) throw new Error("connect");
    if (urls.length === 2) return new Response(null, { status: 302, headers: { location: "https://cn.bing.com/search?format=rss&q=test" } });
    return new Response(rss);
  } });
  assert.equal(result.source, "Bing"); assert.equal(new URL(urls[2]).hostname, "cn.bing.com");
  for (const location of ["http://www.bing.com/", "https://www.bing.com.evil.test/", "http://127.0.0.1/", "https://user:secret@www.bing.com/"]) {
    let requests = 0;
    await assert.rejects(webSearch({ query: "test" }, { request: async () => {
      requests++; return new Response(null, { status: 302, headers: { location } });
    } }), { code: "redirect" });
    assert.equal(requests, 1);
  }
});

test("enforces response size and redacts invalid proxy configuration", async () => {
  await assert.rejects(webSearch({ query: "test" }, { request: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), { code: "size" });
  await assert.rejects(webSearch({ query: "test" }, { env: { HTTPS_PROXY: "invalid-proxy-with-secret" } }), (error) => {
    assert.equal(error.code, "proxy"); assert.doesNotMatch(error.message, /with-secret/); return true;
  });
});
