/** 用真的 npm（不联网）验证私有安装的 npm 环境能正常加载配置：假 npm 测不出 beta.58 的「double-loading config」。 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NativeInstaller, runPrivateNpm, type NativeRelease } from "../src/cli-agents/native-install.ts";

const release: NativeRelease = { packageName: "@test/x", version: "1.0.0", integrity: "sha512-AAAA", bin: "x" };

test("私有 npm 环境：真 npm 能加载配置、读到我们的 registry，用户 / 全局配置是两个文件", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "pia-real-npm-"));
	try {
		const installer = new NativeInstaller({ dataDir, releases: { gemini: release, codebuddy: release } as never });
		const env = installer.npmEnvironment("gemini");
		assert.notEqual(env.npm_config_userconfig, env.npm_config_globalconfig);
		const out = await runPrivateNpm({ args: ["config", "get", "registry"], cwd: dataDir, env, signal: AbortSignal.timeout(30_000) });
		assert.equal(out.trim(), "https://registry.npmjs.org/");
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});
