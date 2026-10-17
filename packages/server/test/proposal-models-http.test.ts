/**
 * 群提议的思考强度：HTTP 契约 + 已有群成员经公共 PATCH 改思考强度后运行时生效。
 *
 * 两件事：
 *  1. `GET /api/proposals/models` 必须带**真实** thinking 数组（与 `/api/models` 同一份 Pi 元数据）和
 *     providerName，同时保留角色排序 / 星标理由 / 价格档 / 排除原因 —— 界面不自己造 7 档。
 *  2. 群成员（`scope = room`）走公共 `PATCH /api/agents/:id` 改 thinking：库里的原值 = thinkingSetting，
 *     实际生效值 = runtime.thinkingFor（按模型 clamp），与 `GET /api/agents` 一致。
 *
 * 边界：真实服务进程（`test/launch-memory.ts`：内存 CredentialStore 绕开钥匙串）+ 临时数据目录 +
 * PIA_MOCK / PIA_OFFLINE，无真实 Key、无外网、无浏览器、不重建。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { THINKING_LEVEL_ORDER } from "@pi-assistant/shared";
// @ts-expect-error 共享隔离启动夹具是 .mjs，API由HTTP/UI集成验收。
import { cleanupTempRun, makeTempRun, startTempServer } from "../../../e2e/fixtures/temp-server.mjs";

type Json = Record<string, any>;

const root = join(import.meta.dirname, "../../..");
const run = makeTempRun("pia-proposal-http-");
const port = await new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;

let srv: ReturnType<typeof startTempServer> | undefined;
const api = async (path: string, init?: RequestInit): Promise<{ status: number; body: Json }> => {
	const r = await fetch(`${base}${path}`, { headers: { "content-type": "application/json" }, ...init });
	const text = await r.text();
	let body: Json = {};
	try {
		body = JSON.parse(text) as Json;
	} catch {
		body = { raw: text };
	}
	return { status: r.status, body };
};

before(async () => {
	srv = startTempServer({ root, port, run });
	const end = Date.now() + 60_000;
	while (Date.now() < end) {
		if (await fetch(`${base}/api/system/public`).then((r) => r.status === 200).catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 120));
	}
	throw new Error(`等待服务启动超时：\n${srv.logs().slice(-2000)}`);
});
after(async () => {
	await srv?.stop();
	cleanupTempRun(run);
});

test("GET /api/proposals/models：真实 thinking 数组 + providerName，排序 / 理由 / 价格 / 排除原因都保留", async () => {
	const catalog = (await api("/api/models")).body as Json[];
	const thinkingOf = new Map(catalog.map((m) => [`${m.provider}/${m.id}`, m.thinking as string[]]));
	const def = (await api("/api/models/defaults")).body;
	assert.ok(THINKING_LEVEL_ORDER.includes(def.thinking), `默认档位应是合法档位：${def.thinking}`);

	const r = await api("/api/proposals/models?needs=vision");
	assert.equal(r.status, 200);
	const rows = r.body as Json[];
	assert.ok(Array.isArray(rows) && rows.length >= 2, `应返回候选模型：${JSON.stringify(rows).slice(0, 200)}`);
	for (const row of rows) {
		assert.equal(typeof row.providerName, "string", "每个候选都带服务名");
		assert.ok(row.providerName.length > 0);
		assert.ok(Array.isArray(row.thinking), `每个候选都带 thinking 数组：${JSON.stringify(row)}`);
		// thinking 必须是这个模型真实的可用档位，不是前端/后端凭空补的 7 档
		assert.deepEqual(row.thinking, thinkingOf.get(`${row.provider}/${row.id}`), `${row.provider}/${row.id} 的档位应与模型目录一致`);
		assert.equal(typeof row.reason, "string", "保留一句话理由（卡片上的星标说明）");
		assert.ok(row.reason.length > 0);
		assert.equal(typeof row.score, "number", "保留排序分数");
		assert.equal(typeof row.tierLabel, "string", "保留价格档文案");
		assert.ok(Array.isArray(row.tags), "保留角色能力标签");
	}
	// 排序仍是分数降序；被硬条件排除的排在最后（保留 excluded 原因，不静默丢行）
	const scores = rows.map((x) => x.score as number);
	assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "候选仍按分数降序");
	const firstExcluded = rows.findIndex((x) => x.excluded);
	if (firstExcluded >= 0) assert.ok(rows.slice(firstExcluded).every((x) => x.excluded), "被排除的都排在最后");
	// 需要看图的角色：mock 的视觉模型排第一（与 e2e 同一口径）
	assert.equal(rows[0].id, "echo");
	assert.ok(rows[0].thinking.length > 0, "视觉模型的档位来自真实模型元数据");
	const reason = rows[0].thinking as string[];
	assert.ok(reason.every((l) => THINKING_LEVEL_ORDER.includes(l as never)), `档位只会是 Pi 的合法档位：${reason}`);
});

test("群成员经公共 PATCH 改思考强度：thinkingSetting 存原值，运行时 thinking 按模型 clamp", async () => {
	const catalog = (await api("/api/models")).body as Json[];
	const thinkModel = catalog.find((m) => m.provider === "mock" && m.id === "echo-think");
	assert.ok(thinkModel, "PIA_MOCK 下应有 mock/echo-think");
	const supported = thinkModel!.thinking as string[];
	assert.ok(supported.length > 0, `推理模型应有可用档位：${supported}`);
	const clampTo = (want: string) => {
		const idx = THINKING_LEVEL_ORDER.indexOf(want as never);
		const lower = supported.filter((l) => THINKING_LEVEL_ORDER.indexOf(l as never) <= idx);
		return lower.length ? lower[lower.length - 1] : supported[0];
	};

	// 1) 建一个用户助理 + 一个群（成员是它），再用「内置管家」造一个真正的群专属成员（scope = room）
	const a = await api("/api/agents", { method: "POST", body: JSON.stringify({ name: "群成员甲", model: { provider: "mock", id: "echo-think" }, thinking: "low" }) });
	assert.equal(a.status, 200, JSON.stringify(a.body));
	assert.equal(a.body.thinkingSetting, "low");
	assert.equal(a.body.thinking, clampTo("low"), "新建助理的生效档位同样按模型 clamp");
	const room = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name: "思考群", memberIds: [a.body.id] }) });
	assert.equal(room.status, 200, JSON.stringify(room.body));
	const mgr = await api("/api/rooms/builtin-manager", { method: "POST", body: JSON.stringify({ roomId: room.body.id }) });
	assert.equal(mgr.status, 200, JSON.stringify(mgr.body));
	const memberId = mgr.body.id as string;
	assert.equal(mgr.body.scope, "room", "管家是群专属成员");
	assert.equal(mgr.body.room_id, room.body.id);
	// 缺省成员没有被提议字段覆盖：仍然是原来的默认档
	const def = (await api("/api/models/defaults")).body;
	assert.equal(mgr.body.thinkingSetting, def.thinking, "没选档位的新成员保持 defaultThinking");

	// 2) 公共 PATCH：换成推理模型 + max（原值落库、生效值 clamp）
	const patched = await api(`/api/agents/${memberId}`, { method: "PATCH", body: JSON.stringify({ model: { provider: "mock", id: "echo-think" }, thinking: "max" }) });
	assert.equal(patched.status, 200, JSON.stringify(patched.body));
	assert.equal(patched.body.thinkingSetting, "max", "库里存用户选的档位");
	assert.equal(patched.body.thinking, clampTo("max"), "运行时按模型合法档位生效");
	assert.equal(patched.body.model.id, "echo-think");

	// 3) GET /api/agents 复读（同一 agentJson / runtime.thinkingFor 链路）与 PATCH 一致
	const list = (await api("/api/agents")).body as Json[];
	const again = list.find((x) => x.id === memberId);
	assert.ok(again);
	assert.equal(again!.thinkingSetting, "max");
	assert.equal(again!.thinking, patched.body.thinking);
	assert.equal(again!.scope, "room");

	// 4) 非推理模型：clamp 到它支持的档位（不是原样保存 max 当生效值）
	const plain = await api(`/api/agents/${memberId}`, { method: "PATCH", body: JSON.stringify({ model: { provider: "mock", id: "echo" }, thinking: "max" }) });
	assert.equal(plain.status, 200, JSON.stringify(plain.body));
	assert.equal(plain.body.thinkingSetting, "max");
	const plainSupported = (catalog.find((m) => m.provider === "mock" && m.id === "echo")!.thinking as string[]) ?? [];
	assert.equal(plain.body.thinking, plainSupported.length ? plainSupported[plainSupported.length - 1] : "off", "不支持推理的模型按目录收敛");

	// 5) 非法档位/开关先整份拒绝，不能已更改模型或资料再报错。
	const before = plain.body;
	const bad = await api(`/api/agents/${memberId}`, { method: "PATCH", body: JSON.stringify({ name: "失败后不该保存的名字", model: { provider: "mock", id: "echo-think" }, thinking: "ultra" }) });
	assert.equal(bad.status, 400);
	const after = (await api("/api/agents")).body.find((a: any) => a.id === memberId);
	assert.equal(after.name, before.name);
	assert.deepEqual(after.model, before.model);
	assert.equal(after.thinkingSetting, before.thinkingSetting);
	const badFast = await api(`/api/agents/${memberId}`, { method: "PATCH", body: JSON.stringify({ name: "同样不该保存", thinking: "high", fast: "yes" }) });
	assert.equal(badFast.status, 400);
	const afterFast = (await api("/api/agents")).body.find((a: any) => a.id === memberId);
	assert.equal(afterFast.name, before.name);
	assert.equal(afterFast.thinkingSetting, before.thinkingSetting);
});
