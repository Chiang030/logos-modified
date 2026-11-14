import { useEffect, useRef, useState, type ReactElement } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { disposeModel, loadModel, stlModel } from "./model-scene";

function prepareModel(object: THREE.Object3D): THREE.Group {
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object), size = bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(extent) || extent <= 0) throw new Error("模型为空或几何尺寸无效");
  const group = new THREE.Group();
  group.add(object); group.scale.setScalar(2 / extent);
  group.position.copy(bounds.getCenter(new THREE.Vector3())).multiplyScalar(-2 / extent);
  group.updateMatrixWorld(true);
  return group;
}

export default function ModelPreview({ path, project, stl }: { path: string; project: string; stl?: ArrayBuffer }): ReactElement {
  const host = useRef<HTMLDivElement>(null), reset = useRef<() => void>(() => undefined);
  const [status, setStatus] = useState("正在读取 3D 模型…"), [error, setError] = useState("");
  const [ready, setReady] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const controller = new AbortController(), urls: string[] = [];
    let current = true, object: THREE.Object3D | undefined, renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined, observer: ResizeObserver | undefined;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b1522);
    setError(""); setReady(false); setStatus("正在读取 3D 模型…");
    const lost = (event: Event): void => { event.preventDefault(); if (current) { setReady(false); setError("3D 显示已中断，请重试或下载查看。"); } };
    async function show(): Promise<void> {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.domElement.setAttribute("aria-label", "3D 模型：" + path);
      renderer.domElement.addEventListener("webglcontextlost", lost);
      container!.append(renderer.domElement);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.minDistance = 0.1; controls.maxDistance = 30;
      const render = (): void => { if (current) renderer!.render(scene, camera); };
      controls.addEventListener("change", render);
      reset.current = () => {
        const distance = 1.8 / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(camera.aspect, 1);
        camera.position.set(1, 0.7, 1).normalize().multiplyScalar(Math.min(distance, 25));
        controls!.target.set(0, 0, 0); controls!.update(); render();
      };
      observer = new ResizeObserver(() => {
        if (!current) return;
        const width = Math.max(container!.clientWidth, 1), height = Math.max(container!.clientHeight, 1);
        renderer!.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); render();
      });
      observer.observe(container!);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 3));
      const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(3, 5, 4); scene.add(light);
      object = stl ? stlModel(stl) : await loadModel(path, project, controller.signal, urls);
      if (!current) { disposeModel(object); object = undefined; return; }
      scene.add(prepareModel(object));
      camera.aspect = Math.max(container!.clientWidth, 1) / Math.max(container!.clientHeight, 1); camera.updateProjectionMatrix();
      reset.current(); setStatus(""); setReady(true);
    }
    void show().catch(cause => {
      if (current) { setStatus(""); setError("无法预览模型：" + (cause instanceof Error ? cause.message : "读取失败") + "。请确认文件及附属文件完整，压缩模型请导出为未压缩 GLB；浏览器需支持 WebGL。"); }
    }).finally(() => { for (const url of urls) URL.revokeObjectURL(url); urls.length = 0; });
    return () => {
      current = false; controller.abort(); observer?.disconnect(); controls?.dispose(); reset.current = () => undefined;
      if (object) { disposeModel(object); object = undefined; }
      renderer?.domElement.removeEventListener("webglcontextlost", lost);
      renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
      for (const url of urls) URL.revokeObjectURL(url); urls.length = 0;
    };
  }, [path, project, attempt, stl]);
  return <div className="model-preview">
    <div className="model-actions"><span>3D 预览</span><button disabled={!ready} onClick={() => reset.current()}>复位视角</button></div>
    <div className="model-viewport" ref={host}>{status && !error ? <div className="model-status" role="status">{status}</div> : null}{error ? <div className="model-status" role="alert">{error}<button onClick={() => setAttempt(value => value + 1)}>重试</button></div> : null}</div>
    <div className="preview-hint">拖动旋转 · 滚轮缩放 · 右键拖动平移 · 触屏双指缩放{ /\.obj$/i.test(path) ? "。OBJ 仅显示几何；保留材质请导出为 GLB。" : "。"}</div>
  </div>;
}
