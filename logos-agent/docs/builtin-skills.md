# LOGOS 内置 Skills

启动器通过 Pi 原生 `--skill` 加载 `pi-domain/skills/`，从任意工作区启动 LOGOS 均可使用。新增 Skill 放入该目录下的 `<名称>/SKILL.md`，重启生效。`--no-skills` 可关闭默认加载。

| Skill | 用途 |
|---|---|
| logos-simulation-workflow | caseDict 和仿真开发、执行流程 |
| sim-cli | 跨求解器执行纪律、版本检查、验收和会话管理 |
| fluent-sim | Fluent 会话、PyFluent 和文件分析 |
| mechanical-sim | Mechanical、PyMechanical 和 DPF |
| workbench-sim | Workbench 项目、journal 和会话 |
| hfss | HFSS、PyAEDT 和 AEDT |
| spaceclaim | SpaceClaim / Discovery 几何处理（仅用户明确指定或兼容例外） |
| solidcraft | CAD 导入、原生构型重建、编辑、检查、装配和导出；CAD 几何任务的默认路径 |
| vibeflow-fluent | caseDict 到 Fluent 的批处理流程 |

`sim-cli/gui/SKILL.md` 是 sim-cli 的 GUI 子指南，按需读取，不单独注册为全局 `gui` Skill。Pi 遇到 Skill 根目录后不继续发现其内部子 Skill。

Ansys Skills 完整复制自用户指定的 `reusable-assets/harnesses/ansys-agent-harness/skills`，保留脚本、参考资料、技术标识和原文；来源见 `import-manifest.json`。`sim-cli` 为用户已添加的目录，内容保留。

这是知识与操作指南的接入，并不安装 sim-cli、Ansys 求解器、Python SDK、许可证或 MCP 服务。运行前先核实所需工具和版本。
