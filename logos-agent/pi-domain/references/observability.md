# Pi → Langfuse V1

## 范围和启动

仅覆盖本包加载的 Pi Agent Harness。未修改 Agent Loop、Provider、simulation 业务逻辑或 VS Code 宿主；不接入 Deep Agents、LangGraph。遥测默认关闭。SDK 初始化失败、事件处理失败、导出失败都不能改变扩展事件返回值或工具结果。

在 `logos-agent/pi-domain` 执行 `npm ci`，参考 `.env.example` 在忽略提交的 `.env.local` 中配置独立 Langfuse Project 的 URL 和密钥。Project 是存储 Trace 的空间，不是 benchmark。使用已构建的仓库 Pi CLI 示例：

```powershell
node --env-file=.env.local ../../vendor/pi/packages/coding-agent/dist/cli.js -e .
```

运行 Pi 的进程必须收到这些环境变量；扩展不会自行读取 `.env.local`。`LOGOS_OBSERVABILITY=1` 启用；未启用时不加载 Langfuse/OTel SDK。`LOGOS_OBSERVABILITY_CONTENT=metadata` 关闭上下文、输入和输出正文；其他值开启有界脱敏快照。脱敏是启发式过滤，不能保证识别所有业务秘密，敏感部署应优先使用 metadata 模式。

Node 要求 >=22.19.0，实际验证 v24.14.0。固定 `@langfuse/tracing` / `@langfuse/otel` 6.0.1、OTel API 1.9.0、SDK 2.0.1、OTLP HTTP 0.223.0，锁定完整依赖树。这些官方 SDK 提供 Langfuse 观测类型、OTLP 映射和维护中的导出协议，避免维护自制协议。升级需重跑真实 Pi 和云端契约测试。本次未修改 VSIX 打包；若打包排除 node_modules，需另外解决域包依赖分发，不能据此宣称已支持 VSIX 部署。

## 实际 API 与分层

### 如何在 Langfuse 阅读一次请求

2026-10-19 展示修订：树节点采用中文描述，原 `pi.activity` / `pi.agent_run` / `pi.turn` / `pi.generation` 标识保留在 metadata.component，便于稳定筛选。

```text
用户请求 · 请求文本摘要
└─ Agent 执行 #1
   ├─ 循环 #1 · 调用工具 (1)
   │  ├─ 模型调用 #1 · 请求工具
   │  └─ 工具 · demo_material_lookup
   ├─ 循环 #2 · 调用工具 (1)
   │  ├─ 模型调用 #2 · 请求工具
   │  └─ 工具 · demo_mass_calculate
   └─ 循环 #3 · 模型响应
      └─ 模型调用 #3 · 返回响应
```

- 用户请求：Input.userRequest 是 before_agent_start 捕获的请求；Output 包含最后响应、结束状态和 summary（agentRuns、loops、modelCalls、toolCalls、toolErrors）。循环/模型序号在本条 Activity 内递增；下一请求重新计数。
- Agent 执行：一次 Pi Agent Loop 运行。通常只有 #1，自动恢复可能产生 #2；它与循环轮数不同。Input 说明请求和运行原因，Output 汇总本次运行。未暴露的恢复原因仍为 unknown。
- 循环：模型读取上下文、返回内容或工具调用、执行工具，再进入下一轮。Input 说明本轮请求，Output 展示本轮响应和工具数量；不复制模型 Token。
- 模型调用 Input.messages：按 index 显示 system（含工具声明）、历史对话、先前 Assistant/toolResult；capture 标明采集阶段、消息总数、省略数与截断状态。Output 展示 answer、toolCalls（包含参数）、reasoning、stopReason。
- 工具 Input.arguments：真正收到的参数；Output.result.content/details：工具返回内容与结构化详情。isError 与 simulation 工程判定分别呈现。出现折叠项时，在 Langfuse Formatted 视图点击行左侧箭头或 Expand all rows；也可切 Raw 查看 JSON。

`LOGOS_OBSERVABILITY_CONTENT=full` 开启这些内容（示例配置已设为 full）。metadata 模式保留计数但不上传正文或请求标题。Model reasoning 只采集最终 Assistant Message 中 Provider 对外暴露的 thinking 文本/摘要，状态区分 provider_exposed、not_exposed、redacted_by_provider；不解密签名、不获取未暴露内部思考、不根据工具行为生成假 reasoning。演示中的 reasoning 是测试 SSE 预置内容，明确标记为演示摘要。

上下文在限制内完整捕获；超限时最多选择48条消息（最多8条连续开头 system + 最近历史），按预算分别截取，保留原始 index，显式标记省略。后续系统变更若处在省略部分，也不能声称这是完整模型输入。外层序列化仍可能进一步截断，此时另有 inputTelemetryTruncated。context_with_system 后仍可能有其他 handler 修改上下文，所以不是 wire payload 的保证。

依据当前仓库 `vendor/pi/packages/coding-agent/dist/core/extensions/types.d.ts` 和对应实现，Pi 1.1.0，vendor commit `abe508e1b89912adde45528136c3221eb69acdd7`。这是当前 fork 的能力，不保证同版本上游拥有全部 Hook。

| 层级 | 身份与边界 |
| --- | --- |
| Session | `namespace:PiSessionId`，是 Langfuse session.id 分组，不创建覆盖整段会话的长 Span |
| Activity Trace | 首次 agent_start → agent_settled；独立压缩则创建 maintenance Activity |
| Agent Run | 每次 agent_start → agent_end；同一 Activity 可有多个自动续跑 Run |
| Turn | Run 内的 turn_start → turn_end；身份需加 runSequence，因为 turnIndex 会重置 |
| Generation | 一次可见模型请求；prepared → started → streaming → end_seen → finished；允许跳过缺失中间状态并标记 |
| Tool | `(session epoch, runSequence, toolCallId)`，用 parentToolCallId 关联嵌套；顶层挂 Turn |

Generation 与顶层 Tool 同属 Turn；Tool metadata 的 sourceGenerationId 关联产生该调用的 Generation，避免把已经结束的模型请求错误拉长到工具结束。所有 Span 保存手动引用，并使用显式 parent context；不依赖跨回调的隐式 active span。

自动恢复只根据实际 agent_start/agent_end/agent_settled 表示多个 Run；未暴露准确原因时 `continuationReason=unknown`。不能把每次续跑都声称为 retry。Steering/Follow-up 的 input 记录为意图，以实际消息/请求创建调用，不因入队创建 Generation。同一未 settled Activity 内续跑保留 Trace，settled 之后的新请求另开 Trace。取消由 aborted/最终 stopReason 传播；会话切换清理旧状态并按 session ID 拒绝旧会话回调。

## 事件映射与时间来源

本地时间采用 `Date.now()` 锚定的 `performance.now()` 增量，避免墙钟跳变影响时长。表内均指本扩展收到回调的时刻，不声称网络线上精确时间。

| 真实 pi.on 事件 | 动作 / 计时 |
| --- | --- |
| session_start / session_shutdown | 新 controller epoch / 关闭残留 Span 并最多 2 秒 Flush，不关闭进程 Provider |
| input / before_agent_start | 保存有界意图和 prompt，不开始模型计时 |
| agent_start / agent_end | 开始 / 结束 Run；首次 agent_start 开始 Activity |
| agent_before_settle / agent_settled | 记录最终 outcome / 结束 Activity，包括其间重试等待、工具、压缩和人工等待 |
| turn_start / turn_end | Turn 起止；在 turn_end 读取最终替换后的 Assistant Message Usage |
| context_with_system | 创建 prepared Generation，捕获含 system 的有界上下文；不是保证最终 wire payload |
| before_provider_request | 更新同一 Generation，记录请求钩子时刻与白名单参数，不另开 Generation |
| after_provider_response | 更新 HTTP status 和请求 ID；不采集完整 headers |
| message_start / message_update / message_end | 仅 Assistant；推进状态。首个非空 text_delta 记首次文本；message_end 固定结束时刻 |
| tool_execution_start / tool_execution_end | Tool 墙钟起止；另存事件 durationMs 为 executeDurationMs，不混同钩子墙钟 |
| session_before_compact / session_compact / session_compact_failed | Compaction Span 起止，失败/取消有独立状态；不伪造内部模型 Generation |
| ui_prompt_start / ui_prompt_end | 人工等待 Span 起止，限当前 Activity；Pi runner 自身合并嵌套/重叠 UI 等待，非逐个 UI 对话计时 |
| session_tree | 记录分支变更，不把树导航当作模型调用 |

Generation 的 Span 时长为 context_with_system（缺失则首个 Assistant 事件）到 message_end；到 turn_end 才提交最终 Usage，但结束时间仍用 message_end，排除工具执行。Pi 的 message.timestamp/durationMs 单独保留为模型侧时间证据。首次文本延迟从 before_provider_request 到首个 text_delta，缺 Hook 时以 context 回调为起点并标记降级来源；没有文本则缺省。Langfuse completionStartTime 是首次文本时刻，它相对于 Generation Span 起点的 UI 延迟可能与 metadata.firstTextLatencyMs 不同。

RPC 的 auto_retry_*、queue_update，以及 RPC agent_end.willRetry 不等于 Extension Hook，本实现不注册。before_provider_headers/provider_stream_event 虽存在，但 V1 不需要它们。Provider SDK 内部 HTTP 重试、未暴露的压缩内部模型请求不追踪。Provider Hook 缺请求关联 ID，只更新当前主请求，不观察独立后台调用；异步副请求交错的可区分性是现有 API 的限制。

## Usage 与 Cost

权威 Token 数据源为最终 Assistant Message Usage；stream delta 不累计。message_end 暂存、turn_end 结算；缺终态时尽量使用已有最终消息并标记 incomplete。每个 Generation 结算一次，不向 Root/Run/Turn/Tool 复制 Usage。

| Pi 字段 | Langfuse Usage Type | Cost Type |
| --- | --- | --- |
| input（普通输入） | input | input |
| cacheRead | input_cache_read | input_cache_read |
| cacheWrite（含 cacheWrite1h） | input_cache_write | input_cache_write |
| output（含 reasoning） | output | output |

总量 = input + cacheRead + cacheWrite + output。cacheWrite1h 和 reasoning 只放 metadata，分别校验 <=cacheWrite、<=output；reportedTotal 与规范化总量不符则标记，不重复相加。缺失/非法数据不伪装为 0；全部为 0 标为 unverified_zero。

已用真实 Langfuse 云端读回验证互斥分类及合计。费用采用最终 `usage.cost` 的同名分类，并显式提供 costDetails.total（云端自定义分类单独上报时未自动得到 totalCost）。只接受匹配 model ID、完整非负价格表且至少一项非零、完整非负费用且分项总和一致的估算。metadata 标记 `costSource=pi_final_cost`、`costStatus=estimated`、USD；这是配置价格表估算，不是供应商账单。保留 Pi 已处理的阶梯/缓存计价，不重新用基础价格乘 Token。

未知价格不报可信费用，标记 costStatus=unknown。Langfuse 可能自行推断模型费用，报表必须按 costStatus/costSource 区分；未验证的自动推断不可作为权威成本。1h 缓存费用没有独立可靠分项时不能从合并 cacheWrite 成本中凭空拆分。

## 隔离、清理与资源限制

私有 NodeTracerProvider 不注册为全局 Provider。每个本模块 Span 创建时写入 `logos.observability.source=logos.pi-domain.observability.v1`，instrumentation scope 同名；shouldExportSpan 必须同时匹配两者。测试覆盖外来 root 与外来 child，正常负载下所有本模块父节点保留。该标记是归属筛选，不是对恶意扩展的安全认证。

进程级 SDK 使用 Symbol.for 单例；Extension Reload 新建 Controller、复用 Provider。session_shutdown 只做有限 Flush，beforeExit 才关闭 SDK。凭据/URL 变更需要重启 Pi，不能在 Reload 中悄悄建立第二个 Provider。环境和队列参数同样按首次 SDK 初始化生效。

事件处理总返回 undefined，不替换 context/payload/tool result。缺终态、下一 Turn、session 切换、关闭、TTL 到期均清理 Generation/Tool/Trace。默认 Activity TTL 为 24 小时，每分钟检查；过期仅停止遥测直到 settled，不取消实际 Pi 工作。硬杀进程无法保证清理或 Flush。

默认队列上限 512 Span / 16 MiB（按序列化 attributes + 每 Span 2048 字节估算，含 in-flight），批量 32，每 250ms 排空，HTTP 超时 1 秒，Flush 最多 2 秒；单 in-flight 限制，失败或满队列允许丢弃并累积统计。不是磁盘持久队列；过载丢弃可能使云端树不完整，不能同时承诺有界内存与无损。统计可从 runtime.queue.stats 获取，当前没有独立告警面板。

最多 1024 打开记录、2048 去重记录、64 输入意图。快照默认 32KiB，最多 64KiB；深度8、节点512、容器前64项、单字符串前8192字符；metadata 8KiB，modelParameters 2KiB。仅序列化有界副本，跳过 getter、循环、图片数据；签名脱敏，Provider 已 redacted 的 thinking 不上传。正文截断单独标记，不与工具 result.details.output_truncated 混同。异常事件中若子工具先到，先建父占位；迟到的更高层祖先无法修改已创建 OTel 父链，标记 relationshipIncomplete。

## 文件职责与验证

`extensions/index.mjs` 仅注册；`extensions/observability.mjs` 负责开关、异常隔离和 watchdog。`src/observability/` 下 controller 管会话层级，generation 管请求状态机，tools 管工具图，simulation 只读 result.details，usage 管互斥计数与费用，display 管可读名称/响应/上下文选择/循环计数，spans 管有界更新与引用，sanitize 管快照，exporter 管私有 SDK 和来源筛选，queue 管背压，config 管限制。

simulation metadata 独立保留 transport_ok、script_ok、acceptance、exit_code、remote_state、operation_id、output_truncated；isError=false 不代表工程成功。当前业务实现 acceptance=not_evaluated；stop 的 remote_state=unknown，其他情况 not_inferred，观测层不提升这些结论。

执行 `npm test` 验证本地逻辑、真实 Pi SDK 和 OTLP 故障；`npm run test:live` / `test:usage-contract` 会向已配置 Langfuse Project 写入合成验收数据；`npm run bench:observability` 运行 OFF/ON 对照。详见 observability-validation.md。自动恢复、Steering、取消、压缩的复杂顺序目前主要由事件夹具验证，真实 Pi 集成覆盖普通调用、嵌套工具、域入口和 Reload，不声称完成全部真实 Provider/工程负载验收。
