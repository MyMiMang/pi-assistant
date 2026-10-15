/**
 * 按需工具发现（tool_search）+ codemode 批量编排：接入完整性与权限链验证。
 *
 * 用真实 PiSession（公开 SDK）+ 临时 stdio MCP 服务器 + 脚本化 faux provider，
 * 证明 MCP 服务的每种 exposure 对模型可见性、tool_search 命中后可用、codemode
 * 命名空间与授权范围，以及嵌套调用仍走 ext-approval（暂停 / 凭据 / 低档位 / 取消）。
 * 不依赖任何真实模型、真实凭据或外网。
 */
process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { approvalExtension } from "@pi-assistant/ext-approval";
const { config } = await import("../src/config.ts");
const modelsMod = await import("../src/models.ts");
const { createPiSession, disposeSession, promptSession } = await import("../src/pi-adapter/index.ts");

const FIXTURE = join(import.meta.dirname, "fixtures", "mock-mcp-discovery.mjs");
const PROVIDER = "fauxdisc";
const MODEL = "faux-disc";

type Msg = { role: string; content: unknown; toolName?: string; toolsAdded?: { name: string }[]; toolsRemoved?: ({ name?: string } | string)[] };
type Ctx = { messages: Msg[] };
const textOf = (m: Msg | undefined) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "");
/** 只在第一次模型步骤发出工具调用；已经拿到 toolResult 就收尾，避免无限循环。 */
const once = (ctx: Ctx, toolName: string, args: Record<string, unknown>) => (ctx.messages.some((m) => m.role === "toolResult") ? fauxAssistantMessage("完成") : fauxAssistantMessage([fauxToolCall(toolName, args as never)]));
/** 某个工具调用的结果文本（脚本输出 / 错误都在这里）。 */
const toolText = (session: { messages: readonly unknown[] }, name: string) => (session.messages as Msg[]).filter((m) => m.role === "toolResult" && m.toolName === name).map((m) => textOf(m)).join("\n");

/** 按顺序重放 system 消息的 toolsAdded / toolsRemoved，得到这一刻模型能看到的工具（带定义与字节数，后声明覆盖先声明，删除生效）。 */
function declaredTools(messages: Msg[]): { name: string; description: string; bytes: number }[] {
	const map = new Map<string, { name: string; description: string; bytes: number }>();
	for (const m of messages) {
		if (m.role !== "system") continue;
		for (const t of (m.toolsAdded ?? []) as { name: string; description?: string }[]) map.set(t.name, { name: t.name, description: t.description ?? "", bytes: Buffer.byteLength(JSON.stringify(t)) });
		for (const r of m.toolsRemoved ?? []) map.delete(typeof r === "string" ? r : (r.name ?? ""));
	}
	return [...map.values()];
}

/** 脚本化 faux provider：每次模型调用都记录当时声明的工具，再交给当前 plan 决定回复。 */
let currentPlan: (ctx: Ctx) => unknown = () => fauxAssistantMessage("no plan");
let fauxRef: ReturnType<typeof registerFauxProvider> | null = null;
let modelsInited = false;
/** 每次模型请求实际收到的工具声明（真实 provider 入参，不做任何估算）。 */
export const requestTools: { name: string; description: string; bytes: number }[][] = [];
function ensureProvider() {
	if (fauxRef) return fauxRef;
	const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: MODEL, name: "faux-disc", input: ["text"] } as never], tokensPerSecond: 10000 });
	const factory = (ctx: Ctx) => {
		requestTools.push(declaredTools(ctx.messages));
		faux.appendResponses([factory as never]);
		return currentPlan(ctx);
	};
	faux.setResponses([factory as never]);
	fauxRef = faux;
	return faux;
}
async function ensureModels(faux: ReturnType<typeof registerFauxProvider>) {
	if (modelsInited) return;
	await modelsMod.initModels();
	const m = faux.getModel();
	modelsMod.models.registerProvider(PROVIDER, {
		baseUrl: m.baseUrl,
		api: m.api,
		models: [{ id: m.id, name: m.name, api: m.api, reasoning: false, input: ["text"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl }],
	});
	await modelsMod.models.setRuntimeApiKey(PROVIDER, "x");
	modelsInited = true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 每个用例都限时 30s：脚本化的 faux provider 每轮都有界结束，超时即暴露卡死。 */
const t = (name: string, fn: () => Promise<void> | void) => test(name, { timeout: 30_000 }, fn);
/** MCP 服务器在 session_start 后台连接；工具声明/激活要等它连上。 */
async function waitForTool(session: { getActiveToolNames(): string[] }, name: string, ms = 12000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (session.getActiveToolNames().includes(name)) return true;
		await sleep(100);
	}
	return false;
}
async function settle(session: { isStreaming: boolean }, ms = 15000) {
	const end = Date.now() + ms;
	while (session.isStreaming && Date.now() < end) await sleep(50);
}

let seq = 0;
async function startSession(opts: { exposure?: string; mcp?: boolean; counter?: string; plan: (ctx: Ctx) => unknown; full?: () => boolean; asks?: { toolName: string }[]; approval?: boolean; enabled?: boolean; agents?: string[]; extraServers?: { name: string; config: Record<string, unknown> }[] }) {
	currentPlan = opts.plan;
	const faux = ensureProvider();
	await ensureModels(faux);
	const ws = join(config.workspaceRoot, `disc-${++seq}`);
	mkdirSync(ws, { recursive: true });
	const mcpServers = opts.mcp === false ? [] : [{ name: "demo", config: { type: "stdio", command: process.execPath, args: [FIXTURE], env: opts.counter ? { COUNTER_FILE: opts.counter } : undefined, exposure: opts.exposure ?? "direct", description: "验证用服务" } }, ...(opts.extraServers ?? [])];
	const extensions = opts.approval === false ? [] : [{ name: "approval", factory: approvalExtension({ workspace: ws, guard: { target: "host" }, hostAccess: () => opts.full?.() ?? false, request: async (r: { toolName: string }) => (opts.asks?.push({ toolName: r.toolName }), { approved: false }) }) }];
	const session = await createPiSession({
		models: modelsMod.models,
		cwd: ws,
		agentDir: join(config.agentsDir, `disc-${seq}`),
		sessionDir: join(config.agentsDir, `disc-${seq}`, "sessions"),
		model: { provider: PROVIDER, id: MODEL },
		systemPromptAppend: [],
		extensions,
		mcpServers,
	});
	return { session, faux, ws };
}

t("exposure=direct：MCP 工具直接声明给模型，无需 tool_search / codemode", async () => {
	const { session } = await startSession({ exposure: "direct", plan: (ctx) => once(ctx, "mcp__demo__get_weather", { city: "上海" }) });
	try {
		assert.ok(await waitForTool(session, "mcp__demo__get_weather"), `direct 工具应直接声明，实际：${session.getActiveToolNames().join(",")}`);
		assert.ok(!session.getActiveToolNames().includes("codemode"), "direct 不应激活 codemode");
		await promptSession(session, "查一下上海天气");
		await settle(session);
		assert.match(toolText(session, "mcp__demo__get_weather"), /晴，22°C/);
	} finally {
		disposeSession(session);
	}
});

t("exposure=deferred：默认只有 tool_search，命中后 MCP 工具进入声明并能真实调用", async () => {
	let step = 0;
	const { session } = await startSession({
		exposure: "deferred",
		plan: (ctx) => {
			step++;
			if (step === 1) return fauxAssistantMessage([fauxToolCall("tool_search", { query: "查询城市天气 weather" })]);
			const last = [...ctx.messages].reverse().find((m) => m.role === "toolResult" || m.role === "user");
			if (last?.toolName === "tool_search") return fauxAssistantMessage([fauxToolCall("mcp__demo__get_weather", { city: "北京" })]);
			return fauxAssistantMessage("done");
		},
	});
	try {
		assert.ok(await waitForTool(session, "tool_search"), `deferred 应激活 tool_search，实际：${session.getActiveToolNames().join(",")}`);
		assert.ok(!session.getActiveToolNames().includes("mcp__demo__get_weather"), "deferred 工具初始不应声明");
		await promptSession(session, "北京天气");
		await settle(session);
		assert.match(toolText(session, "mcp__demo__get_weather"), /晴，22°C/);
	} finally {
		disposeSession(session);
	}
});

t("exposure=codemode：脚本入口激活、命名空间正确、脚本可调用授权工具", async () => {
	const { session } = await startSession({
		exposure: "codemode",
		plan: (ctx) => once(ctx, "codemode", { code: "const r = await tools.mcp__demo__get_weather({ city: '广州' }); return r.content[0].text;" }),
	});
	try {
		assert.ok(await waitForTool(session, "codemode"), `codemode 应被激活，实际：${session.getActiveToolNames().join(",")}`);
		assert.ok(!session.getActiveToolNames().includes("mcp__demo__get_weather"), "codemode 暴露的工具不应直接声明");
		assert.ok(!session.getActiveToolNames().includes("tool_search"), "codemode 暴露不应激活 tool_search");
		await promptSession(session, "脚本查广州天气");
		await settle(session);
		assert.match(toolText(session, "codemode"), /晴，22°C/);
	} finally {
		disposeSession(session);
	}
});

t("exposure=hidden：既不声明也不可被 tool_search 搜到", async () => {
	let step = 0;
	const { session } = await startSession({
		exposure: "hidden",
		plan: () => (step++ === 0 ? fauxAssistantMessage([fauxToolCall("tool_search", { query: "天气 weather" })]) : fauxAssistantMessage("done")),
	});
	try {
		await sleep(2500); // 等服务器连接完成
		const active = session.getActiveToolNames();
		assert.ok(!active.includes("mcp__demo__get_weather"), "hidden 不应声明");
		assert.ok(!active.includes("tool_search"), "只有 hidden 服务器不应激活 tool_search");
		await promptSession(session, "搜索天气工具");
		await settle(session);
		const results = (session.messages as Msg[]).filter((m) => m.toolName === "tool_search").map((m) => textOf(m));
		assert.ok(results.every((t) => !t.includes("get_weather")), `hidden 工具不应出现在搜索结果：${results.join("|")}`);
	} finally {
		disposeSession(session);
	}
});

t("未启用的服务器：工具完全不出现（不声明、不可搜、脚本也调不到）", async () => {
	let step = 0;
	const { session } = await startSession({
		mcp: false,
		plan: () => (step++ === 0 ? fauxAssistantMessage([fauxToolCall("codemode", { code: "return typeof tools.mcp__demo__get_weather;" })]) : fauxAssistantMessage("done")),
	});
	try {
		await sleep(1500);
		const active = session.getActiveToolNames();
		assert.ok(!active.includes("codemode") && !active.includes("tool_search") && !active.includes("mcp__demo__get_weather"), `无 MCP 时不应激活发现类工具：${active.join(",")}`);
		await promptSession(session, "随便");
		await settle(session);
	} finally {
		disposeSession(session);
	}
});

t("嵌套 codemode 调用仍走 ext-approval：destructive 工具被拒后不执行（凭据/暂停同理）", async () => {
	const asks: { toolName: string }[] = [];
	const counter = join(config.workspaceRoot, `disc-counter-${++seq}.txt`);
	const { session } = await startSession({
		exposure: "codemode",
		counter,
		asks,
		plan: (ctx) => once(ctx, "codemode", { code: "const a = await tools.mcp__demo__get_weather({ city: '上海' }); await tools.mcp__demo__send_note({ to: 'x', text: 'y' }); return 'done';" }),
	});
	try {
		await promptSession(session, "先查天气再发便签");
		await settle(session);
		assert.ok(asks.some((a) => a.toolName === "mcp__demo__send_note"), "脚本里的 destructive MCP 调用应触发审批");
		assert.match(toolText(session, "codemode"), /拒绝/);
		const calls = existsSync(counter) ? readFileSync(counter, "utf8") : "";
		assert.ok(!calls.includes("send_note"), `被拒的 send_note 不应到达 MCP 服务器：${calls}`);
		assert.ok(calls.includes("get_weather"), "只读调用应已到达 MCP 服务器");
	} finally {
		disposeSession(session);
		if (existsSync(counter)) rmSync(counter);
	}
});

t("完全权限：应用层不弹审批，destructive MCP 调用直接执行", async () => {
	const asks: { toolName: string }[] = [];
	const { session } = await startSession({
		exposure: "codemode",
		asks,
		full: () => true,
		plan: (ctx) => once(ctx, "codemode", { code: "try { await tools.mcp__demo__send_note({ to: 'x', text: 'y' }); return 'sent'; } catch (e) { return 'ERR:' + e.message; }" }),
	});
	try {
		await promptSession(session, "完全权限下发便签");
		await settle(session);
		assert.equal(asks.length, 0, "完全权限不应创建审批请求");
		assert.match(toolText(session, "codemode"), /sent/);
	} finally {
		disposeSession(session);
	}
});

t("完全权限：凭据路径的嵌套调用仍被拒绝，不因脚本包装绕过", async () => {
	const { session } = await startSession({
		exposure: "codemode",
		full: () => true,
		plan: (ctx) => once(ctx, "codemode", { code: "try { await tools.bash({ command: 'cat ~/.aws/credentials' }); return 'ran'; } catch (e) { return 'ERR:' + e.message; }" }),
	});
	try {
		await promptSession(session, "完全权限下读凭据");
		await settle(session);
		assert.match(toolText(session, "codemode"), /ERR:|凭据|拒绝/);
		assert.ok(!toolText(session, "codemode").includes("ran"), "凭据命令不得真的执行");
	} finally {
		disposeSession(session);
	}
});

t("取消：脚本跑到一半被 abort，排在后面的副作用步骤不再执行", async () => {
	const counter = join(config.workspaceRoot, `disc-abort-${++seq}.txt`);
	const { session } = await startSession({
		exposure: "codemode",
		counter,
		full: () => true,
		plan: (ctx) => once(ctx, "codemode", { code: "await tools.mcp__demo__slow_read({}); await tools.mcp__demo__final_delete({}); return 'done';" }),
	});
	try {
		const p = promptSession(session, "慢慢来，先读后删");
		await sleep(700); // slow_read 还在睡
		(session as unknown as { abort?: () => void }).abort?.();
		await Promise.race([p.catch(() => {}), sleep(4000)]);
		await settle(session, 3000);
		const calls = existsSync(counter) ? readFileSync(counter, "utf8") : "";
		assert.ok(!calls.includes("final_delete"), `取消后 final_delete 不应执行：${calls}`);
	} finally {
		disposeSession(session);
		if (existsSync(counter)) rmSync(counter);
	}
});

t("脚本语法 / 未知工具：返回清楚错误，不假成功", async () => {
	const { session } = await startSession({
		exposure: "codemode",
		full: () => true,
		plan: (ctx) => once(ctx, "codemode", { code: "return await tools.mcp__demo__no_such_tool({});" }),
	});
	try {
		await promptSession(session, "调用不存在的工具");
		await settle(session);
		const t = toolText(session, "codemode");
		assert.match(t, /failed|error|Unknown|失败/i, `应报告失败：${t.slice(0, 200)}`);
	} finally {
		disposeSession(session);
	}
});

t("codemode 只可调用实际授权的工具：hidden 服务器不列出也不可调用", async () => {
	const start = requestTools.length;
	const { session } = await startSession({
		exposure: "codemode",
		extraServers: [{ name: "ghost", config: { type: "stdio", command: process.execPath, args: [FIXTURE], exposure: "hidden", description: "隐藏服务" } }],
		full: () => true,
		plan: (ctx) => once(ctx, "codemode", { code: "try { const r = await tools.mcp__ghost__get_weather({ city: 'x' }); return 'ok:' + JSON.stringify(r); } catch (e) { return 'ERR:' + e.message; }" }),
	});
	try {
		assert.ok(await waitForTool(session, "codemode"), "codemode 应被激活");
		await sleep(2000); // 等两个服务器都连上
		await promptSession(session, "脚本调隐藏工具");
		await settle(session);
		const out = toolText(session, "codemode");
		assert.match(out, /ERR:|Unknown/, `hidden 工具不应可调用：${out.slice(0, 200)}`);
		assert.ok(!out.includes("ok:"), "hidden 工具不应真的执行");
		const descs = requestTools
			.slice(start)
			.flat()
			.filter((t) => t.name === "codemode")
			.map((t) => t.description);
		assert.ok(descs.some((d) => d.includes("demo")), "codemode 描述应列出已授权命名空间");
		assert.ok(descs.every((d) => !d.includes("ghost")), "codemode 描述不应出现 hidden 服务器");
	} finally {
		disposeSession(session);
	}
});

t("采样真实 provider 请求里的工具声明（字节实数，不估算 token 节省）", async () => {
	const names = (a: { name: string }[]) => a.map((t) => t.name);
	const bytes = (a: { bytes: number }[]) => a.reduce((s, t) => s + t.bytes, 0);
	/** 一个会话会多次请求模型；按名字去重，只看声明的工具集合。 */
	const uniq = (a: { name: string; description: string; bytes: number }[]) => [...new Map(a.map((t) => [t.name, t])).values()];
	const d0 = requestTools.length;
	{
		const { session } = await startSession({ exposure: "direct", plan: (ctx) => once(ctx, "mcp__demo__get_weather", { city: "上海" }) });
		try {
			assert.ok(await waitForTool(session, "mcp__demo__get_weather"));
			await promptSession(session, "天气");
			await settle(session);
		} finally {
			disposeSession(session);
		}
	}
	const direct = uniq(requestTools.slice(d0).flat());
	const c0 = requestTools.length;
	{
		const { session } = await startSession({ exposure: "codemode", plan: (ctx) => once(ctx, "codemode", { code: "return 1;" }) });
		try {
			assert.ok(await waitForTool(session, "codemode"));
			await promptSession(session, "脚本");
			await settle(session);
		} finally {
			disposeSession(session);
		}
	}
	const codemode = uniq(requestTools.slice(c0).flat());
	assert.ok(names(direct).includes("mcp__demo__get_weather"), "direct 应直接声明 MCP 工具");
	assert.ok(!names(codemode).includes("mcp__demo__get_weather"), "codemode 不应声明 MCP 工具");
	assert.ok(names(codemode).includes("codemode"), "codemode 应声明脚本入口");
	// 只报告实测字节数，不推算 token / 不宣称节省比例
	console.log(`[采样] direct：声明 ${names(direct).length} 个工具 / ${bytes(direct)} 字节；codemode：声明 ${names(codemode).length} 个工具 / ${bytes(codemode)} 字节`);
});

t("deferred→tool_search 命中后直接调用：destructive 工具仍走 ext-approval（未被发现路径绕过）", async () => {
	const asks: { toolName: string }[] = [];
	const counter = join(config.workspaceRoot, `disc-deferred-${++seq}.txt`);
	let step = 0;
	const { session } = await startSession({
		exposure: "deferred",
		counter,
		asks,
		plan: (ctx) => {
			step++;
			if (step === 1) return fauxAssistantMessage([fauxToolCall("tool_search", { query: "发便签 send note" })]);
			if (step === 2) return fauxAssistantMessage([fauxToolCall("mcp__demo__send_note", { to: "x", text: "y" })]);
			return fauxAssistantMessage("完成");
		},
	});
	try {
		assert.ok(await waitForTool(session, "tool_search"), "deferred 应激活 tool_search");
		await promptSession(session, "找到并调用发便签工具");
		await settle(session);
		assert.ok(asks.some((a) => a.toolName === "mcp__demo__send_note"), "tool_search 装载的工具直接调用也必须过审批");
		const calls = existsSync(counter) ? readFileSync(counter, "utf8") : "";
		assert.ok(!calls.includes("send_note"), `被拒的 send_note 不应到达 MCP 服务器：${calls}`);
	} finally {
		disposeSession(session);
		if (existsSync(counter)) rmSync(counter);
	}
});
