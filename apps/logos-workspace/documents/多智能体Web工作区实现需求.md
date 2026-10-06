# 多智能体 Web 工作区实现需求

文档日期：2026-10-06

## 1. 实现前提

以下能力需要先在一个 Web 应用中实现。首版以 Web 作为多智能体协作、会话管理、任务派发、工作区管理和运行观测的统一产品入口；在 Web 版本验证整体交互与运行协议之后，再评估桌面端或其他客户端形态。

系统基于 Deep Agents SDK 和 LangGraph 构建，不直接以 DeepAgent Code 整套产品作为增量开发基座。

系统不是“主智能体调用隐藏的子智能体”，而是由多个具有独立入口、独立会话和独立工作空间的同级智能体组成。总师智能体拥有项目协调权限，但其他智能体仍可被用户直接访问和对话。

## 2. 智能体体系

首版包含三个智能体。

### 2.1 总师智能体

- 作为用户的主要对话入口。
- 接收和澄清用户目标。
- 维护项目级需求、约束和关键决策。
- 拆分任务并选择专业智能体。
- 派发任务时选择新建、继续或 Fork Session。
- 协调建模与验证之间的冲突。
- 汇总各智能体交付并向用户报告项目状态。
- 请求用户处理无法由系统自主决定的事项。

总师智能体是拥有协调权限的同级 Agent，不直接拥有其他智能体的内部状态，也不应通过同步函数调用隐藏其他智能体的执行过程。

### 2.2 建模智能体

- 拥有独立入口和多个独立 Session。
- 负责建模方案、耦合配置和计算准备。
- 用户可以直接进入其 Session 查看总师派发的消息并补充信息。
- 在私有或 Session 工作区内完成草稿和中间工作。
- 向共享工作区发布正式模型、配置和计算产物。

### 2.3 验证智能体

- 拥有独立入口和多个独立 Session。
- 独立读取冻结输入、计算结果和验证证据。
- 使用确定性工具形成检查结果。
- 发布结构化验证报告。
- 不得修改正在验证的模型和结果。

未来可以按实际需求增加设计智能体，以及按物理领域划分的专业智能体，但首版不预先扩张智能体数量。

## 3. 核心对象与层级

```text
Workspace
  └─ Agent
       └─ Session
            ├─ Thread
            ├─ Messages
            ├─ Runs
            ├─ Tasks
            └─ Session Workspace
```

- `Workspace`：一个工程项目及其协作边界。
- `Agent`：智能体身份、能力、工具、权限和长期配置。
- `Session`：某个智能体的一段独立会话，是 Web 产品中的一等对象。
- `Thread`：LangGraph 保存该 Session 对话上下文和 Checkpoint 的载体。
- `Run`：智能体处理一次输入的一次执行过程。
- `Task`：跨智能体派发、跟踪和交付的工作单元。
- `Message`：用户或智能体发送的可见消息。
- `Artifact`：模型、配置、日志、结果、证据和报告等正式产物。

一个 Agent 可以拥有多个 Session。每个 Session 对应独立的 LangGraph `thread_id`，不同 Agent 的状态 Schema 和 Thread 相互隔离。

## 4. 独立入口与多智能体通信

总师、建模和验证智能体都必须注册为独立的 Agent Graph，并能被用户直接访问。

```json
{
  "graphs": {
    "chief_engineer": "./src/agents/chief.py:graph",
    "modeling_agent": "./src/agents/modeling.py:graph",
    "validation_agent": "./src/agents/validation.py:graph"
  }
}
```

总师智能体不再通过以下方式同步隐藏其他智能体：

```python
modeling_agent.invoke(...)
```

总师智能体应通过 Control Plane 派发任务和发送消息：

```python
dispatch_task(
    recipient_agent="modeling_agent",
    session_strategy="new",
    task=task,
    shared_workspace_revision=42,
)
```

用户和其他智能体使用同一套消息入口。每条消息至少记录：

- `message_id`
- `workspace_id`
- `sender`
- `recipient`
- `agent_id`
- `session_id`
- `task_id`
- `in_reply_to`
- 顺序号和时间
- 投递及处理状态

用户打开建模或验证智能体的 Session 后，必须能够看到总师智能体发送的消息，并能在同一 Session 中直接发送补充消息。

## 5. Session 管理与任务派发

总师智能体派发任务时，需要明确选择目标 Agent 以及 Session 策略。

### 5.1 新建 Session

- 用于新的独立任务。
- 创建新的 Session 和 Thread。
- 使用干净的消息上下文。
- 固定本次任务使用的共享工作区输入版本。
- 作为跨任务派发时的默认选择。

### 5.2 继续指定 Session

- 用于同一任务的补充、追问、修订和返工。
- 必须选择明确的 `session_id`。
- 不得仅根据“最近一次会话”自动继承，以免混入其他任务上下文。

### 5.3 Fork Session

- 从指定 Session 的指定 Checkpoint 创建独立分支。
- 继承已有上下文，但不修改原 Session。
- 用于替代方案探索、参数分支和设计比较。

```json
{
  "mode": "fork",
  "source_session_id": "session-model-27",
  "source_checkpoint_id": "checkpoint-18"
}
```

首版可以优先实现“新建 Session”和“继续指定 Session”，在基础协议稳定后增加 Fork。

## 6. 工作区体系

系统需要四层工作空间：

```text
Project Shared Workspace
Agent Private Workspace
Session Workspace
Run Scratch Workspace
```

### 6.1 Project Shared Workspace

用于保存所有授权智能体共同使用的正式内容：

- 已确认的需求和约束。
- 当前有效的模型与配置。
- 输入数据、单位、坐标系和边界条件。
- 已发布的计算结果和产物。
- 验证证据和验证报告。

### 6.2 Agent Private Workspace

用于保存某个智能体跨 Session 使用的长期资料、配置、记忆和内部工作内容。其他智能体不能自动获得该区域的内容。

### 6.3 Session Workspace

用于保存具体 Session 的草稿、中间方案、候选模型和任务上下文。正式内容必须经过发布流程才能进入共享工作区。

### 6.4 Run Scratch Workspace

用于保存单次 Run 的下载文件、转换结果、缓存和临时计算文件。Run 结束后按策略归档或清理。

运行时可以向智能体提供统一逻辑路径：

```text
/workspace/shared/
/workspace/private/
/workspace/session/
/workspace/run/
```

底层由 Workspace Backend 根据 `workspace_id`、`agent_id`、`session_id`、`run_id` 和权限进行路由。

## 7. 共享工作区版本与发布

共享工作区不能作为所有智能体任意覆盖的公共文件夹。正式内容应通过版本化 ChangeSet 发布。

```text
读取共享版本 v12
    ↓
在 Session Workspace 中工作
    ↓
提交 base_revision=v12 的 ChangeSet
    ↓
发布模型版本 v13
    ↓
验证智能体固定读取 v13
    ↓
发布对应验证报告
```

发布过程至少包括：

- 权限检查。
- 基线版本检查。
- 冲突检测。
- 文件哈希计算。
- 创建不可变 Artifact 版本。
- 记录发布者、来源 Session、来源 Run 和 Task。
- 发送工作区更新事件。
- 支持历史版本读取和回退。

任务启动时必须固定 `shared_workspace_revision` 和输入 Artifact，避免执行期间的输入漂移。

## 8. 运行与并发规则

- 每次用户或智能体输入对应一个新 Run。
- 多轮对话通过复用 Session 对应的 `thread_id` 实现。
- 同一 Session 同时只允许一个活动 Run。
- Run 执行期间收到的新消息进入该 Session 的 Inbox 队列。
- 不同 Session 可以并行运行，但受 Agent 或系统并发额度限制。
- 用户可以选择等待处理、取消当前 Run 或显式中断。
- 不允许两个 Run 同时修改同一个 Thread Checkpoint。
- 智能体完成任务后，在自己的 Session 中保留完整可见交付。
- 派发者默认接收结构化摘要、状态和 Artifact 引用，不自动复制目标 Agent 的全部对话上下文。

需要展示可观察的输入、输出、工具调用、执行状态、错误和证据，但不以展示模型内部思维链为目标。

## 9. Control Plane

LangGraph 之外需要一个 Workspace Control Plane，负责多智能体之间的协作治理：

- Workspace 和成员管理。
- Agent 注册和权限。
- Session 创建、继续、归档和 Fork。
- 消息投递和 Agent Inbox。
- Task 创建、派发、追踪和交付。
- Run 创建、排队、取消、中断和恢复。
- 工作区版本、ChangeSet 和冲突管理。
- Artifact 元数据、来源和权限。
- 统一事件流和前端订阅。

职责边界如下：

- Deep Agents SDK：负责单个智能体内部的推理、工具调用和上下文管理。
- LangGraph：负责单个智能体的 Thread、Run、Checkpoint 和执行图。
- Control Plane：负责智能体之间的消息、任务、Session、权限和调度。
- Workspace Service：负责文件、版本、发布、Artifact 和冲突处理。

## 10. Web 前端结构

首版 Web 应用采用三栏工作区布局。

```text
左侧
  智能体列表
    总师智能体
      项目总体规划
      需求澄清
      新建 Session
    建模智能体
      热结构模型 v2       运行中
      材料参数修订        等待中
      新建 Session
    验证智能体
      热结构模型 v2 验证  等待中
      基线模型审查        已完成
      新建 Session

中间
  当前 Agent 和 Session 选择器
  用户消息
  其他智能体发送的消息
  当前智能体回复
  工具调用和执行状态
  消息输入与取消/中断操作

右侧
  当前 Session 的关联任务
  固定的输入版本
  Run 历史
  Session 工作文件
  已发布 Artifact
  验证报告
```

右侧信息默认跟随当前 Session，也应支持切换到整个项目范围。

前端订阅 Workspace 级 SSE 或 WebSocket 事件流，并按照以下标识分发事件：

- `workspace_id`
- `agent_id`
- `session_id`
- `task_id`
- `run_id`

建议统一支持以下事件类型：

- `message_created`
- `task_dispatched`
- `run_queued`
- `run_started`
- `agent_message`
- `tool_started`
- `tool_completed`
- `artifact_published`
- `run_completed`
- `run_failed`
- `workspace_updated`

## 11. 数据与存储

首版建议使用：

- PostgreSQL：Workspace、AgentSession、Message、Task、Run、权限、版本和 Artifact 元数据。
- LangGraph 数据库 Checkpointer：各 Agent Thread 的执行状态和恢复点。
- 本地产物目录或对象存储适配层：模型、结果、日志和大型文件。
- 本地 Run 目录：单次执行临时空间。
- SSE 或 WebSocket：向 Web 前端推送实时事件。

主要数据模型至少包括：

- `workspaces`
- `agents`
- `agent_sessions`
- `messages`
- `tasks`
- `runs`
- `workspace_revisions`
- `changesets`
- `artifacts`
- `events`

## 12. 首版部署形态

首版采用模块化单体，不提前拆成大量微服务：

```text
一个 Web 前端
一个 Control Plane 后端
一个 LangGraph Server，注册多个独立 Agent Graph
一个 PostgreSQL
一个 Artifact Storage
一个后台调度 Worker
```

如果早期规模较小，Control Plane、Workspace Service 和调度 Worker 可以位于同一代码库和部署单元中，但模块边界必须保留。

## 13. 首版实施顺序

1. 将总师、建模和验证注册为三个独立 Graph。
2. 验证用户可以分别直接访问三个 Agent 并进行多轮对话。
3. 建立 Workspace、AgentSession、Message、Task、Run 和 Artifact 数据模型。
4. 实现每个 Agent 的多 Session 管理。
5. 实现总师向其他 Agent 派发新 Session 或继续指定 Session。
6. 实现 Agent Inbox 和单 Session 串行执行。
7. 实现 Project Shared、Agent Private、Session 和 Run Scratch 工作区。
8. 实现共享 Artifact 的版本化 ChangeSet 发布。
9. 实现统一事件流和三栏式 Web 前端。
10. 实现持久化、恢复、取消、错误处理和基础权限。
11. 在基础协议稳定后增加 Session Fork、复杂权限和分布式调度。

## 14. 首版暂不扩张的能力

- 不提前按每个物理场创建常驻智能体。
- 不一次性拆成多个独立微服务。
- 不实现无约束的智能体相互递归调用。
- 不把模型内部思维链作为产品展示内容。
- 不在首版实现复杂的跨机器调度和高可用队列。
- 不让共享目录采用无版本、无冲突检测的直接覆盖方式。

## 15. 核心架构原则

1. 每个智能体都是可由用户直接访问的独立入口。
2. 总师智能体拥有协调权限，但其他智能体不是隐藏的次级函数。
3. 每个智能体拥有多个 Session，每个 Session 对应独立 Thread。
4. 用户和智能体可以向同一个 Session 发送消息，并保留真实发送者身份。
5. LangGraph 管理单个智能体的执行，Control Plane 管理多个智能体之间的协作。
6. 私有区用于自由工作，共享区通过版本化 ChangeSet 协作，正式产物必须显式发布。
7. Web 是首个完整实现和验证这些能力的产品载体。
