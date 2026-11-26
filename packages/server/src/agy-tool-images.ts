import { createRequire } from "node:module";
import { Type } from "typebox";
import type { CallToolResult, Tool } from "./pi-adapter/mcp-protocol.ts";

// Reuse the SDK's locked WASM codec; no native command or external dependency.
const codec = () => createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("@silvia-odwyer/photon-node") as typeof import("@silvia-odwyer/photon-node");
const TARGET_BYTES = 9_000; // decoded preview bytes; empirical target, not an AGY protocol limit
export const AGY_IMAGE_PROVIDER = "antigravity";
type Image = { type: "image"; data: string; mimeType: string };
export type ImageRegion = { x: number; y: number; width: number; height: number };

/** Only AGY advertises the crop option, including after an in-place model switch. */
export function agyImageToolSchema(tool: Tool): Tool {
 if (tool.name !== "look_at_image") return tool;
 const region = Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }, { description: "一张原图的像素区域，用于看清缩小总览中的细节" });
 const properties = tool.inputSchema.properties;
 const paths = Type.Array(Type.String(), { minItems: 1, maxItems: 1, description: "每次只读一张；要看多张请分别读取" });
 return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...(properties && typeof properties === "object" ? properties : {}), paths, region } } };
}

/** Crop from original encoded pixels, never from the preview. */
export function cropAgyImage(input: Omit<Image, "type">, region: ImageRegion): Image {
 const { x, y, width, height } = region;
 if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1) throw new Error("局部坐标必须是有效的原图像素范围");
 const p = codec();
 const original = p.PhotonImage.new_from_byteslice(Buffer.from(input.data, "base64"));
 try {
  if (x + width > original.get_width() || y + height > original.get_height()) throw new Error("局部坐标超出原图");
  const crop = p.crop(original, x, y, x + width, y + height);
  try { return { type: "image", mimeType: "image/png", data: Buffer.from(crop.get_bytes()).toString("base64") }; }
  finally { crop.free(); }
 } finally { original.free(); }
}

function preview(block: Image) {
 const p = codec();
 const original = p.PhotonImage.new_from_byteslice(Buffer.from(block.data, "base64"));
 try {
  const ow = original.get_width(), oh = original.get_height();
  const pixels = original.get_raw_pixels();
  let hasTransparency = false;
  for (let i = 3; i < pixels.length; i += 4) {
   if (pixels[i] !== 255) { hasTransparency = true; break; }
  }
  let scale = Math.min(1, 720 / Math.max(ow, oh));
  for (let i = 0; i < 9; i++, scale *= 0.75) {
   const w = Math.max(1, Math.round(ow * scale)), h = Math.max(1, Math.round(oh * scale));
   const resized = p.resize(original, w, h, p.SamplingFilter.Lanczos3);
   try {
    const png = resized.get_bytes();
    const encodings = [[png, "image/png"]] as [Uint8Array, string][];
    if (!hasTransparency && png.byteLength > TARGET_BYTES) encodings.push([resized.get_bytes_jpeg(82), "image/jpeg"], [resized.get_bytes_jpeg(65), "image/jpeg"]);
    for (const [bytes, mimeType] of encodings) {
     if (bytes.byteLength <= TARGET_BYTES) return { image: { type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType }, ow, oh, w, h };
    }
   } finally { resized.free(); }
  }
  return null;
 } finally { original.free(); }
}

/** One MCP reply; each original maps to one image block in the same order. */
export function adaptAgyToolImages(result: CallToolResult, tool?: string): CallToolResult {
 if (result.isError || !result.content.some(b => b.type === "image" && Buffer.byteLength(b.data, "base64") > TARGET_BYTES)) return result;
 const content: CallToolResult["content"] = [];
 let index = 0;
 for (const block of result.content) {
  if (block.type !== "image") { content.push(block); continue; }
  index++;
  if (Buffer.byteLength(block.data, "base64") <= TARGET_BYTES) { content.push(block); continue; }
  let small: ReturnType<typeof preview> = null;
  try { small = preview(block); } catch { /* keep the original and tell the recipient */ }
  if (!small) {
   content.push({ type: "text", text: `第 ${index} 张图片未能生成轻量总览，仍附原图；此渠道可能无法显示。` }, block);
   continue;
  }
  const { image, ow, oh, w, h } = small;
  const mapping = tool === "look_at_image"
   ? `本次读取区域为 ${ow}×${oh}，总览坐标分别乘 ${ow}/${w}、${oh}/${h}；若本次为局部，请再加工具正文中的原图左上角。用 look_at_image 的 region={x,y,width,height} 读取原图局部。`
   : `回传图片尺寸为 ${ow}×${oh}，不一定是原文件尺寸；需要细节时，先用 look_at_image 读取原文件总览，再按其坐标说明取局部。`;
  content.push({ type: "text", text: `第 ${index} 张为压缩后的总览（${w}×${h}）。不要用总览猜小字。${mapping}` }, image);
 }
 return { ...result, content };
}
