/**
 * `e2e/fixtures/native-launch-env.mjs` 的纯逻辑回归（node:test；不启动浏览器 / 服务 / 构建）。
 *
 * 这个 helper 是「给原生 Chrome / 原生子进程」的那份环境：真实 HOME、真实 TMPDIR。回归点是
 * **父进程本身就是合成 HOME / TMPDIR 时不能把合成值漏给 Chrome**（launch-memory 类隔离启动会这样）。
 * 来源与唯一改动见文件头（laya 树 `4b2c5ea`，`diverged` 改在覆盖 HOME 之前判定）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeLaunchBrowserEnv } from "./fixtures/native-launch-env.mjs";

test("真实父环境：HOME 取真实家目录、真实 TMPDIR 保留、CFFIXED_USER_HOME 删除", () => {
	const baseEnv = { HOME: "/Users/tester", TMPDIR: "/var/folders/real/T/", CFFIXED_USER_HOME: "/tmp/fake", PATH: "/usr/bin" };
	const env = nativeLaunchBrowserEnv({ baseEnv, realHome: "/Users/tester" });
	assert.equal(env.HOME, "/Users/tester");
	assert.equal(env.TMPDIR, "/var/folders/real/T/");
	assert.equal(env.CFFIXED_USER_HOME, undefined);
	assert.equal(env.PATH, "/usr/bin");
	// 纯函数：不改调用方对象
	assert.equal(baseEnv.CFFIXED_USER_HOME, "/tmp/fake");
});

test("合成父环境（隔离启动）：HOME 改回真实家目录，合成 TMPDIR / TEMP / TMP 一律剥离", () => {
	const env = nativeLaunchBrowserEnv({
		baseEnv: { HOME: "/tmp/pia-run/home", TMPDIR: "/tmp/pia-run/tmp/", TEMP: "/tmp/pia-run/tmp", TMP: "/tmp/pia-run/tmp" },
		realHome: "/Users/tester",
	});
	assert.equal(env.HOME, "/Users/tester");
	// 回归：旧写法先覆盖 HOME 再比较 diverged → 恒 false，这几个合成临时目录会被漏给 Chrome
	assert.equal(env.TMPDIR, undefined);
	assert.equal(env.TEMP, undefined);
	assert.equal(env.TMP, undefined);
});

test("syntheticRoots：落在本次运行临时根里的 TMPDIR 剥离，真实 TMPDIR 不受影响", () => {
	const runDir = "/var/folders/real/T/pia-e2e-fast-mode-abc";
	const inside = nativeLaunchBrowserEnv({ baseEnv: { HOME: "/Users/tester", TMPDIR: `${runDir}/tmp/` }, realHome: "/Users/tester", syntheticRoots: [runDir] });
	assert.equal(inside.TMPDIR, undefined);
	const outside = nativeLaunchBrowserEnv({ baseEnv: { HOME: "/Users/tester", TMPDIR: "/var/folders/real/T/" }, realHome: "/Users/tester", syntheticRoots: [runDir] });
	assert.equal(outside.TMPDIR, "/var/folders/real/T/");
	// 前缀相近但不是同一路径（/tmpx 不该命中 /tmp）
	const sibling = nativeLaunchBrowserEnv({ baseEnv: { TMPDIR: "/tmp-other/t/" }, realHome: "/Users/tester", syntheticRoots: ["/tmp"] });
	assert.equal(sibling.TMPDIR, "/tmp-other/t/");
});

test("取不到真实家目录（realHome:null）：不改写 HOME、也不按 env 猜，临时目录只按合成根剥离", () => {
	const env = nativeLaunchBrowserEnv({ baseEnv: { HOME: "/tmp/pia-run/home", TMPDIR: "/tmp/pia-run/tmp/" }, realHome: null });
	assert.equal(env.HOME, "/tmp/pia-run/home");
	assert.equal(env.TMPDIR, "/tmp/pia-run/tmp/");
	const stripped = nativeLaunchBrowserEnv({ baseEnv: { HOME: "/tmp/pia-run/home", TMPDIR: "/tmp/pia-run/tmp/" }, realHome: null, syntheticRoots: ["/tmp/pia-run"] });
	assert.equal(stripped.TMPDIR, undefined);
});
