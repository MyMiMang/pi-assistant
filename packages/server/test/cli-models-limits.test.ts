import { TEST_DATA_DIR } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelDb } from "../src/model-db.ts";
import { registerAntigravityModels } from "../src/pi-adapter/cli-models/antigravity.ts";
import { registerCodexModels } from "../src/pi-adapter/cli-models/codex.ts";
import { registerClaudeCodeModels } from "../src/pi-adapter/cli-models/claude-code.ts";
import { registerNativeModels } from "../src/pi-adapter/cli-models/native.ts";
import { registerOpencodeModels } from "../src/pi-adapter/cli-models/opencode.ts";
import { cliModelLimits, registerCliProvider, type CliModelSpec } from "../src/pi-adapter/cli-models/provider.ts";
import type { PiModels } from "../src/pi-adapter/index.ts";
import type { DbEntry } from "../src/pi-adapter/model-limits.ts";

const spec = (id: string, contextWindow = 200_000, maxTokens = 64_000): CliModelSpec => ({ id, name: id, reasoning: false, image: false, contextWindow, maxTokens });
const limits = (contextWindow: number, maxTokens: number) => ({ contextWindow, maxTokens });

function registry(catalog: DbEntry[]) {
	const registered = new Map<string, { models: CliModelSpec[] }>();
	const keys: string[] = [];
	const models = {
		listModels: () => [...catalog, ...[...registered].flatMap(([provider, value]) => value.models.map((m) => ({ ...m, provider })))],
		registerProvider: (id: string, value: { models: CliModelSpec[] }) => registered.set(id, value),
		setRuntimeApiKey: async (id: string) => { keys.push(id); },
	} as unknown as PiModels;
	return { models, registered, keys };
}

test("CLI limits：复用同名 / 日期快照 / 官方优先规则，Pi 元数据在 models.dev 前", () => {
	const catalog = [
		{ id: "gemini-4-hydrogen", provider: "proxy", ...limits(200_000, 16_000) },
		{ id: "gemini-4-hydrogen", provider: "google", ...limits(1_048_576, 65_536) },
		{ id: "gemini-4-hydrogen", provider: "google", ...limits(1_000_000, 32_768) },
		{ id: "model-a-2026-11-01", provider: "other", ...limits(400_000, 96_000) },
	];
	assert.deepEqual(cliModelLimits(spec("google/GEMINI-4-HYDROGEN:free"), catalog), limits(1_048_576, 65_536));
	assert.deepEqual(cliModelLimits(spec("model-a-latest"), catalog), limits(400_000, 96_000));
	const exact = [...catalog, { id: "model-a-latest", ...limits(300_000, 32_000) }];
	assert.deepEqual(cliModelLimits(spec("model-a-latest"), exact), limits(300_000, 32_000), "同名优先于快照");
});

test("CLI limits：不猜家族、版本、档位或别名；查不到保留各渠道原值", () => {
	const catalog = [{ id: "gemini-4-hydrogen-pro", ...limits(1_048_576, 65_536) }];
	for (const [id, ctx, out] of [
		["gemini-4-hydrogen", 200_000, 64_000],
		["gpt-unknown-future", 258_400, 64_000],
		["sonnet", 200_000, 64_000],
		["claude-fable-5-1[1m]", 1_000_000, 64_000],
		["default", 32_000, 8_000],
		["opencode/unknown", 128_000, 16_000],
	] as const) assert.deepEqual(cliModelLimits(spec(id, ctx, out), catalog), limits(ctx, out));
	assert.deepEqual(cliModelLimits(spec("invalid"), [{ id: "invalid", contextWindow: 0 }]), limits(200_000, 64_000));
});

test("CLI 注册：models.dev 查表、零费用及原始能力保留；刷新不从其他 CLI 旧预算反查", async () => {
	const entry = modelDb().find((m) => m.contextWindow && m.contextWindow > 0 && m.maxTokens && m.maxTokens < m.contextWindow)!;
	assert.ok(entry, "离线 models.dev 快照有可用元数据");
	const { models, registered, keys } = registry([
		{ id: "gemini-only-old-cli", provider: "antigravity", ...limits(9_000, 1_000) },
		{ id: "gemini-only-old-cli", provider: "gemini-cli", ...limits(8_000, 1_000) },
		{ id: "gemini-own-budget", provider: "test-cli", ...limits(7_000, 1_000) },
	]);
	const provider = {
		id: "test-cli", name: "测试", api: "test-cli", baseUrl: "test-cli://local", streamSimple: (() => {}) as never,
		models: [spec(entry.id), spec("gemini-only-old-cli"), spec("gemini-own-budget")],
	};
	await registerCliProvider(models, provider);
	const list = registered.get(provider.id)!.models;
	assert.deepEqual(cliModelLimits(list[0], []), cliModelLimits(spec(entry.id), modelDb()));
	assert.deepEqual(cliModelLimits(list[1], []), limits(200_000, 64_000));
	assert.deepEqual(cliModelLimits(list[2], []), limits(200_000, 64_000));
	assert.deepEqual((list[0] as unknown as { cost: unknown }).cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	await registerCliProvider(models, { ...provider, models: [spec("gemini-own-budget", 300_000)] });
	assert.equal(registered.get(provider.id)!.models[0].contextWindow, 300_000);
	assert.deepEqual(keys, [provider.id, provider.id]);
});

test("各家注册入口共用查表：Claude Code / Antigravity / Codex / OpenCode / 原生 ACP", async () => {
	const id = "gemini-4-hydrogen";
	const { models, registered } = registry([{ id, provider: "google", ...limits(1_048_576, 65_536) }]);
	await registerClaudeCodeModels(models, { deps: { dataDir: TEST_DATA_DIR, command: () => null, bridgeBaseUrl: () => "http://127.0.0.1:1", customModels: () => [id] }, streamSimple: () => {} } as never);
	const claude = registered.get("claude-code")!.models;
	assert.deepEqual(cliModelLimits(claude.find((m) => m.id === id)!, []), limits(1_048_576, 65_536));
	assert.deepEqual(cliModelLimits(claude.find((m) => m.id === "sonnet")!, []), limits(200_000, 64_000));
	let families: unknown;
	await registerAntigravityModels(models, { setFamilies: (value: unknown) => { families = value; }, streamSimple: () => {} } as never, [{ id, name: "Gemini 4 Hydrogen", variants: {} }]);
	assert.ok(families);
	await registerCodexModels(models, { hub: { listModels: async () => [{ id, name: "测试", efforts: [], image: false }], stopIfIdle: () => {} }, streamSimple: () => {} } as never);
	await registerOpencodeModels(models, { streamSimple: () => {} } as never, [{ ...spec(`google/${id}`), providerID: "google", efforts: [] }]);
	await registerNativeModels(models, { streamSimple: () => {} } as never, "gemini-cli", [spec(id)]);
	for (const provider of ["antigravity", "codex", "opencode-cli", "gemini-cli"]) {
		assert.deepEqual(cliModelLimits(registered.get(provider)!.models[0], []), limits(1_048_576, 65_536), provider);
	}
	await registerNativeModels(models, { streamSimple: () => {} } as never, "gemini-cli");
	assert.deepEqual(cliModelLimits(registered.get("gemini-cli")!.models[0], []), limits(32_000, 8_000), "工具默认模型仍使用原预算");
});
