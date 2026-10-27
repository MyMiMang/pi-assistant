/**
 * 向本机 `claude` 问模型列表：发一条 `initialize` 控制请求，读回包里的 `models`（= claude 里 `/model` 菜单的完整清单）。
 * 不发用户消息、不耗额度；拿到就关 stdin 并结束进程。环境和启动时同一套白名单（`buildClaudeEnv`）。
 * 回包里的 `account` 等字段不读、不记日志、不存。
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { extractModels, parseClaudeModels, type ClaudeModelInfo } from "./claude-models-parse.ts";
import { buildClaudeEnv } from "./launch.ts";

export interface ListClaudeModelsOptions {
	cwd: string;
	baseEnv?: NodeJS.ProcessEnv;
	/** 额外环境变量（测试用假 claude 选场景） */
	extraEnv?: Record<string, string>;
	timeoutMs?: number;
}

const ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--no-session-persistence"];

/** 问 `claude` 的模型列表；超时 / 没登录 / 回包里没有 models 都抛带原因的错误（调用方退回内置三个别名）。 */
export function listClaudeModels(command: string, opts: ListClaudeModelsOptions): Promise<ClaudeModelInfo[]> {
	mkdirSync(opts.cwd, { recursive: true });
	return new Promise((resolve, reject) => {
		const child = spawn(command, ARGS, { cwd: opts.cwd, env: buildClaudeEnv({ baseEnv: opts.baseEnv, command, extra: opts.extraEnv }), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
		let done = false;
		const finish = (err: Error | null, value?: ClaudeModelInfo[]) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			child.stdin.destroy();
			child.kill();
			if (err) reject(err);
			else resolve(value!);
		};
		const timer = setTimeout(() => finish(new Error("问 claude 模型列表超时")), opts.timeoutMs ?? 30_000);
		child.on("error", (e) => finish(new Error(`无法启动 claude：${e.message}`)));
		child.on("close", (code) => finish(new Error(`claude 没有返回模型列表（退出码 ${code ?? "未知"}）`)));
		child.stdin.on("error", () => {});
		createInterface({ input: child.stdout }).on("line", (line) => {
			let j: { type?: string } | null = null;
			try {
				j = JSON.parse(line);
			} catch {
				return;
			}
			if (j?.type !== "control_response") return;
			const list = parseClaudeModels(extractModels(j));
			finish(list.length ? null : new Error("claude 的回包里没有模型列表"), list);
		});
		child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } })}\n`);
	});
}
