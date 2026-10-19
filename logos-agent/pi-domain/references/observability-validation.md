# Pi observability 实施验收记录

验证日期：2026-10-19。范围限 `logos-agent/pi-domain`；Node v24.14.0 / Windows，当前 vendor Pi 1.1.0，commit `abe508e1b89912adde45528136c3221eb69acdd7`。固定 Langfuse 6.0.1、OTel SDK 2.0.1，见 package-lock.json。

## 端到端结果

真实 Pi SDK → 本地合成 SSE 模型 → 真实 OTLP HTTP → Langfuse Leadhk 测试项目，最终验收 Trace：

[64ec963a069e92489cf6effd2fb0996b](https://jp.cloud.langfuse.com/project/cmvf0gw8w0001ad0e5g07em2p/traces/64ec963a069e92489cf6effd2fb0996b)

按 Langfuse `/api/public/v2/observations` 读回，7 个 observation：1 Activity Root、1 Agent Run、2 Turn、2 Generation、1 Tool，父 ID 全部可解析。两条 Generation 各自普通输入100、缓存读取200、缓存写入60、输出80，Langfuse 合计输入360 / 输出80 / 总440；reasoning30 没有重复累计。每条成本约 `$0.000355`，总计约 `$0.00071`（服务端小数截断容差 1e-8）。导出7、失败0、丢弃0。

独立 Usage/Cost 契约 Trace：`c0c04971f7a145af26372e2236de0fce`。确认互斥 Usage Types 可落库并聚合，costDetails.total 必须显式提供，不能依赖自定义分类自动算总费用。这些数据使用人为定义的合成模型价格，验证的是映射契约，不是实际模型账单。

只上传合成测试内容；同事 VM002 工程测试包未上传、未执行。Langfuse 项目 ID 来自只读 Projects API。`.env.local` 和 `.observability-results/` 已忽略提交，不将密钥纳入代码或报告。

## 测试覆盖

初版 `npm test`：36 passed；展示修订后为 **40 passed，0 failed / skipped**（可观测性32项，既有 simulation/UI 回归8项）。以下初版性能数据保留作历史记录，最新结果见文末。

| 组 | 验证重点 | 证据类型 |
| --- | --- | --- |
| 1 | 一次请求 Root/Generation/Tool、Usage、完整父链 | 真实 Pi + 本地 SSE，另有云端验收 |
| 2 | 最终 Assistant Message 覆盖流式暂存；重复终态不双计 | 事件夹具 |
| 3 | context/start/end 缺失，清理且标记不完整 | 事件夹具 |
| 4 | 自动续跑多 Run 共用一个 Activity，turnIndex 重置 | 事件夹具 |
| 5 | Steering / Follow-up 入队意图不产生虚构请求 | 事件夹具 |
| 6 | 并行、嵌套、父先结束、迟到祖先 | 事件夹具 + 真实 ctx.executeTool 嵌套 |
| 7 | simulation transport/script/acceptance 独立；isError=false 的脚本失败 | 事件夹具 + 既有 simulation 回归 |
| 8 | 取消、会话切换、过期回调隔离 | 事件夹具 |
| 9 | 压缩成功/失败、人工等待、首次文本计时 | 事件夹具 |
| 10 | cacheWrite1h/reasoning 子集、未知价格、互斥成本 | 单元 + 云端契约 |
| 11 | owned/foreign roots 和 children 的筛选 | 真实私有 OTel Provider + 内存 exporter |
| 12 | session_shutdown 可复用 SDK，Reload 无污染/重复 Provider | 单元 + 真实 Pi Reload |
| 13 | 脱敏、循环、getter、超大上下文、参数限制 | 单元 |
| 14 | 401/429/503/挂起、队列数/字节上限、有限 Flush | 本地 HTTP OTLP + 挂起 transport |
| 15 | OFF、不支持/异常遥测、TTL watchdog、记录数上限 | 单元 |
| 16 | ON/OFF 延迟、CPU、内存、快照、队列 | 下述独立进程微基准 |

运行时错误隔离测试预期输出一次 `[logos-observability] telemetry error; agent continues`；这是注入故障的成功结果。真实复杂恢复、取消、压缩仍需在实际业务部署补充验收，不能把事件夹具等同于真实远程模型的全覆盖。

## ON/OFF 性能结果

最终独立测量时间 `2026-10-19T09:28:37.313Z`。4 个独立进程，顺序 OFF/ON/ON/OFF，每个4次预热+20次计量；每次278,528字节 prompt，历史随请求累积。真实 Pi 使用本地合成 SSE 模型，成功的内存传输模拟 exporter，每次请求后 Flush，Flush 不计入延迟。测量时已结束本任务其他测试进程；不是隔离机器或生产负载。

| 进程 | 延迟 P50/P95 ms | CPU P50/P95 ms/请求 | RSS P50/采样最大 MiB | Heap P50/采样最大 MiB |
| --- | ---: | ---: | ---: | ---: |
| OFF 1 | 52.58 / 86.75 | 47 / 140 | 205.20 / 257.26 | 79.37 / 98.57 |
| ON 1 | 54.24 / 82.85 | 62 / 125 | 247.45 / 320.94 | 91.37 / 132.88 |
| ON 2 | 51.56 / 93.15 | 47 / 141 | 250.50 / 316.65 | 97.09 / 125.28 |
| OFF 2 | 51.33 / 82.25 | 47 / 156 | 222.30 / 301.23 | 82.43 / 112.76 |

ON 的 SDK 首次初始化128.0 /129.9ms，初始化 RSS 增量20.22 /17.13MiB；OFF 路径没有加载 SDK。ON 队列峰值7条 /94,608字节以内，每进程导出168条、丢弃0、失败0。

独立快照微基准使用10,000条长消息的数组，每进程200次；ON 快照 P50约0.096/0.106ms，P95约0.222/0.261ms。只遍历受限前缀，没有复制完整历史。正文模式、真实压缩频率、宽对象、并发负载都可能改变实际开销。

结果说明有可见内存增量；P50接近，P95存在波动，不能宣称零开销或性能显著改善。每进程仅20样本，此处 nearest-rank 实现的 P95 落在最高样本，置信度有限。CPU 是进程 user+system 时间，不是主机利用率；RSS/Heap 是请求完成时采样，包含 Pi/Node/GC，不是遥测对象独占内存。内存队列成功路径不包括真实网络序列化和传输成本，需另看 OTLP 故障测试和生产监测。

## 部署与剩余边界

V1 域包实现及上述验收完成；实际宿主注入环境变量、VSIX 依赖分发、真实远程 Provider/工程负载验收不在本次修改范围。未接入 Provider 内部 HTTP retry、隐藏压缩 LLM 请求、额外 Token Budget 或其他 Agent 框架。队列满、硬杀或来源缺失可能留下不完整 Trace，已有标记和清理，不能承诺全量无损。

入口 factory 从同步改为 async，以等待可选遥测模块注册；参数未变，真实 Pi domain entry 加载测试已通过。所有处理器仍返回 undefined。具体状态机、事件映射、计时定义、资源限制与成本口径见 observability.md；同事 benchmark 的映射和待补原始证据见 vm002-langfuse-mapping.md。


## 请求链路展示修订与交接

2026-10-19：节点改为用户请求、Agent 执行、循环、模型调用、工具。新增逐层 Input/Output、每条 Activity 的循环与调用计数、Provider 对外暴露的 reasoning 及缺失/脱敏状态。上下文保留 system 前缀与最近历史，并记录原消息 index、截断和省略。

最新合成 Trace：[491904507544f3a1e09295b964a349e2](https://jp.cloud.langfuse.com/project/cmvf0gw8w0001ad0e5g07em2p/traces/491904507544f3a1e09295b964a349e2)。真实 Pi 跑3轮，2次工具执行，共10个 observation；每层 IO 已从云端 API 读回。第2轮上下文包含第1轮 toolResult，工具实参为 density_kg_m3=2700、volume_m3=0.002，返回 mass_kg=5.4，根节点汇总3轮/3次模型/2次工具/0工具错误。浏览器核对了中文树、根请求摘要、工具输入及 content/details。reasoning 是合成 SSE 提供的演示摘要，不是真实远端模型推理或工程求解证明。

完整测试40项通过。新增真实三轮集成、长上下文保留最近结果、reasoning 暴露/缺失/脱敏、metadata 模式无正文泄漏的覆盖。之后用户要求由人工验收，未继续运行自动测试。

最新性能测量时间为 2026-10-19 17:46:54 +08:00（原始 JSON 为 UTC 09:46:54.847Z）；方法与上文相同，4进程独立运行，正文开启，仍为两次模型调用的 SSE 微基准：

| 进程 | 延迟 P50/P95 ms | CPU P50/P95 ms/请求 | RSS P50/采样最大 MiB | Heap P50/采样最大 MiB |
| --- | ---: | ---: | ---: | ---: |
| OFF 1 | 51.56 / 95.46 | 47 / 188 | 222.35 / 295.57 | 80.27 / 112.80 |
| ON 1 | 60.55 / 88.32 | 62 / 172 | 243.93 / 311.11 | 93.68 / 124.14 |
| ON 2 | 56.41 / 85.19 | 62 / 156 | 252.45 / 314.47 | 91.90 / 123.13 |
| OFF 2 | 49.90 / 73.49 | 47 / 140 | 213.64 / 274.76 | 82.02 / 107.45 |

ON 初始化147.01/130.10ms，RSS增量19.57/19.98MiB；队列峰值7条/96,591字节，丢弃与失败为0。新增 contextView + snapshot 微基准在10,000条长消息上 P95 为0.820/0.785ms。内容更丰富带来 P50、CPU 和内存开销；小样本 P95 波动不能作为性能改善结论。统计边界和生产负载限制同上文。

交接基线、同事合入方式及真实仿真机器启动步骤见 observability-handoff.md。业务代码没有改动，真实仿真验收留给使用者。
