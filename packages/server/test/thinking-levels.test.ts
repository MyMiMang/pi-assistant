/**
 * 推理档位回归：自定义服务的模型若和 Pi 内置目录里的同名模型一致，就照搬 Pi 的 thinkingLevelMap，
 * 让界面档位（getSupportedThinkingLevels）、切换 clamp 和真正发出去的 reasoning 参数三者一致，
 * 含 xhigh / max；认不出来的模型保持 Pi 默认档位，不凭空补。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { startMockOpenAI } from "../../../e2e/mock-openai.mjs";
import { config } from "../src/config.ts";
import { customProviders, initModels, models } from "../src/models.ts";
import { createPiSession, lastAssistantText, promptSession } from "../src/pi-adapter/index.ts";

const relay = await startMockOpenAI({ port: 0, key: "sk-unit" });
after(() => relay.close());
await initModels();

test("自定义服务：档位来自 Pi 内置目录（gpt-6.1-sol 有 xhigh / max），认不出的模型不凭空补", async () => {
	const p = await customProviders.save(null, {
		name: "档位测试",
		api: "openai-completions",
		baseUrl: relay.url,
		apiKey: "sk-unit",
		models: [{ id: "gpt-6.1-sol", reasoning: true }, { id: "my-private-model", reasoning: true }],
	});
	try {
		const by = Object.fromEntries(models.listModels(p.id).map((m) => [m.id, m]));
		assert.deepEqual(by["gpt-6.1-sol"].thinking, ["low", "medium", "high", "xhigh", "max"]);
		assert.deepEqual(by["my-private-model"].thinking, ["off", "minimal", "low", "medium", "high"], "目录里没有的模型保持 Pi 默认档位，不凭空补");
		// 切换模型时按真实支持的档位收敛：xhigh 保留，超出范围的仍回落到 high
		assert.equal(models.clampThinking(p.id, "gpt-6.1-sol", "xhigh"), "xhigh");
		assert.equal(models.clampThinking(p.id, "gpt-6.1-sol", "max"), "max");
		assert.equal(models.clampThinking(p.id, "my-private-model", "xhigh"), "high");
		// 写进 Pi 的 models.json，Pi 自己按它算档位与请求参数
		const cfg = JSON.parse(readFileSync(join(config.dataDir, "models.json"), "utf8"));
		assert.deepEqual(cfg.providers[p.id].models.find((m: { id: string }) => m.id === "gpt-6.1-sol").thinkingLevelMap, { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
	} finally {
		await customProviders.remove(p.id);
	}
});

test("旧配置启动补齐：没有档位映射的自定义模型，backfill 后拿到 xhigh / max", async () => {
	const p = await customProviders.save(null, { name: "旧档位", api: "openai-completions", baseUrl: relay.url, noKey: true, models: [{ id: "gpt-6.1-sol", reasoning: true }] });
	try {
		// 模拟旧版本：元数据和 models.json 都没有 thinkingLevelMap
		const { getSetting, setSetting } = await import("../src/db.ts");
		const metas = getSetting<{ id: string; models: Record<string, unknown>[] }[]>("customProviders", []);
		setSetting("customProviders", metas.map((x) => (x.id === p.id ? { ...x, models: [{ id: "gpt-6.1-sol", reasoning: true }] } : x)));
		const cfgPath = join(config.dataDir, "models.json");
		const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
		cfg.providers[p.id].models = [{ id: "gpt-6.1-sol", reasoning: true }];
		writeFileSync(cfgPath, JSON.stringify(cfg));
		await models.reloadConfig();
		assert.deepEqual(models.listModels(p.id).find((m) => m.id === "gpt-6.1-sol")!.thinking, ["off", "minimal", "low", "medium", "high"], "补齐前是 Pi 默认档位");
		assert.ok((await customProviders.backfillLimits()) >= 1);
		const live = models.listModels(p.id).find((m) => m.id === "gpt-6.1-sol")!;
		assert.ok(live.thinking.includes("xhigh") && live.thinking.includes("max"), `补齐后有 xhigh / max：${live.thinking}`);
	} finally {
		await customProviders.remove(p.id);
	}
});

test("请求参数：选 xhigh 时真的发 reasoning_effort=xhigh，不被 clamp 回 high", async () => {
	const p = await customProviders.save(null, {
		name: "请求参数测试",
		api: "openai-completions",
		baseUrl: relay.url,
		apiKey: "sk-unit",
		models: [{ id: "gpt-6.1-sol", reasoning: true }],
	});
	try {
		const ws = join(config.workspaceRoot, "think-levels");
		mkdirSync(ws, { recursive: true });
		const session = await createPiSession({
			models,
			cwd: ws,
			agentDir: join(config.agentsDir, "think-levels"),
			sessionDir: join(config.agentsDir, "think-levels", "sessions"),
			model: { provider: p.id, id: "gpt-6.1-sol" },
			thinking: models.clampThinking(p.id, "gpt-6.1-sol", "xhigh"),
			systemPromptAppend: [],
			extensions: [],
		});
		assert.equal(session.thinkingLevel, "xhigh", "会话档位保留 xhigh");
		await promptSession(session, "你好");
		assert.ok(lastAssistantText(session));
		session.dispose();
		const chats = relay.seen.filter((r) => r.url === "/v1/chat/completions");
		assert.ok(chats.length >= 1, "应该向中转站发过聊天请求");
		const body = JSON.parse(chats[chats.length - 1].body) as { model?: string; reasoning_effort?: string };
		assert.equal(body.model, "gpt-6.1-sol");
		assert.equal(body.reasoning_effort, "xhigh", "xhigh 必须真的发出去，而不是被 clamp 回 high");
	} finally {
		await customProviders.remove(p.id);
	}
});
