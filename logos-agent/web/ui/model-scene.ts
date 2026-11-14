import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { gltfDocument, modelFile, modelResources } from "./model-assets.ts";

/** Release GPU resources, including image bitmaps created by glTF textures. */
export function disposeModel(object: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  object.traverse(child => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
    if (child instanceof THREE.SkinnedMesh) child.skeleton.dispose();
  });
  for (const texture of textures) {
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) texture.image.close();
    texture.dispose();
  }
}

function geometryModel(geometry: THREE.BufferGeometry, points = false): THREE.Object3D {
  if (!geometry.getAttribute("position")?.count) { geometry.dispose(); throw new Error("模型没有可显示的几何数据"); }
  if (points) return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x8bcbe5, size: 0.012, vertexColors: geometry.hasAttribute("color") }));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8bcbe5, roughness: 0.7, side: THREE.DoubleSide, vertexColors: geometry.hasAttribute("color") }));
}

export function stlModel(data: ArrayBuffer): THREE.Object3D {
  return geometryModel(new STLLoader().parse(data));
}

/** Load geometry locally; glTF sidecars are resolved only through the project file API. */
export async function loadModel(path: string, project: string, signal: AbortSignal, urls: string[]): Promise<THREE.Object3D> {
  const budget = { bytes: 0 }, data = await modelFile(path, project, signal, budget);
  signal.throwIfAborted();
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "stl") return geometryModel(new STLLoader().parse(data));
  if (extension === "ply") {
    const geometry = new PLYLoader().parse(data);
    return geometryModel(geometry, !geometry.index?.count);
  }
  if (extension === "obj") return new OBJLoader().parse(new TextDecoder().decode(data));
  const document = gltfDocument(data, extension === "glb");
  const resources = await modelResources(document, path, project, signal, budget, urls);
  signal.throwIfAborted();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(uri => {
    if (uri.startsWith("blob:")) return uri; // Embedded GLB images are created by GLTFLoader.
    const resolved = resources.get(uri);
    if (!resolved) throw new Error("模型引用了未声明的附属文件");
    return resolved;
  });
  const loader = new GLTFLoader(manager);
  const abort = (): void => { manager.abort(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await loader.parseAsync(extension === "glb" ? data : new TextDecoder().decode(data), "");
    return result.scene;
  } finally { signal.removeEventListener("abort", abort); }
}
