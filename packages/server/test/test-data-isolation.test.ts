/**
 * 回归：单测的数据目录必须是临时目录，且不受外部 PIA_DATA_DIR 影响（fail-closed）。
 *
 * 背景：2026-10-15 侧边栏凭空多出一个助理「小微」（id `wa`）。根因是 test/setup.ts 一度被改成
 * `process.env.PIA_DATA_DIR ??= …`（或在某次改动里丢掉了临时目录这一行），外部环境里已有的
 * PIA_DATA_DIR 让单测直接写用户真实数据目录，`test/clawbot.test.ts` 的测试助理就这样进了用户库。
 * 这里把「必须临时目录」和「外部 PIA_DATA_DIR 必须被忽略」两件事都钉住。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { TEST_DATA_DIR, isTempDataDir } from "./setup.ts";

const { config } = await import("../src/config.ts");

test("单测数据目录在临时目录里，不是真实 App 数据目录", () => {
	assert.equal(config.dataDir, TEST_DATA_DIR);
	assert.ok(isTempDataDir(config.dataDir), `数据目录必须在临时目录里：${config.dataDir}`);
	assert.ok(config.workspaceRoot.startsWith(config.dataDir), "工作区也必须在同一个临时目录下");
	const real = join(homedir(), "Library", "Application Support", "Pi Assistant");
	assert.notEqual(resolve(config.dataDir), resolve(real));
	assert.ok(!config.dataDir.startsWith(real));
});

test("外部环境里的 PIA_DATA_DIR 不能把单测引到别处（fail-closed）", () => {
	const sentinel = join(tmpdir(), "pia-sentinel-should-be-ignored");
	const out = execFileSync(
		process.execPath,
		["--import", "tsx", "--import", "./test/setup.ts", "-e", 'import("./src/config.ts").then((m) => console.log(m.config.dataDir))'],
		{ cwd: join(import.meta.dirname, ".."), env: { ...process.env, PIA_DATA_DIR: sentinel }, encoding: "utf8" },
	).trim();
	assert.notEqual(resolve(out), resolve(sentinel), "setup.ts 必须覆盖外部 PIA_DATA_DIR");
	assert.ok(isTempDataDir(out), `子进程的数据目录也必须是临时目录：${out}`);
});
