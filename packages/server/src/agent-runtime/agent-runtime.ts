/** 每个对话一个运行时（独立的 Pi 会话）：发消息 / 插话 / 停止 / 群聊回合 / 整理上下文 / 隐藏触发。 */
import { createAgentSession } from "./agent-session.ts";
import { listSubagents, stopAgentSubagents, stopConversationSubagents, isLiveSubagent, agentFast } from "../subagents.ts";
import { cancelWaitsForConversation } from "../task-waits.ts";
import { imageKey } from "../image-gen/index.ts";
import { tierOf, hostAllowedFor, hostPaused, hostSettings, hostStatus } from "../host-control.ts";
import { wechatAllowed } from "../wechat.ts";
import { accountsFor } from "../email.ts";
import { cancelAdvances, drainAdvances, hiddenConversation, listAdvances } from "../proactive.ts";
import { NUDGE_TYPE } from "@pi-assistant/ext-skills";
import { conversationForkParent, currentConversation, getConversation, setConversationSession } from "../conversations.ts";
import { skillsVersion } from "../skills.ts";
import { assignmentsVersion } from "../skill-assignments.ts";
import { mcpVersion } from "../mcp.ts";
import { packagesVersion } from "../pi-packages.ts";
import { db } from "../db.ts";
import { type AttachmentInput, prepareAttachments } from "../attachments.ts";
import { supportsVision } from "../vision.ts";
import { isStopCommand } from "../interject.ts";
import { insertMessage, updateMessage } from "../messages.ts";
import { defaultModel, defaultThinking, models } from "../models.ts";
import { composeQuotedInput } from "../replies.ts";
import { abortSession, type AgentSession, type SkillInvocationInput, compactSession, triggerHidden, applyModelSettings, disposeSession, injectContext, isSessionBusy, lastAssistantText, modelErrorMessage, promptSession, skillCommand, sessionFileOf, sessionStats, subscribeSession, INTERJECTION_PREFIX } from "../pi-adapter/index.ts";
import { attachFastMode } from "../pi-adapter/fast-mode.ts";
import { requests } from "../requests.ts";
import { computerFor, desktopStatus } from "../desktop.ts";
import { type AgentRow, getAgent, setAgentStatus } from "./rows.ts";
import { roomHooks } from "./room-hooks.ts";
import { bindSession } from "./bind-session.ts";

/** 会话缓存键里的“本机操作”部分：开关、清单、档位、暂停、守护进程状态变化都会重建会话（权限本身仍每次调用动态求值） */
const hostKey = (agentId: string) =>
	hostAllowedFor(agentId) ? `${hostSettings().approvedHash}:${tierOf(agentId)}:${hostPaused() ? "paused" : hostStatus().daemon.state === "off" || hostStatus().daemon.state === "error" ? "down" : "up"}` : "off";

export class AgentRuntime {
	session: AgentSession | null = null;
	private modelKey = "";
	private unsub: (() => void) | null = null;
	private creating: Promise<AgentSession | null> | null = null;
	/** 只有宿主发起的技能用途推断允许无输出结束，普通请求与真实错误照常可见。 */
	private allowEmptyNudge = false;
	constructor(
		readonly id: string,
		readonly conversationId: string,
	) {}

	/** 这个助理的思考强度（已按当前模型收敛到支持的档位） */
	thinkingFor(a: AgentRow) {
		const m = this.modelFor(a);
		return m ? models.clampThinking(m.provider, m.id, a.thinking ?? defaultThinking()) : "off";
	}

	modelFor(a: AgentRow) {
		if (a.model_provider && a.model_id && models.getModel(a.model_provider, a.model_id)) return { provider: a.model_provider, id: a.model_id };
		return defaultModel();
	}

	async ensure(): Promise<AgentSession | null> {
		if (this.creating) return this.creating;
		const a = getAgent(this.id)!;
		const model = this.modelFor(a);
		if (!model) return null;
		const ds = await desktopStatus(this.id).catch(() => null);
		const desk = ds?.state === "running" ? "on" : ds?.available ? "off" : "none";
		const thinking = this.thinkingFor(a);
		// 模型 / 思考强度不在 key 里：用 session.setModel / setThinkingLevel 原地切换，不重建会话
		const room = roomHooks?.info(this.id, this.conversationId) ?? null;
		const key = `${a.name}|${a.persona}|room:${room?.key ?? "-"}|desk:${desk}|pc:${computerFor(this.id)}|skills:${skillsVersion()}|assign:${assignmentsVersion()}|mcp:${mcpVersion()}|pkg:${packagesVersion()}|host:${hostKey(this.id)}|mail:${accountsFor(this.id).map((a) => a.id).join(",")}|wx:${wechatAllowed(this.id)}|img:${imageKey(this.id)}`;
		if (this.session && this.modelKey === key) {
			if (!isSessionBusy(this.session)) await applyModelSettings(this.session, models, model, thinking).catch((e) => console.warn(`[model] ${e instanceof Error ? e.message : e}`));
			return this.session;
		}
		if (this.session && isSessionBusy(this.session)) return this.session; // 运行中先不切换
		this.creating = (async () => {
			this.unsub?.();
			if (this.session) disposeSession(this.session);
			const session = await createAgentSession(a, {
				sessionDir: "sessions",
				sessionFile: getConversation(this.conversationId)?.session_file,
				// 从消息另开、且分支点在首条消息之前：新会话只记父关系，等首条消息落盘（官方 newSession({ parentSession }) 语义）
				parentSession: conversationForkParent(this.conversationId),
				model,
				thinking,
				rules: room?.rules,
				conversationId: this.conversationId,
				taskId: null,
				ext: { allowSpawn: true, actor: room ? "group" : this.conversationId === hiddenConversation(this.id) ? "background" : "main" },
			});
			// 请求级 Fast：每次请求重新读这个助理的开关（公开 hook，不重建会话；与 thinking / 模型无关）
			const fast = attachFastMode(session, () => agentFast(this.id));
			const file = sessionFileOf(session);
			if (file && file !== getConversation(this.conversationId)?.session_file) setConversationSession(this.conversationId, file);
			const unUser = subscribeSession(session, (e) => {
				if (e.type === "user_start") this.allowEmptyNudge = false;
				if (e.type !== "user_start" || !e.text.startsWith(INTERJECTION_PREFIX) || /（(?:子代理|帮手)事件 /.test(e.text)) return;
				const mid = this.steering.shift();
				if (mid) updateMessage(mid, { meta: { delivery: "delivered", deliveredAt: Date.now() } });
			});
			const unBind = bindSession(session, this.id, this.conversationId, null, (aborted) => {
				if (isSessionBusy(session)) return;
				this.dropSteering(aborted ? "stopped" : "delivered");
				settleAgent(this.id);
				if (aborted) cancelAdvances(this.id, this.conversationId);
				else drainAdvances(this.id, this.conversationId);
				for (const w of [...this.waiters]) w(aborted);
			}, undefined, this.pendingUserEntries, fast, () => this.allowEmptyNudge);
			this.unsub = () => (unUser(), unBind());
			this.session = session;
			this.modelKey = key;
			return session;
		})();
		try {
			return await this.creating;
		} finally {
			this.creating = null;
		}
	}

	/** 把附件整理成模型输入（看图模型收到图片本身；文档附上文字摘录） */
	private async withAttachments(s: NonNullable<Awaited<ReturnType<typeof this.ensure>>>, text: string, files?: AttachmentInput[]) {
		if (!files?.length) return { text, images: undefined };
		// 图片只跟随当前对话模型：能看图就把图片发给它；不能看图就明确提示换模型，不静默改用别的模型。
		const vision = supportsVision(this.modelFor(getAgent(this.id)!));
		const p = await prepareAttachments(files, { vision });
		return { text: [text, p.text].filter((x) => x.trim()).join("\n\n"), images: p.images };
	}

	/** 已经发出、还没送进模型上下文的插话（用户消息 id，按顺序） */
	private steering: string[] = [];
	/** 已交给 Pi、还没落 meta.piEntryId 的 user 消息 id（按发送顺序）；与 entry_id(user) 事件 FIFO 配对 */
	private pendingUserEntries: string[] = [];
	private dropSteering(state: "stopped" | "delivered") {
		const ids = this.steering.splice(0);
		// 没送达的插话也从待映射队列里去掉，免得后面一条 user 消息误配到它
		if (ids.length) this.pendingUserEntries = this.pendingUserEntries.filter((x) => !ids.includes(x));
		for (const mid of ids) updateMessage(mid, { meta: { delivery: state } });
	}

	/**
	 * 发一条用户消息。助理空闲：开始新一轮。
	 * 正在工作：整条是停止词 → 立刻全部停下；否则作为插话在下一个工具边界送达（Pi steer），
	 * 消息上标 delivery = queued → delivered，界面显示“已送达正在进行的任务”。
	 */
	async send(text: string, files?: AttachmentInput[], opts: { messageId?: string; quote?: string; skills?: SkillInvocationInput[] } = {}): Promise<"started" | "steered" | "stopped" | "none"> {
		if ((this.busy || listSubagents(this.id).some((r) => isLiveSubagent(r.status))) && !files?.length && isStopCommand(text)) {
			if (opts.messageId) updateMessage(opts.messageId, { meta: { delivery: "stop" } });
			await this.abort();
			insertMessage({ agentId: this.id, conversationId: this.conversationId, role: "assistant", content: "好的，已经停下了。", status: "done", meta: { system: "stopped" } });
			return "stopped";
		}
		if (!this.busy && isStopCommand(text) && !files?.length && (this.hasPendingCards() || listAdvances({ agentId: this.id, conversationId: this.conversationId, status: "queued" }).length > 0)) {
			// 等待卡片或推进队列时说停也要真正取消，不依赖下一次settle。
			await this.abort();
			insertMessage({ agentId: this.id, conversationId: this.conversationId, role: "assistant", content: "好的，已经停下了。", status: "done", meta: { system: "stopped" } });
			return "stopped";
		}
		const s = await this.ensure();
		if (!s) {
			insertMessage({ agentId: this.id, conversationId: this.conversationId, role: "system", content: "还没有可用的模型。请先在「设置 → 模型」里登录一个模型服务并选择默认模型。", meta: { action: "open-models" } });
			return "none";
		}
		const steer = isSessionBusy(s);
		// 引用作为带 role wrapper 的上下文拼在用户新消息之前（不改 Pi 消息格式）
		const fullText = composeQuotedInput(text, opts.quote);
		// 本次点选的技能 → Pi 原生 `/skill:name`（Pi 自己读全文并拼进本轮输入）；只接受会话已加载的技能，失败不发送
		let skillCmd: string | undefined;
		if (opts.skills?.length) {
			try {
				skillCmd = skillCommand(s, opts.skills);
			} catch (e) {
				insertMessage({ agentId: this.id, conversationId: this.conversationId, role: "system", content: `本次选用的技能不可用：${e instanceof Error ? e.message : String(e)}`, status: "error" });
				return "none";
			}
		}
		setAgentStatus(this.id, "running");
		const input = await this.withAttachments(s, fullText, files).catch(() => ({ text: fullText, images: undefined }));
		if (steer && opts.messageId) {
			this.steering.push(opts.messageId);
			updateMessage(opts.messageId, { meta: { delivery: "queued" } });
		}
		// 记入待映射队列：Pi 落盘时按同一顺序回填 meta.piEntryId（插话要等到工具边界才落盘）
		if (opts.messageId) this.pendingUserEntries.push(opts.messageId);
		promptSession(s, input.text, input.images, skillCmd).catch((e: unknown) => {
			if (opts.messageId) {
				this.steering = this.steering.filter((x) => x !== opts.messageId);
				this.pendingUserEntries = this.pendingUserEntries.filter((x) => x !== opts.messageId);
			}
			const error = modelErrorMessage(e);
			insertMessage({ agentId: this.id, conversationId: this.conversationId, role: "system", content: `出错了：${error}`, status: "error", meta: { kind: "model-error", error } });
			if (!isSessionBusy(s)) settleAgent(this.id);
		});
		return steer ? "steered" : "started";
	}

	private hasPendingCards() {
		return !!db.prepare("SELECT 1 FROM requests WHERE status = 'pending' AND conversation_id = ? LIMIT 1").get(this.conversationId);
	}
	/** 停止时：这个对话里还在等用户处理的审批 / 提问按拒绝处理，让卡住的工具调用立刻返回 */
	private cancelPending(note: string) {
		const rows = db.prepare("SELECT id FROM requests WHERE status = 'pending' AND conversation_id = ?").all(this.conversationId) as { id: string }[];
		for (const r of rows) requests.resolve(r.id, { approved: false, answer: "（用户已停止）", note }, "system");
	}

	private waiters = new Set<(aborted: boolean) => void>();
	/**
	 * 群聊回合：发一条（模型可见的）消息，等这一轮彻底结束。
	 * 返回是否被中止、出错信息、本轮最后的回复文字、用掉的 token。
	 */
	async turn(text: string, files?: AttachmentInput[]): Promise<{ ok: boolean; aborted: boolean; error?: string; text: string; tokens: number }> {
		const s = await this.ensure();
		if (!s) {
			insertMessage({ agentId: this.id, conversationId: this.conversationId, role: "system", content: "还没有可用的模型。请先在「设置 → 模型」里登录一个模型服务并选择默认模型。", meta: { action: "open-models" } });
			return { ok: false, aborted: false, error: "没有可用的模型", text: "", tokens: 0 };
		}
		const before = sessionStats(s).session?.tokens.total ?? 0;
		const startedAt = Date.now();
		setAgentStatus(this.id, "running");
		let abortedFlag = false;
		const w = (a: boolean) => void (abortedFlag = abortedFlag || a);
		this.waiters.add(w);
		const done = new Promise<void>((resolve) => {
			const v = () => (this.waiters.delete(v), resolve());
			this.waiters.add(v);
		});
		let thrown: string | undefined;
		const input = await this.withAttachments(s, text, files).catch(() => ({ text, images: undefined }));
		await promptSession(s, input.text, input.images).catch((e: unknown) => {
			thrown = e instanceof Error ? e.message : String(e);
		});
		// prompt 正常返回时这一轮已结束；仍在跑（排在后面）就等 settled
		if (isSessionBusy(s)) await done;
		this.waiters.clear();
		const aborted = abortedFlag;
		if (!isSessionBusy(s)) settleAgent(this.id);
		const err = db.prepare("SELECT meta FROM messages WHERE conversation_id = ? AND role = 'assistant' AND status = 'error' AND created_at >= ? ORDER BY rowid DESC LIMIT 1").get(this.conversationId, startedAt) as { meta: string } | undefined;
		const error = thrown ?? (err ? String(JSON.parse(err.meta).error ?? "模型请求失败") : undefined);
		return { ok: !error && !aborted, aborted, error, text: lastAssistantText(s), tokens: Math.max(0, (sessionStats(s).session?.tokens.total ?? 0) - before) };
	}

	/** 停止：清掉没送达的插话，拒绝等待中的审批，中止模型请求和正在跑的工具（命令子进程、电脑操作随 abort 信号结束） */
	async abort(opts: { scope?: "agent" | "conversation" } = {}) {
		// 先同步失效推进队列与在飞回调，不能等模型abort异步完成再取消。
		cancelAdvances(this.id, this.conversationId);
		// 用户说停：这个对话登记中的任务等待一并取消，避免停下后又被唤醒
		cancelWaitsForConversation(this.conversationId, "用户停止了任务");
		if (opts.scope === "conversation") await stopConversationSubagents(this.id, this.conversationId);
		else await stopAgentSubagents(this.id);
		this.cancelPending("用户停止了任务");
		if (this.session) await abortSession(this.session);
		this.dropSteering("stopped");
		settleAgent(this.id);
	}

	get busy() {
		return !!this.session && isSessionBusy(this.session);
	}

	/** 手动整理上下文（Pi compaction）。instructions 可选，只影响摘要请求（希望保留什么）；空 = 原行为，不改变主会话 / 安全策略。 */
	async compact(instructions?: string) {
		const s = await this.ensure();
		if (!s) throw new Error("还没有可用的模型");
		if (isSessionBusy(s)) throw new Error("助理正在工作，等这一轮结束再整理");
		const focus = typeof instructions === "string" ? instructions.trim() : "";
		return compactSession(s, focus || undefined);
	}

	/** 让助理在后台接着做一轮（指令对模型可见，聊天里不显示）。返回 false 表示这一轮没能触发（无会话/模型或 Pi 报错）——
	 *  调用方（如任务等待唤醒）据此重试，而不是把“静默失败”当成已唤醒。 */
	async nudge(text: string, opts: { onlyIdle?: boolean; allowEmpty?: boolean } = {}): Promise<boolean> {
		const s = await this.ensure();
		if (!s || (opts.onlyIdle && isSessionBusy(s))) return false;
		this.allowEmptyNudge = !!opts.allowEmpty && !!opts.onlyIdle;
		setAgentStatus(this.id, "running");
		try {
			await triggerHidden(s, NUDGE_TYPE, text);
			return true;
		} catch {
			settleAgent(this.id);
			return false;
		} finally {
			this.allowEmptyNudge = false;
		}
	}

	async inject(text: string) {
		const s = await this.ensure();
		if (s) await injectContext(s, "pia_task_result", text).catch(() => {});
	}
}

/** 每个对话一个运行时（独立的 Pi 会话） */
export const runtimes = new Map<string, AgentRuntime>();
/** 某个对话结束一轮后：助理所有对话都空闲了才标记为空闲 */
export function settleAgent(agentId: string) {
	const busy = [...runtimes.values()].some((r) => r.id === agentId && r.busy);
	if (!busy) setAgentStatus(agentId, "idle");
}
/** 删除助理时释放它所有对话的会话 */
export async function disposeRuntime(agentId: string) {
	for (const cid of new Set(listAdvances({ agentId }).filter((r) => r.status === "queued" || r.status === "started").map((r) => r.conversation_id))) cancelAdvances(agentId, cid, "助理会话已释放，取消尚未完成的主动推进");
	await stopAgentSubagents(agentId);
	for (const [k, r] of [...runtimes]) {
		if (r.id !== agentId) continue;
		await r.abort().catch(() => {});
		if (r.session) disposeSession(r.session);
		runtimes.delete(k);
	}
}
export async function disposeConversationRuntime(conversationId: string) {
	const r = runtimes.get(conversationId);
	if (!r) {
		const c = db.prepare("SELECT agent_id FROM conversations WHERE id = ?").get(conversationId) as { agent_id: string } | undefined;
		if (c) {
			cancelAdvances(c.agent_id, conversationId, "对话已释放，取消尚未执行的主动推进");
			cancelWaitsForConversation(conversationId, "对话已释放");
			await stopConversationSubagents(c.agent_id, conversationId);
		}
		return;
	}
	await r.abort({ scope: "conversation" }).catch(() => {});
	if (r.session) disposeSession(r.session);
	runtimes.delete(conversationId);
}
/** 取某个对话的运行时；不传对话 = 助理的当前对话 */
export function runtime(agentId: string, conversationId?: string | null) {
	const conv = conversationId ?? currentConversation(agentId);
	let r = runtimes.get(conv);
	if (!r) runtimes.set(conv, (r = new AgentRuntime(agentId, conv)));
	return r;
}
