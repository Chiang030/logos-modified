This directory is the LOGOS Agent product/runtime layer. Run its npm scripts from here, or prefix them with `npm --prefix logos-agent` from the repository root.

# LOGOS CLI

The built-in `simulation` tool calls the configured sim CLI. See [configuration, result semantics and pending backend work](docs/simulation-tool.md).

LOGOS 的终端入口，完整复用 `../vendor/pi/` 中的 Pi 源码，以官方 `v1.1.0` 为起点。默认 Logo 左侧复用纸飞机与星点轨道动画，右侧单独截取用户图片转换光栅中的 LOGOS 字标，绘制为固定 48 列 × 8 行字符画，保留白蓝斜切与 G 的金色横杠。窄终端上下排列，极窄终端回退为普通 LOGOS 文字。此前的手工斜切、轨道连笔、机翼负形和流场线条方案保留为备选。小字为 AIRCRAFT DESIGN & SIMULATION AGENT（飞行器设计仿真 Agent）。

需要 Node.js 22.19 或更新版本。在本目录运行：

```powershell
# 独立动画预览：无需安装依赖或配置 API key，Ctrl+C 退出
node bin/logos.mjs --logo

# 只播放一圈 / 显示静态字符画
node bin/logos.mjs --logo --once
node bin/logos.mjs --logo --static

# 新克隆项目时初始化源码子模块；本次已完成
git submodule update --init --recursive

# 首次准备源码依赖和模型目录数据；本次已完成
npm run pi:setup

# 日常直接从源码启动，带 LOGOS 欢迎动画
npm start

# Pi 原有参数直接透传
npm start -- --help

# VS Code 等客户端可用同一入口启动 RPC
node bin/logos.mjs --mode rpc
```

Pi 源码通过 Git 子模块保存，来源为 <https://github.com/earendil-works/pi>，初始提交为 `abe508e1b89912adde45528136c3221eb69acdd7`。本地已创建开发分支 `Chiang030/code/pi-source`。根项目不再安装 npm 发布版 `@earendil-works/pi-coding-agent`；`vendor/pi/node_modules/` 中是源码开发所需依赖及指向工作区源码的包链接。

启动器预加载 Pi 自带的源码解析器，再运行 `packages/coding-agent/src/cli.ts`，内部 Pi 包也解析到各自的 `src/`。普通 TypeScript 修改后重启即可验证，无需每次完整编译；此方式不提供自动热重载。原生组件变更和最终分发打包仍按上游流程构建。`pi:setup` 需要联网获取依赖和模型目录，不必每次启动都执行。

Pi 有自己的 Git 历史。修改后先在 `../vendor/pi/` 提交，再由根仓库记录新的子模块提交；需要共享这些修改时，应将 Pi 分支推送到自己的 fork，并更新子模块地址。本次仅拉取和配置，未提交或推送修改。

交互界面输入 `/logos` 可重播动画。也可以用现有 Pi 加载此扩展：

```powershell
pi -e ./pi-domain/extensions/index.mjs
```

预览在临时终端屏幕中循环播放，退出后恢复原屏幕并留下一帧静态 Logo。`LOGOS_WORDMARK` 可设为 `image`（默认）、`split`、`orbit`、`wing` 或 `flow`。使用 `npm run ascii:import -- <转换稿.txt>` 可以重新导入图片转换工具生成的字符光栅。设置 `LOGOS_NO_ANIMATION=1` 关闭动画，`LOGOS_ASCII=1` 使用 ASCII 字符。`NO_COLOR` 或 `TERM=dumb` 自动关闭彩色和动画；输出重定向时只生成一帧纯文本。Pi 的 print、JSON 和 RPC 模式不展示动画。

动画和 Pi 欢迎区共用 `pi-domain/src/ui/logo.mjs`；接入位置是 `pi-domain/extensions/index.mjs`。此前代码保留在项目外的 `../logos-back-20261008/`。

`previews/logos-orbit.html` 是可直接打开的动态预览，支持暂停、速度和宽度切换；`previews/logos-orbit.gif` 是 8 秒循环演示，`previews/logos-static.txt` 是静态字符稿。修改绘制代码后，运行 `npm run preview:build` 更新 HTML 和字符稿。

## 本地 API 配置

启动器自动读取 `logos-agent/.env`（不依赖当前工作目录）。在其中填写 `DEEPSEEK_API_KEY`，通过 `LOGOS_PROVIDER` 和 `LOGOS_MODEL` 设置默认服务商与模型；命令行模型参数优先。`.env` 已被 Git 忽略，可参考 `.env.example`。

填写后在仓库根目录运行 `npm --prefix logos-agent start`。配置修改后需重启 CLI。本地文件以明文保存 Key。

## 系统提示词

编辑 `pi-domain/prompts/system.md` 后重启 CLI 生效。启动器通过 Pi 原生 `--system-prompt` 文件参数替换默认提示词主体，适用于交互、print 和 RPC；AGENTS.md、Skills 和追加提示词仍按 Pi 规则加载。显式传入 `--system-prompt <文件或文本>` 可覆盖此默认文件。此文件是可调整的基础版本，不代表已实现仿真或多智能体能力。

### 分层提示词（当前版本）

- `pi-domain/prompts/system.md`：基础角色，通过 `--system-prompt` 加载。
- `pi-domain/prompts/append.md`：全局追加规则，通过 `--append-system-prompt` 加载。
- `pi-domain/skills/`：LOGOS 内置 Skills，通过 `--skill` 统一注册，具体流程按需读取；`--no-skills` 可关闭默认注册。包含仿真流程、sim-cli 和 Ansys Skills，详见 [内置 Skills](docs/builtin-skills.md)。
- `pi-domain/references/toolchain.md`：实例的工具链快照，不自动注入，使用前核实。
- `pi-domain/prompts/system.full.md`：拆分前完整版本，仅作对照，不自动加载。

修改后重启生效。拆分保留了实例各流程和规则原文，并补充工作区边界、工具可用性与 Studio 集成适用条件。显式 `--system-prompt` 仅替换基础角色，默认追加规则仍加载；显式追加参数与默认追加规则共同生效。旧章节“系统提示词”的单文件说明已由此分层方式替代。
