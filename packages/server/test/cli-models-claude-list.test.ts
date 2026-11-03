/**
 * claude 模型列表（假 claude，绝不调用真实 claude）：命名 / 重名 / 思考档位 / 1M 上下文 / 问不到时退回三个别名 / 重新检测刷新。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CLAUDE_EXTRA_MODELS, CLAUDE_FALLBACK_MODELS, extractModels, mergeClaudeModels, parseClaudeModels, validateClaudeModelId } from "../src/cli-agents/claude-models-parse.ts";
import { listClaudeModels } from "../src/cli-agents/claude-models.ts";
import { createClaudeCodeChannel, registerClaudeCodeModels, registerClaudeCodeProvider, CLAUDE_CODE_PROVIDER } from "../src/pi-adapter/cli-models/claude-code.ts";
import { PiModels } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "pia-cc-list-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));

let mode = "dup";
const deps = { dataDir, bridgeBaseUrl: () => "http://127.0.0.1:1", command: () => FAKE, extraEnv: () => ({ FAKE_CLAUDE_MODELS: mode }) };
const newModels = () => PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });

test("纯函数：两种嵌套都能取到 models，没有就是 null", () => {
	assert.equal(extractModels({ response: { response: { models: [{}] } } })?.length, 1);
	assert.equal(extractModels({ response: { models: [{}] } })?.length, 1);
	assert.equal(extractModels({ response: { response: {} } }), null);
});

test("纯函数：命名、自定义别名、1M、重名补 value、思考档位", () => {
	const eff = ["low", "high"];
	const list = parseClaudeModels([
		{ value: "default", displayName: "Default (recommended)", description: "x", supportsEffort: true, supportedEffortLevels: eff },
		{ value: "opus", displayName: "claude-opus-5-5", description: "Custom Opus model", supportsEffort: true, supportedEffortLevels: eff },
		{ value: "claude-fable-5-1[1m]", displayName: "Fable", description: "Fable 5.1", supportsEffort: true, supportedEffortLevels: eff },
		{ value: "haiku", displayName: "Haiku", description: "fast", supportsEffort: false },
		{ value: "a", displayName: "Twin", description: "x" },
		{ value: "b", displayName: "Twin", description: "x" },
		{ value: "a", displayName: "dup value", description: "x" },
		{ displayName: "没有 value" },
	]);
	assert.deepEqual(list.map((m) => m.name), ["Claude Code · 默认", "Claude Code · Opus（claude-opus-5-5）", "Claude Code · Fable · 1M 上下文", "Claude Code · Haiku", "Claude Code · Twin（a）", "Claude Code · Twin（b）"]);
	assert.deepEqual(list.map((m) => m.contextWindow), [200_000, 200_000, 1_000_000, 200_000, 200_000, 200_000]);
	assert.deepEqual(list.map((m) => m.reasoning), [true, true, true, false, false, false]);
	assert.deepEqual(list[0].efforts, eff);
});

test("向假 claude 问列表：带 [1m] 和重名", async () => {
	const list = await listClaudeModels(FAKE, { cwd: join(dataDir, "work"), extraEnv: { FAKE_CLAUDE_MODELS: "dup" } });
	assert.ok(list.some((m) => m.id === "claude-fable-5-1[1m]" && m.name === "Claude Code · Fable · 1M 上下文"));
	assert.equal(new Set(list.map((m) => m.name)).size, list.length, "显示名没有重名");
	const nested = await listClaudeModels(FAKE, { cwd: join(dataDir, "work"), extraEnv: { FAKE_CLAUDE_MODELS: "nested" } });
	assert.deepEqual(nested.map((m) => m.id), ["opus"]);
});

test("问不到：没有 models / 进程直接退出 / 超时都抛错", async () => {
	for (const m of ["none", "exit"]) await assert.rejects(listClaudeModels(FAKE, { cwd: dataDir, extraEnv: { FAKE_CLAUDE_MODELS: m } }));
	await assert.rejects(listClaudeModels(FAKE, { cwd: dataDir, timeoutMs: 500, extraEnv: { FAKE_CLAUDE_MODELS: "hang" } }), /超时/);
});

test("注册进 Pi：id 带方括号原样保留，思考档位和上下文窗口正确", async () => {
	mode = "dup";
	const models = await newModels();
	const channel = await registerClaudeCodeProvider(models, deps);
	const list = models.listModels(CLAUDE_CODE_PROVIDER);
	const fable = list.find((m) => m.id === "claude-fable-5-1[1m]")!;
	assert.ok(fable);
	assert.equal(fable.contextWindow, 1_000_000);
	assert.deepEqual(fable.thinking, ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(list.find((m) => m.id === "haiku")!.thinking, ["off"]);
	assert.ok(list.every((m) => m.input.includes("image")));
	channel.disposeAll();
});

test("问不到时退回 opus / sonnet / haiku；重新检测后换成真实列表", async () => {
	mode = "none";
	const models = await newModels();
	const channel = createClaudeCodeChannel(deps);
	await registerClaudeCodeModels(models, channel);
	const extra = CLAUDE_EXTRA_MODELS.map((m) => m.id);
	assert.deepEqual(models.listModels(CLAUDE_CODE_PROVIDER).map((m) => m.id), ["opus", "sonnet", "haiku", ...extra]);
	mode = "default";
	await registerClaudeCodeModels(models, channel);
	assert.deepEqual(models.listModels(CLAUDE_CODE_PROVIDER).map((m) => m.id), ["default", "opus", "haiku", ...extra]);
	channel.disposeAll();
});

test("合并：别名在前、清单在后、按 id 去重；问不到时别名 + 清单都在", () => {
	const eff = ["low", "high"];
	const aliases = [
		{ id: "opus", name: "Claude Code · Opus", reasoning: true, efforts: eff, contextWindow: 200_000 },
		{ id: "claude-opus-4-8", name: "Claude Code · 别名里已有的 4.8", reasoning: true, efforts: eff, contextWindow: 200_000 },
	];
	const list = mergeClaudeModels(aliases);
	assert.deepEqual(list.slice(0, 2).map((m) => m.id), ["opus", "claude-opus-4-8"]);
	assert.equal(list.length, 1 + CLAUDE_EXTRA_MODELS.length, "已有的 id 不重复");
	assert.equal(list[1].name, "Claude Code · 别名里已有的 4.8");
	assert.equal(list.find((m) => m.id === "claude-opus-5-5")!.name, "Claude Code · Opus 5.5");
	assert.deepEqual(list.find((m) => m.id === "claude-opus-5-5")!.efforts, eff, "沿用同家族别名的档位");
	assert.deepEqual(list.find((m) => m.id === "claude-sonnet-5-5")!.efforts, ["low", "medium", "high", "xhigh", "max"], "没有同家族别名给全档");
	assert.deepEqual(list.find((m) => m.id === "claude-haiku-4-5")!.efforts, []);
	assert.equal(list.find((m) => m.id === "claude-haiku-4-5")!.reasoning, false);
	assert.ok(list.every((m) => m.contextWindow === 200_000));
	const fallback = mergeClaudeModels(CLAUDE_FALLBACK_MODELS);
	assert.deepEqual(fallback.map((m) => m.id), ["opus", "sonnet", "haiku", ...CLAUDE_EXTRA_MODELS.map((m) => m.id)]);
});

test("自定义 ID：校验规则、并入列表、思考强度按 haiku 判断、与清单重复不重复加", () => {
	assert.equal(validateClaudeModelId("claude-opus-4-8"), null);
	assert.equal(validateClaudeModelId("anthropic.claude-x:1/v2[1m]"), null);
	for (const bad of ["", "   ", "a b", "a\tb", "中文", "a;b", "a".repeat(101), 5, undefined]) assert.ok(validateClaudeModelId(bad), String(bad));
	assert.equal(validateClaudeModelId("a".repeat(100)), null);
	const list = mergeClaudeModels([], ["my-model-x", "my-haiku-9", "claude-opus-4-8", "bad id"]);
	const mine = list.find((m) => m.id === "my-model-x")!;
	assert.equal(mine.name, "Claude Code · my-model-x");
	assert.deepEqual(mine.efforts, ["low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(list.find((m) => m.id === "my-haiku-9")!.efforts, []);
	assert.equal(list.filter((m) => m.id === "claude-opus-4-8").length, 1);
	assert.ok(!list.some((m) => m.id === "bad id"));
});

test("注册进 Pi：自定义 ID 出现在模型列表里", async () => {
	mode = "default";
	const models = await newModels();
	const channel = createClaudeCodeChannel({ ...deps, customModels: () => ["my-model-x"] });
	await registerClaudeCodeModels(models, channel);
	assert.ok(models.listModels(CLAUDE_CODE_PROVIDER).some((m) => m.id === "my-model-x" && m.name === "Claude Code · my-model-x"));
	channel.disposeAll();
});
