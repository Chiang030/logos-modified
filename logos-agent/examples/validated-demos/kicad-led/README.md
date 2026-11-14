# KiCad：5V 电阻与 LED 小板

**2026-11-12 在 KiCad 10.0.7 完成真实闭环**：标准符号原理图 → ERC → XML网表 → PCB一致性/DRC → Gerber、钻孔和板体STEP导出。不是 SPICE、电路实测或量产认证。

## 电路与结果

30×20 mm双层演示板；外部5V输入、330 Ω电阻、红色LED，3个器件、6个通孔焊盘、3个网络、0.5 mm铜线。假设LED压降2V时电流约9.09 mA、电阻功耗0.0273 W，二者是设计估算而非实测。

| 网络 | 应连接引脚 |
|---|---|
| +5V | J1.1 ↔ R1.1 |
| LED_A | R1.2 ↔ D1.2（A） |
| GND | D1.1（K） ↔ J1.2 |

使用 KiCad 标准 `Connector_Generic:Conn_01x02`、`Device:R`、`Device:LED`；**LED标准脚号为1=K、2=A**。最终实际报告：ERC 0 violations；DRC 0 violations、0 unconnected、0 schematic parity issues。导出完整Gerber集、Excellon钻孔和STEP板体成功。

成功文件集中在 [results](results/)：可打开 [led.kicad_sch](results/led.kicad_sch)、[led.kicad_pcb](results/led.kicad_pcb)；查看 [erc.json](results/erc.json)、[drc-parity.json](results/drc-parity.json)、[网表](results/led.xml)、[板体STEP](results/led.step)、Gerber及钻孔。项目局部 `sym-lib-table` 使用普通Linux系统符号安装目录；在别的平台应按自己的KiCad库位置调整，而不是修改全局配置。

## 离线检查（无需 KiCad）

Python 3.10+，仅标准库，不写入原始材料：

```bash
python check_kicad_full.py results
```

检查真实ERC/DRC报告、三个网络的精确节点和LED标准极性。上级统一校验还确认早期ERC/parity报告确实含失败项，不把失败尝试当完成。

## 真实重跑（Linux）

需要现有KiCad CLI、标准符号库，以及能导入 `pcbnew` 的Python。通常Linux系统Python自带该模块，独立虚拟环境不一定可用。不自动安装依赖。

```bash
# 按自己的安装指定；命令可执行且库确实存在后再运行。
export KICAD_CLI=kicad-cli
export KICAD_PYTHON=python3
export KICAD_SYMBOL_DIR=/usr/share/kicad/symbols
bash run_kicad.sh
```

脚本创建全新输出目录，依次执行生成、ERC、网表、parity/DRC、Gerber/钻孔/STEP和离线核对，任何失败立即退出。它不覆写本仓库证据，也不改全局KiCad配置。

1. `kicad_led.py NEW_INTERMEDIATE_DIRECTORY` 生成历史中间板（中间LED曾采用1=A、2=K约定）。
2. `kicad_full.py NEW_FINAL_DIRECTORY INTERMEDIATE_PCB --symbols SYMBOL_DIRECTORY` **只对该中间板做一次脚号映射**，生成标准1=K、2=A原理图和匹配PCB。不要把已是最终编号的 `results/led.kicad_pcb` 当中间输入再次交换。
3. 在新最终目录执行 `kicad-cli sch erc --format json --exit-code-violations`、`sch export netlist --format kicadxml`、`pcb drc --schematic-parity --format json --exit-code-violations`，其余完整参数见 [run_kicad.sh](run_kicad.sh)。

2026-11-14 的路径参数/输出保护整理和封装脚本尚未重新运行 KiCad；历史证据来自2026-11-12实际逐步执行成功，不能把离线校验冒充一次新导出。

## 不隐瞒失败与边界

- 首版缺项目库表，产生3条ERC warning；修复项目局部表后通过，[原失败报告](attempts/erc-first.json)保留。
- 另一版PCB/原理图的网络路径命名不一致，产生6条parity warning；统一为`/+5V`、`/LED_A`、`/GND`后通过，[原报告](attempts/drc-parity.json)保留。
- PCB使用自定义演示封装，未含庭院、量产库Footprint属性或器件3D模型；默认忽略项仍含missing_courtyard、footprint_filter等。未关闭额外规则，但0错误不能证明所有制造约束满足。
- STEP只有板体，不是LED/电阻装配；三个器件都是被动脚，供电来自外接连接器，未靠伪PWR_FLAG掩盖power_input错误。
- XML网表源文档绝对路径已去标识，电气内容不变；其他科学/制造产物不作拟合修改。缓存标准符号来自用户已有KiCad库，完整第三方库不随仓库分发。
