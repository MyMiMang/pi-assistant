/**
 * Laya benchmark 的 **supervisor 握手（worker 侧）**。
 *
 * 为什么不是 `PIA_BENCH_HARNESS_ENABLE=1`：环境变量是任何一次 `node` 调用都能设置的，
 * 等于「谁都能绕过外部监护直接跑 harness」。这里改成**父进程持有的管道证明**：
 *  - supervisor 启动 worker 时额外给 fd 3（worker→supervisor，checkpoint）和 fd 4（supervisor→worker，一次性 token）；
 *  - worker 必须从 fd 4 读到随机 token、核对 `process.ppid`，再把 token 原样 ack 回 fd 3；
 *  - fd 4 必须是 FIFO / socket，普通文件 / TTY 一律拒绝（不能预先写一个 token 文件冒充）。
 * token 只在内存管道里，不落盘、不进 argv。
 *
 * 读取带超时：直接 `node harness.mjs` 时 fd 3/4 可能恰好被外层工具占用（也是管道），
 * 没有超时就会永远等一个不会来的 token。
 */
import { createReadStream, fstatSync, writeSync } from "node:fs";

/** worker → supervisor：checkpoint 与最终结果。 */
export const SUPERVISOR_OUT_FD = 3;
/** supervisor → worker：一次性握手 token。 */
export const SUPERVISOR_IN_FD = 4;

/**
 * 接受 supervisor 的握手。成功返回 `{ supervisorPid, send }`，失败返回 null（调用方必须 fail-closed）。
 * `send` 把对象写成一行 JSON 发给 supervisor；管道断了返回 false（不抛）。
 */
export async function acceptSupervisorHandshake({ timeoutMs = 5_000 } = {}) {
	let st;
	try {
		st = fstatSync(SUPERVISOR_IN_FD);
	} catch {
		return null; // 直接运行 / 没给 fd
	}
	if (!st.isFIFO() && !st.isSocket()) return null; // 只认管道 / socket，不认普通文件

	const line = await new Promise((resolve) => {
		let buf = "";
		const stream = createReadStream(null, { fd: SUPERVISOR_IN_FD, autoClose: false });
		const done = (v) => {
			clearTimeout(timer);
			stream.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => done(null), timeoutMs);
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			buf += chunk;
			const i = buf.indexOf("\n");
			if (i >= 0) done(buf.slice(0, i));
		});
		stream.on("error", () => done(null));
		stream.on("end", () => done(null));
	});
	if (!line) return null;

	let hello;
	try {
		hello = JSON.parse(line);
	} catch {
		return null;
	}
	if (!hello || typeof hello.token !== "string" || hello.token.length < 16) return null;
	if (hello.supervisorPid !== process.ppid) return null;

	const send = (msg) => {
		try {
			writeSync(SUPERVISOR_OUT_FD, `${JSON.stringify(msg)}\n`);
			return true;
		} catch {
			return false;
		}
	};
	if (!send({ type: "ack", token: hello.token, pid: process.pid })) return null;
	return { supervisorPid: hello.supervisorPid, send };
}
