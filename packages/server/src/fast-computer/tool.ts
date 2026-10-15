/**
 * 快速操作模型工具层：`fast_pick_action`。
 *
 * 闭环：主模型给出 goal + 目标窗口（可选 expected 后置条件）→ 程序收集当前窗口状态 / 限候选 →
 * 快速模型只选一个候选 id → 程序回候选表校验 → **执行前独立重读同 session 同窗口**，要求语义目标唯一、
 * role/value/actions 不变，用新快照 element_token 重构目标 → 经既有电脑工具（`ctx.executeTool`，走同一套钩子）
 * 派发 → **执行后独立重读核验 expected 后置条件**（confirmed / unsatisfied / unknown）→ 结果回主模型。
 *
 * 失败 / abstain / 低可信 / 超时 / 模型故障 / 目标已变化 / 无法核验 → 明确回主模型，不无限重试、不重复操作。
 * 绝不把「执行返回成功」当成任务成功；没有 expected 就只能报 unknown 交回主模型。
 *
 * 安全：快速模型看不到 tool/args；候选只允许电脑输入工具白名单；执行经 `ctx.executeTool`，
 * ext-computer 的 guard / 审批 / 暂停 / 凭据 deny 原样生效，不绕过。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { models } from "../models.ts";
import { recordUsage } from "../usage/index.ts";
import { createChatChooser, MAX_FAST_CANDIDATES } from "./choosers.ts";
import {
	fastComputerSettings,
	selectFastAction,
	validateCandidates,
	resolveFreshCandidate,
	verifyExpectation,
	type FastActionCandidate,
	type FastActionChooser,
	type FastComputerSettings,
	type FastExpectation,
	type FastSemanticTarget,
	type VerifyOutcome,
} from "./index.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** 按设置构建选择器。systemone = 原生 Jev；chat = OpenAI 兼容替代（非 Jev）。 */
export function buildChooser(s: FastComputerSettings): FastActionChooser | null {
	if (s.kind === "systemone") {
		// 原生 Jev（SystemOne）渠道需要「用户所选渠道」的授权凭据；在拿到已授权的公开 auth 抽象之前
		// fail-closed：不再从全局 env 取 Key（否则可能把全局 Key 发给任意自定义 baseURL），也不再假装可用。
		return null;
	}
	if (!s.provider || !s.id) return null;
	return createChatChooser({
		provider: s.provider,
		id: s.id,
		timeoutMs: s.timeoutMs,
		complete: (p, m, req) => models.complete(p, m, { messages: req.messages.map((x) => ({ role: "user" as const, text: x.text })), maxTokens: req.maxTokens, temperature: req.temperature, signal: req.signal }),
	});
}

interface CollectedElement extends FastSemanticTarget {
	element_index?: number;
	element_token?: string;
}

/** 目标窗口标识（可选 cua session 标签；G1：必须透传到读取 / 执行，否则可能读到 / 点错会话）。 */
export interface FastTarget {
	pid: number;
	window_id: number;
	session?: string;
}

/** 从当前窗口状态程序化收集「点击」候选（语义候选 → 预构建动作 ID）。 */
export function clickCandidatesFromWindowState(prefix: string, target: FastTarget, structured: unknown): FastActionCandidate[] {
	const elements = (structured as { elements?: CollectedElement[] } | null)?.elements ?? [];
	const clickable = elements.filter((e) => e.element_token && (!e.actions || e.actions.includes("press") || /button|checkbox|radio|link|menuitem|tab|row|cell|textfield|combobox/i.test(e.role ?? "")));
	return clickable.slice(0, MAX_FAST_CANDIDATES).map((e) => ({
		id: `el-${e.element_index ?? 0}`,
		label: `${e.role ?? "元素"}${e.label ? `：${e.label}` : ""}`.slice(0, 120),
		tool: `${prefix}click`,
		args: { pid: target.pid, window_id: target.window_id, ...(target.session ? { session: target.session } : {}), element_token: e.element_token },
		// 收集时的语义身份：执行前重读同窗口据此校验目标唯一且未变（G2）。
		semantic: { role: e.role, label: e.label, value: e.value, actions: e.actions },
	}));
}

const outcomeText = (r: { result?: { content?: { type: string; text?: string }[] } }) => (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

export interface FastComputerToolOptions {
	agentId: string;
	conversationId?: string | null;
	taskId?: string | null;
	/** 测试注入：覆盖默认 chooser 构建（生产不传，走 buildChooser）。 */
	chooserFor?: (s: FastComputerSettings) => FastActionChooser | null;
}

export function fastComputerExtension(opts: FastComputerToolOptions) {
	return {
		name: "pia-fast-computer",
		factory: (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "fast_pick_action",
				label: "快速操作模型",
				description:
					"当你已经把目标收窄成一组有界候选、但需要在当前窗口里挑一个最合适的控件时用：程序读当前窗口状态生成候选，" +
					"由一个可选快速模型（默认关闭）只挑一个候选 id，然后由程序经既有电脑工具执行。" +
					"执行前程序会重新读取同一窗口状态，要求目标唯一且未变化，再用新 element_token 派发；目标变了就中止回你。" +
					"执行后程序会用 expected 做独立核验，返回 confirmed / unsatisfied / unknown；没有 expected 只会返回 unknown，别把执行成功当成任务成功。" +
					"快速模型看不到工具名 / 参数 / 坐标，也不能自由调工具；选中不等于授权，执行仍走原有权限与审批。" +
					"没开启、模型不可用、拿不准、超时或目标已变化都会明确回到你自己完成，不会无限重试。",
				promptSnippet: "fast_pick_action: 用快速模型在有界候选里挑一个控件（默认关闭）",
				parameters: Type.Object({
					goal: Type.String({ description: "要达成的目标（一句话）" }),
					pid: Type.Integer({ description: "目标窗口所属进程 pid" }),
					window_id: Type.Integer({ description: "目标窗口 id" }),
					prefix: Type.Optional(Type.Union([Type.Literal("hostpc"), Type.Literal("computer")], { description: "电脑目标：hostpc=用户电脑，computer=助理电脑；默认按可用工具判断" })),
					session: Type.Optional(Type.String({ description: "cua session 标签（可选）；会透传到读取与执行，避免读错 / 点错会话" })),
					expected: Type.Optional(
						Type.Object({
							role: Type.Optional(Type.String({ description: "后置条件：目标元素的 role" })),
							label_contains: Type.Optional(Type.String({ description: "后置条件：目标元素 label 包含该子串" })),
							value_equals: Type.Optional(Type.String({ description: "后置条件：目标元素 value 等于该值" })),
							action_contains: Type.Optional(Type.String({ description: "后置条件：目标元素暴露的 actions 含该动作" })),
							exists: Type.Optional(Type.Boolean({ description: "后置条件：该元素存在（true，默认）/ 不存在（false）" })),
						}),
					),
				}),
				async execute(_id: string, args: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionToolContext) {
					const s = fastComputerSettings();
					if (!s.enabled) return text("快速操作模型没有开启（设置 › 模型 › 快速操作模型）。请直接用电脑工具自己完成。");
					const goal = String(args.goal ?? "").trim();
					const pid = Number(args.pid);
					const windowId = Number(args.window_id);
					const prefix = resolvePrefix(ctx, args.prefix);
					if (!prefix) return text("没有可用的电脑工具（操作这台电脑 / 助理电脑都没开），无法收集候选。请自己完成。");
					const session = typeof args.session === "string" && args.session ? args.session : undefined;
					const target: FastTarget = { pid, window_id: windowId, session };

					const collected = await collectCandidates(ctx, prefix, target);
					if ("error" in collected) return text(`${collected.error} 请自己用电脑工具完成。`);
					const bad = validateCandidates(collected.candidates);
					if (bad) return text(`候选不可用（${bad}）。请自己用电脑工具完成。`);

					const chooser = (opts.chooserFor ?? buildChooser)(s);
					if (!chooser) return text(noChooserText(s));

					const key = `${opts.agentId}:${prefix}:${pid}:${windowId}`;
					const res = await selectFastAction({
						key,
						goal,
						candidates: collected.candidates,
						chooser,
						settings: s,
						signal,
						onUsage: (u) => {
							try {
								recordUsage({ agentId: opts.agentId, provider: u.provider, model: u.model, conversationId: opts.conversationId ?? null, subagentId: opts.taskId ?? null, input: u.input, output: u.output, cacheRead: 0, cacheWrite: 0 });
							} catch (e) {
								console.error("[fast-computer] 记录用量失败", e);
							}
						},
					});

					if (res.kind === "disabled") return text("快速操作模型没有开启。请自己完成。");
					if (res.kind === "fallback") return text(`快速路径跳过（${res.reason}${res.detail ? `：${res.detail}` : ""}）。请自己用电脑工具完成，不要重复调用本工具。`);

					// 执行前重查：用户在异步等待快模型期间取消 / 动态关闭，一律不派发任何动作。
					if (signal?.aborted) return text("已取消（用户停止）。未执行任何动作。请自己完成。");
					if (!fastComputerSettings().enabled) return text("快速操作模型在执行前已被关闭，未执行任何动作。请自己完成。");

					// G2：独立重读同 session 同窗口，校验语义目标唯一且 role/value/actions 未变，用新 element_token 重构动作。
					const fresh = await collectCandidates(ctx, prefix, target);
					if ("error" in fresh) return text(`快速路径中止（执行前重读窗口状态失败：${fresh.error}）。请自己完成，不要重复调用本工具。`);
					const resolved = resolveFreshCandidate(res.candidate, fresh.structured);
					if (!resolved.ok) return text(`快速路径中止（目标已变化：${freshReasonText(resolved.reason)}）。请自己重新读取窗口状态后再决定；不要重复调用本工具。`);

					const out = await ctx.executeTool(resolved.candidate.tool, resolved.candidate.args, { signal });

					// G3：执行后独立核验（另取一次窗口状态），只返回 confirmed / unsatisfied / unknown。
					const verify = await verifyPostcondition(ctx, prefix, target, args.expected);
					const conf = res.uncalibrated ? "无原生校准概率，替代模型" : `confidence ${res.confidence ?? "—"}`;
					const dispatchNote = out.isError ? "执行返回错误（未确认动作已生效）。" : "已派发。";
					return text(
						`快速模型选了「${res.candidate.label}」（${conf}）。${dispatchNote}` +
							`\n独立核验：${verifyText(verify.outcome)}${verify.detail ? `（${verify.detail}）` : ""}` +
							`\n${verify.outcome === "confirmed" ? "后置条件已满足。" : verify.outcome === "unsatisfied" ? "后置条件未满足，请自己判断并重新规划；不要盲目重复同一动作。" : "无法确认是否达成，请自己用独立来源核验后决定下一步。"}` +
							`${outcomeText(out) ? `\n${outcomeText(out).slice(0, 2000)}` : ""}`,
					);
				},
			});
		},
	};
}

const noChooserText = (s: FastComputerSettings) =>
	s.kind === "systemone"
		? "原生 Jev（SystemOne）渠道接入待完成：当前没有可用的已授权渠道凭据，快速路径 fail-closed 跳过。请自己完成。"
		: "快速操作模型没有选好模型，快速路径跳过。请自己完成。";

const freshReasonText = (reason: "no_semantic" | "not_found" | "ambiguous" | "changed") =>
	reason === "no_semantic" ? "候选缺少可校验的语义身份" : reason === "not_found" ? "原目标已找不到" : reason === "ambiguous" ? "同语义目标不唯一" : "目标的 role/value/actions 已变化";

const verifyText = (o: VerifyOutcome) => (o === "confirmed" ? "confirmed" : o === "unsatisfied" ? "unsatisfied" : "unknown");

/** 只接受已知后置条件字段（不接受任意表达式）；空对象视为未提供。 */
function normalizeExpected(raw: unknown): FastExpectation | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const o = raw as Record<string, unknown>;
	const out: FastExpectation = {};
	if (typeof o.role === "string") out.role = o.role;
	if (typeof o.label_contains === "string") out.label_contains = o.label_contains;
	if (typeof o.value_equals === "string") out.value_equals = o.value_equals;
	if (typeof o.action_contains === "string") out.action_contains = o.action_contains;
	if (typeof o.exists === "boolean") out.exists = o.exists;
	return Object.keys(out).length ? out : undefined;
}

function resolvePrefix(ctx: ExtensionToolContext, requested: unknown): string | null {
	const names = ctx.tools.map((t) => t.name);
	const host = "mcp__hostpc__";
	const sandbox = "mcp__computer__";
	if (requested === "hostpc") return names.some((n) => n.startsWith(host)) ? host : null;
	if (requested === "computer") return names.some((n) => n.startsWith(sandbox)) ? sandbox : null;
	if (names.some((n) => n.startsWith(host))) return host;
	if (names.some((n) => n.startsWith(sandbox))) return sandbox;
	return null;
}

async function readWindowState(ctx: ExtensionToolContext, prefix: string, target: FastTarget): Promise<{ structured: unknown } | { error: string }> {
	const r = await ctx.executeTool(`${prefix}get_window_state`, { pid: target.pid, window_id: target.window_id, ...(target.session ? { session: target.session } : {}), include_accessibility_tree: true, include_screenshot: false });
	if (r.isError) return { error: `读取窗口状态失败：${outcomeText(r).slice(0, 300)}` };
	return { structured: r.result?.structuredContent };
}

async function collectCandidates(ctx: ExtensionToolContext, prefix: string, target: FastTarget): Promise<{ candidates: FastActionCandidate[]; structured: unknown } | { error: string }> {
	const read = await readWindowState(ctx, prefix, target);
	if ("error" in read) return read;
	const candidates = clickCandidatesFromWindowState(prefix, target, read.structured);
	if (!candidates.length) return { error: "当前窗口没有可点击的候选控件。" };
	return { candidates, structured: read.structured };
}

/** 执行后独立核验：另取一次窗口状态，按 expected 判定；没有 expected / 读不到 → unknown（绝不臆断成功）。 */
async function verifyPostcondition(ctx: ExtensionToolContext, prefix: string, target: FastTarget, rawExpected: unknown): Promise<{ outcome: VerifyOutcome; detail: string }> {
	const expected = normalizeExpected(rawExpected);
	if (!expected) return { outcome: "unknown", detail: "未提供可验证的后置条件 expected" };
	const read = await readWindowState(ctx, prefix, target);
	if ("error" in read) return { outcome: "unknown", detail: `核验读取窗口状态失败：${read.error.slice(0, 200)}` };
	return { outcome: verifyExpectation(expected, read.structured), detail: `expected ${JSON.stringify(expected)}` };
}
