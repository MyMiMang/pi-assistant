/**
 * 本机命令行渠道在后台注册：claude 的假命令卡住（不回模型列表）时，initModels 也很快返回，不挡服务启动；
 * 卡住的渠道最终超时退回三个别名，cliChannelsReady() 落定。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
const dir = mkdtempSync(join(tmpdir(), "pia-cc-startup-"));
const cmd = join(dir, "claude");
writeFileSync(cmd, `#!/bin/sh\nFAKE_CLAUDE_MODELS=hang exec "${process.execPath}" "${FAKE}" "$@"\n`);
chmodSync(cmd, 0o755);
process.env.PIA_CLAUDE_COMMAND = cmd;
process.env.PIA_MOCK = "1"; // Mock 模式有默认模型

test("claude 问模型列表卡住时：initModels 很快返回；有默认模型时不等；只等卡住的这一家；注册完发「模型列表变了」", { timeout: 60000 }, async () => {
	const m = await import("../src/models.ts");
	const { bus } = await import("../src/bus.ts");
	const { cliProviderReady } = await import("../src/cli-services.ts");
	const changed: string[] = [];
	bus.on((e) => e.type === "models.changed" && changed.push(String(e.provider)));
	const t0 = Date.now();
	await m.initModels(memoryCredentialStore());
	assert.ok(Date.now() - t0 < 10_000, `initModels 用了 ${Date.now() - t0}ms，不应等 claude`);
	assert.equal(m.models.listModels("claude-code").length, 0, "此时还没注册完");
	// Mock 模式有默认模型：不等
	const t1 = Date.now();
	await m.waitCliForDefaultModel();
	assert.ok(Date.now() - t1 < 1000, "有默认模型时不该等");
	// 别的渠道 / 没在注册的：立刻返回；只等 claude 这一家
	const t2 = Date.now();
	await cliProviderReady("codex");
	await cliProviderReady("custom-xyz");
	assert.ok(Date.now() - t2 < 1000);
	await cliProviderReady("claude-code", 300); // 最多等指定时间
	assert.equal(m.models.listModels("claude-code").length, 0, "300 毫秒内还没注册上，不会一直等");
	await cliProviderReady("claude-code"); // 等到注册完（卡住的 claude 超时后退回三个别名）
	assert.deepEqual(m.models.listModels("claude-code").map((x) => x.id), ["opus", "sonnet", "haiku"]);
	await m.cliChannelsReady();
	assert.deepEqual(changed, ["claude-code"], "注册上的那一刻发了一次事件");
});
