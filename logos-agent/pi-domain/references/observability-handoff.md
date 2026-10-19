# Pi 可观测性分支交接

日期：2026-10-19（Asia/Shanghai）。仓库：https://github.com/Chiang030/logos-modified 。分支：`codex/pi-langfuse-observability`。

## 精确版本基线

| 项目 | 版本 |
| --- | --- |
| 本次实现的父提交 | `fad372b9aed03efe3d29274d22b125de09b87784` |
| 父提交时间 / 标题 | 2026-10-19 14:05:39 +08:00；`chore(repo): upload current LOGOS project` |
| 交接时读取的 GitHub main | `af35c62455651ecd82cdb3b146e75747168b73e4` |
| main 新增提交 | `chore(repo): remove legacy projects and unused assets` |
| 两个基线的 pi-domain Git tree | 均为 `dd4f2165b6bd0cc794b37136ce9078a9ddaf6d01` |
| 两个基线的 vendor/pi gitlink | 均为 `abe508e1b89912adde45528136c3221eb69acdd7` |
| 已验证 Pi 包 | `@earendil-works/pi-coding-agent` 1.1.0，以上 vendor 提交的 Extension API |
| 已验证 Node | v24.14.0；本域包要求 >=22.19.0 |
| Langfuse / OTel | Langfuse tracing/otel 6.0.1；OTel API 1.9.0、SDK 2.0.1；以 package-lock.json 为准 |

本分支从上述父提交建立，不把 main 的仓库清理混进可观测性提交。交接时 main 比父提交多1个提交，但 `git diff fad372b9 origin/main -- logos-agent/pi-domain vendor/pi` 为空：本次涉及的域包基线和 Pi 依赖没有差异。这个结论不覆盖同事未推送、其他分支或其他机器上的修改，也不等于远程仿真已验收。

本次提交只包含 `logos-agent/pi-domain`。本机已有 VS Code 宿主修改、runtime 副本、Langfuse 密钥、node_modules、合成上报结果和截图均未纳入交接提交。Pi Agent Loop、Provider 和 simulation 业务代码保持原基线。

## 同事如何合入已有项目

先在同事工作区保存自己的修改为 commit，然后 fetch 本分支。在他的工作分支上合入可观测性提交，不用拷贝整个旧项目覆盖他的版本。

```bash
git fetch origin codex/pi-langfuse-observability
git log --oneline fad372b9aed03efe3d29274d22b125de09b87784..origin/codex/pi-langfuse-observability
git diff --stat fad372b9aed03efe3d29274d22b125de09b87784 origin/codex/pi-langfuse-observability -- logos-agent/pi-domain
# 检查上面列出的提交后，将所需提交 cherry-pick 到同事自己的分支。
git cherry-pick <上面列出的可观测性提交SHA>
```

若该分支以后包含多个提交，按历史顺序选择，不把移动的分支名当作永久版本号。交付时的确切提交 SHA 可从 GitHub 分支历史读取；合入后记录自己项目的 HEAD 与 vendor/pi SHA。

如果同事改过 `extensions/index.mjs`，保留其工具注册，同时保留 `await registerObservability(pi)`；只注册一次。本扩展入口现在为 async，需使用支持异步扩展加载的当前 Pi。若改过 package.json，合并依赖并按其包管理方式更新锁文件。不要用本分支覆盖同事的 simulation 或 Provider 修改。

若同事的 vendor/pi SHA 不同，重点核对 `context_with_system`、`before_provider_request`、`after_provider_response`、`agent_settled`、`turn_end.message`、`tool_execution_*.parentToolCallId` 的实际类型与语义。仅有版本号 1.1.0 不能保证 API 相同；不支持的事件不能当作已覆盖。

## 在有仿真软件的机器启用

不需要本机安装仿真软件才能开发遥测；真正的仿真由同事原有 Pi 工具链执行。本模块被动观察它产生的事件。

1. 合入代码；在 `logos-agent/pi-domain` 执行 `npm ci`，安装锁定依赖。
2. 复制 `.env.example` 为本机 `.env.local`，配置 Langfuse Project URL / Public Key / Secret Key，保持 `LOGOS_OBSERVABILITY=1`、`LOGOS_OBSERVABILITY_CONTENT=full`。密钥不提交 Git。
3. 保留同事原有模型凭据、模型配置、仿真工具、许可证、远端连接和 `LOGOS_SIM_COMMAND` 等配置。遥测配置不会替代这些运行条件。
4. 让实际运行 Pi 的进程加载这些环境变量及本域扩展；如果沿用另一个启动器/RPC 服务，应在那个进程配置环境变量和扩展路径。

已有仓库构建产物时，可在域包目录启动：

```bash
node --env-file=.env.local ../../vendor/pi/packages/coding-agent/dist/cli.js -e .
```

`-e .` 加载当前域包一次；若原启动器已加载该包，不要再次添加。不要直接运行 `tests/integration_tests/live.mjs` 代替真实业务，它只创建预置的合成演示。

全新 checkout 若没有 Pi dist，先在仓库根目录 `git submodule update --init --recursive`，再到 `vendor/pi` 按该版本构建要求安装依赖并执行 `npm run build`，之后安装域包依赖。现有同事环境已构建时不必重新构建。源码入口验收不代表 VSIX 已打包这些 SDK；VS Code 打包分发另行处理。

## 人工验收看什么

- 发起一次真实请求，打开根节点「用户请求」：Input 有请求，Output 有结果与循环/模型/工具次数。
- 逐轮展开：模型 Input 有 system、历史消息、前轮工具结果；Output 有模型文本、工具请求和 Provider 暴露的 reasoning 状态。
- 工具 Input.arguments 有实参，Output.result.content/details 有返回值；simulation 的 transport_ok、script_ok、acceptance、exit_code、remote_state、operation_id、output_truncated 分别保留。
- 原生工具、同事新增工具只要通过 Pi 执行事件即可被观测；远程仿真进程内部步骤没有事件时，不会凭空生成子 Span。
- 长内容有大小限制及截断标记；缺失 reasoning 标为 not_exposed，不伪造模型思考。
- 检查新请求另起 Trace、取消后不污染下一请求。自动续跑在 settled 前归于同一请求；运行次数与循环次数分别计数。

本地曾通过40项测试及真实 Langfuse 三轮合成验收。按使用者要求，后续真实仿真和业务正确性由人工验收；目前不声称本机验证了求解器。技术口径见 observability.md，已做的验收及开销见 observability-validation.md。
