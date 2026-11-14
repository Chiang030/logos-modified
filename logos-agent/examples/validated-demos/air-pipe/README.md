# 气动：低速空气轴对称管流

**2026-11-12 完成真实 Fluent 2026 R1（26.1）求解和双网格检查**，PyFluent 0.38.1。二维轴对称、单核双精度、稳态不可压缩层流；这是低马赫内部空气流动，不是翼型升阻或湍流验证。

## 参数

圆管长度1 m、直径0.01 m；空气密度1.225 kg/m³、动力黏度1.7894×10⁻⁵ Pa·s；均匀入口0.1 m/s、出口表压0 Pa、无滑移壁面、轴线半径0。Re=68.4587，Ma≈0.000292。脚本直接生成结构化 Fluent ASCII 网格，不依赖 Gmsh Python 包。

求解设置为 pressure-based coupled、least-square-cell-based 梯度、二阶压力/二阶迎风动量。连续性与两方向速度绝对残差阈值均1e-8。取 x=0.2–0.8 m 发展段静压梯度，避免将均匀入口附加压损误当作充分发展压损。

| 指标 | 粗网格 strict | 稳定细网格 fine-stable |
|---|---:|---:|
| 网格 | 160×24=3840 cells | 320×48=15360 cells |
| 伪时间尺度因子 | 默认1.0 | 0.1 |
| 收敛迭代 | 56 | 160 |
| 最终连续性残差 | 8.1211e-9 | 9.9460e-9 |
| 压降梯度 Pa/m | 0.5716160352 | 0.5723596408 |
| 对解析0.572608 Pa/m误差 | 0.1732363% | 0.0433733% |
| 相对质量不平衡 | 1.6262e-11 | 1.7978e-10 |

验收：压降误差≤2%，质量不平衡≤0.1%，残差≤1e-8，双网格梯度相对差≤1%。两档结果差为 **0.1299193%**（细网格分母）。只有两档网格，不宣称 GCI 或完整离散不确定度分析。

## 离线复核

Python 3.10+，仅标准库，不安装 PyFluent 也能读保留报告：

```bash
python check_cfd_reports.py results/strict/reports.json
python check_cfd_reports.py results/fine-stable/reports.json
# 下面是负例，预期退出码为1；不能当作成功：
python check_cfd_reports.py attempts/fine-failed/reports.json
```

各成功目录含实际 `reports.json`、ASCII `pipe.msh` 和去标识化 `run.txt`。上级 `verify_demo_evidence.py` 同时检查数值、文本末次残差、双网格差及失败负例。

## 真实重跑（Linux）

需要已安装 Fluent、PyFluent（历史0.38.1）和用户自己的可用许可。脚本不安装包、不配置许可证、不操作别的会话。`--fluent` 优先于环境变量 `FLUENT_EXECUTABLE`，未提供则查找 PATH 中的 `fluent`。

```bash
# 输出目录必须尚不存在；软件路径按自己的安装调整。
python fluent_air_pipe.py NEW_COARSE_DIRECTORY 160 24 --fluent /opt/ansys_inc/v261/fluent/bin/fluent
python check_cfd_reports.py NEW_COARSE_DIRECTORY/reports.json
python fluent_air_pipe.py NEW_FINE_DIRECTORY 320 48 0.1 --fluent /opt/ansys_inc/v261/fluent/bin/fluent
python check_cfd_reports.py NEW_FINE_DIRECTORY/reports.json
```

两次应顺序运行、事先确认许可与资源。脚本单核、每次600秒限时、最多600迭代并退出自己的会话；仅在全新目录写入mesh/report/case/data，拒绝覆盖已有目录。网格大小另有演示级上限。执行退出0只表示脚本运行完，应另执行物理校验并核对残差。

## 保留的失败与修复依据

第一次320×48细网格使用默认因子1.0，出现反流和振荡，600次后连续性残差1.6358，压降误差198.964%、质量不平衡22.4904%。[失败报告](attempts/fine-failed/reports.json)和[失败文本](attempts/fine-failed/run.txt)保留。

查看实际安装版本的设置接口后，将 `solution.run_calculation.pseudo_time_settings.time_step_method.time_step_size_scale_factor` 从1.0降至0.1，保持几何、物性、细网格与离散格式不变；自动/conservative设置的before/after可在[稳定细网格文本](results/fine-stable/run.txt)复核，随后才取得收敛结果。没有改写失败产物或把未收敛报告当作可信结果。

Fluent HDF5 case/data 内含历史路径，因此公开仓库不附原生二进制；原件完整保留在维护者私有归档，自己重跑会生成可在 Fluent 打开的对应文件。文本仅去标识环境元数据。2026-11-14 做了可移植路径、参数及禁止覆写保护，未再次求解；不把历史独立 PyFluent 验证当成每个部署环境已由网页智能体完整执行。
