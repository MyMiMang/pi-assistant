/**
 * 请求级 Fast（OpenAI `service_tier`）的纯函数 + 真实 Pi SDK 流路径验证。
 *
 * 关键点：**不是 mock provider**。这里用真实 `createPiSession`（Pi 1.3.0）+ loopback OpenAI 兼容 HTTP，
 * 由服务端记录最终收到的请求体，证明参数真的发到了线上（mock provider 绕开 SDK 不会证明这一点）。
 *
 * 覆盖：
 *  - 关 → 请求体里没有 service_tier；开 → 只多 service_tier=priority，reasoning_effort 不变；再关 → 恢复没有；
 *  - 协议不支持（换模型到非 OpenAI 协议）→ 不注入，状态如实标 unsupported-api；
 *  - 已有 instrumentation 组合（前一个 onPayload 加的字段仍在）；已有 service_tier 不被覆盖（conflict / externally-configured）；
 *  - 400 原样失败，不自动删参数重发（只发出一次带 service_tier 的请求）；
 *  - 回显 priority / default / 不回显 → observedKind 分别是 fast / standard / unknown；
 *  - 助理状态独立、子代理默认跟随 + 独立覆盖（直接读真实 DB 行）。
 *
 * 全部在临时数据目录 + 内存凭据里跑，不连真实云、不用真实 Key、不发真实付费请求。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { config } from "../src/config.ts";
import { db, now, uid } from "../src/db.ts";
import { customProviders, initModels, models } from "../src/models.ts";
import { attachFastMode, classifyObservedTier, fastCapability, observedFastTier, planFastRequest, reportedFastTier } from "../src/pi-adapter/index.ts";
import { applyModelSettings, createPiSession, disposeSession, promptSession } from "../src/pi-adapter/index.ts";
import { agentFast, resolveSubagentFast, setSubagentFastOverride } from "../src/subagents.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

// ---------------------------------------------------------------- 纯函数
test("能力口径：只认 OpenAI Responses / Chat Completions / Codex；官方 Responses 是 supported，其余 requestable-unverified", () => {
	assert.equal(fastCapability("openai-responses", "openai").capability, "supported");
	assert.equal(fastCapability("openai-completions", "openai").capability, "requestable-unverified");
	assert.equal(fastCapability("openai-codex-responses", "openai").capability, "requestable-unverified");
	assert.equal(fastCapability("openai-completions", "my-relay").capability, "requestable-unverified");
	for (const api of ["anthropic-messages", "azure-openai-responses", "google-generative-ai", "llama-cpp", undefined]) {
		const c = fastCapability(api, "x");
		assert.equal(c.capability, "unsupported");
		assert.equal(c.reason, "当前接口暂未接入 Fast");
	}
});

test("注入：关闭不附加任何字段；开启只加 service_tier=priority；不支持 / 非对象安全跳过", () => {
	const payload = { model: "m", messages: [], reasoning_effort: "medium" };
	const off = planFastRequest(payload, { api: "openai-completions", provider: "r" }, false);
	assert.equal(off.status, "off");
	assert.equal(off.changed, false);
	assert.equal("service_tier" in payload, false);

	const on = planFastRequest(payload, { api: "openai-completions", provider: "r" }, true);
	assert.equal(on.status, "injected");
	assert.equal(on.changed, true);
	assert.deepEqual(on.payload, { ...payload, service_tier: "priority" });
	assert.equal(on.requested, true);

	const bad = planFastRequest({ ...payload }, { api: "anthropic-messages", provider: "a" }, true);
	assert.equal(bad.status, "unsupported-api");
	assert.equal(bad.changed, false);
	assert.equal(planFastRequest(null, { api: "openai-completions" }, true).status, "bad-payload");
	assert.equal(planFastRequest([], { api: "openai-completions" }, true).status, "bad-payload");
});

test("已有 tier：开启时尊重原值（相同=externally-configured，不同=conflict 不改写）；关闭时如实标 externally-configured", () => {
	const same = planFastRequest({ service_tier: "priority" }, { api: "openai-completions" }, true);
	assert.equal(same.status, "externally-configured");
	assert.equal(same.changed, false);
	assert.equal(same.requested, true);

	const conflict = planFastRequest({ service_tier: "default" }, { api: "openai-completions" }, true);
	assert.equal(conflict.status, "conflict");
	assert.equal(conflict.changed, false);
	assert.equal(conflict.requested, false);
	assert.equal(conflict.existingTier, "default");

	const off = planFastRequest({ service_tier: "default" }, { api: "openai-completions" }, false);
	assert.equal(off.status, "externally-configured");
	assert.equal(off.requested, false);
	assert.match(off.reason ?? "", /关闭只停止本开关附加参数/);
});

test("回显解析：只有终止事件的 tier 才算实际；created / chunk 只是回显（可能是 requested）", () => {
	// sub2api upstream_response_model.go:78-90：非终止事件回显的是请求的 tier，不能当 accepted / actual
	assert.equal(observedFastTier({ type: "response.created", response: { service_tier: "priority" } }), null);
	assert.equal(reportedFastTier({ type: "response.created", response: { service_tier: "priority" } }), "priority");
	assert.equal(observedFastTier({ type: "response.completed", response: { service_tier: "fast" } }), "fast");
	assert.equal(observedFastTier({ type: "response.done", response: { service_tier: "default" } }), "default");
	assert.equal(reportedFastTier({ type: "response.completed", response: { service_tier: "fast" } }), null);
	// Chat Completions 流式 chunk 没有终止语义：来源可能是 Responses created 的 echoed requested
	assert.equal(observedFastTier({ service_tier: "priority" }), null);
	assert.equal(reportedFastTier({ service_tier: "priority" }), "priority");
	assert.equal(observedFastTier({ response: { id: "x" } }), null);
	assert.equal(observedFastTier(null), null);
	assert.equal(classifyObservedTier("priority"), "fast");
	assert.equal(classifyObservedTier("FAST"), "fast");
	assert.equal(classifyObservedTier("default"), "standard");
	assert.equal(classifyObservedTier("auto"), "other");
	assert.equal(classifyObservedTier(null), "unknown");
});

test("tracker：终止事件 default 只标 standard（不推断标准计费）；priority 标 fast；没有回显是 unknown", async () => {
	const agent: { onPayload?: (p: unknown, m: unknown) => unknown; onProviderStreamEvent?: (d: unknown, m: unknown) => void } = {};
	const session = { agent };
	let enabled = true;
	const tracker = attachFastMode(session as never, () => enabled);
	await agent.onPayload!({ model: "m" }, { api: "openai-responses", provider: "r" });
	assert.equal(tracker.snapshot().status, "injected");
	assert.equal(tracker.snapshot().observedKind, "unknown");

	await agent.onProviderStreamEvent!({ type: "response.created", response: { service_tier: "priority" } }, {});
	assert.equal(tracker.snapshot().observedKind, "unknown", "非终止事件不算实际");
	assert.equal(tracker.snapshot().reportedKind, "fast");

	await agent.onProviderStreamEvent!({ type: "response.completed", response: { service_tier: "default" } }, {});
	assert.equal(tracker.snapshot().observedKind, "standard", "default 只表示服务回显 default");
	assert.equal(tracker.snapshot().observed, "default");

	await agent.onPayload!({ model: "m" }, { api: "openai-responses", provider: "r" });
	assert.equal(tracker.snapshot().observedKind, "unknown", "下一次请求不复用上一条回复的回显");
	await agent.onProviderStreamEvent!({ type: "response.completed", response: { service_tier: "priority" } }, {});
	assert.equal(tracker.snapshot().observedKind, "fast");
});

// ---------------------------------------------------------------- 真实 SDK 路径
/** loopback「中转」：记录最终请求体；可配置回显 tier / 400 / 是否走流式。 */
async function startRelay() {
	const seen: Record<string, unknown>[] = [];
	const state: { tier: string | null; reject: number | false } = { tier: "priority", reject: false };
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		const json = JSON.parse(body || "{}") as Record<string, unknown>;
		seen.push(json);
		if (state.reject && "service_tier" in json) {
			res.writeHead(state.reject, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "unknown field service_tier", type: "invalid_request_error" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: json.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
		res.write(chunk({ role: "assistant", content: "" }, state.tier ? { service_tier: state.tier } : {}));
		res.write(chunk({ content: "好" }));
		res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: json.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	const url = await new Promise<string>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`));
	});
	return { url, seen, state, close: () => (server.closeAllConnections?.(), server.close()) };
}

const relay = await startRelay();
after(() => relay.close());
await initModels(memoryCredentialStore());
const provider = await customProviders.save(null, {
	name: "Fast 测试中转",
	api: "openai-completions",
	baseUrl: relay.url,
	apiKey: "sk-fast-test",
	models: [{ id: "fast-relay", reasoning: true }],
});
after(() => customProviders.remove(provider.id));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(session: Awaited<ReturnType<typeof createPiSession>>, ms = 15000) {
	const end = Date.now() + ms;
	while (session.isStreaming && Date.now() < end) await sleep(30);
}

async function newSession(name: string, thinking = "medium") {
	const ws = join(config.workspaceRoot, name);
	mkdirSync(ws, { recursive: true });
	return createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, name),
		sessionDir: join(config.agentsDir, name, "sessions"),
		model: { provider: provider.id, id: "fast-relay" },
		thinking,
		systemPromptAppend: ["你是 Fast 测试助理。"],
		extensions: [],
	});
}

test("真实 SDK：关→开→关，最终请求体证明只多 service_tier=priority，reasoning_effort 不变", async () => {
	let enabled = false;
	const session = await newSession("fast-toggle");
	const tracker = attachFastMode(session, () => enabled);
	try {
		await promptSession(session, "第一次");
		await settle(session);
		const first = relay.seen.at(-1)!;
		assert.equal("service_tier" in first, false, "关：不附加任何字段（也不补 auto/default）");
		assert.equal(tracker.snapshot().status, "off");

		enabled = true;
		await promptSession(session, "第二次");
		await settle(session);
		const second = relay.seen.at(-1)!;
		assert.equal(second.service_tier, "priority", "开：真实请求体带 priority");
		assert.equal(second.reasoning_effort, first.reasoning_effort, "开 Fast 不改思考强度");
		assert.equal(tracker.snapshot().status, "injected");
		assert.equal(tracker.snapshot().reportedKind, "fast", "completions chunk 只是回显：不能当实际档位");
		assert.equal(tracker.snapshot().observedKind, "unknown", "没有终止事件 → 实际未知");

		enabled = false;
		await promptSession(session, "第三次");
		await settle(session);
		const third = relay.seen.at(-1)!;
		assert.equal("service_tier" in third, false, "再关：恢复不附加");
		assert.equal(third.reasoning_effort, first.reasoning_effort);
	} finally {
		await disposeSession(session);
	}
});

test("真实 SDK：组合已有 onPayload / onProviderStreamEvent，不覆盖别的 instrumentation", async () => {
	let enabled = true;
	const session = await newSession("fast-compose");
	let seenEvent = 0;
	session.agent.onPayload = (payload) => ({ ...(payload as Record<string, unknown>), marker_from_previous_hook: "kept" });
	session.agent.onProviderStreamEvent = () => {
		seenEvent++;
	};
	const tracker = attachFastMode(session, () => enabled);
	try {
		await promptSession(session, "组合 hook");
		await settle(session);
		const body = relay.seen.at(-1)!;
		assert.equal(body.marker_from_previous_hook, "kept", "前一个 hook 的替换结果保留");
		assert.equal(body.service_tier, "priority", "Fast 叠加在它上面");
		assert.ok(seenEvent > 0, "前一个流事件 hook 仍被调用");
		assert.equal(tracker.snapshot().reportedKind, "fast");
		assert.equal(tracker.snapshot().observedKind, "unknown");
	} finally {
		await disposeSession(session);
	}
});

test("真实 SDK：已有 service_tier 不被覆盖（conflict），也不谎报已 Fast", async () => {
	let enabled = true;
	const session = await newSession("fast-conflict");
	session.agent.onPayload = (payload) => ({ ...(payload as Record<string, unknown>), service_tier: "default" });
	const tracker = attachFastMode(session, () => enabled);
	try {
		await promptSession(session, "已有档位");
		await settle(session);
		const body = relay.seen.at(-1)!;
		assert.equal(body.service_tier, "default", "尊重已有值，不改写成 priority");
		assert.equal(tracker.snapshot().status, "conflict");
		assert.equal(tracker.snapshot().requested, false);
	} finally {
		await disposeSession(session);
	}
});

for (const status of [400, 403]) {
	test(`真实 SDK：${status} 原样失败，不自动删参数重发（只发一次带 service_tier 的请求）`, async () => {
		let enabled = true;
		relay.state.reject = status;
		const before = relay.seen.length;
		const session = await newSession(`fast-${status}`);
		attachFastMode(session, () => enabled);
		try {
			await promptSession(session, "会被拒绝").catch(() => {});
			await settle(session);
			const requests = relay.seen.slice(before);
			const withTier = requests.filter((r) => "service_tier" in r);
			assert.equal(withTier.length, 1, `只应有一次带参数请求，实际 ${withTier.length}`);
			assert.ok(requests.every((r) => r.service_tier === "priority"), "重试也不会偷偷去掉参数");
		} finally {
			relay.state.reject = false;
			await disposeSession(session);
		}
	});
}

test("真实 SDK：chunk 回显 default / 不回显 → 只标 reported（200 不等于加速成功）", async () => {
	let enabled = true;
	const session = await newSession("fast-observe");
	const tracker = attachFastMode(session, () => enabled);
	try {
		relay.state.tier = "default";
		await promptSession(session, "回显 default");
		await settle(session);
		assert.equal(tracker.snapshot().reportedKind, "standard");
		assert.equal(tracker.snapshot().reported, "default");
		assert.equal(tracker.snapshot().observedKind, "unknown", "chunk 不证明实际档位");

		relay.state.tier = null;
		await promptSession(session, "不回显");
		await settle(session);
		assert.equal(tracker.snapshot().reportedKind, "unknown");
		assert.equal(tracker.snapshot().observedKind, "unknown");
		assert.equal(tracker.snapshot().requested, true, "仍然只是「已请求」");
	} finally {
		relay.state.tier = "priority";
		await disposeSession(session);
	}
});

test("真实 SDK：换到不支持的协议后不再注入（按本次实际 model.api 判断，不用最初选的模型）", async () => {
	const faux = registerFauxProvider({ provider: "fastfaux", models: [{ id: "faux-fast", reasoning: false, input: ["text"] } as never], tokensPerSecond: 10000 });
	const fm = faux.getModel();
	models.registerProvider("fastfaux", { baseUrl: fm.baseUrl, api: fm.api, models: [{ id: fm.id, name: fm.name, api: fm.api, input: ["text"], cost: fm.cost, contextWindow: fm.contextWindow, maxTokens: fm.maxTokens, baseUrl: fm.baseUrl }], colors: null, docs: "" } as never);
	await models.setRuntimeApiKey("fastfaux", "faux-key");
	faux.setResponses([fauxAssistantMessage([fauxText("好")]) as never, fauxAssistantMessage([fauxText("好")]) as never]);
	let enabled = true;
	const session = await newSession("fast-switch");
	const tracker = attachFastMode(session, () => enabled);
	try {
		await promptSession(session, "先走中转");
		await settle(session);
		assert.equal(tracker.snapshot().status, "injected");

		await applyModelSettings(session, models, { provider: "fastfaux", id: "faux-fast" }, "off");
		await promptSession(session, "换到别的协议");
		await settle(session);
		assert.equal(tracker.snapshot().status, "unsupported-api", "实际模型协议不支持 → 不注入");
		assert.equal(tracker.snapshot().api, fm.api);
	} finally {
		await disposeSession(session);
	}
});

// ---------------------------------------------------------------- 状态：助理独立 / 子代理跟随与覆盖
function makeAgent(name: string, fast: number) {
	const id = uid("a");
	db.prepare("INSERT INTO agents(id, name, avatar, color, persona, sort, created_at, fast) VALUES(?,?,?,?,?,?,?,?)").run(id, name, "A", "#888", "", 0, now(), fast);
	return id;
}
function makeSubagent(agentId: string, fast: number | null) {
	const id = uid("s");
	db.prepare("INSERT INTO subagents(id, agent_id, conversation_id, task, model_provider, model_id, model_reason, status, last_activity_at, created_at, fast) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
		id, agentId, "c-test", "t", provider.id, "fast-relay", "test", "done", now(), now(), fast,
	);
	return id;
}

test("状态：助理之间互不污染；子代理默认跟随所属助理，可独立覆盖 / 恢复跟随", () => {
	const a = makeAgent("FastA", 1);
	const b = makeAgent("FastB", 0);
	assert.equal(agentFast(a), true);
	assert.equal(agentFast(b), false);
	assert.equal(agentFast("missing"), false);

	const follow = makeSubagent(a, null);
	assert.equal(resolveSubagentFast(a, null), true, "默认跟随助理");
	assert.equal(resolveSubagentFast(b, null), false);
	const off = makeSubagent(a, 0);
	assert.equal(resolveSubagentFast(a, 0), false, "独立关覆盖助理的开");
	const on = makeSubagent(b, 1);
	assert.equal(resolveSubagentFast(b, 1), true, "独立开覆盖助理的关");

	// 落库 + 恢复跟随（null）：重新读行，证明是持久化字段而不是内存值
	setSubagentFastOverride(off, null);
	assert.equal((db.prepare("SELECT fast FROM subagents WHERE id = ?").get(off) as { fast: number | null }).fast, null);
	assert.equal(resolveSubagentFast(a, (db.prepare("SELECT fast FROM subagents WHERE id = ?").get(off) as { fast: number | null }).fast), true);
	setSubagentFastOverride(on, false);
	assert.equal(resolveSubagentFast(b, 0), false);

	// 改子代理的 fast 不动所属助理的 fast（两个独立列）
	db.prepare("UPDATE agents SET fast = 0 WHERE id = ?").run(a);
	assert.equal(agentFast(a), false);
	setSubagentFastOverride(off, true);
	assert.equal(resolveSubagentFast(a, 1), true, "子代理覆盖生效");
	assert.equal(agentFast(a), false, "助理本身仍是关");
});
