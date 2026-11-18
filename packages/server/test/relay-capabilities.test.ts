import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Hono } from "hono";
import { customProviders, initModels, models } from "../src/models.ts";
import { mountModelRoutes } from "../src/routes/models.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

await initModels(memoryCredentialStore());
const app = new Hono<Parameters<typeof mountModelRoutes>[0] extends Hono<infer E> ? E : never>();
mountModelRoutes(app);
test("自动协议只向已保存的实际列表地址刷新，证据不能带到切换后的端点", async () => {
 const hits: string[] = [];
 const upstream = createServer((req, res) => {
  hits.push(req.url ?? "");
  res.end(JSON.stringify({ data: [{ id: "fixture-future-auto", ...(req.url === "/actual/models" ? { input: ["text", "image"], reasoning: true } : {}) }] }));
 });
 await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
 const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
 const input = { name: "自动列表地址", api: "auto", baseUrl, noKey: true, protocolUrls: { "openai-completions": `${baseUrl}/actual` } };
 const id = "fixture-future-auto";
 let providerId: string | undefined;
 try {
  const saved = await customProviders.save(null, { ...input, models: [{ id }] });
  providerId = saved.id;
  const result = await app.request("http://localhost/api/models/custom/fetch-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: saved.id, api: "auto", baseUrl }) });
  assert.equal(result.status, 200);
  const { models: fetched } = await result.json();
  assert.deepEqual(hits, ["/actual/models"]);
  assert.equal(fetched[0].listEvidence.baseUrl, `${baseUrl}/actual`);
  await customProviders.save(saved.id, { ...input, models: fetched });
  assert.deepEqual(models.getModel(saved.id, id)?.input, ["text", "image"]);
  await customProviders.save(saved.id, { ...input, protocolUrls: { "openai-completions": `${baseUrl}/other` }, models: fetched });
  assert.deepEqual(models.getModel(saved.id, id)?.input, ["text"]);
  assert.deepEqual(hits, ["/actual/models"]);
 } finally {
  if (providerId) await customProviders.remove(providerId);
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
 }
});

for (const api of ["openai-completions", "openai-responses"]) test(`channel facts: ${api}`, async () => {
 const ids = ["glass-ibis-87071", "copper-moon-89402", "amber-kite-77003", "slate-delta-80562"];
 let refreshed = false;
 const upstream = createServer((req, res) => {
  assert.match(req.url ?? "", /\/models$/);
  res.end(JSON.stringify({ data: ids.map((id, i) => ({ id, ...(i === 3 ? { input: refreshed ? ["text"] : ["text", "image"], reasoning: !refreshed, thinkingLevelMap: { max: "untrusted" } } : {}) })) }));
 });
 await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
 try {
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const input = { name: `Stage one ${api}`, api, baseUrl, noKey: true };
  const fetched = await customProviders.fetchModels(input);
  const a = await customProviders.save(null, { ...input, models: fetched, capabilityScope: { api, baseUrl, source: "Fixture documentation", appliesTo: "all-chat", defaults: { vision: true, reasoning: true, levels: { high: "fixture_high", off: null } }, exceptions: { [ids[2]]: { vision: false, reasoning: false } } } });
  const b = await customProviders.save(null, { ...input, name: `${input.name} B`, models: [{ id: ids[0] }, { ...a.models.find((m) => m.id === ids[3])! }] });
  const row = async (id: string, provider = a.id) => (await (await app.request("http://localhost/api/models")).json()).find((m: { provider: string; id: string }) => m.provider === provider && m.id === id);
  for (const id of ids.slice(0, 2)) {
   const dto = await row(id);
   assert.equal(dto.effectiveCapability.visionSource, "渠道范围");
   assert.equal(dto.effectiveCapability.off, "omit");
   assert.deepEqual(dto.thinking, ["high"]);
   assert.deepEqual(models.getModel(a.id, id)?.input, ["text", "image"]);
   assert.equal(dto.thinkingLevelMap.high, "fixture_high");
  }
  assert.equal((await row(ids[2])).effectiveCapability.vision, false);
  assert.deepEqual(models.getModel(a.id, ids[2])?.input, ["text"]);
  assert.equal((await row(ids[0], b.id)).effectiveCapability.vision, undefined);
  assert.equal((await row(ids[3], b.id)).effectiveCapability.reasoning, undefined);
  assert.equal((await row(ids[3])).effectiveCapability.reasoningSource, "/models");
  await customProviders.save(a.id, { ...input, models: a.models.map((m) => m.id === ids[3] ? { ...m, visionOverride: true, reasoning: true, thinkingLevelSource: "user", thinkingLevelMap: { low: "manual", off: "confirmed_off" } } : m) });
  refreshed = true;
  const refresh = await customProviders.fetchModels({ ...input, id: a.id });
  const manual = customProviders.list().find((p) => p.id === a.id)!;
  const merged = manual.models.map((m) => ({ ...m, listEvidence: refresh.find((x) => x.id === m.id)?.listEvidence }));
  await customProviders.save(a.id, { ...input, models: merged });
  assert.equal((await row(ids[3])).effectiveCapability.off, "value");
  assert.deepEqual((await row(ids[3])).thinking, ["off", "low"]);
  await customProviders.save(a.id, { ...input, models: merged.map((m) => m.id === ids[3] ? { ...m, visionOverride: null, reasoning: undefined, thinkingLevelSource: undefined, thinkingLevelMap: undefined } : m) });
  assert.equal((await row(ids[3])).effectiveCapability.visionSource, "/models");
  assert.equal((await row(ids[3])).reasoning, false);
  const saved = customProviders.list().find((p) => p.id === a.id)!;
  for (const change of [{ api: api === "openai-completions" ? "openai-responses" : "openai-completions" }, { baseUrl: `${baseUrl}/other` }]) {
   await customProviders.save(a.id, { ...input, ...change, models: saved.models });
   assert.equal((await row(ids[0])).effectiveCapability.vision, undefined);
   assert.equal((await row(ids[3])).reasoning, undefined);
   assert.deepEqual(models.getModel(a.id, ids[0])?.input, ["text"]);
  }
 } finally { await new Promise<void>((resolve) => upstream.close(() => resolve())); }
});
