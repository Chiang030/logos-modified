import { HttpError } from "./errors.ts";

export interface ImageAttachment { type: "image"; data: string; mimeType: string; }
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;

/** Accept inline raster images only; never fetch URLs or resolve user paths. */
export function validateImages(value: unknown): ImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new HttpError(400, "每次最多发送 4 张视觉附件");
  let total = 0;
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "图片附件无效");
    const image = item as Record<string, unknown>;
    if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string" || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new HttpError(400, "图片必须是有效的 base64，单张不超过 4 MiB");
    const bytes = Buffer.from(image.data, "base64");
    total += bytes.length;
    if (bytes.toString("base64") !== image.data || !bytes.length || bytes.length > MAX_IMAGE_BYTES || total > MAX_TOTAL_IMAGE_BYTES) throw new HttpError(400, "图片总大小不能超过 8 MiB");
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
    if (!mime || image.mimeType !== mime) throw new HttpError(400, "仅支持内容与类型一致的 PNG、JPEG、WebP 图片");
    return { type: "image", data: bytes.toString("base64"), mimeType: mime };
  });
}
