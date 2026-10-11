/**
 * Pi 兼容性测试：只通过 pi-adapter 使用 Pi，验证我们依赖的 Pi 能力都还在。
 * CI 的 pi-latest 工作流会把 Pi 升到最新版后运行这些测试。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { approvalExtension } from "@huhao/ext-approval";
import { deliveryExtension } from "@huhao/ext-delivery";
import { sandboxExtension } from "@huhao/ext-sandbox";
import { config } from "../src/config.ts";
import { checkPiCompat, createPiSession, lastAssistantText, makeBashTool, PiModels, promptSession, subscribeSession, type AgentEvent } from "../src/pi-adapter/index.ts";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "../src/pi-adapter/mock-provider.ts";
import { EncryptedCredentialStore } from "../src/secrets.ts";

const models = await PiModels.create({ credentials: new EncryptedCredentialStore(), modelsPath: null, allowNetwork: false });
await registerMockProvider(models);

test("版本检查可用", () => {
	const c = checkPiCompat();
	assert.match(c.version, /^\d+\.\d+\.\d+/);
});

test("provider 目录由 Pi 动态提供（含 API Key 与订阅登录）", () => {
	const ps = models.listProviders();
	assert.ok(ps.length >= 20, `provider 数量 ${ps.length}`);
	assert.ok(ps.some((p) => p.apiKey), "至少有 API Key 登录");
	assert.ok(ps.some((p) => p.oauth?.isSubscription), "至少有订阅登录");
	assert.ok(models.listModels().length > 50);
});

test("通用登录交互：API Key 通过 prompt 写入加密存储", async () => {
	const prompts: string[] = [];
	await models.login("deepseek", "api_key", {
		prompt: async (p) => (prompts.push(p.type), "sk-test"),
		notify: () => {},
	});
	assert.deepEqual(prompts, ["secret"]);
	assert.ok(models.listProviders().find((p) => p.id === "deepseek")?.configured);
	await models.logout("deepseek");
});

test("会话：流式事件、扩展工具、审批拦截、文件交付", async () => {
	const ws = join(config.workspaceRoot, "compat");
	mkdirSync(ws, { recursive: true });
	const approvals: string[] = [];
	const delivered: string[] = [];
	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, "compat"),
		sessionDir: join(config.agentsDir, "compat", "sessions"),
		model: { provider: MOCK_PROVIDER, id: MOCK_MODEL },
		systemPromptAppend: ["test"],
		extensions: [
			{ name: "sandbox", factory: sandboxExtension({ workspace: ws, mode: "workspace", makeBashTool: makeBashTool as never }) },
			{ name: "approval", factory: approvalExtension({ workspace: ws, request: async (r) => (approvals.push(r.toolName), { approved: false }) }) },
			{ name: "delivery", factory: deliveryExtension({ deliverFile: async (p) => (delivered.push(p), { fileId: "f1", name: p }), ask: async () => "A" }) },
		],
	});
	const events: AgentEvent["type"][] = [];
	subscribeSession(session, (e) => events.push(e.type));
	await promptSession(session, "帮我生成报告");
	assert.deepEqual(delivered, ["report.md"]);
	assert.ok(events.includes("text_delta") && events.includes("tool_start") && events.includes("settled"));
	await promptSession(session, "删除旧文件");
	assert.deepEqual(approvals, ["bash"]);
	assert.match(lastAssistantText(session), /没有获得批准/);
	session.dispose();
});
