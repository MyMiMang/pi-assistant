/**
 * 长命令自动转后台里「碰 Pi」的部分（逻辑在 ../bg-jobs.ts，设计见 docs/design/background-commands.md）：
 * - 用 Pi 公开的 createBashToolDefinition + 可替换的 BashOperations 做一个同名 `bash` 工具（工具名 / 参数 / 审批拦截都不变），
 *   命令跑满 5 秒没结束就返回「已转后台」，进程继续跑；
 * - job_output / job_stop 两个配套工具；
 * - 作业结束后把结果送进会话：助理还在这一轮里 → steer（下一个工具边界就读到），已空闲 → 开新一轮（Pi sendCustomMessage 公开接口）。
 * Windows：Pi 自带的 powershell 工具同样是 createShellToolDefinition 做的，我们的会话没有启用它（Windows 上用 Git Bash 的 bash 工具），
 * 所以只包 bash；以后启用 powershell 时用同一个 withBackground 包它的 operations 即可。
 */
import { createBashToolDefinition, createLocalBashOperations, type AgentSession, type BashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BgDetached, type BgOwner, bgLimits, getJob, jobLine, killJob, killOwner, listJobs, tailOf, waitJob, withBackground } from "../bg-jobs.ts";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, ...(isError ? { isError } : {}) });

export const BG_CUSTOM_TYPE = "pia_bg_job";

type SpawnCtx = { command: string; cwd: string; env: NodeJS.ProcessEnv };

/** 同名 bash 工具：5 秒内结束和 Pi 自带的完全一样；没结束就转后台。owner 为 null（帮手 / 后台任务，没人插话）：照旧等命令跑完 */
export function makeBackgroundBashTool(cwd: string, opts: { operations?: BashOperations; spawnHook?: (c: SpawnCtx) => SpawnCtx }, owner: BgOwner | null) {
	if (!owner) return createBashToolDefinition(cwd, { operations: opts.operations, spawnHook: opts.spawnHook, exposeSessionEnvironment: false });
	const def = createBashToolDefinition(cwd, { operations: withBackground(opts.operations ?? createLocalBashOperations(), owner), spawnHook: opts.spawnHook, exposeSessionEnvironment: false });
	const inner = def.execute.bind(def);
	return {
		...def,
		description: `${def.description} If the command is still running after ${bgLimits.afterMs / 1000} seconds it is moved to the background (a job id is returned, the command keeps running, you are told when it ends); use job_output to look at or wait for it, job_stop to end it. A background job runs at most ${bgLimits.maxMs / 60_000} minutes.`,
		async execute(...args: Parameters<typeof inner>) {
			try {
				return await inner(...args);
			} catch (e) {
				if (!(e instanceof BgDetached)) throw e;
				const sec = bgLimits.afterMs / 1000;
				const out = tailOf(e.job.id);
				return text(
					`命令跑了 ${sec} 秒还没结束，已转到后台继续运行（编号 ${e.job.id}，最长 ${bgLimits.maxMs / 60_000} 分钟）。目前输出：\n${out || "（还没有输出）"}\n\n它结束后系统会把结果告诉你；想现在看或等它用 job_output，不要了用 job_stop。在它结束之前，不要对用户说这件事做完了。`,
				);
			}
		},
	};
}

/** job_output / job_stop 两个配套工具（所有者是同一个对话） */
export function bgJobsExtension(owner: BgOwner) {
	return (pi: ExtensionAPI) => {
		// 作业按对话归属，跨会话重建保留（停止 / 释放时由运行时结束）
		pi.registerTool({
			name: "job_output",
			label: "后台命令输出",
			description: "查看后台命令（bash 跑满 5 秒转到后台的作业）的状态和输出末尾；可以等它结束。不填 job_id 列出所有后台命令。",
			promptSnippet: "job_output: 查看 / 等待后台命令的输出",
			parameters: Type.Object({
				job_id: Type.Optional(Type.String({ description: "作业编号，如 job_ab12cd；不填 = 列出全部" })),
				wait_seconds: Type.Optional(Type.Number({ description: `最多等它结束多少秒（默认 0 = 立刻返回，最大 ${bgLimits.maxWaitSeconds}）` })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p, signal) {
				if (!p.job_id) {
					const all = listJobs(owner.key);
					return text(all.length ? all.map(jobLine).join("\n") : "没有后台命令。");
				}
				const j = await waitJob(owner.key, p.job_id, p.wait_seconds ?? 0, signal);
				if (!j) return text(`没有这个后台命令：${p.job_id}`, true);
				const out = tailOf(j.id);
				return text(`${jobLine(j)}\n输出末尾：\n${out || "（没有输出）"}`);
			},
		});
		pi.registerTool({
			name: "job_stop",
			label: "结束后台命令",
			description: "结束一个还在运行的后台命令。",
			promptSnippet: "job_stop: 结束后台命令",
			parameters: Type.Object({ job_id: Type.String({ description: "作业编号" }) }),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async execute(_id, p) {
				const j = getJob(owner.key, p.job_id);
				if (!j) return text(`没有这个后台命令：${p.job_id}`, true);
				if (!killJob(owner.key, p.job_id)) return text(`${jobLine(j)}（已经结束了，不用再停）`);
				return text(`已结束 ${p.job_id}。结束前的输出末尾：\n${tailOf(p.job_id) || "（没有输出）"}`);
			},
		});
	};
}

/** 把一段模型可见（聊天里不显示）的文字送进会话：这一轮还在跑就 steer，已空闲就开新一轮 */
export function sendBgResult(session: AgentSession, content: string) {
	return session.sendCustomMessage({ customType: BG_CUSTOM_TYPE, content, display: false }, { triggerTurn: true });
}
