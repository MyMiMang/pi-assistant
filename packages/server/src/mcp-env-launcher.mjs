#!/usr/bin/env node
/**
 * 原生 MCP 启动器（`native-launch-env.ts` 的 `nativeLaunchCommand()` 会用它启动 `cua-driver mcp`）。
 *
 * 为什么需要这一层：Pi 的 `StdioTransport` 默认 `{...process.env, ...options.env}`（`inheritEnv` 没关），
 * 而 Pi 内置 MCP 扩展构造 transport 时不暴露 `inheritEnv`，所以**只传一份“少几个键”的 env 对象删不掉任何东西**——
 * 被 `delete` 的 `CFFIXED_USER_HOME` / 合成 `TMPDIR` 会从父进程重新长回来。
 *
 * 这个启动器是**纯机制**（不含任何策略）：它继承父进程环境，按参数删几个键、覆盖几个键，然后
 * `spawn(真实命令, { env })` 用**全量替换**的环境起真正目标。策略仍在 TypeScript 侧（`native-launch-env.ts`），
 * 这里只执行 `--strip=KEY` / `--set=KEY=VALUE`。
 *
 * 安全边界（重要）：
 *  - argv **只**允许出现「要删的键名」和「非敏感覆盖值」（目前只有 HOME 这一个路径类变量）。
 *    **绝不把整份环境（JSON / base64 / K=V 列表）塞进 argv**：`ps`、操作历史、崩溃报告都能看到 argv。
 *  - 不读盘、不连网、不打印环境内容；stderr 只报启动失败原因。
 *  - stdin/stdout 用 `inherit` 直通，JSON-RPC 字节不经过这个进程。
 *
 * 用法（由 `nativeLaunchCommand()` 生成，不要手写）：
 *   node mcp-env-launcher.mjs --strip=CFFIXED_USER_HOME --set=HOME=/Users/x -- /path/cua-driver mcp --socket …
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const strip = [];
const set = {};
let i = 0;
for (; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--") {
		i++;
		break;
	}
	if (a.startsWith("--strip=")) strip.push(a.slice("--strip=".length));
	else if (a.startsWith("--set=")) {
		const kv = a.slice("--set=".length);
		const eq = kv.indexOf("=");
		if (eq <= 0) {
			process.stderr.write(`[mcp-env-launcher] 非法的 --set 参数\n`);
			process.exit(2);
		}
		set[kv.slice(0, eq)] = kv.slice(eq + 1);
	} else break;
}
const [command, ...args] = argv.slice(i);
if (!command) {
	process.stderr.write("[mcp-env-launcher] 缺少要启动的命令\n");
	process.exit(2);
}

const env = { ...process.env };
for (const key of strip) delete env[key];
for (const [key, value] of Object.entries(set)) env[key] = value;

const child = spawn(command, args, { env, stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
	process.on(sig, () => {
		try {
			child.kill(sig);
		} catch {}
	});
}
child.on("error", (e) => {
	process.stderr.write(`[mcp-env-launcher] 启动失败：${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(126);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
