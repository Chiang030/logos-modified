// Run with a Playwright Page and the deployed origin. All API traffic is mocked.
export default async function verifyFileNavigation(page, origin) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const directory = name => ({ name, directory: true, size: 0, modified: 0 });
  const file = name => ({ name, directory: false, size: 12, modified: 0 });
  const projects = [
    { id: "files-a", name: "Files A", directory: "ttt" },
    { id: "files-b", name: "Files B", directory: "other" },
  ];
  const requests = [], previews = [], mutations = [];
  let failRoot = false, delayChild = 350;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    let data = {}, status = 200;
    if (route.request().method() !== "GET") mutations.push(url.pathname);
    if (url.pathname === "/api/bootstrap") data = {
      user: { id: "file-navigation-fixture", name: "Test", admin: false },
      csrf: "fixture", previewEnabled: false, version: "0.3.14", executionReady: true,
    };
    else if (url.pathname === "/api/projects") data = { projects };
    else if (url.pathname === "/api/files") {
      const path = url.searchParams.get("path") || "", project = url.searchParams.get("project");
      requests.push({ project, path });
      if (project === "files-b") data = { entries: [file("other.txt")] };
      else if (!path && !failRoot) data = { entries: [directory(".logos"), directory("0-caseDict"), directory("missing"), directory("nested"), directory("empty")] };
      else {
        await new Promise(resolve => setTimeout(resolve, delayChild));
        if (path === "0-caseDict") data = { entries: [file("caseDict")] };
        else if (path === "nested") data = { entries: [directory("nested")] };
        else if (path === "nested/nested" || path === "empty") data = { entries: [] };
        else { status = 404; data = { error: "文件不存在或不可访问" }; }
      }
    } else if (url.pathname === "/api/preview") {
      previews.push(url.searchParams.get("path")); data = { text: "verified file content", truncated: false };
    } else if (url.pathname === "/api/models") data = { models: [], ready: true };
    else if (url.pathname === "/api/sessions") data = { sessions: [] };
    else if (url.pathname === "/api/runs") data = { runs: [], ready: true };
    else if (url.pathname === "/api/events") data = { events: [] };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  });
  try {
    await page.goto(origin);
    const project = name => page.locator(".project-switcher").getByRole("button", { name, exact: false });
    const list = page.locator(".file-list");
    const row = name => list.locator("button").filter({ has: page.locator("span").filter({ hasText: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }) });
    const idle = () => page.locator(".file-list[aria-busy=false]").waitFor();
    const breadcrumb = () => page.locator(".file-location span").innerText();
    const reset = async () => { await project("Files A").click(); await row("0-caseDict").waitFor(); };

    await reset();
    await row("0-caseDict").evaluate(button => {
      button.click(); button.click(); button.click();
    });
    await page.locator(".file-list[aria-busy=true]").waitFor();
    check(await breadcrumb() === "ttt", "Breadcrumb moved before the directory response");
    check(await row("0-caseDict").count() === 0, "Stale parent rows remain clickable while loading");
    check(await page.getByTitle("上传文件", { exact: true }).isDisabled(), "Uploads must wait for a verified directory");
    await row("caseDict").waitFor(); await idle();
    check(await breadcrumb() === "0-caseDict", "Child breadcrumb is incorrect");
    check(!requests.some(r => r.path.includes("0-caseDict/0-caseDict")), "Rapid clicks requested a fictional nested directory");
    await row("caseDict").click();
    await page.getByText("verified file content", { exact: false }).waitFor();
    check(previews.at(-1) === "0-caseDict/caseDict", "File preview uses the wrong directory");

    await reset();
    await row("missing").click(); await idle();
    check(await breadcrumb() === "ttt", "Failed navigation changed the breadcrumb");
    check(await row("0-caseDict").isVisible(), "Failed navigation did not preserve the verified parent");
    await row("0-caseDict").click(); await row("caseDict").waitFor();
    check(await breadcrumb() === "0-caseDict", "Recovery after a failed request did not work");

    await reset();
    await row("nested").click(); await idle();
    await row("nested").click(); await idle();
    check(await breadcrumb() === "nested/nested", "Real same-name directories must remain accessible");
    await page.getByTitle("上一级", { exact: true }).click(); await idle();
    check(await breadcrumb() === "nested" && await row("nested").isVisible(), "Parent navigation is inconsistent");

    await reset(); await row("empty").click(); await idle();
    check(await breadcrumb() === "empty" && await list.getByText("此目录暂无可见文件", { exact: false }).isVisible(), "Empty directories must be navigable");

    await reset(); failRoot = true;
    await page.getByRole("button", { name: "刷新文件", exact: true }).click(); await idle();
    check(await list.locator("button").count() === 0, "Failed refresh exposes unverified entries");
    failRoot = false;
    await page.getByRole("button", { name: "刷新文件", exact: true }).click(); await row("0-caseDict").waitFor();

    delayChild = 800;
    await row("0-caseDict").click();
    await project("Files B").click(); await row("other.txt").waitFor();
    await page.waitForTimeout(1000);
    check(await breadcrumb() === "other" && await row("other.txt").isVisible(), "Late old-project response replaced the new project");
    check(await row("caseDict").count() === 0, "Old-project entries leaked into the new project");
    check(mutations.length === 0, "File navigation should not mutate server data");
    return { passed: true, requests, previews, mutations };
  } finally { await page.unrouteAll({ behavior: "wait" }); }
}
