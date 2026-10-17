/**
 * 原生子进程启动环境（`src/native-launch-env.ts`）：纯环境构造 / 校验。
 *
 * 只读内存里的假 env，不读凭据、不读数据库、不启动 Chrome / CuaDriver、不碰用户目录。
 * 要证明的是三条边界：
 *  1. 服务自己的合成 HOME（隔离启动）**不被删掉**，但**不传给**原生进程；
 *  2. 原生进程拿到的 HOME 来自 OS 账户信息（`os.userInfo().homedir`），不是 `$HOME`；
 *  3. 合成临时目录（TMPDIR / TEMP / TMP）与 `CFFIXED_USER_HOME` 一律不传给原生进程。
 */
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { test } from "node:test";
import { envStrings, nativeLaunchEnv, nativeLaunchEnvForChild, nativeLaunchEnvProblems, osAccountHome } from "../src/native-launch-env.ts";

const REAL_HOME = "/Users/real-user";
const SYNTH_HOME = "/tmp/pia-layabench/home";
const SYNTH_DATA = "/tmp/pia-layabench/data";

/** 隔离启动时的服务环境：合成 HOME + 合成临时目录 + 我们自己的数据 / 工作区 / profile 隔离变量。 */
const syntheticBaseEnv = (): NodeJS.ProcessEnv => ({
	HOME: SYNTH_HOME,
	TMPDIR: "/tmp/pia-layabench/tmp",
	TEMP: "/tmp/pia-layabench/tmp",
	TMP: "/tmp/pia-layabench/tmp",
	CFFIXED_USER_HOME: SYNTH_HOME,
	PIA_DATA_DIR: SYNTH_DATA,
	PIA_WORKSPACE: `${SYNTH_DATA}/workspace`,
	CUA_DRIVER_BROWSER_PROFILE_ROOT: `${SYNTH_DATA}/cua-profiles`,
	PIA_MOCK: "1",
	PATH: "/usr/bin:/bin",
});

test("隔离启动：原生进程拿 OS 账户家目录，合成临时目录与 CFFIXED_USER_HOME 都被剥离", () => {
	const base = syntheticBaseEnv();
	const r = nativeLaunchEnv({ baseEnv: base, realHome: REAL_HOME, syntheticRoots: [SYNTH_DATA] });
	assert.equal(r.env.HOME, REAL_HOME, "HOME 必须是 OS 账户家目录，不是服务的合成 HOME");
	assert.equal(r.diverged, true);
	assert.equal(r.homeSource, "os");
	assert.equal(r.env.CFFIXED_USER_HOME, undefined, "CFFIXED_USER_HOME 会覆盖 HOME，必须删除");
	for (const k of ["TMPDIR", "TEMP", "TMP"]) assert.equal(r.env[k], undefined, `${k} 不能保留合成临时目录`);
	assert.deepEqual(r.stripped.sort(), ["CFFIXED_USER_HOME", "TEMP", "TMP", "TMPDIR"].sort());
	// 数据 / 工作区 / profile 隔离不靠改 HOME 实现，原样保留（不能顺手删掉）。
	assert.equal(r.env.PIA_DATA_DIR, SYNTH_DATA);
	assert.equal(r.env.PIA_WORKSPACE, `${SYNTH_DATA}/workspace`);
	assert.equal(r.env.CUA_DRIVER_BROWSER_PROFILE_ROOT, `${SYNTH_DATA}/cua-profiles`);
	assert.equal(r.env.PIA_MOCK, "1");
	assert.equal(r.env.PATH, "/usr/bin:/bin");
	// 纯函数：不能改调用方的 env。
	assert.equal(base.HOME, SYNTH_HOME);
	assert.equal(base.TMPDIR, "/tmp/pia-layabench/tmp");
	assert.equal(base.CFFIXED_USER_HOME, SYNTH_HOME);
});

test("生产正常路径：HOME 就是登录用户家目录时是恒等变换（真实 TMPDIR 保留，不回归）", () => {
	const base: NodeJS.ProcessEnv = { HOME: REAL_HOME, TMPDIR: "/var/folders/xx/T/", PATH: "/usr/bin" };
	const r = nativeLaunchEnv({ baseEnv: base, realHome: REAL_HOME, syntheticRoots: [SYNTH_DATA] });
	assert.equal(r.diverged, false);
	assert.equal(r.env.HOME, REAL_HOME);
	assert.equal(r.env.TMPDIR, "/var/folders/xx/T/", "生产环境的真实临时目录不该被剥掉");
	assert.deepEqual(r.stripped, []);
	assert.deepEqual(nativeLaunchEnvProblems(r.env, { realHome: REAL_HOME, syntheticRoots: [SYNTH_DATA] }), []);
});

test("HOME 正确但临时目录指向合成根（数据目录）→ 只剥临时目录", () => {
	const base: NodeJS.ProcessEnv = { HOME: REAL_HOME, TMPDIR: `${SYNTH_DATA}/tmp`, TMP: "/var/tmp" };
	const r = nativeLaunchEnv({ baseEnv: base, realHome: REAL_HOME, syntheticRoots: [SYNTH_DATA] });
	assert.equal(r.diverged, false);
	assert.equal(r.env.TMPDIR, undefined);
	assert.equal(r.env.TMP, "/var/tmp", "不在合成根里的值保留");
	assert.deepEqual(r.stripped, ["TMPDIR"]);
});

test("路径按段判断：/tmp/syn-evil 不算 /tmp/syn 之内（不误剥 / 不误留）", () => {
	const base: NodeJS.ProcessEnv = { HOME: REAL_HOME, TMPDIR: "/tmp/syn-evil/tmp" };
	const r = nativeLaunchEnv({ baseEnv: base, realHome: REAL_HOME, syntheticRoots: ["/tmp/syn"] });
	assert.equal(r.env.TMPDIR, "/tmp/syn-evil/tmp");
	const inside = nativeLaunchEnv({ baseEnv: { HOME: REAL_HOME, TMPDIR: "/tmp/syn/tmp" }, realHome: REAL_HOME, syntheticRoots: ["/tmp/syn"] });
	assert.equal(inside.env.TMPDIR, undefined);
});

test("取不到 OS 账户家目录时不改写 HOME、不按 env 猜（homeSource=unknown）", () => {
	const base = syntheticBaseEnv();
	const r = nativeLaunchEnv({ baseEnv: base, realHome: null, syntheticRoots: [SYNTH_DATA] });
	assert.equal(r.homeSource, "unknown");
	assert.equal(r.diverged, false);
	assert.equal(r.env.HOME, SYNTH_HOME, "不知道真实家目录时保持原样，不猜一个值");
	// 能证明的照旧处理：CFFIXED_USER_HOME 一律删；落在**已知**合成根里的临时目录仍剥离。
	assert.equal(r.env.CFFIXED_USER_HOME, undefined);
	// 家目录未知时只能靠“已知合成根”判定：把整个临时根声明进来才会剥掉。
	const scoped = nativeLaunchEnv({ baseEnv: base, realHome: null, syntheticRoots: ["/tmp/pia-layabench"] });
	assert.equal(scoped.env.TMPDIR, undefined);
});

test("extra 覆盖（例如 CUA_DRIVER_TELEMETRY=0）在最后生效", () => {
	const r = nativeLaunchEnv({ baseEnv: { HOME: REAL_HOME, CUA_DRIVER_TELEMETRY: "1" }, realHome: REAL_HOME, extra: { CUA_DRIVER_TELEMETRY: "0" } });
	assert.equal(r.env.CUA_DRIVER_TELEMETRY, "0");
});

test("Windows：存在 USERPROFILE 时对齐到 OS 账户家目录，不凭空造", () => {
	const withProfile = nativeLaunchEnv({ baseEnv: { HOME: "C:\\synth", USERPROFILE: "C:\\synth" }, realHome: "C:\\Users\\real", platform: "win32" });
	assert.equal(withProfile.env.USERPROFILE, "C:\\Users\\real");
	const without = nativeLaunchEnv({ baseEnv: { HOME: "C:\\synth" }, realHome: "C:\\Users\\real", platform: "win32" });
	assert.equal(without.env.USERPROFILE, undefined);
});

test("校验函数：能指出 CFFIXED_USER_HOME / 非 OS 家目录 / 合成临时目录三类问题", () => {
	const problems = nativeLaunchEnvProblems({ HOME: SYNTH_HOME, CFFIXED_USER_HOME: SYNTH_HOME, TMPDIR: `${SYNTH_DATA}/tmp` }, { realHome: REAL_HOME, syntheticRoots: [SYNTH_DATA] });
	assert.equal(problems.length, 3);
	assert.match(problems.join("\n"), /CFFIXED_USER_HOME/);
	assert.match(problems.join("\n"), /HOME 不是 OS 账户家目录/);
	assert.match(problems.join("\n"), /TMPDIR/);
});

test("envStrings：丢掉 undefined，只留字符串（给只收 Record<string,string> 的 MCP stdio 用）", () => {
	assert.deepEqual(envStrings({ A: "1", B: undefined, C: "" }), { A: "1", C: "" });
});

test("生产入口：家目录来自 os.userInfo()，不是 process.env.HOME", () => {
	const r = nativeLaunchEnvForChild({ CUA_DRIVER_TELEMETRY: "0" }, { syntheticRoots: [SYNTH_DATA] });
	assert.equal(r.homeSource, "os");
	assert.equal(r.env.HOME, userInfo().homedir);
	assert.equal(r.env.HOME, osAccountHome());
	assert.equal(r.env.CUA_DRIVER_TELEMETRY, "0");
	assert.equal(r.env.CFFIXED_USER_HOME, undefined);
});
