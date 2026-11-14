# 结构：钢悬臂梁静力基准

**2026-11-12 真实验证通过。** 使用 ANSYS Mechanical APDL 2026 R1（26.1），BEAM188 一维梁单元、单进程单线程。不是三维实体有限元，也不是 Workbench/Mechanical GUI 建模验收。

## 参数和验收

| 参数 | 数值 |
|---|---:|
| 梁长、宽、高 | 1 m、0.02 m、0.04 m |
| 弹性模量、泊松比 | 210 GPa、0.3 |
| 约束、载荷 | 根部全自由度固支，端部 FZ=-100 N |
| 网格 | 20 个 BEAM188，21 个物理节点及一个方向节点 |
| 分析 | 线弹性小变形，忽略重力，KEYOPT(3)=3 |

矩形截面输入 `SECDATA,0.04,0.02` 与方向节点配合，使全局 Z 弯曲深度为 0.04 m。它是线梁端部合力，不是实体端面载荷。

| 指标 | 真实结果 | 判据 |
|---|---:|---:|
| 端部 UZ | -1.4899330536 mm | Euler–Bernoulli -1.4880952381 mm |
| 位移相对误差 | 0.1235012% | ≤3% |
| 根部 FZ | +99.9999999978 N | +100 N，相对误差≤0.1% |
| 根部 MY | -99.9999999962 N·m | -100 N·m，相对误差≤0.1% |
| 求解器诊断 | 0 warnings、0 errors | 见 [文本输出](results/solve.txt) |

参考使用 `I=bh³/12`、`δ=PL³/(3EI)`；BEAM188 包含剪切变形，因此与 Euler–Bernoulli 约0.12%的差异不能直接归为离散误差。近似 Timoshenko 挠度为1.4899523810 mm（κ=5/6）。18.75 MPa 只是根部名义弯曲应力公式值，**不是本次提取的有限元应力**。未做实体应力或网格收敛验收。

## 离线检查（无需 ANSYS）

Python 3.10+，仅标准库；命令只读证据，输出 JSON 到终端：

```bash
python structure_demo.py results
```

[results.csv](results/results.csv) 是实际导出值；[comparison.json](results/comparison.json) 是原独立复算记录。统一上级校验还会验证[首次错误截面结果](attempts/wrong-section/results.csv)必须失败。首次截面方向/尺寸顺序错误导致约-5.954219 mm挠度，求解器正常退出并不意味着模型正确；保留[首次文本输出](attempts/wrong-section/solve.txt)，没有把该结果当通过。

## 真实重跑（Linux）

需要已安装且有可用许可的 MAPDL（历史验证26.1）、Bash、GNU `timeout`。脚本继承用户现有许可环境，不设置或查询许可证端点，不安装任何包。

```bash
# 将路径替换为自己的安装；若 ansys261 已在 PATH 则无需设置。
export MAPDL_EXECUTABLE=/opt/ansys_inc/v261/ansys/bin/ansys261
bash structure_demo.sh
# 上一步打印全新输出目录。用该目录替换下面的占位符：
python structure_demo.py "NEW_OUTPUT_DIRECTORY"
```

脚本每次创建全新临时目录、单核运行、540秒超时（超时仅作用于本次新进程组），不覆写已有项目。模型输入见 [structure_demo.dat](structure_demo.dat)。自己的新结果目录将包含 `cantilever.rst`、`cantilever.db`、`results.csv`、求解与启动日志，原生二进制可由 ANSYS 打开。

公开包未包含原始 RST/DB：闭源二进制元数据无法充分排除环境标识，原件在维护者私有归档。公开 `.txt` 只去标识环境元数据，未改变科学数值。2026-11-14 仅调整启动路径与许可继承及离线校验只读行为；没有重新运行求解器来声称新验证。
