import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ToolBridge } from "../src/cli-agents/tool-bridge.ts";
import { join } from "node:path";
import { test } from "node:test";
import { AcpProcess, type AcpItem, type AcpProcessOptions, type AcpProfile } from "../src/cli-agents/acp-process.ts";
import { AcpInactivity, type AcpClock } from "../src/cli-agents/acp-inactivity.ts";
import { convertAcpUpdate, pickOnceOption } from "../src/cli-agents/acp-events.ts";
import { buildNativeAcpEnv, nativeAcpHome } from "../src/cli-agents/native-env.ts";
import { prepareGeminiWorkspace } from "../src/cli-agents/profiles/gemini.ts";
import { geminiProfile, codebuddyProfile } from "../src/cli-agents/native-profile.ts";

const fake = join(import.meta.dirname, "fixtures/fake-native-acp.mjs");
const waitFor = async (condition: () => boolean) => {
	for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, 10)); }
	throw new Error("假 ACP 未在三秒内达到预期状态");
};
async function run(scenario: string, extra: Partial<AcpProcessOptions> = {}, check?: (p: AcpProcess, items: AcpItem[], root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "native-acp-test-"));
	const log = join(root, "events.jsonl");
	const profile: AcpProfile = { ...geminiProfile, args: () => [fake] };
	const items: AcpItem[] = [];
	const proc = new AcpProcess({ profile, command: process.execPath, runsRoot: join(root, "runs"), dataDir: root, workDir: join(root, "work"), bridgeBaseUrl: "http://127.0.0.1:1", tools: [], ...extra, extraEnv: { FAKE_NATIVE_SCENARIO: scenario, FAKE_NATIVE_LOG: log, ...extra.extraEnv } });
	proc.attach({ onItem: (i) => items.push(i), onExit: () => {} });
	try {
		proc.start();
		assert.equal(proc.sendPrompt([{ type: "text", text: "persona from host" }], "model-b", undefined, [{ type: "text", text: "fresh history plus persona" }]), true);
		if (check) await check(proc, items, root);
		else await waitFor(() => items.some((i) => i.type === "result"));
		return { items, log: readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s)), initialize: proc.initializeResult };
	} finally { proc.shutdown(); await proc.done; assert.equal(proc.runDir, undefined); rmSync(root, { recursive: true, force: true }); }
}
const text = (items: AcpItem[]) => items.flatMap((i) => i.type === "text_delta" ? [i.text] : []).join("");

test("native profile：独立 HOME / env、Gemini空env和边界配置在启动前准备；人设仅在输入", async () => {
	const result = await run("meta", {}, async (_p, items, root) => {
		await waitFor(() => items.some((i) => i.type === "result"));
		const info = JSON.parse(text(items));
		assert.equal(info.env.HOME, nativeAcpHome(root, "gemini"));
		assert.equal(info.env.GEMINI_CLI_HOME, info.env.HOME);
		assert.deepEqual(info.settings.context.memoryBoundaryMarkers, []);
		assert.equal(readFileSync(join(root, "work/.gemini/.env"), "utf8"), "");
		assert.equal(info.cwd, realpathSync(join(root, "work")));
		assert.equal(info.argv.includes("persona from host"), false);
		assert.equal(info.prompt[0].text, "persona from host");
		assert.equal(info.mcp[0].type, "http");
		assert.match(info.mcp[0].headers[0].value, /^Bearer /);
	});
	assert.equal((result.initialize as { agentCapabilities: { loadSession: boolean } }).agentCapabilities.loadSession, true);
	assert.equal(result.log.find((x) => x.method === "session/set_config_option").params.configId, "chosen-model");
});

test("native正式availableModels目录使用session/set_model，不虚构config option", async () => {
 const result = await run("legacy-models");
 assert.equal(result.log.find(entry => entry.method === "session/set_model")?.params.modelId, "model-b");
 assert.ok(!result.log.some(entry => entry.method === "session/set_config_option"));
});

test("隔离环境覆盖Windows大小写键和extra中的目录；模型密钥 / 父级配置不继承", () => {
	const e = buildNativeAcpEnv({ id: "codebuddy", dataDir: "/private", realHome: "/real", platform: "win32", baseEnv: { Home: "/real", UserProfile: "/real", AppData: "/user", XDG_RUNTIME_DIR: "/user/runtime", CODEBUDDY_IS_SANDBOX: "1", OPENAI_API_KEY: "secret", GEMINI_API_KEY: "secret" }, extra: { HOME: "/escape" } });
	assert.equal(e.HOME, "/private/cli-agents/codebuddy/home");
	for (const k of ["Home", "UserProfile", "AppData", "XDG_RUNTIME_DIR", "CODEBUDDY_IS_SANDBOX", "OPENAI_API_KEY", "GEMINI_API_KEY"]) assert.equal(e[k], undefined);
	const cb = codebuddyProfile.env({ dataDir: "/private", command: "/bin/codebuddy", runDir: "/private/run" });
	assert.equal(cb.CODEBUDDY_DISABLE_PARENT_MEMORY, "1");
	assert.equal(cb.CODEBUDDY_DISABLE_AUTO_MEMORY, "1");
	assert.deepEqual(codebuddyProfile.args("/w"), ["--acp", "--setting-sources", "user", "--strict-mcp-config", "--permission-mode", "default", "--subagent-permission-mode", "default"]);
	assert.deepEqual(codebuddyProfile.runFiles({ systemPrompt: "do not replace" }), []);
});

test("Gemini现有非空env不覆盖，启动失败不留下运行目录；native command必须绝对路径", async () => {
	const root = mkdtempSync(join(tmpdir(), "native-prep-"));
	try {
		prepareGeminiWorkspace(root, root);
		const settingsPath = join(nativeAcpHome(root, "gemini"), ".gemini/settings.json");
		writeFileSync(settingsPath, JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } }, context: { fileName: "CUSTOM.md", memoryBoundaryMarkers: ["old"] }, advanced: { custom: true } }));
		prepareGeminiWorkspace(root, root);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { security: { auth: { selectedType: "oauth-personal" } }, context: { fileName: "CUSTOM.md", memoryBoundaryMarkers: [] }, advanced: { custom: true, ignoreLocalEnv: true } });
		assert.deepEqual(geminiProfile.args(root), ["--acp", "--approval-mode", "default"]);
		writeFileSync(join(root, ".gemini/.env"), "KEEP");
		assert.throws(() => prepareGeminiWorkspace(root, root), /必须为空/);
		assert.equal(readFileSync(join(root, ".gemini/.env"), "utf8"), "KEEP");
		const p = new AcpProcess({ profile: geminiProfile, command: "gemini", runsRoot: join(root, "runs"), dataDir: root, workDir: root, bridgeBaseUrl: "http://127.0.0.1:1", tools: [] });
		assert.throws(() => p.start(), /绝对路径/);
		assert.equal(existsSync(join(root, "runs")), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("native审批：只接受当前请求的一次性选项；无回调、永久授权、异常均拒绝", async () => {
	for (const picked of ["once", "always", "no", undefined]) {
		const r = await run("permission", { requestPermission: async () => picked });
		assert.equal(JSON.parse(text(r.items)).outcome.optionId, picked === "once" ? "once" : "no");
	}
	assert.equal(JSON.parse(text((await run("permission")).items)).outcome.optionId, "no");
	assert.equal(JSON.parse(text((await run("permission", { requestPermission: async () => { throw new Error("no"); } })).items)).outcome.optionId, "no");
	assert.equal(pickOnceOption([{ optionId: "always", kind: "allow_always" }], "allow_once"), undefined);
});

test("缺allow_once、错误会话或不完整请求直接拒绝，不调用宿主", async () => {
	for (const scenario of ["no-once", "bad-session", "malformed"]) {
		let count = 0;
		const r = await run(scenario, { requestPermission: async () => { count++; return "once"; } });
		assert.equal(count, 0);
		assert.equal(JSON.parse(text(r.items)).outcome.optionId, "no");
	}
});

test("异步审批期间notification不阻塞；停止取消审批，迟到批准不再次回包", async () => {
	let done!: (v: string) => void;
	let signal: AbortSignal | undefined;
	const r = await run("permission", { requestPermission: (_p, s) => { signal = s; return new Promise((resolve) => { done = resolve; }); } }, async (p) => {
		await waitFor(() => !!signal);
		p.abort();
		assert.equal(signal!.aborted, true);
		done("once");
		await p.done;
	});
	const replies = r.log.filter((v) => v.permissionReply);
	assert.equal(replies.length, 1);
	assert.equal(replies[0].permissionReply.result.outcome.outcome, "cancelled");
	assert.equal(r.log.some((v) => v.method === "session/cancel"), true);
});

test("批准回调返回时再次读取暂停状态，暂停后不能允许", async () => {
	let paused = false;
	const r = await run("permission", { isPaused: () => paused, requestPermission: async () => { paused = true; return "once"; } });
	assert.equal(JSON.parse(text(r.items)).outcome.optionId, "no");
});

test("原生工具是独立补丁事件，标题含pia也不生成Pi工具调用；保留乱序和未提供字段", async () => {
	const r = await run("tools");
	const events = r.items.filter((i) => i.type === "native_tool");
	assert.equal(events.length, 3);
	assert.equal(events[0].status, "in_progress");
	assert.equal(events[0].title, undefined);
	assert.equal(events[1].title, "pia_native-name");
	assert.equal(events[2].status, "completed");
	assert.ok(events.every((e) => e.runId && e.sessionId === "native-session" && e.id === "native-1"));
	assert.equal(r.items.filter((i) => i.type === "tool_call").length, 0);
	const parsed = convertAcpUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "x", rawOutput: "x".repeat(30000) } }, "pia_", "native");
	assert.equal((parsed[0] as { rawOutput: string }).rawOutput.length, 16384);
	const content = [{ type: "content", content: { type: "text", text: "first" } }, { type: "content", content: { type: "text", text: "second" } }];
	const blocks = convertAcpUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "x", content } }, "pia_", "native");
	assert.deepEqual((blocks[0] as { content: unknown[] }).content, content);
});

test("原生步骤与真实HTTP桥调用混合：原生0次Pi调用，桥仅执行一次并回填", async () => {
	const bridge = new ToolBridge();
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const run = bridge.authorize(req.url!.split("/").pop()!, req.headers.authorization?.replace(/^Bearer /, ""));
		if (!run) { res.writeHead(401).end(); return; }
		const reply = await run.handleMessage(JSON.parse(Buffer.concat(chunks).toString()));
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try {
		const r = await run("mixed", { bridge, bridgeBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] }, async (p, items) => {
			await waitFor(() => items.some((i) => i.type === "tools_ready"));
			const calls = items.filter((i) => i.type === "tool_call");
			assert.equal(calls.length, 1);
			assert.equal(calls[0].name, "echo");
			p.resolveTool(calls[0].key, { content: [{ type: "text", text: "echo-result" }] });
			await waitFor(() => items.some((i) => i.type === "result"));
		});
		assert.equal(r.items.filter((i) => i.type === "native_tool").length, 3);
		assert.equal(r.items.filter((i) => i.type === "tool_call").length, 1);
		assert.match(text(r.items), /echo-result/);
	} finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test("load期间回放抑制和历史工具去重；无load新建且用完整输入；无http协商stdio",  async () => {
	const r = await run("meta", { sessionId: "restored" });
	assert.equal(text(r.items).includes("OLD"), false);
	assert.equal(r.items.some((i) => i.type === "native_tool"), false);
	assert.equal(r.log.filter((x) => x.method === "session/load").length, 1);
	assert.equal(r.log.some((x) => x.method === "session/resume"), false);
	const fresh = await run("no-load", { sessionId: "restored" });
	assert.equal(fresh.log.some((x) => x.method === "session/new"), true);
	assert.equal(fresh.log.some((x) => x.method === "session/load" || x.method === "session/resume"), false);
	assert.equal(JSON.parse(text(fresh.items)).prompt[0].text, "fresh history plus persona");
	const stdio = await run("no-http", { sessionId: "restored" }, async (p, items) => {
  await waitFor(() => items.some(i => i.type === "result"));
  const file = join(p.runDir!, "tool-bridge.json");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).token, p.bridgeRun.token);
 });
	assert.equal(stdio.items.some((i) => i.type === "result" && i.isError), false);
	const definition = stdio.log.find(x => x.method === "session/load").params.mcpServers[0];
	assert.equal(definition.type, undefined);
	assert.equal(definition.command, process.execPath);
	assert.equal(definition.args.length, 2);
	assert.equal(definition.args.some((arg: string) => arg.includes("Bearer")), false);
	assert.equal(existsSync(definition.args[1]), false, "运行结束删除含令牌文件");
	assert.equal((await run("no-config")).log.some((x) => x.method === "session/set_config_option"), false);
});

class FakeClock implements AcpClock {
	time = 0;
	next = 0;
	timers = new Map<number, { at: number; cb: () => void }>();
	now = () => this.time;
	setTimeout = (cb: () => void, ms: number) => { const id = ++this.next; this.timers.set(id, { at: this.time + ms, cb }); return id as unknown as ReturnType<typeof setTimeout>; };
	clearTimeout = (timer: ReturnType<typeof setTimeout>) => { this.timers.delete(timer as unknown as number); };
	advance(ms: number) { this.time += ms; for (const [id, t] of [...this.timers]) if (t.at <= this.time) { this.timers.delete(id); t.cb(); } }
}

test("注入时钟：无事件阈值取消；新事件重计，审批等待暂停，结束清定时器", () => {
	const clock = new FakeClock();
	let waiting = false;
	let cancels = 0;
	const guard = new AcpInactivity(600000, () => waiting, () => cancels++, clock);
	guard.start(); clock.advance(500000); guard.activity(); clock.advance(500000);
	assert.equal(cancels, 0);
	waiting = true; clock.advance(900000); assert.equal(cancels, 0);
	waiting = false; guard.activity(); clock.advance(599999); assert.equal(cancels, 0);
	clock.advance(1); assert.equal(cancels, 1);
	guard.start(); guard.stop(); assert.equal(clock.timers.size, 0);
});

test("native异步审批超过无事件阈值继续等待，批准后恢复计时", async () => {
	const clock = new FakeClock();
	let approve!: (v: string) => void;
	let requested = false;
	const r = await run("permission", { clock, inactivityMs: 100, requestPermission: () => { requested = true; return new Promise((resolve) => { approve = resolve; }); } }, async (_p, items) => {
		await waitFor(() => requested);
		clock.advance(1000);
		assert.equal(items.some((i) => i.type === "result"), false);
		approve("once");
		await waitFor(() => items.some((i) => i.type === "result"));
	});
	assert.equal(JSON.parse(text(r.items)).outcome.optionId, "once");
	assert.equal(clock.timers.size, 0);
});

test("native运行无事件达到注入阈值会发cancel，拒绝并发prompt", async () => {
	const clock = new FakeClock();
	const r = await run("hang", { clock, inactivityMs: 100 }, async (p, items) => {
		await waitFor(() => text(items) === "started");
		assert.equal(p.sendPrompt([], "model-a", undefined), false);
		clock.advance(100);
		await p.done;
	});
	assert.equal(r.items.filter((i) => i.type === "result").length, 1);
	assert.equal(r.items.some((i) => i.type === "result" && i.stopReason === "inactivity"), true);
	assert.equal(r.log.some((x) => x.method === "session/cancel"), true);
});
