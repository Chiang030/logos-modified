// Run on a non-loopback HTTP origin. Every API request is mocked.
export default async function verifyPrivateHttp(page, origin) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const requests = [];
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    let data = {};
    if (url.pathname === "/api/bootstrap") data = {
      user: { id: "http-fixture", name: "HTTP Test", admin: false },
      csrf: "fixture", previewEnabled: false, version: "0.3.15", executionReady: true,
    };
    else if (url.pathname === "/api/projects") data = { projects: [{ id: "http-project", name: "HTTP Project", directory: "fixture" }] };
    else if (url.pathname === "/api/files") data = { entries: [] };
    else if (url.pathname === "/api/models") data = { models: [{ id: "fixture", provider: "fixture", name: "Fixture", reasoning: false }], ready: true };
    else if (url.pathname === "/api/sessions") data = { sessions: [{ id: "http-session", title: "HTTP Session", project: "http-project" }] };
    else if (url.pathname === "/api/runs") data = { runs: [], ready: true };
    else if (url.pathname === "/api/events") data = { events: [] };
    else if (url.pathname === "/api/bridge") {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) { await route.abort("failed"); return; }
      data = { run: { id: "http-run", status: "completed", created: Date.now() } };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  try {
    await page.goto(origin);
    check(await page.evaluate(() => !isSecureContext && typeof crypto.randomUUID !== "function"), "Test must use a real insecure HTTP browser context");
    await page.locator(".project-switcher").getByRole("button", { name: "HTTP Project", exact: false }).click();
    const composer = page.getByRole("textbox", { name: "Message LOGOS", exact: true });
    await composer.fill("HTTP submission regression");
    const submitted = page.waitForResponse(response => response.url().endsWith("/api/bridge") && response.status() === 200);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await submitted;
    check(requests.length === 2, "A failed submission must retry once on HTTP");
    const key = requests[0].command.requestKey;
    check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key), "HTTP submission must carry a random v4 UUID");
    check(key === requests[1].command.requestKey, "Retries must retain the same idempotency key");
    const clipboard = await page.evaluate(async () => {
      const original = document.execCommand;
      let copied;
      document.execCommand = command => { if (command === "copy") copied = document.activeElement.value; return true; };
      try { await navigator.clipboard.writeText("http-copy-fixture"); return copied; }
      finally { document.execCommand = original; }
    });
    check(clipboard === "http-copy-fixture", "HTTP copy fallback must select the requested text");
    return { passed: true, insecureContext: true, submitted: true, retryKeyPreserved: true, clipboardFallback: true };
  } finally { await page.unroute("**/api/**"); }
}
