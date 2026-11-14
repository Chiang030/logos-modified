import { useEffect, useRef, useState, type ReactElement, type PointerEvent } from "react";
import "./ImageAttachments.css";

export interface DraftImage { type: "image"; data: string; mimeType: string; }
export async function readImageFile(file: File): Promise<DraftImage> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 4 * 1024 * 1024) throw new Error("请选择不超过 4 MiB 的 PNG、JPEG 或 WebP 图片");
  const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("无法读取图片")); reader.readAsDataURL(file); });
  const image = await loadImage({ type: "image", data, mimeType: file.type });
  if (image.width * image.height > 24_000_000) throw new Error("图片不能超过 2400 万像素，请先缩小");
  return { type: "image", data, mimeType: file.type };
}
function loadImage(image: DraftImage): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const node = new Image(); node.onload = () => resolve(node); node.onerror = () => reject(new Error("无法解码图片")); node.src = `data:${image.mimeType};base64,${image.data}`; });
}
export function ImageAttachments({ images, disabled, onChange, onFiles }: { images: DraftImage[]; disabled: boolean; onChange: (images: DraftImage[]) => void; onFiles: (files: File[]) => void }): ReactElement {
  const [editing, setEditing] = useState<number>();
  return <div className="logos-images"><label><input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled} onChange={event => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />添加视觉附件</label><small>Ctrl+V 粘贴图片 · 发送给模型看图；文件面板“上传”仅保存项目文件。</small><div className="logos-image-list">{images.map((image, index) => <div key={index}><img src={`data:${image.mimeType};base64,${image.data}`} alt={`待发送图片 ${index + 1}`} /><button disabled={disabled} onClick={() => setEditing(index)} type="button">编辑</button><button disabled={disabled} onClick={() => onChange(images.filter((_, i) => i !== index))} type="button" aria-label={`移除图片 ${index + 1}`}>移除</button></div>)}</div>{editing !== undefined && images[editing] ? <ImageEditor image={images[editing]} onCancel={() => setEditing(undefined)} onSave={image => { onChange(images.map((old, index) => index === editing ? image : old)); setEditing(undefined); }} /> : null}</div>;
}
function ImageEditor({ image, onCancel, onSave }: { image: DraftImage; onCancel: () => void; onSave: (image: DraftImage) => void }): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  const start = useRef<{x:number;y:number} | undefined>(undefined);
  const pointer = useRef<number | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"draw" | "crop">("draw");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void loadImage(image).then(source => {
      const node = canvas.current;
      if (cancelled || !node) return;
      node.width = source.width; node.height = source.height;
      node.getContext("2d")!.drawImage(source, 0, 0); setReady(true);
    }).catch(() => { if (!cancelled) setError("图片加载失败"); });
    return () => { cancelled = true; start.current = undefined; pointer.current = undefined; };
  }, [image]);
  const point = (event: PointerEvent<HTMLCanvasElement>): {x:number;y:number} => { const bounds = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(event.currentTarget.width, (event.clientX - bounds.left) * event.currentTarget.width / bounds.width)), y: Math.max(0, Math.min(event.currentTarget.height, (event.clientY - bounds.top) * event.currentTarget.height / bounds.height)) }; };
  const rotate = (): void => { const node = canvas.current!; const copy = document.createElement("canvas"); copy.width = node.width; copy.height = node.height; copy.getContext("2d")!.drawImage(node, 0, 0); node.width = copy.height; node.height = copy.width; const context = node.getContext("2d")!; context.translate(node.width, 0); context.rotate(Math.PI / 2); context.drawImage(copy, 0, 0); context.resetTransform(); };
  return <div className="logos-image-editor" role="dialog" aria-label="编辑视觉附件"><p>标注：拖动画线；裁剪：从左上拖到右下，松开应用。取消不修改原图。</p><button type="button" disabled={!ready} onClick={() => setMode("draw")}>红笔标注</button><button type="button" disabled={!ready} onClick={() => setMode("crop")}>矩形裁剪</button><button type="button" disabled={!ready} onClick={rotate}>旋转 90°</button><canvas ref={canvas} onPointerDown={event => { if (!ready || !event.isPrimary || event.button !== 0 || pointer.current !== undefined) return; pointer.current = event.pointerId; start.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!ready || pointer.current !== event.pointerId || !start.current || mode !== "draw") return; const next = point(event), context = event.currentTarget.getContext("2d")!; context.strokeStyle = "#ff3030"; context.lineWidth = Math.max(3, event.currentTarget.width / 300); context.beginPath(); context.moveTo(start.current.x, start.current.y); context.lineTo(next.x, next.y); context.stroke(); start.current = next; }} onPointerUp={event => { if (pointer.current !== event.pointerId) return; pointer.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); const first = start.current; start.current = undefined; if (!first || mode !== "crop") return; const last = point(event), node = event.currentTarget; const x = Math.max(0, Math.min(first.x, last.x)), y = Math.max(0, Math.min(first.y, last.y)); const width = Math.floor(Math.min(node.width - x, Math.abs(last.x - first.x))), height = Math.floor(Math.min(node.height - y, Math.abs(last.y - first.y))); if (width < 2 || height < 2) return; const pixels = node.getContext("2d")!.getImageData(x, y, width, height); node.width = width; node.height = height; node.getContext("2d")!.putImageData(pixels, 0, 0); }} onLostPointerCapture={() => { start.current = undefined; pointer.current = undefined; }} onPointerCancel={() => { start.current = undefined; pointer.current = undefined; }} /><p role="alert">{error}</p><button type="button" onClick={onCancel}>取消</button><button type="button" disabled={!ready} onClick={() => { const data = canvas.current!.toDataURL("image/png").split(",")[1]; if (data.length > Math.ceil(4 * 1024 * 1024 / 3) * 4) { setError("编辑后超过 4 MiB，请进一步裁剪或取消"); return; } onSave({ type: "image", mimeType: "image/png", data }); }}>应用编辑</button></div>;
}
