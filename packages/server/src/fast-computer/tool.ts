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
 * 两种目标：
 *  - **原生窗口**（默认）：读 `get_window_state` 的原生 AX，用 `element_token` 派发；
 *  - **网页**（可选 `browser: {target_id, tab_id}` 或 `browser: {}` 让本工具用 pid+window_id 做一次精确绑定核对）：
 *    网页内容不在原生 AX 里（Chrome 后台窗口只暴露工具栏），所以读驱动 CDP 的 `get_browser_state` semantic_v2 refs，
 *    派发走 `browser_click{target_id, tab_id, ref}`（官方入参是 `ref`，不是 `element_token`）。
 *    只接受**精确绑定**（`binding_quality=exact` + `mutation_allowed`）；本工具**绝不**自己 `browser_prepare` / attach 浏览器，
 *    也不接受驱动报回来的 target/tab 与请求不一致（换 target 就是换权限面）→ 一律 fail-closed 交回主模型。
 *
 * 安全：快速模型看不到 tool/args；候选只允许电脑输入工具白名单；执行经 `ctx.executeTool`，
 * ext-computer 的 guard / 审批 / 暂停 / 凭据 deny 原样生效，不绕过。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { models } from "../models.ts";
import { recordUsage } from "../usage/index.ts";
import { createChatChooser, createClassifierChooser, MAX_FAST_CANDIDATES } from "./choosers.ts";
import { browserSnapshotAsWindow, parseBrowserBind, parseBrowserSnapshotView } from "./browser-snapshot.ts";
import {
	fastComputerSettings,
	selectFastAction,
	validateCandidates,
	resolveFreshCandidate,
	verifyExpectation,
	type FastActionCandidate,
	type FastActionChooser,
	type FastComputerScope,
	type FastComputerSettings,
	type FastExpectation,
	type FastSemanticTarget,
	type VerifyOutcome,
} from "./index.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** 按设置构建选择器。systemone = 原生 Jev 分类器（从 classifier 目录选）；chat = OpenAI 兼容替代（非 Jev）。 */
export function buildChooser(s: FastComputerSettings): FastActionChooser | null {
	if (s.kind === "systemone") {
		// 原生 Jev 必须绑定到「用户已配置认证的 classifier 模型」：provider/id 来自 Pi 的 classifier 目录，
		// 鉴权由 Pi 的 request-time 解析（按 model.provider 绑定 baseURL/headers/key），这里不取、不传 key。
		if (!s.provider || !s.id) return null;
		return createClassifierChooser({
			provider: s.provider,
			model: s.id,
			timeoutMs: s.timeoutMs,
			classify: (provider, model, context, opts) => models.classify(provider, model, context, opts),
		});
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

/** 浏览器 fixture 的会话级身份（driver `get_browser_state` 铸的 target/tab 能力，不是 pid/window）。 */
export interface FastBrowserTarget {
	target_id: string;
	tab_id: string;
	session?: string;
}

/**
 * 从**页面快照**（`get_browser_state` semantic_v2；refs 形如 `p3:7`）收集点击候选。
 * 浏览器里的网页内容不走原生 AX（Chrome 后台窗口不暴露 web AX 子树，实测只能看到工具栏），
 * 所以走驱动自己的 `browser_click{target_id,tab_id,ref}`；候选里 `element_token` 仍存 ref，
 * 好让执行前的「目标新鲜度重校验」同一套逻辑生效；派发时换成官方入参 `ref`（见 `dispatchArgs`）。
 *
 * 能力语义（`actions`）：`click` 才是「可直接点击」的显式能力；`pointer` 表示「可悬停 / 可滚动 / 可定位」，
 * **不等于** click。内容节点（`content_refs`）没有动作能力，`actions` 为空，永远不进候选。
 * `pointer`-only 的文本节点**没有删**：ref 点击落在元素中心，点「按钮里的文字」在真实页面上可能照样冒泡触发容器
 * 的点击（label-click）；但这一点**未在真实浏览器验证过**，所以既不当成已证事实，也不凭猜删掉候选。
 * 这个取舍在 `fast-computer-tool.test.ts` 里显式钉住语义（content 不进候选、pointer-only 保留）。
 */
export function clickCandidatesFromBrowserRefs(prefix: string, target: FastBrowserTarget, structured: unknown): FastActionCandidate[] {
	const elements = (structured as { elements?: CollectedElement[] } | null)?.elements ?? [];
	const clickable = elements.filter((e) => e.element_token && (!e.actions || e.actions.includes("click") || e.actions.includes("pointer")));
	return clickable.slice(0, MAX_FAST_CANDIDATES).map((e, i) => ({
		id: `ref-${i}`,
		label: `${e.role ?? "元素"}${e.label ? `：${e.label}` : ""}`.slice(0, 120),
		tool: `${prefix}browser_click`,
		args: { target_id: target.target_id, tab_id: target.tab_id, ...(target.session ? { session: target.session } : {}), element_token: e.element_token },
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
					"没开启、模型不可用、拿不准、超时或目标已变化都会明确回到你自己完成，不会无限重试。" +
					"目标是网页（Chrome / Edge / Brave 页面）时传 browser：要么带上你自己刚 get_browser_state 绑定得到的 target_id + tab_id，" +
					"要么给空对象 browser:{} 让本工具用 pid + window_id 做一次精确绑定核对（不会替你 attach / 拉起浏览器）；" +
					"网页目标读驱动 CDP 的 semantic_v2 refs、执行用 browser_click{ref}；不传 browser 则仍读原生 AX。",
				promptSnippet: "fast_pick_action: 用快速模型在有界候选里挑一个控件（默认关闭）",
				parameters: Type.Object({
					goal: Type.String({ description: "要达成的目标（一句话）" }),
					pid: Type.Integer({ description: "目标窗口所属进程 pid" }),
					window_id: Type.Integer({ description: "目标窗口 id" }),
					prefix: Type.Optional(Type.Union([Type.Literal("hostpc"), Type.Literal("computer")], { description: "电脑目标：hostpc=用户电脑，computer=助理电脑；默认按可用工具判断" })),
					session: Type.Optional(Type.String({ description: "cua session 标签（可选）；会透传到读取与执行，避免读错 / 点错会话" })),
					browser: Type.Optional(
						Type.Object({
							target_id: Type.Optional(Type.String({ description: "浏览器页面目标的 target_id（来自你自己 get_browser_state 的精确绑定）" })),
							tab_id: Type.Optional(Type.String({ description: "浏览器页面目标的 tab_id；与 target_id 同时给" })),
						}, { description: "网页目标（可选）：给 target_id + tab_id 就直接用；给空对象 {} 就用 pid + window_id 做一次精确绑定核对。本工具不会自行 attach 浏览器。" }),
					),
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
					const prefix = resolvePrefix(ctx, args.prefix);
					const s = fastComputerSettings(scopeOfPrefix(prefix));
					if (!s.enabled) return text("快速操作模型没有开启（设置 › 电脑 › 快速操作模型）。请直接用电脑工具自己完成。");
					const goal = String(args.goal ?? "").trim();
					const pid = Number(args.pid);
					const windowId = Number(args.window_id);
					if (!prefix) return text("没有可用的电脑工具（操作这台电脑 / 助理电脑都没开），无法收集候选。请自己完成。");
					const session = typeof args.session === "string" && args.session ? args.session : undefined;

					// 目标：默认读原生 AX；传了 `browser` 就读驱动 CDP 的页面快照（网页内容不在原生 AX 里）。
					// 浏览器目标只接受精确绑定证据：显式 target_id+tab_id，或本工具用既有 pid+window_id 做一次 bind 核对；
					// **绝不**自己 browser_prepare / attach 浏览器，也不换 target。
					const browserReq = parseBrowserRequest(args.browser);
					let collectTarget: FastCollectTarget = { kind: "native", target: { pid, window_id: windowId, session } };
					if (browserReq) {
						const bound = await resolveBrowserTarget(ctx, prefix, browserReq, { pid, window_id: windowId, session });
						if ("error" in bound) return text(`${bound.error} 请你自己用浏览器工具完成。`);
						collectTarget = { kind: "browser", target: bound.target };
					}

					const collected = await collectCandidates(ctx, prefix, collectTarget);
					if ("error" in collected) return text(`${collected.error} 请自己用电脑工具完成。`);
					const bad = validateCandidates(collected.candidates);
					if (bad) return text(`候选不可用（${bad}）。请自己用电脑工具完成。`);

					const chooser = (opts.chooserFor ?? buildChooser)(s);
					if (!chooser) return text(noChooserText(s));

					const key = captureKey(opts.agentId, prefix, collectTarget);
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
					if (res.kind === "fallback") return text(`快速路径跳过（${res.reason}${res.detail ? `：${res.detail}` : ""}）。由你在当前会话里自己用电脑工具完成（程序不会另发模型请求、也不会自动接管）；必要时先重新读取窗口状态，不要拿调用前的旧快照直接点击。`);

					// 执行前重查：用户在异步等待快模型期间取消 / 动态关闭，一律不派发任何动作。
					if (signal?.aborted) return text("已取消（用户停止）。未执行任何动作。请自己完成。");
					if (!fastComputerSettings(scopeOfPrefix(prefix)).enabled) return text("快速操作模型在执行前已被关闭，未执行任何动作。请自己完成。");

					// G2：独立重读**同一个目标**（原生=同 session 同窗口；网页=同 target 同 tab）并取**最新**快照，
					// 校验语义目标唯一且 role/value/actions 未变，再用新 element_token（网页是新的 ref）重构动作。
					const fresh = await collectCandidates(ctx, prefix, collectTarget);
					if ("error" in fresh) return text(`快速路径中止（执行前重读目标状态失败：${fresh.error}）。请自己完成，不要重复调用本工具。`);
					const resolved = resolveFreshCandidate(res.candidate, fresh.structured);
					if (!resolved.ok) return text(`快速路径中止（目标已变化：${freshReasonText(resolved.reason)}）。请自己重新读取窗口状态后再决定；不要重复调用本工具。`);

					const out = await ctx.executeTool(resolved.candidate.tool, dispatchArgs(collectTarget, resolved.candidate), { signal });

					// G3：执行后独立核验（另取一次快照），只返回 confirmed / unsatisfied / unknown。
					const verify = await verifyPostcondition(ctx, prefix, collectTarget, args.expected);
					const conf = res.uncalibrated ? "无原生校准概率，替代模型" : confidenceText(res);
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
		? "原生 Jev（SystemOne）还没选好 classifier 模型（设置 › 模型 › 快速操作模型），快速路径跳过。请自己完成。"
		: "快速操作模型没有选好模型，快速路径跳过。请自己完成。";

const freshReasonText = (reason: "no_semantic" | "not_found" | "ambiguous" | "changed") =>
	reason === "no_semantic" ? "候选缺少可校验的语义身份" : reason === "not_found" ? "原目标已找不到" : reason === "ambiguous" ? "同语义目标不唯一" : "目标的 role/value/actions 已变化";

const verifyText = (o: VerifyOutcome) => (o === "confirmed" ? "confirmed" : o === "unsatisfied" ? "unsatisfied" : "unknown");

/** 分开展示「阈值比较值」与协议原值：不同服务上这两个数不是一个量（Laya 的 confidence 是归一化熵）。
 * 阈值比较用原始精度，这里只为展示取到 4 位小数（不把 0.59996 显示成 0.6 却实际已过 / 没过）。 */
function confidenceText(res: { candidate?: { id: string }; confidence?: number; decisionConfidence?: number }): string {
	const shown = res.decisionConfidence ?? res.confidence;
	if (typeof shown !== "number") return "置信度 —";
	const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4);
	if (typeof res.confidence !== "number" || res.confidence === shown) return `置信度 ${fmt(shown)}`;
	return `置信度 ${fmt(shown)}（协议 confidence ${fmt(res.confidence)}）`;
}

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

/** 电脑前缀 → 快速操作设置的 scope：hostpc=用户电脑，computer=助理电脑；解析不出来就用全局（向后兼容）。 */
function scopeOfPrefix(prefix: string | null): FastComputerScope | undefined {
	if (prefix === "mcp__hostpc__") return "hostpc";
	if (prefix === "mcp__computer__") return "computer";
	return undefined;
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

/** 收集目标：原生窗口（AX element_token）或网页（CDP target/tab + ref）。 */
type FastCollectTarget = { kind: "native"; target: FastTarget } | { kind: "browser"; target: FastBrowserTarget };

/** 浏览器能力最小集：读页面快照 + 按 ref 点击。缺一个就 fail-closed，不自行 attach。 */
const BROWSER_TOOLS = ["get_browser_state", "browser_click"] as const;

/** `browser` 参数：给 target_id+tab_id = 直接用它；给空对象 = 用 pid+window_id 做精确绑定核对。 */
export interface FastBrowserRequest {
	target_id?: string;
	tab_id?: string;
}

/** 只认这两个字段（其它插值一律忽略）；`undefined`/非对象 = 不启用浏览器目标。 */
function parseBrowserRequest(raw: unknown): FastBrowserRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const out: FastBrowserRequest = {};
	if (typeof o.target_id === "string" && o.target_id.trim()) out.target_id = o.target_id.trim();
	if (typeof o.tab_id === "string" && o.tab_id.trim()) out.tab_id = o.tab_id.trim();
	return out;
}

/**
 * 解析浏览器目标。**不自 attach**（绝不调用 `browser_prepare`）：
 *  - 显式 target_id + tab_id → 直接用（主模型自己刚绑定的就是精确身份）；
 *  - 都不给 → 用既有 pid+window_id 调一次 `get_browser_state` 做绑定核对，要求 `binding_quality=exact` +
 *    `mutation_allowed`，再从 `tabs[]` 取唯一活动标签；
 *  - 只给一半 / 工具缺失 / 绑定证据不足 → 明确失败，交回主模型。
 */
async function resolveBrowserTarget(
	ctx: ExtensionToolContext,
	prefix: string,
	req: FastBrowserRequest,
	window: FastTarget,
): Promise<{ target: FastBrowserTarget } | { error: string }> {
	const names = ctx.tools.map((t) => t.name);
	const missing = BROWSER_TOOLS.filter((t) => !names.includes(`${prefix}${t}`));
	if (missing.length) return { error: `这台电脑的浏览器工具不完整（缺 ${missing.join("、")}），快速路径不支持网页目标。` };
	if (req.target_id && req.tab_id) return { target: { target_id: req.target_id, tab_id: req.tab_id, ...(window.session ? { session: window.session } : {}) } };
	if (req.target_id || req.tab_id) return { error: "browser 目标要么同时给 target_id + tab_id，要么都不给（都不给时用 pid+window_id 做精确绑定核对）。" };

	const r = await ctx.executeTool(`${prefix}get_browser_state`, { pid: window.pid, window_id: window.window_id, ...(window.session ? { session: window.session } : {}) });
	if (r.isError) return { error: `浏览器精确绑定核对失败：${outcomeText(r).slice(0, 300)}` };
	const binding = parseBrowserBind(r.result?.structuredContent);
	if (!binding.ok || !binding.targetId || !binding.tabId) {
		return { error: `浏览器精确绑定核对不通过：${binding.reason ?? "缺少 target_id / tab_id"}（本工具不会替你 attach / 拉起浏览器）。` };
	}
	return { target: { target_id: binding.targetId, tab_id: binding.tabId, ...(window.session ? { session: window.session } : {}) } };
}

/** 读原生窗口状态（`get_window_state {pid, window_id}`）。 */
async function readWindowState(ctx: ExtensionToolContext, prefix: string, target: FastTarget): Promise<{ structured: unknown } | { error: string }> {
	const r = await ctx.executeTool(`${prefix}get_window_state`, { pid: target.pid, window_id: target.window_id, ...(target.session ? { session: target.session } : {}), include_accessibility_tree: true, include_screenshot: false });
	if (r.isError) return { error: `读取窗口状态失败：${outcomeText(r).slice(0, 300)}` };
	return { structured: r.result?.structuredContent };
}

/**
 * 读**网页**快照（`get_browser_state {target_id, tab_id, snapshot_format:"semantic_v2"}`）并归一成同一套 elements。
 * fail-closed：读不到 / 没 pin / 驱动报回的 target 或 tab 与请求不一致（换 target = 换权限面）都中止。
 */
async function readBrowserState(ctx: ExtensionToolContext, prefix: string, target: FastBrowserTarget): Promise<{ structured: unknown } | { error: string }> {
	const r = await ctx.executeTool(`${prefix}get_browser_state`, {
		target_id: target.target_id,
		tab_id: target.tab_id,
		snapshot_format: "semantic_v2",
		...(target.session ? { session: target.session } : {}),
	});
	if (r.isError) return { error: `读取页面快照失败：${outcomeText(r).slice(0, 300)}` };
	const raw = r.result?.structuredContent;
	const view = parseBrowserSnapshotView(raw);
	if (!view.ok) return { error: `页面快照不可用：${view.reason ?? "fail-closed"}` };
	if ((view.targetId && view.targetId !== target.target_id) || (view.tabId && view.tabId !== target.tab_id)) {
		return { error: "页面快照报回的 target / tab 与请求不一致（拒绝换 target），已中止" };
	}
	return { structured: browserSnapshotAsWindow(raw) };
}

async function collectCandidates(ctx: ExtensionToolContext, prefix: string, t: FastCollectTarget): Promise<{ candidates: FastActionCandidate[]; structured: unknown } | { error: string }> {
	if (t.kind === "browser") {
		const read = await readBrowserState(ctx, prefix, t.target);
		if ("error" in read) return read;
		const candidates = clickCandidatesFromBrowserRefs(prefix, t.target, read.structured);
		if (!candidates.length) return { error: "当前页面没有可点击的候选控件。" };
		return { candidates, structured: read.structured };
	}
	const read = await readWindowState(ctx, prefix, t.target);
	if ("error" in read) return read;
	const candidates = clickCandidatesFromWindowState(prefix, t.target, read.structured);
	if (!candidates.length) return { error: "当前窗口没有可点击的候选控件。" };
	return { candidates, structured: read.structured };
}

/** capture / 熔断作用域键：原生=同窗口；网页=同 target+tab（换标签就是换作用域，不拿旧熔断挡新页面）。 */
function captureKey(agentId: string, prefix: string, t: FastCollectTarget): string {
	return t.kind === "browser" ? `${agentId}:${prefix}:browser:${t.target.target_id}:${t.target.tab_id}` : `${agentId}:${prefix}:${t.target.pid}:${t.target.window_id}`;
}

/**
 * 派发参数：原生窗口原样用 `element_token`；网页把新鲜 ref 换到 `browser_click` 的官方入参 `ref`
 * （不把 `element_token` 这个名字塞给浏览器工具）。
 */
function dispatchArgs(t: FastCollectTarget, candidate: FastActionCandidate): Record<string, unknown> {
	if (t.kind === "native") return candidate.args;
	const { element_token, ...rest } = candidate.args as Record<string, unknown>;
	return typeof element_token === "string" ? { ...rest, ref: element_token } : rest;
}

/** 执行后独立核验：另取一次**同一目标**的状态，按 expected 判定；没有 expected / 读不到 → unknown（绝不臆断成功）。 */
async function verifyPostcondition(ctx: ExtensionToolContext, prefix: string, t: FastCollectTarget, rawExpected: unknown): Promise<{ outcome: VerifyOutcome; detail: string }> {
	const expected = normalizeExpected(rawExpected);
	if (!expected) return { outcome: "unknown", detail: "未提供可验证的后置条件 expected" };
	const read = t.kind === "browser" ? await readBrowserState(ctx, prefix, t.target) : await readWindowState(ctx, prefix, t.target);
	if ("error" in read) return { outcome: "unknown", detail: `核验读取${t.kind === "browser" ? "页面快照" : "窗口状态"}失败：${read.error.slice(0, 200)}` };
	return { outcome: verifyExpectation(expected, read.structured), detail: `expected ${JSON.stringify(expected)}` };
}
