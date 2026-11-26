import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { adaptAgyToolImages, agyImageToolSchema, cropAgyImage } from "../src/agy-tool-images.ts";
import { BridgeRun } from "../src/cli-agents/tool-bridge.ts";
const p = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as typeof import("@silvia-odwyer/photon-node");
function sample(w: number, h: number, noise = false) {
 const pixels = new Uint8Array(w * h * 4);
 let r = 19;
 for (let i = 0; i < pixels.length; i += 4) {
  if (noise) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; pixels[i] = r >>> 24; pixels[i+1] = r >>> 16; }
  else pixels[i] = (i / 4 % w) < w / 2 ? 255 : 0;
  pixels[i+3] = 255;
 }
 const image = new p.PhotonImage(pixels, w, h);
 try { return { type: "image" as const, data: Buffer.from(image.get_bytes()).toString("base64"), mimeType: "image/png" }; }
 finally { image.free(); }
}
test("small bytes remain untouched; indexed previews keep every image in one reply", async () => {
 const orig = sample(1280, 720, true), tiny = sample(40, 20), second = sample(800, 600, true);
 const text = { type: "text" as const, text: "original text" };
 const source = { content: [text, orig, tiny, second] };
 const adapted = adaptAgyToolImages(source);
 const imgs = adapted.content.filter(b => b.type === "image");
 assert.equal(imgs.length, 3); assert.equal(imgs[1], tiny);
 for (const [i, input] of [[0, orig], [2, second]] as const) {
  assert.ok(Buffer.byteLength(imgs[i].data, "base64") <= 9000); assert.notEqual(imgs[i].data, input.data);
 }
 assert.deepEqual(source.content, [text, orig, tiny, second]);
 const tool = { name: "look_at_image", inputSchema: { type: "object" as const, properties: { paths: { type: "array" } } } };
 const direct = agyImageToolSchema(tool);
 assert.ok(Object.hasOwn(direct.inputSchema.properties as object, "region")); assert.ok(!("region" in tool.inputSchema.properties));
 const bridge = new BridgeRun({ tools: [direct], callKey: () => "7" }, () => {});
 const pending = bridge.handleMessage({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:tool.name}});
 assert.equal(bridge.resolveTool("7", adapted), true);
 assert.equal(bridge.resolveTool("7", adapted), false);
 assert.deepEqual(JSON.parse(JSON.stringify(await pending)).result.content, adapted.content);
 bridge.close();
});
test("detail crops original pixels with explicit bounds; small crop passes through", () => {
 const image = sample(400, 200);
 const crop = cropAgyImage(image, { x: 190, y: 25, width: 20, height: 30 });
 const decoded = p.PhotonImage.new_from_byteslice(Buffer.from(crop.data, "base64"));
 try {
  assert.deepEqual([decoded.get_width(), decoded.get_height()], [20, 30]);
  const pixels = decoded.get_raw_pixels();
  assert.equal(pixels[0], 255); assert.equal(pixels[10 * 4], 0);
 } finally { decoded.free(); }
 assert.equal(adaptAgyToolImages({ content: [crop] }).content[0], crop);
 assert.throws(() => cropAgyImage(image, { x: 399, y: 5, width: 2, height: 30 }), /超出/);
});
test("black transparent PNG keeps alpha contrast across the preview within 9 KB", () => {
 const width = 720, height = 480;
 const pixels = new Uint8Array(width * height * 4);
 let rng = 19;
 for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
  pixels[(y * width + x) * 4 + 3] = x < 160 ? 0 : x >= 560 ? 255 : (rng >>> 31) * 255;
 }
 const original = new p.PhotonImage(pixels, width, height);
 let bytes: Buffer;
 try { bytes = Buffer.from(original.get_bytes()); } finally { original.free(); }
 assert.ok(bytes.length > 9000);
 const image = {type: "image" as const, mimeType: "image/png", data: bytes.toString("base64")};
 const result = adaptAgyToolImages({content: [image]});
 const thumb = result.content.find(b => b.type === "image");
 assert.ok(thumb);
 assert.equal(thumb.mimeType, "image/png");
 const preview = Buffer.from(thumb.data, "base64");
 assert.ok(preview.length <= 9000);
 assert.deepEqual(Buffer.from(image.data, "base64"), bytes);
 const decoded = p.PhotonImage.new_from_byteslice(preview);
 try {
  const w = decoded.get_width(), h = decoded.get_height();
  assert.ok(w < width && h < height);
  const out = decoded.get_raw_pixels();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
   const i = (y * w + x) * 4;
   assert.equal(out[i] | out[i+1] | out[i+2], 0);
   if (x < w / 8) assert.equal(out[i+3], 0);
   if (x >= w * 7 / 8) assert.equal(out[i+3], 255);
  }
 } finally { decoded.free(); }
});

test("decoder failure preserves the block and warns rather than dropping it", () => {
 const image = {type:"image" as const, data:Buffer.alloc(9_500, 254).toString("base64"), mimeType:"image/png"};
 const [label, original] = adaptAgyToolImages({content:[image]}).content;
 assert.ok(label.type === "text" && label.text.includes("仍附原图"));
 assert.equal(original, image);
});
