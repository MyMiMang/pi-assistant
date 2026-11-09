/** 真正经过 Pi session / 公共 stream hook / HTTP 工具桥的 native 渠道测试；只运行假 ACP。 */
import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createPiSession, defineTool, disposeSession, lastAssistantText, PiModels, promptSession, Type } from "../src/pi-adapter/index.ts";
import { createNativeAcpChannel, registerNativeAcpProvider, registerNativeProvider, type NativeAcpSpec } from "../src/pi-adapter/cli-models/native.ts";
import { registerNativeSessionContext, releaseNativeSessionContext } from "../src/pi-adapter/cli-models/session-context.ts";
import { codebuddyProfile } from "../src/cli-agents/profiles/codebuddy.ts";
import { mountToolBridgeRoutes } from "../src/routes/tool-bridge.ts";
import type { Env } from "../src/routes/common.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-native-acp.mjs");
const spec: NativeAcpSpec = { provider: "test-native", name: "Fake Native", profile: { ...codebuddyProfile, prepare: undefined }, sessionPolicy: "test-v1" };
const modelSpec = { id: "default", name: "工具默认模型", reasoning: false, image: false, contextWindow: 32_000, maxTokens: 8_000 };
let server: ReturnType<typeof serve>;
let baseUrl = "";
before(async () => {
	const app = new Hono<Env>();
	mountToolBridgeRoutes(app);
	server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	await new Promise<void>((r) => server.once("listening", r));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { (server as import("node:http").Server).closeAllConnections(); server.close(); });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean) {
	for (let i = 0; i < 500; i++) { if (check()) return; await pause(10); }
	throw new Error("假 ACP 清理超时");
}
async function fixture(t: TestContext, scenario = "meta") {
	const dir = mkdtempSync(join(tmpdir(), "pia-native-channel-"));
	const workspace = join(dir, "workspace");
	mkdirSync(workspace);
	const log = join(dir, "rpc.jsonl");
	const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
	const deps = { dataDir: dir, bridgeBaseUrl: () => baseUrl, command: () => FAKE, extraEnv: () => ({ FAKE_NATIVE_SCENARIO: scenario, FAKE_NATIVE_LOG: log }) };
	const channel = await registerNativeAcpProvider(models, spec, { ...deps, models: [modelSpec] });
	const sessions: Awaited<ReturnType<typeof createPiSession>>[] = [];
	const offs: Array<() => void> = [];
	let cancelled = 0;
	let paused = false;
	const pauses = new Set<() => void>();
	const permissions: unknown[] = [];
	const context = {
		workspace,
		requestPermission: async (params: unknown) => { permissions.push(params); return "once"; },
		isPaused: () => paused,
		cancelPending: () => { cancelled++; },
		onPause: (cb: () => void) => { pauses.add(cb); return () => { pauses.delete(cb); }; },
	};
	const bind = (key: string) => { const off = registerNativeSessionContext(key, context); offs.push(off, () => releaseNativeSessionContext(key)); };
	const session = async (ran: string[] = [], provider = spec.provider) => {
		const echo = defineTool({ name: "echo", label: "回显", description: "回显", parameters: Type.Object({ text: Type.String() }), execute: async (_id, p) => { ran.push(p.text); return { content: [{ type: "text", text: `ECHO:${p.text}` }], details: {} }; } });
		const s = await createPiSession({ models, cwd: workspace, agentDir: join(dir, "agent"), sessionDir: join(dir, "sessions"), model: { provider, id: "default" }, thinking: "off", systemPromptAppend: ["人设唯一标记：我是测试助理"], extensions: [], tools: ["echo"], customTools: [echo] as never, minimalExtensions: true, inMemorySession: true });
		sessions.push(s);
		bind(s.sessionId);
		return s;
	};
	t.after(async () => {
		for (const s of sessions) await disposeSession(s);
		for (const off of offs) off();
		channel.disposeAll();
		const runs = join(dir, "cli-models");
		await until(() => !existsSync(runs) || readdirSync(runs).filter((d) => d.endsWith("-runs")).every((d) => readdirSync(join(runs, d)).length === 0));
		rmSync(dir, { recursive: true, force: true });
	});
	const logs = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	return { dir, workspace, models, deps, channel, session, logs, permissions, bind, pauses, cancelled: () => cancelled, setPaused: () => { paused = true; for (const cb of pauses) cb(); } };
}

const promptText = (blocks: Array<{ type: string; text?: string }>) => blocks.map((b) => b.text ?? "").join("\n");
const directModel = (): Model<string> => ({ ...modelSpec, api: "test-native-acp-native", provider: spec.provider, baseUrl: "test://local", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) as Model<string>;
const context = (tools = true) => normalizeContext({ systemPrompt: "persona", messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: tools ? [{ name: "echo", description: "回显", parameters: Type.Object({ text: Type.String() }) }] : [] });
async function direct(ch: ReturnType<typeof createNativeAcpChannel>, key?: string, tools = true): Promise<AssistantMessage> {
	const stream = ch.streamSimple(directModel() as never, context(tools), { sessionId: key });
	for await (const _ of stream) { /* drain */ }
	return stream.result();
}

test("真实 Pi 会话：默认模型不切换，workspace正确，人设只首条；第二轮仅新增输入复用同进程", async (t) => {
	const f = await fixture(t);
	const s = await f.session();
	await promptSession(s, "第一句");
	const first = JSON.parse(lastAssistantText(s));
	assert.equal(first.cwd, realpathSync(f.workspace));
	assert.match(promptText(first.prompt), /人设唯一标记/);
	assert.match(promptText(first.prompt), /Pi 工具/);
	await promptSession(s, "第二句");
	const second = JSON.parse(lastAssistantText(s));
	assert.equal(promptText(second.prompt), "第二句");
	assert.equal(f.logs().filter((l) => l.method === "initialize").length, 1);
	assert.equal(f.logs().filter((l) => l.method === "session/set_config_option").length, 0);
	assert.equal(f.channel.liveCount(), 0);
});

test("真实 Pi 会话：原生步骤只透传，Pi MCP工具仅执行一次且同轮回填", async (t) => {
	const f = await fixture(t, "mixed");
	const ran: string[] = [];
	const s = await f.session(ran);
	const native: any[] = [];
	s.agent.onProviderStreamEvent = (event) => { if ((event as any).type === "native_tool") native.push(event); };
	await promptSession(s, "执行并回显");
	assert.deepEqual(ran, ["bridge"]);
	assert.match(lastAssistantText(s), /ECHO:bridge/);
	assert.equal(native.length, 3);
	assert.equal(native[0].update, "update");
	assert.ok(native.every((e) => e.runId && e.sessionId));
	const msgs = s.messages as any[];
	const calls = msgs.filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((b: any) => b.type === "toolCall"));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "echo");
	assert.equal(msgs.filter((m) => m.role === "toolResult").length, 1);
	assert.equal(f.logs().filter((l) => l.method === "session/prompt").length, 1);
});

test("原生权限请求交给当前Pi会话宿主，不走旧渠道默认允许", async (t) => {
	const f = await fixture(t, "permission");
	const s = await f.session();
	await promptSession(s, "写文件");
	assert.equal(f.permissions.length, 1);
	assert.match(lastAssistantText(s), /selected.*once/);
});

test("重新创建渠道后session/load，不resume、不重复人设或load回放", async (t) => {
	const f = await fixture(t);
	const s = await f.session();
	await promptSession(s, "第一句");
	f.channel.disposeAll();
	await until(() => f.pauses.size === 0);
	const ch = await registerNativeAcpProvider(f.models, spec, { ...f.deps, models: [modelSpec] });
	t.after(() => ch.disposeAll());
	await promptSession(s, "第二句");
	assert.equal(promptText(JSON.parse(lastAssistantText(s)).prompt), "第二句");
	assert.equal(f.logs().filter((l) => l.method === "session/load").length, 1);
	assert.equal(f.logs().filter((l) => l.method === "session/resume").length, 0);
	assert.doesNotMatch(lastAssistantText(s), /OLD/);
	ch.disposeAll();
	await until(() => f.pauses.size === 0);
});

test("没有load能力时协商新建，带完整历史和首条人设，不调用resume",  async (t) => {
	const f = await fixture(t, "no-load");
	const s = await f.session();
	await promptSession(s, "第一句");
	f.channel.disposeAll();
	await until(() => f.pauses.size === 0);
	const ch = await registerNativeAcpProvider(f.models, spec, { ...f.deps, models: [modelSpec] });
	t.after(() => ch.disposeAll());
	await promptSession(s, "第二句");
	const sent = promptText(JSON.parse(lastAssistantText(s)).prompt);
	assert.match(sent, /人设唯一标记/);
	assert.match(sent, /用户：第一句/);
	assert.match(sent, /第二句/);
	assert.equal(f.logs().filter((l) => l.method === "session/new").length, 2);
	assert.equal(f.logs().filter((l) => l.method === "session/prompt").length, 2);
	assert.equal(f.logs().filter((l) => l.method === "session/resume").length, 0);
	ch.disposeAll();
	await until(() => f.pauses.size === 0);
});

test("缺上下文、无工具总结、相对命令路径与暂停均拒绝且不起进程", async (t) => {
	const f = await fixture(t);
	assert.match((await direct(f.channel, "missing")).errorMessage ?? "", /缺少原生会话上下文/);
	f.bind("key");
	assert.match((await direct(f.channel, "key", false)).errorMessage ?? "", /单次总结/);
	const ch = createNativeAcpChannel(spec, { ...f.deps, command: () => "fake-native-acp" });
	t.after(() => ch.disposeAll());
	assert.match((await direct(ch, "key")).errorMessage ?? "", /绝对命令路径/);
	const { command: _command, ...unconfigured } = f.deps;
	const noCommand = createNativeAcpChannel(spec, unconfigured as never);
	t.after(() => noCommand.disposeAll());
	assert.match((await direct(noCommand, "key")).errorMessage ?? "", /绝对命令路径/);
	f.setPaused();
	assert.match((await direct(f.channel, "key")).errorMessage ?? "", /已暂停/);
	assert.equal(f.logs().length, 0);
});

test("原生轮运行中暂停：进程被取消，待审批清理，暂停订阅释放", async (t) => {
	const f = await fixture(t, "hang");
	const s = await f.session();
	const running = promptSession(s, "等");
	await until(() => f.logs().some((l) => l.method === "session/prompt"));
	f.setPaused();
	await running;
	await until(() => f.pauses.size === 0);
	assert.ok(f.cancelled() > 0);
	assert.equal(f.channel.liveCount(), 0);
});

test("释放宿主上下文叠加关闭原生进程，保留并调用其他宿主cleanup", async (t) => {
	const f = await fixture(t);
	const s = await f.session();
	const { addNativeSessionCleanup } = await import("../src/pi-adapter/cli-models/session-context.ts");
	let hostCleaned = 0;
	addNativeSessionCleanup(s.sessionId, () => { hostCleaned++; });
	await promptSession(s, "你好");
	assert.equal(hostCleaned, 0, "创建原生进程不能提前触发宿主cleanup");
	releaseNativeSessionContext(s.sessionId);
	await until(() => f.pauses.size === 0);
	assert.equal(hostCleaned, 1);
	assert.ok(f.cancelled() > 0);
});

test("Gemini/CodeBuddy注册仅default且不启动探测；实际Pi会话使用Gemini默认模型", async (t) => {
	const f = await fixture(t);
	const channels = await Promise.all(["gemini-cli", "codebuddy-cli"].map((id) => registerNativeProvider(f.models, id as "gemini-cli" | "codebuddy-cli", f.deps)));
	t.after(() => channels.forEach((ch) => ch.disposeAll()));
	for (const id of ["gemini-cli", "codebuddy-cli"]) {
		const list = f.models.listModels(id);
		assert.deepEqual(list.map((m) => m.id), ["default"]);
		assert.match(list[0].name, /工具默认模型/);
		assert.deepEqual(list[0].input, ["text"]);
	}
	assert.equal(f.logs().length, 0);
	const s = await f.session([], "gemini-cli");
	await promptSession(s, "你好");
	assert.equal(JSON.parse(lastAssistantText(s)).cwd, realpathSync(f.workspace));
	assert.equal(f.logs().filter((l) => l.method === "session/set_config_option").length, 0);
	channels.forEach((ch) => ch.disposeAll());
	await until(() => f.pauses.size === 0);
});
