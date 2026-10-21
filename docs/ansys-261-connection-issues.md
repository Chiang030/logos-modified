# LOGOS 运行问题与 Ansys 26.1 连接排查记录

更新时间：2026-10-14

## 1. 当前结论

当前主要阻塞不是 Linux 权限，而是 **Ansys 26.1、PyWorkbench 0.14.0 与 sim-cli 之间的连接协议和后端选择不匹配**。

已确认的可用链路是：

```text
RunWB2 / Workbench 原生 journal
    -> 创建、打开、更新和保存 Workbench 工程
```

尚未打通的链路是：

```text
sim-cli
    -> PyWorkbench 0.14.0
    -> Ansys Workbench 26.1 持久 SDK 会话
```

以及：

```text
sim-cli attach
    -> 手动启动的 Workbench 非 TLS 本地端口
```

当前工程和用户参数已经保存，可以从已有工程继续，不需要重新建模：

- `/home/jiangjincheng/projects/101301/261013_modal.wbpj`
- `/home/jiangjincheng/projects/101301/261013_modal_files/`
- `/home/jiangjincheng/projects/101301/0-caseDict/caseDict`
- `/home/jiangjincheng/projects/101301/progress.md`

## 2. 已完成并确认成功的部分

根据 `progress.md` 和现有工程文件，以下步骤已经成功：

1. 检查 STEP 文件有效性。
2. 恢复当前用户访问 Ansys 26.1 的 Linux 权限。
3. 确认 RunWB2 原生 journal 可以执行。
4. 创建 Workbench Modal system。
5. 写入 STEP 几何路径。
6. 执行 Geometry `UpdateCAD()`，返回 `GEOMETRY_UPDATECAD_OK`。
7. 保存 Workbench 工程，返回 `PROJECT_SAVED`。
8. 生成 `261013_modal_files` 工程缓存目录。
9. 确认 sim-cli 发现的 Workbench installation ID：`7d2d7568049715eb`。

这些结果说明 Ansys 安装、RunWB2 可执行程序、journal 执行环境、工程路径和当前用户权限至少在原生批处理链路上是可用的。

## 3. 已确认的问题

### 3.1 PyWorkbench 0.14.0 启动 Ansys 26.1 超时

现象：

- `sim-cli` 尝试通过 PyWorkbench 0.14.0 启动 Ansys 26.1。
- 启动过程超时，无法建立可用的 SDK client。
- 当前 `progress.md` 将此列为主要阻塞。

代码路径：


```text
WorkbenchDriver.launch()
  -> _try_import_pyworkbench()
  -> _launch_workbench(..., release="261")
```

相关实现位于：

- `logos-agent/integrations/plugins/workbench/sim_plugin_workbench/driver.py`
- `logos-agent/integrations/plugins/workbench/sim_plugin_workbench/compatibility.yaml`

影响：

- `sim-cli connect --solver workbench` 不能稳定建立持久会话。
- 后续 `exec`、`inspect`、Mechanical handoff 无法依赖 SDK session。
- 不能把“Workbench 进程已经出现”误判成“SDK 已连接”。

当前仓库没有 26.1 的正式兼容性 profile。`compatibility.yaml` 目前只声明到 25.2，因此 26.1 + PyWorkbench 0.14.0 在本仓库中属于未验证组合。

### 3.2 手动 Workbench 暴露非 TLS 本地端口

现象：

- 手动启动的 Workbench 可以暴露本地端口。
- 该端口使用非 TLS 协议。
- sim-cli attach 默认按照 mTLS 方式连接。
- 连接时会寻找证书材料，尤其是 `certs/ca.crt`。
- 非 TLS 连接随后被 Workbench 关闭。

当前实现：

```python
sdk.connect_workbench(
    host=host,
    port=int(port),
    security=kwargs.get("security", "mtls"),
)
```

这意味着：

- 默认 `security` 是 `mtls`；
- attach 没有可靠的非 TLS 默认或自动协商路径；
- cert、key、CA 路径没有在 sim-cli attach 接口中完整暴露；
- 一个非 TLS 端口不能直接按当前默认配置连接。

相关实现：

- `logos-agent/integrations/plugins/workbench/sim_plugin_workbench/driver.py` 的 `attach()`。

影响：

- 端口发现成功不代表 attach 成功。
- “Workbench 正在监听端口”与“sim-cli 能用同一种协议握手”是两个不同条件。
- 即使手动 GUI 已经打开，sim-cli 仍可能无法接管。

### 3.3 `native_batch` 当前没有真正优先绕过 SDK

现象：

- 用户指定 `backend=native_batch` 时，当前 `launch()` 仍然先检查并尝试 PyWorkbench。
- 只要 `ansys-workbench-core` 已安装，就会先调用 SDK。
- SDK 超时或抛异常后，代码直接抛出错误。
- 不会继续进入 RunWB2 fallback。

当前逻辑简化如下：

```text
如果 PyWorkbench 存在：
    尝试 SDK 启动
    SDK 失败 -> 直接抛错

只有 PyWorkbench 不存在时：
    检查 backend == native_batch
    使用 RunWB2
```

相关代码：

- `driver.py` 的 `launch()`，约 515 行附近；
- `driver.py` 的 `_run_file_runwb2()` 和 `_exec_runwb2()`，约 1115 行以后。

影响：

- `native_batch` 不能作为用户明确选择的后端。
- “SDK 失败后自动切换到 native batch”也没有实现。
- 当前 sim-cli 无法复用已经验证成功的 RunWB2 链路。

### 3.4 RunWB2 的“GUI”与持久 SDK 会话不是同一概念

RunWB2/Workbench 原生链路可以启动带 GUI 的 Workbench 并执行 journal，但当前实现使用：

```text
RunWB2 -B -R journal.wbjn
```

`-B` 是批处理模式。它适合：

- 打开或创建 `.wbpj`；
- 创建系统；
- 更新 Geometry；
- 保存工程；
- 执行一次性 journal；
- 输出结构化结果和日志。

它不自动提供：

- 长期存活的 PyWorkbench client；
- `connect -> exec -> inspect` 的 SDK 语义；
- 对已打开 GUI 的任意代码持续发送能力；
- sim-cli 的 session ID 路由。

因此 `logo test` 成功打开 Ansys，只能证明原生 Workbench/RunWB2 路径可用，不能证明 PyWorkbench 或 mTLS attach 可用。

### 3.5 真实运行时覆盖不足

仓库文档已经明确提示，以下组合尚未完成真实运行时回归：

- Ansys 26.1；
- PyWorkbench 0.14.0；
- Linux/Windows 实际版本组合；
- 许可证状态；
- GUI 捕获；
- 端口冲突；
- 原生 batch 文件传输；
- SDK 的 ownership/destructor 行为；
- attach 后的 detach 和退出语义。

因此测试通过或进程出现，不能直接宣称“连接链路已验证”。

### 3.6 当前工程尚未进入 Mechanical 和模态求解阶段

`progress.md` 记录当前尚未完成：

- Mechanical 几何实体识别；
- 铝合金、PLA、电池等效材料分配；
- 集中质量点设置；
- 自由模态和地面模态设置；
- 网格生成；
- 基准工况求解；
- 30 组厚度迭代；
- 前 15 阶频率、振型和变化报告。

因此目前不能报告频率、振型或结构结论。

## 4. 可能的问题与待验证项

以下项目已经从实现和运行现象中暴露出来，但需要实机回归确认：

1. Ansys 26.1 的 SDK 服务是否实际启动，只是 PyWorkbench 等待条件不匹配，还是 Workbench 根本没有启动成功。
2. PyWorkbench 0.14.0 对 `release="261"` 的参数、版本门控和服务发现方式是否正确。
3. 手动 Workbench 非 TLS 端口的准确协议格式、生命周期和关闭条件。
4. 是否存在同时运行多个 Workbench 进程导致的端口或锁冲突。
5. RunWB2 GUI journal 是否能够在当前桌面会话下持续执行并交互，而不是仅能完成一次性批处理。
6. Workbench 打开 `261013_modal.wbpj` 后是否能稳定启动 Mechanical 数据库。
7. `disconnect`、`detach` 是否会关闭用户手动启动的 Workbench。当前代码设计上应保护 attached session，但需要实机验证。
8. 连接超时后 Ansys 进程是否仍然存活。超时不能直接视为远端软件已停止。

## 5. 计划的解决方案

### 5.1 P0：让 native_batch 成为真正可选且优先的后端

修改 `WorkbenchDriver.launch()`：

```text
如果 backend == native_batch：
    不导入、不调用 PyWorkbench
    直接定位 RunWB2
    建立 native batch session

否则：
    走 PyWorkbench SDK
```

要求：

- SDK 不得在显式 `native_batch` 时被调用；
- RunWB2 路径失败时返回明确的 RunWB2 错误；
- 返回中标明 `backend=runwb2`、`session_origin=launched`、`ownership`；
- 不把 RunWB2 batch session 伪装成 PyWorkbench session；
- 对已有 `.wbpj` 提供明确的 journal 打开入口。

### 5.2 P0：先用已有工程验证 native batch/GUI journal

使用现有文件：

```text
/home/jiangjincheng/projects/101301/261013_modal.wbpj
/home/jiangjincheng/projects/101301/handoff_mechanical.wbjn
```

验证顺序：

1. 用 RunWB2 打开已有工程。
2. 输出 Workbench 进程、工程路径和 journal 状态。
3. 执行只读项目查询。
4. 尝试 handoff 到 Mechanical。
5. 每一步单独保存日志和 JSON 结果。
6. 确认失败后工程仍可从保存点恢复。

### 5.3 P1：修复 attach 的协议选择

attach 接口需要显式支持至少两种模式：

```text
security=mtls
security=none
```

建议增加：

- `--security mtls|none`；
- `--ca-cert`；
- `--client-cert`；
- `--client-key`；
- 连接前的协议探测或明确错误提示；
- 返回实际使用的 `security`、endpoint 和 ownership。

对于手动 Workbench 暴露的非 TLS 本地端口，应显式使用 `security=none`，而不是继续默认 mTLS。

### 5.4 P1：增加 Ansys 26.1 兼容性状态

在 `compatibility.yaml` 增加 26.1 条目，但在真实回归完成前标记为：

```text
status: experimental
```

至少记录：

- Ansys 版本：26.1；
- PyWorkbench 版本：0.14.0；
- Linux 发行版和桌面会话；
- SDK 启动是否成功；
- 手动 attach 的 TLS 模式；
- RunWB2 journal 是否成功；
- Mechanical handoff 是否成功。

### 5.5 P1：明确区分三种能力

在 sim-cli 返回和文档中分别标识：

1. `process_started`：Workbench 进程已出现；
2. `transport_connected`：HTTP/端口/SDK 通信已建立；
3. `script_ok`：journal 或脚本执行成功；
4. `mechanical_ready`：Mechanical 数据库可用。

不能因为第一项成功就报告 SDK session 已连接。

### 5.6 P1：处理超时后的进程和会话状态

启动或脚本超时后：

- 记录 PID、端口、backend 和远端状态；
- 不自动重试；
- 先执行 `ps`、进程探测或只读 inspect；
- 明确返回 `remote_state=unknown`；
- 只有确认旧进程已退出后才允许重新启动。

### 5.7 P2：为原生 GUI journal 增加可恢复工作流

因为 RunWB2 更适合分步执行，应把工作流拆成可恢复阶段：

```text
open_project
  -> inspect_project
  -> handoff_mechanical
  -> assign_materials
  -> add_masses
  -> mesh
  -> solve
  -> export_results
```

每一步：

- 使用独立 journal；
- 产生独立日志；
- 写入成功/失败标记；
- 保存工程；
- 支持从最近保存点继续。

### 5.8 P2：完成真实 26.1 回归矩阵

至少覆盖：

- SDK launch；
- RunWB2 batch；
- RunWB2 GUI journal；
- 手动 Workbench 非 TLS attach；
- mTLS attach；
- `detach`；
- `disconnect`；
- 超时后恢复；
- 已有 `.wbpj` 打开；
- Mechanical handoff；
- 工程保存和重开。

## 6. 建议的执行优先级

### 第一阶段：立即可用

1. 修复 `native_batch` 优先级。
2. 用 RunWB2 继续处理 `261013_modal.wbpj`。
3. 把每一步 journal 的输出保存到工程目录。

### 第二阶段：连接协议修复

1. 增加非 TLS attach。
2. 保留 mTLS 的证书参数。
3. 增加 endpoint/security/ownership 诊断信息。

### 第三阶段：SDK 兼容性验证

1. 单独测试 PyWorkbench 0.14.0 + Ansys 26.1。
2. 确认启动超时发生在进程启动、端口发现还是 TLS 握手。
3. 再决定是否继续支持 SDK launch，或将 26.1 默认后端设为 native batch。

## 7. 当前不应作出的结论

- 不能说 Ansys 26.1 完全无法使用；RunWB2 原生链路已经成功。
- 不能说 Linux 权限仍是主因；现有证据显示权限问题已解决。
- 不能说 `logo test` 证明 PyWorkbench 连接成功；它更可能只证明 RunWB2/journal 成功。
- 不能说打开 GUI 就等于建立了持久 SDK session。
- 不能在 Mechanical 尚未建立和求解尚未完成时报告模态结果。

## 8. 参考文件

- `/home/jiangjincheng/projects/101301/progress.md`
- `/home/jiangjincheng/projects/101301/261013_modal.wbpj`
- `/home/jiangjincheng/projects/101301/0-caseDict/caseDict`
- `logos-agent/integrations/plugins/workbench/sim_plugin_workbench/driver.py`
- `logos-agent/integrations/plugins/workbench/sim_plugin_workbench/compatibility.yaml`
- `logos-agent/docs/simulation-tool.md`
- `logos-agent/integrations/sim-cli/docs/architecture/multi-session-and-config.md`
