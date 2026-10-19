# VM002 benchmark 与 Pi Trace 的映射

## 结论与证据边界

已静态检查 `logos-vm002-benchmark-20261019.zip`，未执行其中脚本，也未上传工程数据。包内有示例指标、报告、评测脚本、版本文件哈希；没有完整 RPC 事件流、逐条 Assistant Message 或求解器原始数据库。因此它能提供 **Trace 的评测摘要和 Scores**，不能单凭摘要准确重建 30 次模型调用和 34 次工具调用的时间树。

Langfuse Project 是存放 Trace、Scores 和访问密钥的空间；benchmark 是可关联到其中某次 Trace 的测试任务，两者不同。

本次运行：`run_id=20261019-vm002-eff59c04`，`case_id=S01_VM002`，Pi session ID 为 `01a152f1-c91a-73d7-97cc-758552f66813`。一段 Session 可能包含多条 Activity Trace，不能只凭 session ID 认定唯一 traceId。优先以 run_id、session ID、运行时间共同核对，并在未来 benchmark 启动时持久保存实际 traceId。

## 建议映射

| 包中数据 | Langfuse 位置 | 限制 |
| --- | --- | --- |
| run_id、case_id、repetition、track、版本哈希 | Root metadata 的 benchmark 命名空间 | 文件哈希不是完整 build commit |
| agent_wall_seconds = 385.1953 | benchmark.agentWallSeconds | 没有绝对起止锚点时，不伪造 Span 时间 |
| assistant_turns = 30；tool_count = 34；tool_error_count = 3 | Root metadata 摘要 | 摘要不生成虚构子 Span |
| 逐条 final Assistant Message Usage（需要补充） | 对应 Generation usageDetails/costDetails | 不按 turn 数平均分摊总量 |
| tool_details：read 5、bash 19、write 8、edit 2 | 工具统计 metadata | 缺 toolCallId、parentToolCallId、逐条起止时间，不能恢复并发与嵌套 |
| 原始 gates 与校准后 gates | 两组带版本的 BOOLEAN Scores | 必须保留两次判定，不覆盖原始失败 |
| 位移、应力、反力、能量相对误差；网格/重放误差 | NUMERIC Scores | 保留 variant、单位、参考值、容差和评测器版本 |
| verdict、leaderboard_eligible、calibration | CATEGORICAL / BOOLEAN Scores 与 metadata | 排行资格必须显示为 false |
| physics_repair_count = 2、错误分类 | 人工审核来源的 Scores/metadata | 脚本内人工整理值，不能标成自动追踪推导 |
| 采样进程树 RSS = 710.140625 MiB | benchmark 资源指标 | 0.5 秒采样，共享页可重复，可能漏峰；不是 OTel 进程瞬时内存 |

评测器是在 Agent 执行之外评价工程质量。未来应通过 traceId 关联 Scores；不把事后审核伪装成 Agent 工具，也不修改 simulation 原始 `acceptance`。本次工具是 bash/read/write/edit，无法据此制造 simulation 工具 Span 或其 `result.details`。

## Token 与费用核对

包内两份汇总（session_statistics、event_usage_sum）一致：

| 互斥分类 | Token |
| --- | ---: |
| 普通输入 | 48,605 |
| 缓存读取 | 760,704 |
| 缓存写入 | 0 |
| 输出（含 reasoning） | 15,932 |
| 合计 | 825,241 |

reasoning = 3,344 是输出子集，仅记 metadata，不能再加到合计。费用 `$0.3326004` 是运行时价格表估算，`actual_billed_cost_usd=null`。按包内基础价格可复核为普通输入 `$0.09721` + 缓存读取 `$0.0760704` + 输出 `$0.15932`；这不等于验证了供应商账单或每次调用的阶梯定价。

在只有汇总的情况下，将这些数放在 `benchmark.usageSummary` / `benchmark.estimatedCostUsd` metadata，不创建一条总量 Generation，也不向每条 Generation 重复写入总量。以后补齐原始调用明细时，只有逐条 Generation 参与 Langfuse Usage/Cost 汇总；摘要用于对账。

## 时间与判定注意事项

- `first_visible_text_seconds_from_process_start=3.654688853` 包含启动和请求前时间，不能作为模型 TTFT。Generation TTFT 需要请求开始和首次文本事件。
- 工具时长之和 `14.356806073s` 可能存在并发或嵌套，不可用总墙钟减它来声称得到模型计算耗时。
- 原始 gates 为 10/11，通过事后评测器校准变为 11/11。报告解释为初始能量参考漏计 BEAM188 剪切能；阈值未变。准确结论是 `PASS_AFTER_EVALUATOR_CALIBRATION`，不是首次无条件通过。
- `first_model_attempt_passed=false`，单案例、单次运行不能给出总体成功率或跨运行稳定性结论。

## 需要同事补充的原始证据

请提供同一 run 的：

1. `collected/evidence/events.jsonl`：逐条 RPC 事件、elapsed_s、工具 ID、时间顺序。
2. `get_messages.json`：最终 Assistant Message Usage、内容、工具调用关系。
3. `run-summary.json`：进程及 Agent 起止点、退出状态，以及可靠的绝对开始时间。
4. 建议一并提供 `get_state.json`、`get_session_stats.json` 和原始 Session JSONL。

控制器的 `{elapsed_s, record}` 使用进程起点的单调时钟偏移；必须获得同一时钟对应的绝对时间锚点，不能凭 ZIP 日期或 session 文件名猜测。即使补齐文件，也要检查事件完整性、最终消息去重和时间锚点后再决定可还原范围。

历史 RPC 导入若后续实施，应为独立适配器，标记 `source=benchmark_rpc_import`、原始 run_id、证据哈希、导入版本与完整性，以稳定 ID 保证重跑幂等。不将 RPC 专有事件注册为 `pi.on()` Hook，也不改变当前 Pi Extension 的实时链路。本次只提供映射分析，没有实施历史导入或 Scores 上传。
