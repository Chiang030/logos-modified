import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseSearchResults, webSearch } from "./web-search.mjs";

const page = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">A &amp; B</a><a class="result__snippet">A <b>useful</b> page</a>';
test("parses titles, decoded destination links and snippets", () => {
  assert.deepEqual(parseSearchResults(page), [{ title: "A & B", url: "https://example.com/doc", snippet: "A useful page", source: "DuckDuckGo" }]);
  assert.deepEqual(parseSearchResults('<div class="no-results">No results found</div>'), []);
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
  let destination;
  const proxy = createServer();
  proxy.on("connect", (request, socket) => { destination = request.url; socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n"); });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(webSearch({ query: "proxy test" }, { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "" } }), { code: "network" });
    assert.equal(destination, "html.duckduckgo.com:443");
  } finally { await new Promise((resolve) => proxy.close(resolve)); }
});
