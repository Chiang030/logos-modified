---
name: freecad
description: 用 FreeCAD headless(freecadcmd)做 CAD 几何的独立复核与文件级操作:对导出的 STEP 做第二内核交叉验证(体积/包围盒/质量属性/对称差)、体检和修复外来 STEP/IGES/BREP/FCStd/STL 文件、CAD 格式转换、闭合壳转实体。触发条件:网格阶段前需要独立验证几何、外来 CAD 文件损坏/脏/格式不对、需要格式转换、或用户点名 FreeCAD。参数化建模和构型重建走 solidcraft 技能,网格生成走 gmsh 技能,渲染走 blender 技能——本技能不做这些。
---

# FreeCAD

## Scope

用本技能做 CAD 几何的**独立复核**与**文件级操作**:

- SolidCraft/其他工具导出的 STEP 在进入下游(网格、装配、出图)前的**第二意见**复核——生产工具不给自己发合格证;
- 外来 STEP/IGES/BREP/FCStd/STL 文件的体检、修复(ShapeFix)、闭合壳转实体;
- CAD 格式转换(STEP/IGES/BREP/FCStd/STL 互转,headless 可复现);
- 用户点名 FreeCAD 的任务。

**不做**:参数化建模与构型重建(`solidcraft`)、网格生成(`gmsh`)、渲染与 3D logo(`blender`)。本技能是几何管线的质检员和搬运工,不是建模工具;与 solidcraft 技能里 checking 参考提到的"独立 oracle"思路一致,这里是落地实现。

## 环境(2026-10-21 在本服务器实测)

| 项 | 值 |
|---|---|
| FreeCAD 版本 | 1.1.4(build 20260928,git 4fd3bf32),AppImage 解包于 `~/.local/opt/freecad-1.1.4/squashfs-root/` |
| headless 入口 | `~/.local/bin/freecadcmd`(本技能只用它;`~/.local/bin/freecad` GUI 需桌面会话) |
| 脚本参数 | `sys.argv[2:]` 透传(`argv[0]`=freecadcmd,`argv[1]`=脚本) |
| 脚本 | 本目录 `scripts/inspect_cad.py`、`scripts/compare_step.py`、`scripts/heal_convert.py` |

验证命令:

```bash
command -v freecadcmd && freecadcmd --version
freecadcmd <技能目录>/scripts/inspect_cad.py <任意.step>
```

## freecadcmd 的坑(脚本已内置规避,手写脚本时同样适用)

1. **`Part.Shape.Volume` / `.Area` / `.BoundBox` 是属性不是方法**——不带括号;`isValid()` 则是方法。类型错会抛 `'float' object is not callable`。
2. **`sys.exit()` 前必须 `sys.stdout.flush()`**,否则缓冲输出被整体丢弃(退出码在、输出没了)。
3. **freecadcmd 自己的 CLI 解析器会拦截 `--` 开头的参数**(打印它自己的帮助并退出)。传给脚本的选项用无横线的位置词(本技能脚本用 `heal`、`norefine`),不要用 `--flag`。
4. **未捕获异常会被吞**:freecadcmd 打印 `Exception while processing file` 后继续把 argv 里后续条目当文件打开,且退出码为 0。脚本必须自己捕获异常、flush 后用非零码退出(三个脚本都带了兜底)。
5. **修复 API 是 FreeCAD 包装的 snake_case**:`Part.ShapeFix.Shape(shape)` → `fixer.perform()` → `fixer.shape()`;不是 OCC 原生的 `ShapeFix_Shape`/`Perform`/`Shape`,也不存在顶层 `import ShapeFix`。
6. **`Part.read` STL 得到闭合壳(solids=0)**,布尔运算前要用 `Part.Solid(shell)` 包成实体;`heal_convert.py` 已自动做。网格化体积有细分误差,测试件往返约 0.004%,对比容差要留出这个量级(≥0.05% 稳妥)。

## 脚本用法

所有脚本从技能目录按绝对路径调用,工作目录任意;退出码 0=成功,1=失败,2=用法错误;输出有 `SUMMARY:`/`VERDICT:`/`STATUS:` 行可 grep。

```bash
# 体检:实体数/体积/面积/包围盒/质心/有效性,多文件可一起
freecadcmd scripts/inspect_cad.py part.step [another.fcstd ...]

# 独立复核:对称差体积与位置,默认容差 0.1%(第三个参数可改,如 0.0005=0.05%)
freecadcmd scripts/compare_step.py actual.step expected.step [rel_tol]

# 修复+转换:heal 强制修复(默认仅无效几何时修);norefine 保留面结构(默认合并共面)
freecadcmd scripts/heal_convert.py input.step output.stl [heal] [norefine]
```

### 典型流程

**SolidCraft 出口复核**(几何阶段 → 网格阶段的验收步骤):

```bash
freecadcmd scripts/inspect_cad.py exports/bracket.step      # 体检,必须 PASS
freecadcmd scripts/compare_step.py exports/bracket.step design/reference.step   # 与参考构型对比
```

**外来脏文件处理**:`inspect_cad.py` 体检 → 无效则 `heal_convert.py in.step clean.step heal` 修复(看体积保持率,明显小于 100% 说明修复吃了几何)→ 需要网格/布尔时确认输出 `solids=1`。

## 已验证行为(2026-10-21,60×40×10 带孔板测试件)

- inspect:1 solid/7 faces/21989.381 mm³ 与手算一致;缺文件报 FAIL 退 1。
- compare:同一文件 0.0000% PASS;r8 与 r9 孔对称差 534.071 mm³ = 2.4288% FAIL,差异包围盒精确落在孔周;非实体输入给明确 FAIL。
- heal_convert:STEP→STL→STEP 往返体积保持 100%(细分误差 0.0038%);STL 闭合壳自动转实体。
- 10 项回归全部通过,退出码全部正确。
