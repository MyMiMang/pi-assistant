import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { AgyProcess } from "../src/cli-agents/agy-process.ts";
import { ToolBridge, type BridgeRun } from "../src/cli-agents/tool-bridge.ts";
import { toolDefOf, toolResultToMcp } from "../src/pi-adapter/cli-models/convert.ts";
import { visionExtension } from "../src/vision-ext.ts";
import { initModels, models } from "../src/models.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

test("actual validation, local execution and AGY bridge; same extension switches back to multi-image", async () => {
 await initModels(memoryCredentialStore());
 const dir = mkdtempSync(join(tmpdir(), "agy-image-"));
 const original = models.listModels;
 let provider = "antigravity";
 let bridgeRun!: BridgeRun;
 const bridge = new class extends ToolBridge {
  override register(...args: Parameters<ToolBridge["register"]>) { return bridgeRun = super.register(...args); }
 }();
 try {
  models.listModels = (() => [{ id: "image", input: ["text", "image"] }]) as never;
  let tool!: {name: string; description: string; parameters: ReturnType<typeof Type.Object>; execute(id: string, args: never): Promise<Parameters<typeof toolResultToMcp>[0]>};
  visionExtension({ workspace: dir, model: () => ({ provider, id: "image" }) })({ registerTool: t => { tool = t as typeof tool; }, on() {} });
  const photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as typeof import("@silvia-odwyer/photon-node");
  const png = new photon.PhotonImage(new Uint8Array([100, 20, 40, 255, 40, 5, 12, 255, 30, 40, 70, 255, 12, 10, 30, 255]), 2, 2);
  const bytes = Buffer.from(png.get_bytes());
  png.free();
  writeFileSync(join(dir, "a.png"), bytes);
  const proc = new AgyProcess({ command: "/no-fake-cli-executed", runsRoot: dir, bridgeBaseUrl: "http://127.0.0.1:1", model: "synthetic", bridge, tools: [toolDefOf(tool)] });
  const table = await bridgeRun.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const advertised = (table as unknown as {result: {tools: {name: string; inputSchema: typeof tool.parameters}[]}}).result.tools[0];
  const multi = { name: tool.name, arguments: { paths: ["missing.png", "a.png"] } };
  assert.throws(() => validateToolArguments({ ...tool, parameters: advertised.inputSchema }, multi as never));
  const rejected = await tool.execute("bypass", multi.arguments as never);
  assert.match(JSON.stringify(rejected), /分别读取/);
  const args = { paths: ["a.png"], region: { x: 0, y: 0, width: 1, height: 1 } };
  validateToolArguments({ ...tool, parameters: advertised.inputSchema }, {name:tool.name,arguments:args} as never);
  const validated = validateToolArguments(tool, {name:tool.name,arguments:args} as never);
  const pending = bridgeRun.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool.name, arguments: args, _meta: { progressToken: "synthetic:7" } } });
  const result = toolResultToMcp(await tool.execute("7", validated as never));
  assert.equal(result.content.filter(x => x.type === "image").length, 1, JSON.stringify(result));
  assert.match(JSON.stringify(result), /图片局部/);
  assert.equal(proc.resolveTool("7", result), true);
  const unused = { get content(): never { throw Error("must not access stale result"); } };
  assert.equal(proc.resolveTool("7", unused), false);
  assert.deepEqual((await pending as { result?: unknown }).result, result);
  const cancelled = bridgeRun.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool.name, arguments: args, _meta: { progressToken: "synthetic:8" } } });
  await bridgeRun.handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } });
  assert.equal(proc.resolveTool("8", unused), false);
  assert.match(JSON.stringify(await cancelled), /已取消/);
  provider = "other";
  const normal = validateToolArguments(tool, { name: tool.name, arguments: { paths: ["a.png", "a.png"] } } as never);
  const unchanged = await tool.execute("normal", normal as never);
  assert.deepEqual(unchanged.content.filter(x => x.type === "image").map(x => x.data), [bytes.toString("base64"), bytes.toString("base64")]);
 } finally { bridgeRun?.close(); models.listModels = original; rmSync(dir, {recursive:true,force:true}); }
});
