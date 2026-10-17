/**
 * 真实 Pi（SDK）嵌套工具调用路径验证：`ctx.executeTool` 会走扩展的 `tool_call` 钩子，
 * 钩子返回 `{block:true}` 时底层工具**零执行**。
 *
 * 这是生产钩子证据（不是 stub）：用真实 `createAgentSession` + `DefaultResourceLoader` 内联扩展，
 * 注册一个会被计数的电脑工具 + 一个与 ext-computer 同样形态的守卫钩子，再经真实的
 * `extensionRunner.createToolContext(...).executeTool(...)`（即工具层用的 `ctx.executeTool`）调用，
 * 断言守卫拒绝时计数器为 0、没有守卫时为 1。
 *
 * 不碰真实桌面、不调付费模型（不做模型回合，只直接驱动嵌套调用路径）。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxProvider } from "@earendil-works/pi-ai/compat";
import { fastComputerExtension } from "../src/fast-computer/tool.ts";
import { saveFastComputerSettings } from "../src/fast-computer/index.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pia-fast-guard-"));
const faux = fauxProvider() as unknown as { models: unknown[]; getModel?: (p: string, id: string) => unknown };
const model = (faux.getModel?.("faux", "faux-1") ?? faux.models[0]) as never;

async function makeSession(opts: { block: boolean; fast?: boolean }) {
	const calls = { nested: 0, browser: 0, chooser: 0 };
	const ext = {
		name: "fast-guard-test",
		factory: (pi: { registerTool: (t: unknown) => void; on: (e: string, h: unknown) => void }) => {
			pi.registerTool({
				name: "mock_computer_click",
				label: "mock click",
				description: "counts nested invocations",
				parameters: { type: "object", properties: { element_token: { type: "string" } }, required: [] },
				execute: async () => {
					calls.nested++;
					return { content: [{ type: "text", text: "clicked" }], details: undefined };
				},
			});
			pi.registerTool({
				name: "browser_click",
				label: "mock browser click",
				description: "counts direct browser invocations",
				parameters: { type: "object", properties: { ref: { type: "string" } }, required: [] },
				execute: async () => { calls.browser++; return { content: [{ type: "text", text: "clicked" }], details: undefined }; },
			});
			pi.on("tool_call", async (event: { toolName: string }) => {
				if (opts.block && event.toolName === "mock_computer_click") return { block: true, reason: "guard says no" };
				return undefined;
			});
		},
	};
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [ext as never, ...(opts.fast ? [fastComputerExtension({ agentId: "routing-test", conversationId: null, taskId: null, chooserFor: () => { calls.chooser++; throw new Error("direct calls must not invoke fast chooser"); } })] : [])],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir,
		model,
		noTools: "all",
		tools: ["+mock_computer_click", "+browser_click", ...(opts.fast ? ["+fast_pick_action"] : [])],
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({} as never),
	});
	await session.bindExtensions({ onError: () => {} });
	// 嵌套调用需要一条 assistant 消息存在（真实路径由主模型回合提供）。
	(session.agent.state.messages as unknown[]).push(fauxAssistantMessage([fauxText("hi")]));
	const ctx = session.extensionRunner.createToolContext("parent-1", undefined);
	return { session, ctx, calls };
}

test("真实 Pi：快速模型已开启并注册，直接浏览器/桌面调用仍可执行，guard仍生效且不调用chooser", async () => {
	saveFastComputerSettings({ enabled: true, provider: "routing-test", id: "not-requested" });
	try {
		for (const block of [false, true]) {
			const { ctx, calls } = await makeSession({ block, fast: true });
			const browser = await ctx.executeTool("browser_click", { ref: "e12" }, { signal: undefined });
			const desktop = await ctx.executeTool("mock_computer_click", { element_token: "s1:9" }, { signal: undefined });
			assert.equal(browser.isError, false);
			assert.equal(calls.browser, 1);
			assert.equal(desktop.isError, block);
			assert.equal(calls.nested, block ? 0 : 1);
			assert.equal(calls.chooser, 0, "开关不能把直接调用改成快速模型调用");
		}
	} finally { saveFastComputerSettings({ enabled: false }); }
});

test("真实 Pi 嵌套路径：guard 拒绝 → 底层工具零执行", async () => {
	const { ctx, calls } = await makeSession({ block: true });
	const out = await ctx.executeTool("mock_computer_click", { element_token: "s1:9" }, { signal: undefined });
	assert.equal(calls.nested, 0, "guard 拒绝时底层工具不得执行");
	assert.equal(out.isError, true, "守卫拒绝应返回错误结果");
});

test("真实 Pi 嵌套路径：无 guard → 底层工具执行一次（正向对照）", async () => {
	const { ctx, calls } = await makeSession({ block: false });
	const out = await ctx.executeTool("mock_computer_click", { element_token: "s1:9" }, { signal: undefined });
	assert.equal(calls.nested, 1, "无守卫时应执行一次");
	assert.equal(out.isError, false);
});
