/**
 * Pi 1.3.0 的 resume 工具恢复语义回归（真实 Pi 会话，faux provider + 本地 fake MCP）。
 *
 * 背景：1.3.0 修了 #10785 —— resume 会恢复会话转录里记录的 active tools（`toolsAdded`），
 * 再把 `--tools +name/-name`（我们生产默认传 `["+grep","+find","+ls"]`，全是修饰符）叠加上去
 * （`usesDefaultTools = true`）。1.2.0 不恢复。这条行为变化可能让「当前策略已撤销/降级」的工具
 * 在 resume 后复活，属于最小权限回归风险，必须用真实会话实证，不能只看编译产物。
 *
 * 本用例只用公开 SDK：createPiSession（我们的 pi-adapter）+ stdio fake MCP + 本地 faux provider；
 * 临时目录 + 内存凭据，不碰真实云 / 用户数据 / 系统钥匙串。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { config } from "../src/config.ts";
import { themeDraftTool } from "../src/themes/tool.ts";
import { createPiSession, disposeSession, PiModels, promptSession, sessionFileOf, type AgentSession } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "mock-mcp-discovery.mjs");
const PROVIDER = "fauxrestore";
const MODEL = "faux-restore";

type Ctx = { messages: { role: string }[] };
const faux = registerFauxProvider({
	provider: PROVIDER,
	models: [{ id: MODEL, name: "工具恢复测试模型", input: ["text"] } as never],
	tokensPerSecond: 10000,
});
const respond = (ctx: Ctx) => {
	faux.appendResponses([respond as never]);
	void ctx;
	return fauxAssistantMessage("好的。");
};
faux.setResponses([respond as never]);

const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
const m = faux.getModel();
models.registerProvider(PROVIDER, { baseUrl: m.baseUrl, api: m.api, models: [{ id: MODEL, name: m.name, api: m.api, input: ["text"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl }], colors: null, docs: "" } as never);
await models.setRuntimeApiKey(PROVIDER, "faux-key");

/** 公开 AgentSession 方法：当前 active 工具名（模型真正看得到的集合）。 */
const getActiveToolNames = (s: AgentSession): string[] => s.getActiveToolNames();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(session: AgentSession, ms = 15000) {
	const end = Date.now() + ms;
	while (session.isStreaming && Date.now() < end) await sleep(50);
}
async function waitForTool(session: AgentSession, name: string, ms = 12000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (getActiveToolNames(session).includes(name)) return true;
		await sleep(100);
	}
	return false;
}
/** 有/无 MCP 服务器都能建的会话工厂；返回会话（调用方负责 dispose）。 */
let seq = 0;
async function session(opts: { sessionFile?: string; mcpExposure?: string | null; tools?: string[]; excludeTools?: string[]; inMemory?: boolean; customTools?: never[]; extensions?: { name: string; factory: never }[] }) {
	const name = `restore-${++seq}`;
	const ws = join(config.workspaceRoot, name);
	mkdirSync(ws, { recursive: true });
	const mcpServers = opts.mcpExposure === null ? [] : [{ name: "demo", config: { type: "stdio" as const, command: process.execPath, args: [FIXTURE], exposure: (opts.mcpExposure ?? "direct") as never, description: "恢复语义验证" } }];
	return createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, name),
		sessionDir: join(config.agentsDir, name, "sessions"),
		sessionFile: opts.sessionFile,
		model: { provider: PROVIDER, id: MODEL },
		systemPromptAppend: ["你是恢复语义测试助理。"],
		extensions: opts.extensions ?? [],
		mcpServers,
		...(opts.tools ? { tools: opts.tools } : {}),
		...(opts.excludeTools ? { excludeTools: opts.excludeTools } : {}),
		...(opts.inMemory ? { inMemorySession: true } : {}),
	});
}
/** 起一段会话、等 MCP 连上、跑一轮把 loadout 写进转录，返回会话文件。 */
async function recordRun(session: AgentSession, waitFor?: string) {
	if (waitFor) assert.ok(await waitForTool(session, waitFor), `MCP 工具应 active：${getActiveToolNames(session).join(",")}`);
	await promptSession(session, "你好");
	await settle(session);
	return sessionFileOf(session);
}

test("1.3 基线：resume 会恢复转录里记录的 active tools（生产默认 tools=[+grep,+find,+ls]）", async () => {
	const a = await session({ mcpExposure: "direct" });
	let file: string | undefined;
	try {
		const before = await recordRun(a, "mcp__demo__get_weather");
		const added = getActiveToolNames(a);
		console.log(`[恢复] 首段 active = ${added.join(",")}`);
		// 中途激活一个非默认工具（tool_search 默认 inactive），模拟会话内工具面变化
		(a as unknown as { setActiveToolsByName: (n: string[]) => void }).setActiveToolsByName([...added, "tool_search"]);
		await promptSession(a, "再来一次");
		await settle(a);
		file = before;
		console.log(`[恢复] 关闭前 active = ${getActiveToolNames(a).join(",")}`);
	} finally {
		await disposeSession(a);
	}
	assert.ok(file, "应落盘会话文件");
	const b = await session({ sessionFile: file, mcpExposure: "direct" });
	try {
		await sleep(3000); // 等 MCP 按 direct 重新注册
		const restored = getActiveToolNames(b);
		console.log(`[恢复] resume 后 active = ${restored.join(",")}`);
		assert.ok(restored.includes("tool_search"), "1.3.0 应从转录恢复已激活的工具（含 tool_search）");
		assert.ok(restored.includes("mcp__demo__get_weather"), "direct server 重连后，转录里记录的 MCP 工具也会从 pending 恢复为 active");
	} finally {
		await disposeSession(b);
	}
});

test("1.3 恢复语义保留：当前 eligible 的 deferred / codemode 工具也恢复（不把 1.3 特性清空）", async () => {
	const a = await session({ mcpExposure: "direct" });
	let file: string | undefined;
	try {
		file = await recordRun(a, "mcp__demo__get_weather");
	} finally {
		await disposeSession(a);
	}
	const b = await session({ sessionFile: file, mcpExposure: "deferred" });
	try {
		await sleep(3000);
		const active = getActiveToolNames(b);
		console.log(`[恢复] direct→deferred resume active = ${active.join(",")}`);
		// 仍注册、当前仍 eligible 的发现工具（deferred / codemode）保留恢复，否则 1.3 的「会话内激活的工具跨重启保持」
		// 会被完全关掉。真正的可见性边界在这里：仍是 deferred，模型直接可见的是恢复项，hidden / 已移除不注册就不会出现。
		assert.ok(active.some((n) => n.startsWith("mcp__demo__")), `deferred 工具应随转录恢复为 active：${active.join(",")}`);
	} finally {
		await disposeSession(b);
	}
});

test("1.3 风险①：MCP 由 direct 改 hidden，resume 不应把它的工具复活成 active", async () => {
	const a = await session({ mcpExposure: "direct" });
	let file: string | undefined;
	try {
		file = await recordRun(a, "mcp__demo__get_weather");
		assert.ok(getActiveToolNames(a).includes("mcp__demo__get_weather"), "direct 时工具应 active");
	} finally {
		await disposeSession(a);
	}
	const b = await session({ sessionFile: file, mcpExposure: "hidden" });
	try {
		await sleep(3000); // 等服务器按 hidden 连接完成
		const active = getActiveToolNames(b);
		console.log(`[恢复] direct→hidden resume active = ${active.join(",")}`);
		assert.ok(!active.includes("mcp__demo__get_weather"), `hidden 的工具不应在 resume 后复活：${active.join(",")}`);
	} finally {
		await disposeSession(b);
	}
});

test("1.3 风险②：MCP server 已被移除，resume 不应复活它的旧工具", async () => {
	const a = await session({ mcpExposure: "direct" });
	let file: string | undefined;
	try {
		file = await recordRun(a, "mcp__demo__get_weather");
	} finally {
		await disposeSession(a);
	}
	const b = await session({ sessionFile: file, mcpExposure: null });
	try {
		await sleep(1500);
		const active = getActiveToolNames(b);
		console.log(`[恢复] 移除 server 后 resume active = ${active.join(",")}`);
		assert.ok(!active.includes("mcp__demo__get_weather"), `已移除服务器未注册的工具不应复活：${active.join(",")}`);
	} finally {
		await disposeSession(b);
	}
});

test("1.3 缓解：excludeTools 在 resume 时确实过滤掉恢复项（合法公开 API）", async () => {
	const a = await session({ mcpExposure: "direct" });
	let file: string | undefined;
	try {
		file = await recordRun(a, "mcp__demo__get_weather");
	} finally {
		await disposeSession(a);
	}
	const b = await session({ sessionFile: file, mcpExposure: "direct", excludeTools: ["mcp__demo__get_weather"] });
	try {
		await sleep(3000);
		const active = getActiveToolNames(b);
		console.log(`[恢复] excludeTools 后 resume active = ${active.join(",")}`);
		assert.ok(!active.includes("mcp__demo__get_weather"), `excludeTools 应过滤恢复项：${active.join(",")}`);
	} finally {
		await disposeSession(b);
	}
});

test("1.3 缓解：纯工具名列表（受限会话）resume 只保留显式选择，不多不少", async () => {
	const a = await session({ mcpExposure: null, tools: ["read", "bash"] });
	let file: string | undefined;
	try {
		await promptSession(a, "你好");
		await settle(a);
		file = sessionFileOf(a);
		console.log(`[恢复] 受限会话 active = ${getActiveToolNames(a).join(",")}`);
	} finally {
		await disposeSession(a);
	}
	const b = await session({ sessionFile: file, mcpExposure: "direct", tools: ["read", "bash"] });
	try {
		await sleep(2000);
		const active = getActiveToolNames(b);
		console.log(`[恢复] 受限会话 resume active = ${active.join(",")}`);
		assert.ok(!active.includes("mcp__demo__get_weather"), "纯名字列表不恢复转录里的额外工具");
		assert.ok(!active.includes("tool_search"), "纯名字列表不恢复 tool_search");
		assert.ok(active.includes("read") && active.includes("bash"), "显式选择的工具应保留");
	} finally {
		await disposeSession(b);
	}
});

test("1.3 缓解：主题设计专用会话（tools=[theme_draft] 纯名字 + inMemory）只暴露该工具", async () => {
	const themeTool = themeDraftTool({ images: [], onAccepted() {} });
	const s = await createPiSession({
		models,
		cwd: join(config.workspaceRoot, "restore-theme"),
		agentDir: join(config.agentsDir, "restore-theme"),
		sessionDir: join(config.agentsDir, "restore-theme", "sessions"),
		model: { provider: PROVIDER, id: MODEL },
		systemPromptAppend: ["主题设计"],
		extensions: [],
		tools: ["theme_draft"],
		customTools: [themeTool] as never,
		minimalExtensions: true,
		inMemorySession: true,
	});
	try {
		await sleep(500);
		const active = getActiveToolNames(s);
		console.log(`[恢复] 主题会话 active = ${active.join(",")}`);
		assert.deepEqual(active, ["theme_draft"]);
	} finally {
		await disposeSession(s);
	}
});

test("续接旧对话：重建会话时新挂上的扩展工具（如刚加的邮箱）要进 active，受限会话不受影响", async () => {
	const probe = {
		name: "pia-probe",
		factory: ((pi: { registerTool: (t: unknown) => void }) =>
			pi.registerTool({ name: "probe_new_tool", label: "探针", description: "续接后新加的工具", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }) })) as never,
	};
	const a = await session({ mcpExposure: null });
	let file: string | undefined;
	try {
		file = await recordRun(a);
	} finally {
		await disposeSession(a);
	}
	const b = await session({ sessionFile: file, mcpExposure: null, extensions: [probe] });
	try {
		const active = getActiveToolNames(b);
		assert.ok(active.includes("probe_new_tool"), `新扩展工具应 active：${active.join(",")}`);
		assert.ok(!active.includes("tool_search"), "默认不启用的 tool_search 不被顺手打开");
		assert.ok(active.includes("read") && active.includes("grep"), "原有工具保留");
	} finally {
		await disposeSession(b);
	}
	const c = await session({ sessionFile: file, mcpExposure: null, extensions: [probe], tools: ["read", "bash"] });
	try {
		assert.ok(!getActiveToolNames(c).includes("probe_new_tool"), "纯名字列表的受限会话只保留显式选择");
	} finally {
		await disposeSession(c);
	}
});
