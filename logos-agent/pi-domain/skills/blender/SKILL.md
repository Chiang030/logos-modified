---
name: blender
description: Use for Blender 3D content and rendering - turn text or SVG logos into 3D (extrude, bevel, metallic materials), render lit stills (transparent PNG, dark-background PNG), turntable MP4 animation, and GLB asset export. Trigger when asked to make a 3D logo, brand-mark render, 3D-ize an SVG/PNG logo, or produce GLB/MP4 output.
---

# Blender
## 当前机器的软件位置

首次使用先读取运行时提供的软件清单；缺失或过期时调用 `software_discover`。使用返回的当前主机绝对路径，不要全盘搜索或把历史部署路径当作本机事实。安装、SDK、许可证和 MCP 连接分别验证；远程任务必须在目标主机探测。


## Scope

Use this skill for 3D visual/brand work in Blender:

- text logos extruded into 3D with bevels and PBR materials;
- converting an existing SVG logo to a 3D Curve object;
- lit still renders: transparent-background PNG and dark-background PNG;
- turntable (orbit) animation rendered to MP4;
- exporting the logo as a GLB asset.

Do not use Blender for mechanical CAD, parametric parts, or assemblies - route
those through the `solidcraft` skill. Do not use it for simulation - use the
`fluent-sim` / `mechanical-sim` / `hfss` skills.

## 环境探测

使用 `software_discover` 返回的 Blender 路径。渲染前核实版本、GPU 和字体；MCP 连接仅在实际配置并连通后使用。

## 两条执行路径

1. **headless 脚本(默认,logo 生成一律走这条)**:写 `logos/scripts/<slug>.py`,
   在项目根执行 `blender -b --python logos/scripts/<slug>.py`。无状态、最稳。
   完整可抄的配方:`logos-agent/pi-domain/skills/blender/references/demo_logo.py`
   (在 `~/projects/1021 test/logos/renders/demo/` 有已验证的产出)。
2. **blender MCP(交互式微调)**:MCP 工具转发到 9876 上的常驻 Blender,用
   `execute_blender_code` 增量改场景、`get_scene_info` 查询、`look` 截取视口。
   改坏了 `systemctl --user restart blender-mcp` 重置成干净场景。详见
   `references/mcp.md`。

## 渲染铁律(headless 无 GPU)

- 引擎只能 `CYCLES` + `scene.cycles.device='CPU'`;**EEVEE 在 headless 无 GPU 时不能渲染,禁止使用**。
- `scene.cycles.use_denoising = False`(无 OpenImageDenoise 的构建开降噪直接报错退出)。
- 透明底:`scene.render.film_transparent = True`。
- shell 命令里路径含空格(如 `1021 test`)必须加引号。

## 制作要点

- 文字:`text_add` + `extrude`(厚度)+ `bevel_depth`(倒角)+ `bevel_resolution`;
  中文/品牌字体先 `bpy.data.fonts.load(绝对路径)`。
- SVG logo:`bpy.ops.preferences.addon_enable(module='io_curve_svg')` 后
  `bpy.ops.import_curve.svg(filepath=...)`;导入的是 Curve,设 extrude/bevel 即立体化;
  SVG 单位大,导入后统一缩放并把 Origin 设到几何中心。
- 材质:Principled BSDF,金属感 = Metallic 1.0 + Roughness 0.2~0.35。
- 布光:三点 AREA 灯 + 深色 World 背景;透明底版另渲一次。
- 相机:TRACK_TO 约束瞄准 logo;转圈动画 = 相机父到 Empty,Empty 绕 Z 轴 0→360°
  打关键帧,FFMPEG/H264 出 MP4。
- 导出 GLB:`bpy.ops.export_scene.gltf(export_format='GLB')`。

## Blender 5.2 API 陷阱(demo 脚本里都已处理)

1. Python 建的 TRACK_TO 约束默认 `track_axis='TRACK_X'`,必须显式设
   `'TRACK_NEGATIVE_Z'`,否则相机朝向错误。
2. 视频输出必须先 `render.image_settings.media_type='VIDEO'` 再
   `file_format='FFMPEG'`(旧写法直接设 FFMPEG 报枚举错误)。
3. `Material.use_nodes` / `World.use_nodes` 有 6.0 弃用警告,5.2 下无害可忽略。

## 输出规范

每个 logo 一个目录 `logos/renders/<slug>/`(相对当前项目根):

- `<slug>_transparent.png` - 透明底静帧
- `<slug>_bg.png` - 深色背景静帧
- `<slug>_turntable.mp4` - 转圈展示动画
- `<slug>.glb` - 三维资产
- `<slug>.py` - 生成脚本复制进目录留档
