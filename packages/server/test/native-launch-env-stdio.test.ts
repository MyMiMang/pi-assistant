/**
 * 原生启动环境 × **真实 MCP stdio 通道**（不是 helper 对象）：
 * 用 `@earendil-works/pi-mcp` 的公开 `StdioTransport`（就是 Pi 生产里用的那个类）起一个
 * **只回显白名单变量**的无害子进程，看它最终真的拿到什么环境。
 *
 * 要证明的事：
 *  1. **阻塞问题（红）**：只传一份“已经删掉 `CFFIXED_USER_HOME` / 合成 `TMPDIR`”的 env 对象不够——
 *     StdioTransport 默认 `{...process.env, ...env}`，被删的键会从父进程 env 重新长回来。
 *  2. **修复（绿）**：`nativeLaunchCommand()` 返回自有启动器命令，**同一份父进程 env + 默认合并**下，
 *     子进程拿到的就是干净环境（HOME = OS 账户家目录，没有 `CFFIXED_USER_HOME`，没有合成临时目录）。
 *  3. **argv 不泄密**：启动器命令的 argv 里不出现任何环境变量的值（只允许键名与非敏感 HOME 路径）。
 *
 * 安全边界：子进程是 `node -e` 内联脚本，只读自己的 `process.env` 并发一行 JSON-RPC 到 stdout；
 * 不读盘、不连网、不回显白名单之外的任何变量。测试里放一个哨兵值专门断言它不会进 argv。
 */
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { test } from "node:test";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { envStrings, nativeLaunchCommand, nativeLaunchEnv } from "../src/native-launch-env.ts";

const REAL_HOME = userInfo().homedir;
const SYNTH_HOME = "/tmp/pia-native-stdio/home";
const SYNTH_TMP = "/tmp/pia-native-stdio/tmp";
const SYNTH_DATA = "/tmp/pia-native-stdio/data";
/** 造一个“像密钥”的值：只应留在 env 里，绝不能出现在 argv / ps 可见的位置。 */
const SECRET_SENTINEL = "pia-secret-sentinel-should-not-be-in-argv";

/** 白名单回显：只回 HOME / CFFIXED_USER_HOME / 三个临时目录 / 我们自己两个变量。 */
const ECHO_SCRIPT = `
const pick = (k) => (process.env[k] === undefined ? null : process.env[k]);
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
  HOME: pick("HOME"), CFFIXED_USER_HOME: pick("CFFIXED_USER_HOME"),
  TMPDIR: pick("TMPDIR"), TEMP: pick("TEMP"), TMP: pick("TMP"),
  PIA_DATA_DIR: pick("PIA_DATA_DIR"),
} }) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

const ENV_KEYS = ["HOME", "CFFIXED_USER_HOME", "TMPDIR", "TEMP", "TMP", "PIA_DATA_DIR", "PIA_TEST_SECRET"] as const;

/** 父进程 env 被“隔离启动”污染（模拟服务跑在合成 HOME/TMPDIR 下），外加一个哨兵值。 */
const polluteParentEnv = () => {
	const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	process.env.HOME = SYNTH_HOME;
	process.env.CFFIXED_USER_HOME = SYNTH_HOME;
	process.env.TMPDIR = SYNTH_TMP;
	process.env.TEMP = SYNTH_TMP;
	process.env.TMP = SYNTH_TMP;
	process.env.PIA_DATA_DIR = SYNTH_DATA;
	process.env.PIA_TEST_SECRET = SECRET_SENTINEL;
	return () => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};
};

/** 用真实 StdioTransport 起子进程，取回它回显的那一行（白名单）。 */
async function childEnvOf(transport: StdioTransport): Promise<Record<string, string | null>> {
	const got = new Promise<Record<string, string | null>>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("子进程 5 秒内没有回显环境")), 5000);
		transport.onMessage((m) => {
			const r = (m as { result?: Record<string, string | null> }).result;
			if (r) {
				clearTimeout(timer);
				resolve(r);
			}
		});
		transport.onError((e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
	await transport.start();
	return got;
}

test("阻塞复现：只传“删过键”的 env 对象，StdioTransport 会把合成 HOME / CFFIXED_USER_HOME 从父进程重新合并回来", async () => {
	const restore = polluteParentEnv();
	try {
		// 我们算出来的“干净”环境：HOME 是 OS 家目录，CFFIXED / 合成 TMPDIR 已删。
		const clean = nativeLaunchEnv({ realHome: REAL_HOME, syntheticRoots: [SYNTH_DATA] });
		assert.equal(clean.env.CFFIXED_USER_HOME, undefined);
		const transport = new StdioTransport({ command: process.execPath, args: ["-e", ECHO_SCRIPT], env: envStrings(clean.env), stderr: "pipe" });
		try {
			const seen = await childEnvOf(transport);
			assert.equal(seen.PIA_DATA_DIR, SYNTH_DATA, "覆盖生效的部分是对的");
			// 但删除没有生效：这两个键从父进程 env 又回来了。这就是要修的阻塞点。
			assert.equal(seen.CFFIXED_USER_HOME, SYNTH_HOME, "合并会把 delete 过的键重新长回来");
			assert.equal(seen.TMPDIR, SYNTH_TMP, "合成 TMPDIR 同样会回来");
		} finally {
			await transport.close();
		}
	} finally {
		restore();
	}
});

test("修复后（生产形态：仍用默认合并）：子进程最终环境 = OS 账户家目录、无 CFFIXED_USER_HOME、无合成临时目录", async () => {
	const restore = polluteParentEnv();
	try {
		const cmd = nativeLaunchCommand({ command: process.execPath, args: ["-e", ECHO_SCRIPT] }, { realHome: REAL_HOME, syntheticRoots: [SYNTH_DATA] });
		assert.equal(cmd.envReplaced, true);
		assert.equal(cmd.stripped.sort().join(","), "CFFIXED_USER_HOME,TEMP,TMP,TMPDIR");
		// argv 里只有键名与非敏感 HOME：任何环境变量的值（尤其哨兵）都不许出现。
		const argvText = cmd.args.join(" ");
		assert.ok(!argvText.includes(SECRET_SENTINEL), "环境变量的值不能进 argv（ps / 操作历史可见）");
		assert.ok(!argvText.includes(SYNTH_TMP), "合成临时目录的路径也不该进 argv");
		assert.deepEqual(
			cmd.args.filter((a) => a.startsWith("--set=")),
			[`--set=HOME=${REAL_HOME}`],
			"只允许覆盖非敏感路径类变量",
		);
		// 故意不传 env / inheritEnv：走 Pi 生产里的默认合并路径，证明合并也带不回被删的键。
		const transport = new StdioTransport({ command: cmd.command, args: cmd.args, stderr: "pipe" });
		try {
			assert.equal(transport.pid, undefined);
			const seen = await childEnvOf(transport);
			assert.equal(seen.HOME, REAL_HOME, "HOME 必须是 OS 账户家目录");
			assert.equal(seen.CFFIXED_USER_HOME, null, "CFFIXED_USER_HOME 必须真的不在最终环境里");
			for (const k of ["TMPDIR", "TEMP", "TMP"]) assert.equal(seen[k], null, `${k} 必须是「没有」，不是合成目录`);
			assert.equal(seen.PIA_DATA_DIR, SYNTH_DATA, "数据隔离变量照旧传下去（靠 PIA_*，不靠改 HOME）");
		} finally {
			await transport.close();
		}
	} finally {
		restore();
	}
});

test("我们自己的 StdioTransport：inheritEnv:false + env 也是全量替换（同一子进程环境）", async () => {
	const restore = polluteParentEnv();
	try {
		const cmd = nativeLaunchCommand({ command: process.execPath, args: ["-e", ECHO_SCRIPT] }, { realHome: REAL_HOME, syntheticRoots: [SYNTH_DATA] });
		const transport = new StdioTransport({ command: process.execPath, args: ["-e", ECHO_SCRIPT], env: cmd.env, inheritEnv: cmd.inheritEnv, stderr: "pipe" });
		try {
			const seen = await childEnvOf(transport);
			assert.equal(seen.HOME, REAL_HOME);
			assert.equal(seen.CFFIXED_USER_HOME, null);
			assert.equal(seen.TMPDIR, null);
		} finally {
			await transport.close();
		}
	} finally {
		restore();
	}
});

test("生产形态：HOME 本来就对时，最终环境保留真实 TMPDIR（不误剥）", async () => {
	const realTmp = process.env.TMPDIR;
	if (!realTmp) return; // 没有真实 TMPDIR 的环境（如某些 CI）跳过这条形态断言
	const cmd = nativeLaunchCommand({ command: process.execPath, args: ["-e", ECHO_SCRIPT] }, { realHome: REAL_HOME, syntheticRoots: [SYNTH_DATA] });
	assert.equal(cmd.stripped.length, 0);
	const transport = new StdioTransport({ command: cmd.command, args: cmd.args, stderr: "pipe" });
	try {
		const seen = await childEnvOf(transport);
		assert.equal(seen.HOME, REAL_HOME);
		assert.equal(seen.TMPDIR, realTmp);
	} finally {
		await transport.close();
	}
});
