/**
 * claude 模型列表（假 claude，绝不调用真实 claude）：命名 / 重名 / 思考档位 / 1M 上下文 / 问不到时退回三个别名 / 重新检测刷新。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { extractModels, parseClaudeModels } from "../src/cli-agents/claude-models-parse.ts";
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
	assert.deepEqual(models.listModels(CLAUDE_CODE_PROVIDER).map((m) => m.id), ["opus", "sonnet", "haiku"]);
	mode = "default";
	await registerClaudeCodeModels(models, channel);
	assert.deepEqual(models.listModels(CLAUDE_CODE_PROVIDER).map((m) => m.id), ["default", "opus", "haiku"]);
	channel.disposeAll();
});
