/**
 * @pi-assistant/ext-delivery —— 交付与协作工具（Pi 扩展）：
 *  deliver_file：把工作区文件作为附件发回聊天
 *  ask_user：在聊天里弹出带选项按钮的问题卡片，等待用户回答
 *  spawn_task：把耗时工作放到后台任务里执行
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface DeliveryHost {
	deliverFile(path: string, caption?: string): Promise<{ fileId: string; name: string }>;
	ask(question: string, options: string[], allowFreeText: boolean): Promise<string>;
	spawnTask?(title: string, instructions: string): Promise<{ taskId: string }>;
	subagents?: {
		spawn(input: { task: string; context?: string; needs?: string[]; model?: { provider: string; id: string }; thinking?: string }): Promise<{ id: string; status?: string; queuedAhead?: number }>;
		list(): unknown[];
		get?(id: string): unknown;
		message(id: string, text: string): Promise<void>;
		stop(id: string): Promise<boolean>;
	};
	waits?: {
		register(input: { reason: string; taskId?: string; subagentId?: string; githubRun?: { repo: string; runId?: number; branch?: string }; due?: string; checkMinutes?: number }): { id: string; kind: string; dueAt: number | null; intervalMs: number };
		list(): { id: string; kind: string; ref: string | null; status: string; reason: string; dueAt: number | null; lastCheckedAt: number | null; checkCount: number; firedReason: string | null; outcome: string | null }[];
		refresh(id: string): Promise<{ status: string; detail: string; fired: boolean }>;
		cancel(id: string): boolean;
	};
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function deliveryExtension(host: DeliveryHost) {
	return (pi: ExtensionAPI) => {
		if (host.subagents) {
			const h = host.subagents;
			pi.registerTool({
				name: "spawn_subagent", label: "派子代理", description: "把多步骤或耗时任务交给独立子代理，立即返回。主会话继续聊天，系统会送来结果供你核验汇报。", annotations: { readOnlyHint: true },
				parameters: Type.Object({ task: Type.String(), context: Type.Optional(Type.String()), needs: Type.Optional(Type.Array(Type.String())), model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })), thinking: Type.Optional(Type.String({ description: "思考强度：off/minimal/low/medium/high/xhigh/max；不传则用这个助理的子代理默认设置。" })) }),
				async execute(_id, p) { const r = await h.spawn(p); return text(r.status === "queued" ? `子代理已排队：${r.id}（前面还有 ${r.queuedAhead ?? 0} 个），有空位会自动开始。现在继续回复用户，不要等待。` : `子代理已开始：${r.id}。现在继续回复用户，不要等待。`); },
			});
			pi.registerTool({ name: "subagent_list", label: "查看子代理", description: "查看当前会话的子代理和状态；给 subagent_id 时返回这一个子代理的完整记录（含未截断的结果）。", annotations: { readOnlyHint: true }, parameters: Type.Object({ subagent_id: Type.Optional(Type.String({ description: "按 ID 查看这一个子代理的完整任务说明与结果" })) }), async execute(_id, p) { if (p.subagent_id) { const one = h.get?.(p.subagent_id); return text(one ? JSON.stringify(one) : "没有找到这个子代理。"); } return text(JSON.stringify(h.list())); } });
			pi.registerTool({ name: "subagent_message", label: "补充子代理要求", description: "把用户的补充或改方向要求送给子代理，在下一个工具边界生效。", annotations: { readOnlyHint: true }, parameters: Type.Object({ id: Type.String(), text: Type.String() }), async execute(_id, p) { await h.message(p.id, p.text); return text("已转交子代理。"); } });
			pi.registerTool({ name: "subagent_stop", label: "停止子代理", description: "停止指定子代理。", annotations: { readOnlyHint: true }, parameters: Type.Object({ id: Type.String() }), async execute(_id, p) { return text(await h.stop(p.id) ? "已停止。" : "已结束。"); } });
		}
		pi.registerTool({
			name: "deliver_file",
			label: "发送文件",
			description: "把工作区里的文件（报告、图片、表格、代码等）作为附件发给用户。生成文件后必须调用它，用户才能看到/下载。",
			promptSnippet: "deliver_file: 把工作区文件作为附件发给用户",
			parameters: Type.Object({
				path: Type.String({ description: "工作区内的文件路径" }),
				caption: Type.Optional(Type.String({ description: "附带的一句说明" })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const r = await host.deliverFile(p.path, p.caption);
				return text(`已把 ${r.name} 发送给用户（文件 ID ${r.fileId}）。`);
			},
		});
		pi.registerTool({
			name: "ask_user",
			label: "询问用户",
			description: "当需要用户做选择或确认信息时，用它在聊天里显示一个带选项按钮的问题卡片，并等待回答。不要用它请求执行危险操作的许可（那由系统自动审批）。",
			promptSnippet: "ask_user: 用选项按钮向用户提问并等待回答",
			parameters: Type.Object({
				question: Type.String(),
				options: Type.Array(Type.String(), { description: "2–5 个简短选项" }),
				allowFreeText: Type.Optional(Type.Boolean()),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const answer = await host.ask(p.question, p.options, p.allowFreeText ?? true);
				return text(`用户回答：${answer}`);
			},
		});
		const waits = host.waits;
		if (waits) {
			const w = waits;
			pi.registerTool({
				name: "task_wait",
				label: "登记任务等待",
				description:
					"登记一次持久等待，然后结束这一轮、别再用 sleep / 反复轮询去盯任务：内部后台任务完成/失败、子代理结束、GitHub Actions run 结束、或到点时间，系统都会自动唤醒你（只在你登记的那件事有结果时调用一次模型）。等待期间不会消耗 token。登记后请在回复里告诉用户你在等什么、大概什么时候有结果，然后停止输出，不要再调用任何工具。",
				promptSnippet: "task_wait: 登记等待（任务/子代理/GitHub run/到点），之后系统会唤醒你，不要 sleep 轮询",
				parameters: Type.Object({
					reason: Type.String({ description: "在等什么、唤醒后要做什么（到点时你看不到当前对话，写清楚上下文）" }),
					task_id: Type.Optional(Type.String({ description: "等待这个后台任务（spawn_task 返回的 id）完成" })),
					subagent_id: Type.Optional(Type.String({ description: "等待这个子代理完成" })),
					repo: Type.Optional(Type.String({ description: "等 GitHub Actions：仓库 owner/repo" })),
					run_id: Type.Optional(Type.Number({ description: "等 GitHub Actions：run id（不填就等该分支最新一次 run）" })),
					branch: Type.Optional(Type.String({ description: "等 GitHub Actions：分支（不填 run_id 时用）" })),
					due: Type.Optional(Type.String({ description: "到点时间 / 兜底截止：\"17:00\"、\"+30m\"、\"明天 9:00\"" })),
					check_minutes: Type.Optional(Type.Number({ description: "兜底检查间隔（分钟，默认 5，最小 1）；等待未变化时只检查不唤醒" })),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
				async execute(_id, p) {
					const r = w.register({ reason: p.reason, taskId: p.task_id, subagentId: p.subagent_id, githubRun: p.repo ? { repo: p.repo, runId: p.run_id, branch: p.branch } : undefined, due: p.due, checkMinutes: p.check_minutes });
					const when = r.dueAt ? `最晚 ${new Date(r.dueAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : "有结果时";
					return text(`已登记等待（${r.id}，等 ${r.kind}），${when}唤醒你。现在结束这一轮：简短告诉用户在等什么，不要再轮询或等待。`);
				},
			});
			pi.registerTool({
				name: "task_wait_list",
				label: "查看等待",
				description: "查看当前登记的任务等待和最后检查时间（用户问“现在怎么样了”时可以先看，再决定要不要刷新）。",
				parameters: Type.Object({}),
				annotations: { readOnlyHint: true },
				async execute() {
					const l = w.list();
					return text(l.length ? l.map((x) => `- ${x.id} · ${x.status} · 等 ${x.kind}${x.ref ? ` ${x.ref}` : ""} · 最后检查 ${x.lastCheckedAt ? new Date(x.lastCheckedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—"}（已查 ${x.checkCount} 次）${x.firedReason ? ` · 结果：${x.firedReason}` : ""} · ${x.reason}`).join("\n") : "没有登记中的等待。");
				},
			});
			pi.registerTool({
				name: "task_wait_check",
				label: "立即检查等待",
				description: "立即检查一次某个等待的最新状态并返回（用户问“现在怎么样了”时用，不等下一个定时检查）。",
				parameters: Type.Object({ id: Type.String() }),
				annotations: { readOnlyHint: true },
				async execute(_id, p) {
					const r = await w.refresh(p.id);
					return text(`状态：${r.status}；${r.detail}`);
				},
			});
			pi.registerTool({
				name: "task_wait_cancel",
				label: "取消等待",
				description: "取消一个登记中的等待（事情已经解决或用户说不用等了）。",
				parameters: Type.Object({ id: Type.String() }),
				annotations: { readOnlyHint: false, destructiveHint: false },
				async execute(_id, p) {
					return text(w.cancel(p.id) ? "已取消。" : `没有找到可取消的等待 ${p.id}`);
				},
			});
		}
		if (host.spawnTask) {
			const spawn = host.spawnTask;
			pi.registerTool({
				name: "spawn_task",
				label: "后台任务",
				description: "把耗时较长的工作（超过一两分钟）放到后台执行，用户可以继续聊别的；完成后会通知用户并把结果告诉你。",
				promptSnippet: "spawn_task: 把耗时工作放到后台执行",
				parameters: Type.Object({
					title: Type.String({ description: "简短的任务标题" }),
					instructions: Type.String({ description: "完整、自包含的执行说明" }),
				}),
				annotations: { readOnlyHint: true },
				async execute(_id, p) {
					const r = await spawn(p.title, p.instructions);
					return text(`后台任务已创建（${r.taskId}）：${p.title}。完成后系统会通知。现在先简短告诉用户任务已经在后台进行。`);
				},
			});
		}
	};
}
