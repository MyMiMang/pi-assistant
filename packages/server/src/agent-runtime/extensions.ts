/** 每个会话挂哪些 Pi 扩展（工具）：沙箱、审批、投递、记忆、技能、主动性、定时、邮箱、浏览器、电脑、图片；以及 MCP / Pi 扩展包。 */
import { spawnSubagent, listSubagents, getSubagent, hasSubagentCapacity, messageSubagent, stopSubagent, resumeSubagent, restartSubagent, withResumeInfo, type Subagent } from "../subagents.ts";
import { helperRoomOf, helperScope, helperSteps, peerHelperView, roomHelpers, scopedContext } from "../helper-scope.ts";
import { listWaits, parseDue, refreshWait, registerWait, cancelWait, WAIT_DEFAULT_INTERVAL_MS } from "../task-waits.ts";
import { imageExtensions } from "../image-gen/extension.ts";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { approvalExtension } from "@pi-assistant/ext-approval";
import { visionExtension } from "../vision-ext.ts";
import { computerExtension, computerLauncherExtension, isHostTool, trustedComputerTool, type ComputerHost } from "@pi-assistant/ext-computer";
import { actionHistoryText, recordAction } from "../action-log.ts";
import { guardContext } from "../guard.ts";
import { describeHostAction, cuaInstalled, macPermissionState, tierOf, hostApprovals, sandboxComputerSettings, hostAllowedFor, hostFileAccess, hostMcpCommand, hostPaused, hostStatus } from "../host-control.ts";
import { browserExtension, isBrowserTool } from "@pi-assistant/ext-browser";
import { emailExtension, isEmailTool, wechatExtension } from "@pi-assistant/ext-connectors";
import { openWechat, WECHAT_PROMPT, wechatAllowed } from "../wechat.ts";
import { accountsFor, getAccount, getDraft, listMail, readMail, saveDraft, sendDraft, fileReader } from "../email.ts";
import { browserFor, browserShared, isolatedContext, setHeaded } from "../browser.ts";
import { deliveryExtension } from "@pi-assistant/ext-delivery";
import { memoryExtension } from "@pi-assistant/ext-memory";
import { routinesExtension } from "@pi-assistant/ext-routines";
import { proactiveExtension } from "@pi-assistant/ext-proactive";
import { advanceConversation, agentQuiet, cancelFollowup, fmt as fmtTime, hiddenConversation, isHeartbeatTask, listFollowups, parseWhen, runOfTask, scheduleFollowup, surface as proactiveSurface } from "../proactive.ts";
import { sandboxExtension } from "@pi-assistant/ext-sandbox";
import { skillsExtension } from "@pi-assistant/ext-skills";
import { memory, type MemoryActor } from "../memory/index.ts";
import { computeNext, createRoutine, DEFAULT_QUIET, deleteRoutine, getRoutine, listRoutines, setRoutineStatus, updateRoutine, validateCron, webhookPath } from "../routines.ts";
import { DUP_THRESHOLD, acceptedProposalPrompt, awaitProposalAnswer, hasCreateGrant, resolveSuggestion, saveSkillVersioned, searchSkills, setSuggestSettings, skillDiff, submitProposal } from "../skill-intel.ts";
import { deleteSkill, getSkill, skillPaths } from "../skills.ts";
import { assignedSkillIds, enableSkillForAgent, unassignSkillEverywhere } from "../skill-assignments.ts";
import { enabledSkillsFor } from "../skill-scope.ts";
import { bus } from "../bus.ts";
import { mcpServersFor } from "../mcp.ts";
import { packagePathsFor } from "../pi-packages.ts";
import { config } from "../config.ts";
import { db, uid } from "../db.ts";
import { deliverFromWorkspace, fileInfo, insideWorkspace, workspaceOf } from "../files.ts";
import { insertMessage, roomOfConversation } from "../messages.ts";
import { localBashOperations, makeBashTool } from "../pi-adapter/index.ts";
import { notify } from "../push.ts";
import { requests } from "../requests.ts";
import { dockerOperations, sandboxMode } from "../sandbox.ts";
import { beforeComputerAction, cuaMcpCommand, desktopPause, desktopStatus, screenTools, screenshotDesktop, startDesktop, touchAgent } from "../desktop.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { BRAND } from "@pi-assistant/shared";
import { getAgent } from "./rows.ts";
import { roomHooks } from "./room-hooks.ts";
import { pendingUpdates, maybeSuggest } from "./skill-suggest.ts";
import { runtime } from "./agent-runtime.ts";
import { agentBusy, tasks } from "./background-tasks.ts";

export function latestUserMessage(conversationId: string | null) {
	return db.prepare("SELECT id FROM messages WHERE role = 'user' AND (conversation_id = ? OR (room_id IS NOT NULL AND room_id = ?)) ORDER BY rowid DESC LIMIT 1").get(conversationId, roomOfConversation(conversationId)) as { id: string } | undefined;
}

export async function extensionsFor(agentId: string, conversationId: string | null, taskId: string | null, opts: { allowSpawn: boolean; subagentId?: string; actor?: MemoryActor }) {
	// 记忆写入者身份：服务端按会话上下文注入，工具参数伪造不了（子代理→subagent、后台任务→background、主会话→main）
	const memActor: MemoryActor = opts.actor ?? (opts.subagentId ? "subagent" : taskId ? "background" : "main");
	const memTaskId = taskId ?? opts.subagentId ?? null;
	const memParent = memActor === "main";
	const workspace = workspaceOf(agentId);
	const mode = await sandboxMode();
	const desk = await desktopStatus(agentId).catch(() => null);
	const computerOn = desk?.state === "running";
	const heartbeat = isHeartbeatTask(taskId);
	const approve = async (toolName: string, input: Record<string, unknown>, summary: string, risk = "medium") =>
		!!(await requests.approval(agentId, taskId, toolName, input, summary, risk, conversationId)).approved;
	// 本会话自己派的帮手；帮手会话里只认它自己派的下一层
	const own = (r: Subagent) => r.agent_id === agentId && r.conversation_id === conversationId && (!opts.subagentId || r.parent_subagent_id === opts.subagentId);
	const mustOwn = (id: string) => { const r = getSubagent(id); if (!r || !own(r)) throw new Error("不是本会话派的帮手"); };
	const exts = [
		{ name: "pia-sandbox", factory: sandboxExtension({ workspace, mode, readOnlyRoots: skillPaths(), makeBashTool: makeBashTool, dockerOperations: mode === "docker" ? dockerOperations(agentId, workspace) : undefined, localOperations: mode === "docker" ? localBashOperations() : undefined, hostAccess: () => hostFileAccess(agentId) }) },
		{
			name: "pia-approval",
			factory: approvalExtension({
				workspace,
				guard: guardContext("host"),
				// 电脑工具（sandbox 目标）和浏览器工具由各自的扩展把关（提交/付款/发送/上传才审批）
				trusted: (n) => trustedComputerTool("sandbox")(n) || isBrowserTool(n) || isHostTool(n) || isEmailTool(n) || n === "wechat_open" || n === "room_assign" || n === "room_propose_member" || n === "propose_room" || n === "work_create" || n === "work_submit" || n === "work_verify" || n === "work_list" || n === "work_update" || n === "work_report" || n === "work_ask_user" || n === "room_goal" || n === "room_goal_done",
				request: async (r) => {
					const res = await requests.approval(agentId, taskId, r.toolName, r.input, r.summary, r.risk, conversationId);
					return { approved: !!res.approved, note: res.note };
				},
				hostAccess: () => hostFileAccess(agentId),
			}),
		},
		{
			name: "pia-delivery",
			factory: deliveryExtension({
				deliverFile: async (path, caption) => {
					const f = deliverFromWorkspace(agentId, path, hostFileAccess(agentId));
					// 群任务执行的帮手交付的是任务结果：直接进群（群里人人能看结果），不留在执行详情里
					const toRoom = !!opts.subagentId && getSubagent(opts.subagentId)?.kind === "work";
					insertMessage({ agentId, conversationId, role: "assistant", content: caption ?? "", subagentId: toRoom ? null : opts.subagentId, meta: { attachments: [fileInfo(f)], fromTask: taskId, ...(toRoom ? { fromHelper: opts.subagentId } : {}) } });
					return { fileId: f.id, name: f.name };
				},
				ask: async (question, options, allowFreeText) => (await requests.question(agentId, taskId, question, options, allowFreeText, conversationId)).answer ?? "",
				spawnTask: opts.allowSpawn && !opts.subagentId ? async (title, instructions) => ({ taskId: tasks.spawn(agentId, title, instructions, { conversationId }).id }) : undefined,
				subagents: opts.allowSpawn ? {
					spawn: async (input) => {
						const a = getAgent(agentId)!;
						const fallback = runtime(agentId, conversationId).modelFor(a);
						if (!fallback) throw new Error("没有可用的模型");
						const parent = latestUserMessage(conversationId);
						// 帮手派下一层：继承上一层的角色范围（spawnSubagent 里继承），名额满了就自己做（上一层在等它，排队会互相卡住）
						if (opts.subagentId && !hasSubagentCapacity(agentId)) throw new Error("帮手名额已满：这一块自己做，不要再派");
						const scope = opts.subagentId ? getSubagent(opts.subagentId)?.scope ?? null : helperScope(agentId, conversationId);
						const { done_criteria, ...rest } = input;
						return spawnSubagent(agentId, conversationId!, fallback, { ...rest, context: scopedContext(scope, done_criteria, input.context), parentMessageId: parent?.id, parentSubagentId: opts.subagentId, scope });
					},
					// 自己派的：完整记录 + 最近的工具步骤；群里别的成员派的：列表只给概况，点名查给完整过程（helper-scope.ts）
					list: () => {
						const roomId = opts.subagentId ? null : helperRoomOf(conversationId);
						const mine = listSubagents(agentId, conversationId ?? undefined).filter(own).map(withResumeInfo);
						return roomId ? [...mine, ...roomHelpers(roomId, agentId).map((r) => peerHelperView(agentId, conversationId, r)).filter(Boolean)] : mine;
					},
					get: (id) => {
						const r = getSubagent(id);
						if (r && own(r)) return { ...withResumeInfo(r), steps: helperSteps(id) };
						return opts.subagentId ? null : peerHelperView(agentId, conversationId, r, true);
					},
					message: async (id, text) => {
						mustOwn(id);
						await messageSubagent(id, text, latestUserMessage(conversationId)?.id);
					},
					resume: async (id) => (mustOwn(id), withResumeInfo(resumeSubagent(id, { mode: "manual" }))),
					stop: async (id) => (mustOwn(id), stopSubagent(id)),
					restart: async (id, note) => (mustOwn(id), restartSubagent(id, note)),
				} : undefined,
				// 任务等待：登记一次持久等待，结束当前回合，由 scheduler 在有结果时做一次结构化增量唤醒
				waits: opts.allowSpawn && !opts.subagentId
					? {
						register: (i) => {
							const checkIntervalMs = i.checkMinutes !== undefined ? Math.max(1, i.checkMinutes) * 60_000 : WAIT_DEFAULT_INTERVAL_MS;
							const w = registerWait(agentId, conversationId, { taskId: i.taskId, subagentId: i.subagentId, githubRun: i.githubRun, dueAt: i.due ? parseDue(i.due) : undefined, checkIntervalMs, reason: i.reason });
							return { id: w.id, kind: w.target_kind, dueAt: w.due_at, intervalMs: w.check_interval_ms };
						},
						list: () =>
							listWaits(agentId).map((w) => ({ id: w.id, kind: w.target_kind, ref: w.target_ref, status: w.status, reason: w.reason, dueAt: w.due_at, lastCheckedAt: w.last_checked_at, checkCount: w.check_count, firedReason: w.fired_reason, outcome: w.outcome })),
						refresh: async (id) => {
							const owned = listWaits(agentId).find((w) => w.id === id);
							if (!owned) throw new Error("等待记录不存在");
							const r = await refreshWait(id);
							const o = r.outcome;
							return { status: r.wait.status, detail: o ? `${o.state}${o.conclusion ? `/${o.conclusion}` : ""}${o.detail ? `：${o.detail}` : ""}` : "还没有结果", fired: r.fired };
						},
						cancel: (id) => (listWaits(agentId).some((w) => w.id === id) ? cancelWait(id) : false),
					}
					: undefined,
			}),
		},
		{
			name: "pia-memory",
			factory: memoryExtension({
				context: (prompt) => memory.context(agentId, conversationId, prompt, 6000, { taskId: memTaskId, parent: memParent }),
				remember: (i) => memory.remember(agentId, conversationId, { ...i, actor: memActor, taskId: memTaskId, subagentId: opts.subagentId, source: memParent ? "agent" : memActor }),
				retainTurn: (t) => memory.retainTurn(agentId, conversationId, { ...t, actor: memActor, taskId: memTaskId }),
				recall: async (q, limit) => (await memory.recall(agentId, conversationId, q, limit, { taskId: memTaskId, parent: memParent })).map((m) => ({ id: m.id, text: m.text, scope: m.scope, kind: m.kind, createdAt: m.createdAt, status: m.status })),
				forget: (id) => memory.forget(agentId, id, { actor: memActor, taskId: memTaskId, subagentId: opts.subagentId }),
				reflect: memory.capabilities(agentId).reflect ? (q) => memory.reflect(agentId, q, { actor: memActor, conversationId, taskId: memTaskId, parent: memParent }) : undefined,
				review: memParent
					? {
						list: async () => (await memory.listDrafts(agentId)).map((m) => ({ id: m.id, text: m.text, scope: m.scope, kind: m.kind, createdAt: m.createdAt, status: m.status })),
						promote: (id, scope) => memory.promote(agentId, id, { scope, actor: "main", conversationId }),
						reject: (id) => memory.rejectDraft(agentId, id, { actor: "main" }),
					}
					: undefined,
				onChange: () => bus.emit({ type: "memory.changed", agentId }),
			}),
		},
		{
			name: "pia-skills",
			factory: skillsExtension({
				list: () => enabledSkillsFor(agentId),
				get: (n) => enabledSkillsFor(agentId).find((s) => s.name === n),
				search: (q, ex) => {
					const enabled = new Set(assignedSkillIds(agentId));
					return searchSkills(q, { exclude: ex }).filter((h) => enabled.has(h.id));
				},
				dupThreshold: DUP_THRESHOLD,
				save: (i) => {
					const s = saveSkillVersioned(i, "agent");
					// 模型给本助理新建的技能：默认只启用给本助理，其它助理不受影响
					enableSkillForAgent(agentId, s.id);
					return s;
				},
				remove: (n) => {
					const s = getSkill(n);
					if (!s) return false;
					unassignSkillEverywhere(s.id);
					return deleteSkill(n);
				},
				confirm: (summary) => approve("skill_delete", {}, summary),
				confirmCreate: async ({ name, description, userText }) => {
					// 用户这轮明确提到技能，或刚同意过“做成技能”的建议 → 不再重复确认
					if (/技能|skill/i.test(userText) || hasCreateGrant(conversationId)) return true;
					return approve("skill_save", { name, description }, `新建技能「${name}」：${description}`);
				},
				confirmUpdate: async ({ name, before, after }) => {
					const ok = await approve("skill_save", { 技能: name, diff: skillDiff(name, before, after) }, `修改技能「${name}」`);
					const sg = pendingUpdates.get(conversationId ?? "");
					if (sg) (pendingUpdates.delete(conversationId ?? ""), resolveSuggestion(sg, ok ? "accepted" : "declined"));
					return ok;
				},
				observe: taskId
					? undefined
					: (turn) => void maybeSuggest(agentId, conversationId, turn).catch(() => {}),
				// 提议工具只在普通聊天轮里提供：巡检/子代理任务没有候选，也不应该提技能
				propose: taskId
					? undefined
					: async ({ suggestionId, purpose }) => {
						const r = submitProposal({ agentId, conversationId, suggestionId, purpose });
						if (!r.ok) return { status: "rejected" as const, error: r.error };
						// 卡片留给用户稍后回答，工具立即返回；不让无人点卡片占住模型执行。
						void awaitProposalAnswer({
							suggestionId,
							question: r.question,
							ask: async (question, options) => {
								const res = await requests.question(agentId, null, question, options, false, conversationId);
								return (res as { answer?: string }).answer;
							},
						}).then(async ({ status }) => {
							if (status === "accepted") await runtime(agentId, conversationId).nudge(acceptedProposalPrompt(r.topic, purpose));
							else if (status === "muted") {
								setSuggestSettings({ enabled: false });
								insertMessage({ agentId, conversationId: conversationId ?? undefined, role: "system", content: "好的，不再主动建议做成技能。可以在「设置 › 技能库」里重新打开。" });
							}
						}).catch(() => {});
						return { status: "pending" as const };
					},

			}),
		},
		{
			name: "pia-proactive",
			factory: proactiveExtension({
				// 巡检任务里才能“告诉用户”；普通聊天里助理直接说就行
				surface: heartbeat ? (i) => proactiveSurface(agentId, { ...i, sourceRun: taskId ? runOfTask(taskId) : null }) : undefined,
				// 主动推进：在相关对话的主会话里继续做事（正常权限路径）；心跳本身没有额外权限
				advance: heartbeat ? (i) => advanceConversation(agentId, i) : undefined,
				schedule: (i) => scheduleFollowup(agentId, conversationId && conversationId !== hiddenConversation(agentId) ? conversationId : null, i.dueAt, i.note),
				list: () => listFollowups(agentId),
				cancel: (id) => cancelFollowup(agentId, id),
				parseWhen: (w) => parseWhen(w),
				fmt: fmtTime,
			}),
		},
		{
			name: "pia-routines",
			factory: routinesExtension({
				list: () => listRoutines(agentId).map((r) => ({ id: r.id, name: r.name, trigger: r.trigger, cron: r.cron, status: r.status, nextRunAt: r.next_run_at })),
				describe: (spec) => describeRoutine(spec, agentId),
				confirm: (summary, input) => approve("routine_create", input, summary),
				create: (spec) => {
					const r = createRoutine(agentId, { name: spec.name, prompt: spec.prompt, trigger: spec.trigger, cron: spec.cron, quiet: spec.quietHours === false ? null : undefined, conversationId }, "agent");
					return { id: r.id, webhookUrl: webhookPath(r) };
				},
				update: (id, spec) => {
					if (getRoutine(id)?.agent_id !== agentId) throw new Error("不是你的定时任务");
					return updateRoutine(id, { ...spec, quiet: spec.quietHours === undefined ? undefined : spec.quietHours ? DEFAULT_QUIET : null });
				},
				setStatus: (id, st) => getRoutine(id)?.agent_id === agentId && !!setRoutineStatus(id, st),
				remove: (id) => getRoutine(id)?.agent_id === agentId && deleteRoutine(id),
			}),
		},
	];
	if (roomHooks) exts.push(...(roomHooks.extensions(agentId, conversationId, taskId) as never[]));
	/** 请用户接管：截图进聊天 + 推送到手机，等用户点“已完成” */
	const handoff = async (reason: string, png: Buffer, where: string) => {
		const dir = join(workspace, ".screens");
		mkdirSync(dir, { recursive: true });
		const rel = `.screens/handoff-${Date.now()}.png`;
		writeFileSync(join(workspace, rel), png);
		const f = deliverFromWorkspace(agentId, rel);
		insertMessage({ agentId, conversationId, role: "assistant", content: `需要你接管：${reason}\n\n${where}`, subagentId: opts.subagentId, meta: { attachments: [fileInfo(f)], fromTask: taskId, handoff: true } });
		notify({ title: `${BRAND.name}：需要你接管`, body: reason, data: { type: "handoff", agentId } });
		const r = await requests.question(agentId, taskId, `${reason}——完成后点“已完成”`, ["已完成", "做不了"], true, conversationId);
		return r.answer ?? "无回应";
	};
	// 邮箱：有账号时挂上（先草稿、批准后发送）
	if (accountsFor(agentId).length) {
		const acct = (id: string) => {
			const a = getAccount(id);
			if (!a || (a.agent_id && a.agent_id !== agentId)) throw new Error("没有权限使用这个邮箱");
			return a;
		};
		const readFile = fileReader((p) => {
			const abs = insideWorkspace(agentId, p);
			if (!abs) throw new Error(`只能附加工作区里的文件：${p}`);
			return abs;
		});
		exts.push({
			name: "pia-email",
			factory: emailExtension({
				accounts: () => accountsFor(agentId).map((a) => ({ id: a.id, name: a.name, address: a.address })),
				list: (id, o) => listMail(acct(id), o),
				read: async (id, uid, folder, save) => {
					const m = await readMail(acct(id), uid, folder);
					const attachments = m.attachments.map((x) => {
						if (!save) return { filename: x.filename, size: x.size };
						const rel = join("mail", `${uid}-${x.filename.replace(/[\\/:*?"<>|]/g, "_")}`);
						mkdirSync(join(workspace, "mail"), { recursive: true });
						writeFileSync(join(workspace, rel), x.content);
						return { filename: x.filename, size: x.size, savedTo: rel };
					});
					return { ...m, attachments };
				},
				saveDraft: async (id, d, draftId) => {
					acct(id);
					for (const p of d.attachments ?? []) readFile(p);
					return saveDraft(id, agentId, d, draftId);
				},
				getDraft: (id) => getDraft(id, agentId),
				approve: async (summary, input) => {
					const res = await requests.approval(agentId, taskId, "email_send", input, summary, "high", conversationId);
					return { approved: !!res.approved, note: res.note };
				},
				send: (id) => sendDraft(id, agentId, readFile),
			}),
		});
	}
	if (wechatAllowed(agentId)) exts.push({ name: "pia-wechat", factory: wechatExtension({ open: (p) => openWechat(agentId, p), prompt: WECHAT_PROMPT }) });
	exts.push({
		name: "pia-vision",
		factory: visionExtension({
			workspace,
			hostAccess: () => hostFileAccess(agentId),
			model: () => {
				const a = getAgent(agentId);
				return a ? runtime(agentId).modelFor(a) : null;
			},
		}) as never,
	});
	exts.push({
		name: "pia-browser",
		factory: browserExtension({
			workspace,
			context: async () => (await browserFor(agentId)).ctx,
			get shared() {
				return browserShared(agentId);
			},
			isolated: () => isolatedContext(agentId),
			mode: () => (computerOn ? "sandbox" : "host"),
			isPaused: () => desktopPause.isPaused(agentId),
			request: async (r) => {
				const res = await requests.approval(agentId, taskId, r.toolName, r.input, r.summary, r.risk, conversationId, { allowTask: r.allowTask });
				return { approved: !!res.approved, note: res.note, scope: res.scope };
			},
			handoff: async (reason, png, url) => {
				const s = await browserFor(agentId);
				if (s.mode === "sandbox") return handoff(reason, png, "可以在右侧「电脑」标签里直接操作，或用手机扫描下面画面中的二维码。");
				// 本机无头浏览器：临时打开有界面的窗口让你在这台电脑上操作；不在电脑旁时可直接扫截图里的二维码
				await setHeaded(agentId, true, url);
				try {
					return await handoff(reason, png, "已在这台电脑上打开浏览器窗口，请在窗口里完成；不在电脑旁时，可以直接用手机扫描下面截图里的二维码。");
				} finally {
					const page = (await browserFor(agentId)).ctx.pages()[0];
					await setHeaded(agentId, false, page?.url());
				}
			},
		}),
	});
	// 助理电脑运行中 → 挂上 cua-driver（MCP）与看屏幕/接管工具
	const sandboxComputer = (): ComputerHost => ({
		target: "sandbox",
		mcp: cuaMcpCommand(agentId),
		isPaused: () => desktopPause.isPaused(agentId),
		screenshot: () => screenshotDesktop(agentId),
		approvals: () => sandboxComputerSettings().approvals,
		guard: guardContext("sandbox"),
		log: (e) => (touchAgent(agentId), recordAction(agentId, taskId, e, () => screenshotDesktop(agentId))),
		history: (o) => actionHistoryText(agentId, { target: "sandbox", ...o }),
		// 共用电脑：主屏幕正被别的助理操作时自动给这个助理开自己的屏幕（不抢鼠标键盘）
		before: () => beforeComputerAction(agentId, agentBusy),
		screens: screenTools(agentId),
		handoff: (reason, png) => handoff(reason, png, "可以在右侧「电脑」标签里直接操作，或用手机扫描下面画面中的二维码。"),
		request: async (r) => {
			const res = await requests.approval(agentId, taskId, r.toolName, r.input, r.summary, r.risk, conversationId, { allowTask: r.allowTask });
			return { approved: !!res.approved, note: res.note, scope: res.scope };
		},
	});
	if (computerOn) exts.push({ name: "pia-computer", factory: computerExtension(sandboxComputer()) });
	// 助理电脑已安装但关着机 → 先挂“开电脑”工具；调用后在同一轮里热注册电脑工具（不用等下一轮）
	else if (desk?.available && desk.state !== "running")
		exts.push({ name: "pia-computer-launcher", factory: computerLauncherExtension({ computer: sandboxComputer(), start: async () => void (await startDesktop(agentId), bus.emit({ type: "desktop.changed", agentId })) }) });
	// 用户开启了“操作这台电脑”且允许这个助理 → 挂上本机 Cua（每个动作逐项审批）。
	// 这里只看“授权在不在”，不看守护进程此刻是不是 running：更新后服务刚重启、Cua 还在 starting（或刚失败重试中）时，
	// 如果按瞬时状态决定挂不挂，这个会话就整组没有电脑工具，用户会以为“授权被重置了，得去设置重新开一次”。
	// 未就绪时由下面的 before 明确告诉他原因（结构化原因，不靠沉默）。
	if (hostAllowedFor(agentId) && cuaInstalled())
		exts.push({
			name: "pia-hostpc",
			factory: computerExtension({
				target: "host",
				mcp: hostMcpCommand(agentId),
				isPaused: () => hostPaused(),
				describe: describeHostAction,
				workspace,
				browserTools: tierOf(agentId) !== "bounded",
				hostFileAccess: () => hostFileAccess(agentId),
				approvals: () => hostApprovals(agentId),
				guard: guardContext("host"),
				log: (e) => recordAction(agentId, taskId, e),
				history: (o) => actionHistoryText(agentId, { target: "host", limit: o.limit }),
				// 守护进程没就绪：说清楚是什么问题、要不要用户动手，不让任务在同一个动作上反复重试或无声卡住
				before: async () => {
					const st = hostStatus();
					const s = st.daemon.state;
					if (s === "running" || s === "starting" || s === "paused") return null;
					const detail = st.daemon.detail;
					// 按真实原因分岔：权限计划真的变了 / 缺系统授权 / 只是没就绪，不说成“权限被重置”，也不把真原因藏在“稍后重试”里
					const planChanged = /权限设置已变化/.test(detail);
					const perms = st.macPermissions;
					const denied = (
						[
							["辅助功能", perms?.accessibility],
							["屏幕录制", perms?.screenRecording],
						] as [string, string | undefined][]
					)
						.filter(([, v]) => macPermissionState(v) === "denied")
						.map(([k]) => k);
					const guide = planChanged
						? "权限计划变化了（新增能力或作用域），需要用户本人到 设置 › 操作这台电脑 重新确认"
						: `原因：${detail}。如果只是还没就绪，稍后重试一次；连续失败就把原因告诉用户，别连续重试同一个动作`;
					const permHint = denied.length ? `系统设置里 ${denied.join(" / ")} 明确显示未授权，需要在 设置 › 操作这台电脑 打开授权引导由用户本人点。` : "";
					return `Cua Driver 现在没在运行，驱动尚未就绪，不一定是授权丢失（不一定是你这次的权限被重置）。先停下电脑操作：${guide}。${permHint}`;
				},
				request: async (r) => {
					const res = await requests.approval(agentId, taskId, r.toolName, r.input, r.summary, r.risk, conversationId, { allowTask: r.allowTask });
					return { approved: !!res.approved, note: res.note, scope: res.scope };
				},
			}),
		});
	// 配置了图片模型 → 挂 generate_image（image-gen/extension.ts）
	exts.push(...imageExtensions(agentId, conversationId, taskId));
	return exts;
}

/** 定时任务的人类可读说明（同时校验 cron） */
export function describeRoutine(spec: { trigger: string; cron?: string | null; quietHours?: boolean }, agentId?: string) {
	if (spec.trigger === "webhook") return "收到 Webhook 请求时执行";
	if (!spec.cron) throw new Error("cron 触发需要提供 cron 表达式");
	validateCron(spec.cron);
	// 免打扰按助理统一一份（和主动跟进共用）；没有助理上下文时按默认时段预览
	const follows = spec.quietHours !== false;
	const quiet = !follows ? null : agentId ? agentQuiet(agentId) : DEFAULT_QUIET;
	const next = computeNext({ agent_id: agentId, trigger: "cron", cron: spec.cron, tz: "Asia/Shanghai", quiet: follows ? JSON.stringify(DEFAULT_QUIET) : null });
	return `cron “${spec.cron}”（Asia/Shanghai${quiet ? `，免打扰 ${quiet.start}–${quiet.end} 顺延` : ""}），下次执行 ${next ? new Date(next).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—"}`;
}

// ---------------------------------------------------------------- MCP 与 Pi 扩展包

export function integrationsFor(agentId: string, conversationId: string | null) {
	return {
		mcpServers: mcpServersFor(agentId),
		mcpLogPath: join(config.dataDir, "logs", "mcp.log"),
		packagePaths: packagePathsFor(agentId),
		onMcpAuthUrl: (url: string) => {
			// OAuth 回调是本机回环地址，必须在这台电脑的浏览器里完成；同时把链接发到聊天里
			openOnHost(url);
			insertMessage({ agentId, conversationId: conversationId ?? undefined, role: "system", content: `有个 MCP 服务需要登录授权。已在电脑上打开授权页；如果没弹出来，请**在这台电脑上**打开：\n\n${url}` });
		},
	};
}
function openOnHost(url: string) {
	const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
	try {
		spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).on("error", () => {}).unref();
	} catch {
		/* 没有图形界面就只发聊天消息 */
	}
}
