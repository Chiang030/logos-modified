// Supply a Playwright Page; all /api requests are intercepted, including mutations.
export default async function folderNavigation(page, origin) {
  const requests = [], created = [];
  let failEmpty = false;
  const directory = (name) => ({ name, directory: true, size: 0, modified: 0 });
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let status = 200, data = {};
    if (url.pathname === "/api/bootstrap") data = { user: { id: "folder-navigation-fixture", name: "目录验收", admin: false }, csrf: "fixture", previewEnabled: false, version: "0.3.14", executionReady: true };
    else if (url.pathname === "/api/projects") {
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON(); created.push(input);
        data = { project: { id: "fixture-project", ...input } };
      } else data = { projects: [] };
    } else if (url.pathname === "/api/files") {
      const path = url.searchParams.get("path") || ""; requests.push(path);
      if (!path) data = { entries: [directory("ttt"), directory("missing"), directory("nested")] };
      else {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (path === "ttt" && !failEmpty) data = { entries: [] };
        else if (path === "nested") data = { entries: [directory("nested")] };
        else if (path === "nested/nested") data = { entries: [] };
        else { status = 404; data = { error: "文件不存在或不可访问" }; }
      }
    } else if (url.pathname === "/api/models") data = { models: [], ready: true };
    else if (url.pathname === "/api/sessions") data = { sessions: [] };
    else if (url.pathname === "/api/runs") data = { runs: [], ready: true };
    else if (url.pathname === "/api/events") data = { events: [] };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(origin);
  const open = page.getByRole("button", { name: "＋ 打开文件夹 / 建立项目", exact: true });
  const dialog = page.getByRole("dialog", { name: "打开文件夹", exact: true });
  const row = name => dialog.getByRole("button", { name: "▸ " + name + " 打开 →", exact: true });
  const choose = () => dialog.getByRole("button", { name: "以此文件夹打开项目", exact: true });
  const idle = async () => {
    await dialog.locator(".folder-picker-list[aria-busy=false]").waitFor();
  };

  await open.click(); await row("ttt").waitFor();
  await row("ttt").dblclick({ delay: 20 });
  check(await choose().isDisabled(), "Project creation must be disabled while loading");
  check((await dialog.locator(".folder-path").innerText()).trim().endsWith("我的空间 /"), "Breadcrumb changed before the directory loaded");
  await idle();
  check((await dialog.locator(".folder-path").innerText()).includes("我的空间 / ttt"), "Empty directory did not open");
  check(await row("ttt").count() === 0, "Parent entries remain inside the empty directory");
  check(!requests.includes("ttt/ttt"), "Rapid clicks submitted a nonexistent nested path");
  await choose().click();
  check(created.length === 1 && created[0].directory === "ttt", "Project used an unverified directory");

  await open.click(); await row("missing").click(); await idle();
  check(await dialog.getByRole("alert").isVisible(), "Failed directory request has no error");
  check((await dialog.locator(".folder-path").innerText()).trim().endsWith("我的空间 /"), "Failed navigation changed the breadcrumb");
  check(await choose().isDisabled(), "Root became selectable after failed navigation");
  await row("ttt").click(); await idle();
  check(await dialog.getByRole("alert").count() === 0, "Old error remains after successful navigation");

  failEmpty = true;
  await page.getByRole("button", { name: "关闭文件夹选择", exact: true }).click();
  await open.click(); await row("ttt").click(); await idle();
  check(await dialog.getByRole("alert").isVisible(), "Deleted directory should fail");
  failEmpty = false;
  await dialog.getByRole("button", { name: "重新读取当前目录", exact: true }).click(); await idle();
  check(await dialog.getByRole("alert").count() === 0, "Retry did not clear the error");

  await row("nested").click(); await idle();
  await row("nested").click(); await idle();
  check((await dialog.locator(".folder-path").innerText()).includes("我的空间 / nested/nested"), "Real same-name nested folders must remain navigable");
  await dialog.getByRole("button", { name: "← 上一级", exact: true }).click(); await idle();
  check(await row("nested").isVisible(), "Parent navigation did not restore its own entries");
  return { passed: true, created, requestedPaths: requests };
}
