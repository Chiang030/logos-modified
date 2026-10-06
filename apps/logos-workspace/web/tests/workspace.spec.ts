import { expect, test } from "@playwright/test";

test("desktop collaboration workflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) browserErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "智能体与会话" })).toBeVisible();
  await expect(page.getByText("总师智能体", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("建模智能体", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("验证智能体", { exact: true }).first()).toBeVisible();

  const modeling = page.locator(".agent-group").filter({ hasText: "建模智能体" });
  await modeling.locator(".session-row").first().click();
  const composer = page.getByLabel("向建模智能体发送消息");
  await composer.fill("建立一个 6061-T6 热结构模型，并记录单位制。");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText(/6061-T6/).last()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("工具完成 inspect_runtime_capabilities").last()).toBeVisible();

  const stamp = Date.now().toString().slice(-6);
  await page.getByRole("button", { name: "派发任务" }).click();
  const dispatch = page.getByRole("dialog");
  await dispatch.getByLabel("目标智能体").selectOption("validation_agent");
  await dispatch.getByLabel("新 Session 名称").fill(`热模型验证 ${stamp}`);
  await dispatch.getByLabel("任务标题").fill(`检查模型 ${stamp}`);
  await dispatch.getByLabel("任务消息").fill("读取冻结输入并形成独立验证结论。");
  await dispatch.getByRole("button", { name: "派发并运行" }).click();
  await expect(page.getByText(`热模型验证 ${stamp}`, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("总师智能体", { exact: true }).last()).toBeVisible();

  await page.getByRole("button", { name: "派发任务" }).click();
  const continued = page.getByRole("dialog");
  await continued.getByLabel("目标智能体").selectOption("validation_agent");
  await continued.getByRole("button", { name: "继续", exact: true }).click();
  const continuedSelect = continued.getByLabel("继续指定 Session");
  const continuedValue = await continuedSelect.locator("option").filter({ hasText: `热模型验证 ${stamp}` }).getAttribute("value");
  await continuedSelect.selectOption(continuedValue!);
  await continued.getByLabel("任务标题").fill(`补充验证 ${stamp}`);
  await continued.getByLabel("任务消息").fill("补充检查单位一致性。");
  await continued.getByRole("button", { name: "派发并运行" }).click();
  await expect(page.getByText("补充检查单位一致性。")).toBeVisible();

  await page.getByRole("button", { name: "派发任务" }).click();
  const forked = page.getByRole("dialog");
  await forked.getByLabel("目标智能体").selectOption("validation_agent");
  await forked.getByRole("button", { name: "Fork", exact: true }).click();
  const forkSelect = forked.getByLabel("源 Session");
  const forkValue = await forkSelect.locator("option").filter({ hasText: `热模型验证 ${stamp}` }).getAttribute("value");
  await forkSelect.selectOption(forkValue!);
  await forked.getByLabel("源 Checkpoint").fill("message:2");
  await forked.getByLabel("新 Session 名称").fill(`验证分支 ${stamp}`);
  await forked.getByLabel("任务标题").fill(`替代检查 ${stamp}`);
  await forked.getByLabel("任务消息").fill("从指定检查点探索替代验证方案。");
  await forked.getByRole("button", { name: "派发并运行" }).click();
  await expect(page.getByText(`验证分支 ${stamp}`, { exact: true }).first()).toBeVisible();

  await modeling.locator(".session-row").first().click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "新建文件" }).click();
  const fileDialog = page.getByRole("dialog");
  await fileDialog.getByLabel("相对路径").fill(`candidate/model-${stamp}.json`);
  await fileDialog.getByLabel("文件内容").fill('{"material":"6061-T6","units":"SI"}');
  await fileDialog.getByRole("button", { name: "保存" }).click();
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect(page.getByText(`model-${stamp}.json`, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "发布", exact: true }).click();
  const publish = page.getByRole("dialog");
  await publish.getByLabel("Session 源文件").fill(`candidate/model-${stamp}.json`);
  await publish.getByLabel("共享区目标路径").fill(`models/model-${stamp}.json`);
  await publish.getByLabel("产物类型").selectOption("model");
  await publish.getByLabel("发布摘要").fill(`发布热结构候选模型 ${stamp}`);
  await publish.getByRole("button", { name: "发布新版本" }).click();
  await page.getByRole("button", { name: "产物", exact: true }).click();
  await expect(page.getByText(`models/model-${stamp}.json`, { exact: true })).toBeVisible();

  await page.screenshot({ path: ".artifacts/e2e-desktop.png", fullPage: true });
  expect(browserErrors).toEqual([]);
});

test("mobile navigation exposes all workspace regions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/");
  await expect(page.getByLabel("向总师智能体发送消息")).toBeVisible();
  await page.getByRole("button", { name: "智能体", exact: true }).click();
  await expect(page.getByRole("heading", { name: "智能体与会话" })).toBeVisible();
  await page.getByRole("button", { name: "任务与产物", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目主会话" })).toBeVisible();
  await expect(page.getByRole("button", { name: "任务", exact: true })).toBeVisible();
  await page.screenshot({ path: ".artifacts/e2e-mobile.png", fullPage: true });
});
