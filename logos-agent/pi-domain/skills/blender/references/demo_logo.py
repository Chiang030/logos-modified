import bpy, os, math

SLUG   = "demo"
OUTDIR = os.path.abspath("logos/renders") + "/" + SLUG
os.makedirs(OUTDIR, exist_ok=True)

# ---- 清场 ----
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---- 文字 logo ----
bpy.ops.object.text_add(location=(0, 0, 0))
t = bpy.context.active_object
t.data.body = "LOGO"
t.data.align_x = 'CENTER'
t.data.font = bpy.data.fonts.load("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
t.data.size = 1.0
t.data.extrude = 0.25          # 厚度
t.data.bevel_depth = 0.02      # 倒角
t.data.bevel_resolution = 4

mat = bpy.data.materials.new("metal")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.85, 0.55, 0.1, 1)
bsdf.inputs["Metallic"].default_value = 1.0
bsdf.inputs["Roughness"].default_value = 0.25
t.data.materials.append(mat)

# ---- 灯光(三点布光)----
for name, loc, power in [("key", (-3, -4, 4), 400), ("rim", (4, 2, 3), 200), ("fill", (0, -6, 0), 100)]:
    l = bpy.data.lights.new(name, 'AREA'); l.energy = power
    o = bpy.data.objects.new(name, l); o.location = loc
    bpy.context.collection.objects.link(o)

# ---- 相机 ----
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.location = (0, -7.5, 1.2)
bpy.context.collection.objects.link(cam)
bpy.context.scene.camera = cam
con = cam.constraints.new('TRACK_TO')
con.target = t
con.track_axis = 'TRACK_NEGATIVE_Z'   # Python 建约束默认是 TRACK_X,必须显式设为 -Z 相机才朝向目标

# ---- 渲染设置(服务器无 GPU 的铁律:Cycles + CPU,关降噪)----
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.use_denoising = False   # 无 OpenImageDenoise 的构建开降噪会崩
sc.cycles.samples = 128
sc.render.resolution_x, sc.render.resolution_y = 1600, 900

# ① 透明底 PNG
sc.render.film_transparent = True
sc.render.filepath = f"{OUTDIR}/{SLUG}_transparent.png"
bpy.ops.render.render(write_still=True)

# ② 深色背景版
sc.render.film_transparent = False
sc.world = bpy.data.worlds.new("w")
sc.world.use_nodes = True
sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.03, 0.03, 0.035, 1)
sc.render.filepath = f"{OUTDIR}/{SLUG}_bg.png"
bpy.ops.render.render(write_still=True)

# ③ 转圈展示 MP4
empty = bpy.data.objects.new("spin", None)
bpy.context.collection.objects.link(empty)
cam.parent = empty
for f, z in [(1, 0), (49, math.radians(360))]:
    empty.rotation_euler.z = z
    empty.keyframe_insert("rotation_euler", frame=f)
sc.frame_start, sc.frame_end, sc.render.fps = 1, 48, 24
sc.render.image_settings.media_type = 'VIDEO'   # Blender 5.2:视频格式需先切媒体类型,FFMPEG 才出现在 file_format 枚举里
sc.render.image_settings.file_format = 'FFMPEG'
sc.render.ffmpeg.format = 'MPEG4'
sc.render.ffmpeg.codec = 'H264'
sc.render.filepath = f"{OUTDIR}/{SLUG}_turntable.mp4"
bpy.ops.render.render(animation=True)

# ④ GLB 三维资产
bpy.ops.object.select_all(action='DESELECT')
t.select_set(True)
bpy.ops.export_scene.gltf(filepath=f"{OUTDIR}/{SLUG}.glb", export_format='GLB')
print("DONE ->", OUTDIR)
