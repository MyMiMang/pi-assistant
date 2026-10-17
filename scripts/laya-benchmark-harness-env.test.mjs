/**
 * `scripts/laya-benchmark-harness-env.mjs` 的定向纯测试（不启 daemon / 浏览器 / 模型、不读凭据）。
 *
 * 手动跑：`node --test scripts/laya-benchmark-harness-env.test.mjs`（不进 `npm test`）。
 * 这里只测「服务进程必须合成隔离」「原生 base env 必须是显式 clone」两件事——
 * 原生进程的完整规则仍由生产 `native-launch-env.ts` 自己的单测覆盖，本文件不复制那套规则。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
	SYNTHETIC_ROOT_MARKER,
	cloneNativeBaseEnv,
	envWhitelist,
	planScratchDirs,
	serviceIsolationEnv,
	serviceIsolationProblems,
} from "./laya-benchmark-harness-env.mjs";

const ROOT = "/tmp/pia-lb-owner-test";
const REAL_HOME = "/Users/example";
const dirs = planScratchDirs(ROOT);

test("scratch 目录全部落在本次根内（home / tmp 与服务数据分开）", () => {
	for (const p of [dirs.home, dirs.tmp, dirs.dataDir, dirs.workspaceDir, dirs.profileRoot]) {
		assert.ok(p.startsWith(`${ROOT}/`), `${p} 应在 ${ROOT} 内`);
	}
	assert.notEqual(dirs.home, dirs.dataDir);
	assert.equal(SYNTHETIC_ROOT_MARKER, ".pia-laya-bench-owner");
});

test("serviceIsolationEnv：HOME / 临时目录 / 数据 / 工作区都改到 scratch 根，且不改入参", () => {
	const baseEnv = { HOME: REAL_HOME, TMPDIR: "/var/folders/x/T", PATH: "/usr/bin", PIA_EXTRA: "keep" };
	const frozen = { ...baseEnv };
	const env = serviceIsolationEnv({ baseEnv, dirs });
	assert.equal(env.HOME, join(ROOT, "home"));
	assert.equal(env.TMPDIR, join(ROOT, "tmp"));
	assert.equal(env.TEMP, join(ROOT, "tmp"));
	assert.equal(env.TMP, join(ROOT, "tmp"));
	assert.equal(env.PIA_DATA_DIR, dirs.dataDir);
	assert.equal(env.PIA_WORKSPACE, dirs.workspaceDir);
	assert.equal(env.PIA_OFFLINE, "1");
	assert.equal(env.PIA_EXTRA, "keep", "无关变量原样保留");
	assert.deepEqual(baseEnv, frozen, "不得修改调用方 env");
});

test("serviceIsolationProblems：合成环境通过", () => {
	const env = serviceIsolationEnv({ baseEnv: { PATH: "/usr/bin" }, dirs });
	assert.deepEqual(serviceIsolationProblems(env, { root: ROOT, realHome: REAL_HOME }), []);
});

test("serviceIsolationProblems：服务跑在原生 HOME / 系统临时目录 / 缺数据目录都不通过", () => {
	const p1 = serviceIsolationProblems({ HOME: REAL_HOME, TMPDIR: dirs.tmp, PIA_DATA_DIR: dirs.dataDir, PIA_WORKSPACE: dirs.workspaceDir }, { root: ROOT, realHome: REAL_HOME });
	assert.equal(p1.length, 1);
	assert.match(p1[0], /OS 账户家目录/);

	const p2 = serviceIsolationProblems({ HOME: dirs.home, TMPDIR: "/var/folders/x/T", PIA_DATA_DIR: dirs.dataDir, PIA_WORKSPACE: dirs.workspaceDir }, { root: ROOT, realHome: REAL_HOME });
	assert.equal(p2.length, 1);
	assert.match(p2[0], /TMPDIR 不在本次 scratch 根内/);

	const p3 = serviceIsolationProblems({ HOME: dirs.home, TMPDIR: dirs.tmp, PIA_WORKSPACE: dirs.workspaceDir }, { root: ROOT, realHome: REAL_HOME });
	assert.equal(p3.length, 1);
	assert.match(p3[0], /PIA_DATA_DIR 缺失/);

	const p4 = serviceIsolationProblems({ HOME: "/tmp/pia-lb-other/home", TMPDIR: dirs.tmp, PIA_DATA_DIR: dirs.dataDir, PIA_WORKSPACE: dirs.workspaceDir }, { root: ROOT, realHome: REAL_HOME });
	assert.equal(p4.length, 1);
	assert.match(p4[0], /HOME 不在本次 scratch 根内/);
});

test("envWhitelist：标识原生 HOME / 合成根 / CFFIXED，不读其它键", () => {
	const native = envWhitelist({ HOME: REAL_HOME, TMPDIR: "/var/folders/x/T", PIA_DATA_DIR: "/tmp/pia-lb-other/data", PIA_WORKSPACE: "/tmp/pia-lb-other/work", SECRET_KEY: "nope" }, { root: ROOT, realHome: REAL_HOME });
	assert.equal(native.homeIsOsAccount, true);
	assert.equal(native.tmpdirUnderSyntheticRoot, false);
	assert.equal(native.piaDataDirUnderSyntheticRoot, false);
	assert.equal("SECRET_KEY" in native, false, "白名单不能把其它变量带进证据");

	const synthetic = envWhitelist(serviceIsolationEnv({ baseEnv: {}, dirs }), { root: ROOT, realHome: REAL_HOME });
	assert.equal(synthetic.homeIsOsAccount, false);
	assert.equal(synthetic.tmpdirUnderSyntheticRoot, true);
	assert.equal(synthetic.piaDataDirUnderSyntheticRoot, true);
	assert.equal(synthetic.piaWorkspaceUnderSyntheticRoot, true);
});

test("cloneNativeBaseEnv：显式快照，后续改 process.env 不会漏进原生输入", () => {
	const source = { HOME: join(ROOT, "home"), TMPDIR: join(ROOT, "tmp"), PATH: "/usr/bin" };
	const base = cloneNativeBaseEnv(source);
	assert.notEqual(base, source, "必须是新对象");
	base.HOME = REAL_HOME;
	assert.equal(source.HOME, join(ROOT, "home"), "改 clone 不能回写来源");
	source.TMPDIR = "/changed";
	assert.equal(base.TMPDIR, join(ROOT, "tmp"), "改来源不能影响已 clone 的输入");
});
