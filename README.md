# LOGOS

LOGOS 是面向工程仿真工作的 Windows x64 VS Code 插件，使用 Pi 作为 Agent 内核。
安装包包含 Node.js、Pi 内核、LOGOS 提示词和领域技能；工程求解器及其许可证需要另行安装。

## 项目结构

- `logos-agent/vscode-extension/`：插件代码、聊天界面、测试与打包脚本。
- `logos-agent/pi-domain/`：领域扩展、提示词、技能及工具链参考。
- `logos-agent/integrations/`：工程工具集成包。
- `vendor/pi/`：固定版本的 Pi Git 子模块。

## 开发与验证

需要 Windows x64、Git 和 Node.js/npm。

```powershell
git submodule update --init --recursive
cd logos-agent/vscode-extension
npm ci
npm run compile
npm test
```

## 打包与使用

```powershell
npm run package:win32-x64
```

打包会构建 Pi、生成运行时、验证文件完整性，并运行本地模拟 API 的冒烟测试。
安装生成的 VSIX 后，在 VS Code 中执行 **LOGOS: Open Chat**，通过设置面板配置 API 地址、密钥和模型。

详细安装、配置和运行时隔离说明见 [插件说明](logos-agent/vscode-extension/README.md)。

旧 Deep Agents 工程、Web 工作区、展示网页与设计预览已移除，历史版本可通过 Git 历史查看。
