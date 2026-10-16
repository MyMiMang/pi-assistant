/**
 * 回归：单测的数据目录必须是临时目录，且不受外部 PIA_DATA_DIR / PIA_WORKSPACE 与 HOME 影响（fail-closed）。
 *
 * 背景：2026-10-15 侧边栏凭空多出一个助理「小微」（id `wa`）。根因是 test/setup.ts 一度被改成
 * `process.env.PIA_DATA_DIR ??= …`（或在某次改动里丢掉了临时目录这一行），外部环境里已有的
 * PIA_DATA_DIR 让单测直接写用户真实数据目录。2026-10-16 又有一条 Laya 依赖测试因为 setup 的
 * `await import()` 晚于 ESM 静态 import（config 先捕获真实数据目录）而把 `rl_agent_config.json`
 * 写进真实 App 目录。这里把「必须临时目录」「外部环境不能改向」「预加载必须早于 config」都钉住。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

test("isTempDataDir：必须有路径分隔符边界，且拒绝 symlink 外跳（不用真实盘）", () => {
	// 同前缀但不在临时目录内：旧实现 `startsWith(resolve(tmpdir()))` 会误判 true，新实现必须 false
	// （路径不存在 → realpath 失败 → fail-closed）。
	assert.equal(isTempDataDir(`${tmpdir()}-evil`), false, "同前缀不算临时目录");

	const inside = mkdtempSync(join(tmpdir(), "pia-boundary-"));
	const outside = dirname(tmpdir()); // tmpdir 的父目录：realpath 一定不在 tmpdir 内
	try {
		assert.equal(isTempDataDir(inside), true);
		// 临时目录内、realpath 落在临时目录外 → 拒绝
		const link = join(inside, "escape");
		symlinkSync(outside, link);
		assert.equal(isTempDataDir(link), false, "symlink 外跳必须拒绝");
	} finally {
		rmSync(inside, { recursive: true, force: true });
	}
});

test("预加载隔离子进程：毒化 PIA_DATA_DIR/PIA_WORKSPACE + 假 HOME 都不能被利用或写入", () => {
	// setup.ts 必须在 config.ts 求值之前跑完（npm test 用 `--import ./test/setup.ts` 预加载）。
	// 用**假 HOME** 与毒化 sentinel（都在 tmp，绝非用户真实路径）验证：config.dataDir/workspaceRoot
	// 必是本次新 tmp，而且毒化目录与假 HOME 下都不会被创建任何东西。
	const fakeHome = mkdtempSync(join(tmpdir(), "pia-fake-home-"));
	const poisonData = join(tmpdir(), `pia-poison-data-${process.pid}-${Date.now()}`);
	const poisonWs = join(tmpdir(), `pia-poison-ws-${process.pid}-${Date.now()}`);
	try {
		const out = execFileSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--import",
				"./test/setup.ts",
				"-e",
				'import("./src/config.ts").then((m) => console.log("PIA_ISOLATION=" + JSON.stringify({ data: m.config.dataDir, ws: m.config.workspaceRoot })))',
			],
			{
				cwd: join(import.meta.dirname, ".."),
				env: { ...process.env, HOME: fakeHome, PIA_DATA_DIR: poisonData, PIA_WORKSPACE: poisonWs },
				encoding: "utf8",
			},
		).trim();
		const line = out.split("\n").find((l) => l.startsWith("PIA_ISOLATION="));
		assert.ok(line, `子进程没有输出数据目录：${out}`);
		const { data, ws } = JSON.parse(line.slice("PIA_ISOLATION=".length)) as { data: string; ws: string };
		assert.notEqual(resolve(data), resolve(poisonData), "setup.ts 必须覆盖外部 PIA_DATA_DIR");
		assert.notEqual(resolve(ws), resolve(poisonWs), "setup.ts 必须覆盖外部 PIA_WORKSPACE");
		assert.ok(isTempDataDir(data), `子进程数据目录也必须是临时目录：${data}`);
		assert.ok(resolve(ws).startsWith(resolve(data)), "工作区必须在本次临时数据目录下");
		assert.ok(!existsSync(poisonData), "不得创建毒化的 PIA_DATA_DIR");
		assert.ok(!existsSync(poisonWs), "不得创建毒化的 PIA_WORKSPACE");
		assert.ok(
			!existsSync(join(fakeHome, "Library", "Application Support", "Pi Assistant")),
			"假 HOME 下不得创建 App 数据目录（说明 config 没有跑在默认路径上）",
		);
	} finally {
		rmSync(fakeHome, { recursive: true, force: true });
		rmSync(poisonData, { recursive: true, force: true });
		rmSync(poisonWs, { recursive: true, force: true });
	}
});
