/**
 * 请求级「Fast 快速模式」：只做 OpenAI / Codex 公开的 `service_tier` 语义。
 *
 * 事实来源（研究记录见工作区 `research/fast-inference-mode-review.md` 与 `research/fast-mode-source-check/`）：
 * - OpenAI Responses / Chat Completions 都接受 `service_tier`；`priority` 与 `fast` 都进入 Fast，官方说
 *   `fast` 在旧模型上回显成 `priority`，所以这里固定发 `priority`（Codex 的 `fast` 也映射成它）。
 * - 响应体的 `service_tier` 才是**实际**档位，可能被服务端降级成 `default`；请求成功 ≠ 加速成功。
 * - 中转站 / 兼容服务是否真的支持、是否加价：未知。所以「协议可带」只算 requestable-unverified，
 *   不凭兼容协议宣称服务真支持；不支持的协议 / 本地托管模型不发，并给出原因。
 *
 * 接入方式是 Pi 1.3.0 的公开 hook（`ProviderRequestOptions.onPayload` /
 * `onProviderStreamEvent`，由 `session.agent` 每轮请求透传，含工具循环与自动重试），
 * 不修改 SDK / node_modules，也不 monkeypatch 私有方法；已有 instrumentation 会被**组合**而不是覆盖。
 *
 * 明确不做：
 * - 关闭时绝不补 `service_tier: "auto"/"default"`（那会覆盖服务商 / 项目原有设置），只「不附加」。
 * - 不因为开了 Fast 就改思考强度、换模型、换候选池；与电脑快速操作模型（Jev/Laya）完全无关。
 * - 400 原样报错，不自动删参数重发（会重复推理 / 重复计费）。
 */

/** 固定发送的档位值：兼容性最好（Codex 的 `fast` 也映射到 `priority`）。 */
export const FAST_SERVICE_TIER = "priority" as const;
/** 能带 `service_tier` 的 Pi 协议（按公开 API 字段，不按服务商宣传）。 */
export const FAST_APIS = ["openai-responses", "openai-completions", "openai-codex-responses"] as const;
export type FastApi = (typeof FAST_APIS)[number];

/**
 * 后台能力口径（不冒充「已确认支持」）：
 * - `supported`：协议与官方服务文档都覆盖（目前只有 OpenAI 官方 Responses API）；
 * - `requestable-unverified`：协议能带，但服务（中转站 / 兼容服务）是否支持、是否加价未知，用户可显式请求；
 * - `unsupported`：协议没有这个字段 / 是本地托管模型，不发送。
 */
export type FastCapability = "supported" | "requestable-unverified" | "unsupported";

export interface FastCapabilityInfo {
	capability: FastCapability;
	/** 给界面 / 气泡的短原因（unsupported 必填，其余可选） */
	reason?: string;
}

export const FAST_UNSUPPORTED_REASON = "当前接口暂未接入 Fast";

/**
 * 判断某个**实际模型**能不能带 Fast。参数来自 Pi hook 的 model（不是最初选的模型），
 * 所以换模型 / 池内 fallback 后按新模型重新判断。
 */
export function fastCapability(api: string | undefined, provider?: string): FastCapabilityInfo {
	if (!api || !(FAST_APIS as readonly string[]).includes(api)) return { capability: "unsupported", reason: FAST_UNSUPPORTED_REASON };
	// 只有「服务级明确声明」才用 supported。当前没有这种声明：官方 OpenAI 文档也只说明参数存在，
	// 具体模型 / 账号仍可能拒绝或降级（ChatGPT 登录、自定义 endpoint 更未实测），所以不按 provider 名字猜。
	if (provider && VERIFIED_FAST_SERVICES.has(`${provider}:${api}`)) return { capability: "supported" };
	return { capability: "requestable-unverified", reason: "协议可以带这个参数，但服务 / 模型不一定支持、可能降级或额外收费；实际档位以服务回显为准" };
}

/** 未来拿到某服务「明确声明支持」的证据（文档 + 模型范围）才加进来；不按 provider 名或模型名猜。 */
const VERIFIED_FAST_SERVICES = new Set<string>();

/** 一次请求的注入结果（只描述这次请求，不跨请求复用）。 */
export type FastRequestStatus =
	| "injected" // 我们附加了 service_tier=priority
	| "off" // 开关关闭：不附加任何字段
	| "unsupported-api" // 当前模型协议不能带
	| "externally-configured" // payload 里已有 service_tier：尊重它，不再附加
	| "conflict" // 已有 service_tier 但不是 priority：不静默改写成「已 Fast」
	| "bad-payload"; // payload 不是普通对象：安全跳过

export interface FastPlan {
	/** 替换后的 payload；`changed=false` 时调用方应返回 undefined（Pi 契约：保持原样） */
	payload: unknown;
	changed: boolean;
	status: FastRequestStatus;
	capability: FastCapability;
	api: string | null;
	/** 本次是否真的请求了 priority（externally-configured 且值就是 priority 也算） */
	requested: boolean;
	/** payload 里原本就有的 service_tier（不改写，只用于提示冲突 / 外部配置） */
	existingTier: string | null;
	reason?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 纯函数：根据「开关 + 本次实际模型 + 现有 payload」决定要不要附加参数。
 * 不读全局状态、不写日志、不打印 payload / header。
 */
export function planFastRequest(payload: unknown, model: { api?: string; provider?: string } | undefined, enabled: boolean): FastPlan {
	const cap = fastCapability(model?.api, model?.provider);
	const base = { payload, changed: false, capability: cap.capability, api: model?.api ?? null, requested: false, existingTier: null as string | null };
	// 关闭时也看一眼 payload：模型 samplingParams / 别的 hook 自己带了 tier 就如实标 externally-configured，
	// 不让关灯看起来像「本次一定走标准档」（我们只是不额外附加，服务商默认档不变）。
	const hasExisting = isPlainObject(payload) && "service_tier" in payload;
	const existingTier = hasExisting && isPlainObject(payload) && typeof payload.service_tier === "string" ? payload.service_tier : null;
	if (!enabled) {
		if (!hasExisting) return { ...base, status: "off" };
		return {
			...base,
			status: "externally-configured",
			existingTier,
			requested: existingTier === FAST_SERVICE_TIER,
			reason: `关闭只停止本开关附加参数；请求里仍有服务 / 模型自己配置的 service_tier=${existingTier ?? "（非字符串）"}`,
		};
	}
	if (cap.capability === "unsupported") return { ...base, status: "unsupported-api", reason: cap.reason };
	if (!isPlainObject(payload)) return { ...base, status: "bad-payload", reason: "请求体不是普通对象，未附加 Fast" };
	if ("service_tier" in payload) {
		const existing = existingTier;
		const same = existing === FAST_SERVICE_TIER;
		return {
			...base,
			status: same ? "externally-configured" : "conflict",
			requested: same,
			existingTier: existing,
			reason: same ? "请求里已经带了 service_tier=priority（模型或服务自己配置的）" : `请求里已有 service_tier=${existing ?? "（非字符串）"}，不改写，本次不保证是 Fast`,
		};
	}
	return { ...base, payload: { ...payload, service_tier: FAST_SERVICE_TIER }, changed: true, status: "injected", requested: true };
}

/** 从 provider 原始事件里读 tier 字段（只读、只认公开响应字段）。 */
function tierOf(data: unknown): string | null {
	if (!isPlainObject(data)) return null;
	const direct = typeof data.service_tier === "string" ? data.service_tier : null;
	if (direct) return direct;
	const response = data.response;
	if (isPlainObject(response) && typeof response.service_tier === "string") return response.service_tier;
	return null;
}

/** Responses / Codex 的终止事件：只有它们的 response.service_tier 才可能是实际使用的档位。 */
const TERMINAL_EVENT_TYPES = new Set(["response.completed", "response.done", "response.incomplete", "response.failed"]);

/**
 * 实际档位：**只取终止事件**（`response.completed/done/incomplete/failed`）。
 * sub2api `upstream_response_model.go:78-90` 明确：非终止事件（如 `response.created`）回显的是**请求的** tier，
 * 不能当作 accepted / actual；把它当「已加速」是误判。
 */
export function observedFastTier(data: unknown): string | null {
	if (!isPlainObject(data)) return null;
	const type = typeof data.type === "string" ? data.type : "";
	if (!TERMINAL_EVENT_TYPES.has(type)) return null;
	return tierOf(data);
}

/**
 * 非终止回显（`response.created`、Chat Completions 流式 chunk 等）：只能算「服务回显了某个值」，
 * 来源可能是 requested（中转桥接会把 Responses 的 created 回显搬进 chunk），**不证明实际加速**。
 */
export function reportedFastTier(data: unknown): string | null {
	if (!isPlainObject(data)) return null;
	const type = typeof data.type === "string" ? data.type : "";
	if (TERMINAL_EVENT_TYPES.has(type)) return null;
	return tierOf(data);
}

/** 把回显值收敛成界面语义：只有 priority/fast 才算观测到 Fast；default 是标准档。 */
export function classifyObservedTier(tier: string | null | undefined): "fast" | "standard" | "other" | "unknown" {
	if (!tier) return "unknown";
	const t = tier.toLowerCase();
	if (t === "priority" || t === "fast") return "fast";
	if (t === "default") return "standard";
	return "other";
}

/** 一条请求 / 一条回复的 Fast 状态（短对象，能直接放消息 meta.fast）。 */
export interface FastSnapshot {
	/** 本次请求是否附加 / 确认了 priority */
	requested: boolean;
	/** 请求时读到的开关（false = 本次按标准档，未附加任何字段） */
	enabled: boolean;
	status: FastRequestStatus;
	capability: FastCapability;
	api: string | null;
	/** 终止事件回显的档位（原样短字符串，最多 32 字符；不存 body / header） */
	observed: string | null;
	observedKind: "fast" | "standard" | "other" | "unknown";
	/** 非终止回显（created / chunk）：来源可能是 requested，不能当实际档位 */
	reported: string | null;
	reportedKind: "fast" | "standard" | "other" | "unknown";
	reason?: string;
}

export interface FastTracker {
	/** 最近一次请求的状态快照（每次 onPayload 重新开始，不把上一条回复的回显套到下一次） */
	snapshot(): FastSnapshot;
}

/**
 * 只依赖 Pi 公开的 hook 字段形状。`model` 用 any 接住：函数参数逆变，
 * 只有 any 能同时兼容 Pi 的 `Model<Api>`（这里只读 api/provider 两个字段）。
 */
interface FastAgentLike {
	// biome-ignore lint/suspicious/noExplicitAny: 见上，仅为了结构性接收 Pi 的 Model<Api>
	onPayload?: (payload: unknown, model: any) => unknown | undefined | Promise<unknown | undefined>;
	// biome-ignore lint/suspicious/noExplicitAny: 同上
	onProviderStreamEvent?: (data: unknown, model: any) => void | Promise<void>;
}
type FastModelLike = { api?: string; provider?: string };

const EMPTY: FastSnapshot = { requested: false, enabled: false, status: "off", capability: "unsupported", api: null, observed: null, observedKind: "unknown", reported: null, reportedKind: "unknown" };

/**
 * 挂到已有会话上（公开字段赋值，不改 SDK）：
 * - 组合已有 `onPayload` / `onProviderStreamEvent`：先跑原有 instrumentation，再在它产出的 payload 上判断；
 * - 每次请求重新读开关，所以开关即时生效、不用重建会话；已发出去的请求不受影响；
 * - resolve 失败（例如数据库异常）按「关」处理，不阻断正常请求。
 */
export function attachFastMode(session: { agent: FastAgentLike }, resolveEnabled: () => boolean): FastTracker {
	const agent = session.agent;
	const prevPayload = agent.onPayload;
	const prevEvent = agent.onProviderStreamEvent;
	let state: FastSnapshot = { ...EMPTY };

	agent.onPayload = async (payload, model) => {
		const previous = prevPayload ? await prevPayload(payload, model) : undefined;
		const effective = previous === undefined ? payload : previous;
		let enabled = false;
		try {
			enabled = !!resolveEnabled();
		} catch {
			enabled = false;
		}
		const plan = planFastRequest(effective, model as FastModelLike, enabled);
		state = { requested: plan.requested, enabled, status: plan.status, capability: plan.capability, api: plan.api, observed: null, observedKind: "unknown", reported: null, reportedKind: "unknown", ...(plan.reason ? { reason: plan.reason } : {}) };
		// 组合契约：我们没改时，必须把**前一个 hook 的替换结果**继续返回；否则 Pi 会退回原始 payload，
		// 等于把别的 instrumentation 的修改吞掉（例如模型服务自己配的 service_tier）。
		if (plan.changed) return plan.payload;
		return previous === undefined ? undefined : previous;
	};

	agent.onProviderStreamEvent = async (data, model) => {
		if (prevEvent) await prevEvent(data, model);
		const actual = observedFastTier(data);
		if (actual) {
			state = { ...state, observed: actual.slice(0, 32), observedKind: classifyObservedTier(actual) };
			return;
		}
		const echoed = reportedFastTier(data);
		if (echoed) state = { ...state, reported: echoed.slice(0, 32), reportedKind: classifyObservedTier(echoed) };
	};

	return { snapshot: () => ({ ...state }) };
}

/**
 * 消息 meta.fast 的短对象（runtime 落库用）：只在「开关开着 / 真的请求了 / 有回显 / 冲突 / 请求里本来就有 tier」时返回，
 * 关着且什么都没发生返回 null，避免每条消息都带一个恒定的 off。
 * 开着但协议不支持 / 请求体异常也返回（用户看到灯亮，必须能知道本次其实没发）。
 */
export function fastMetaOf(snap: FastSnapshot | undefined) {
	if (!snap) return null;
	const relevant = snap.enabled || snap.requested || snap.observedKind !== "unknown" || snap.reportedKind !== "unknown" || snap.status === "conflict" || snap.status === "externally-configured";
	if (!relevant) return null;
	return {
		enabled: snap.enabled,
		requested: snap.requested,
		status: snap.status,
		capability: snap.capability,
		api: snap.api,
		observed: snap.observed,
		observedKind: snap.observedKind,
		reported: snap.reported,
		reportedKind: snap.reportedKind,
		...(snap.reason ? { reason: snap.reason } : {}),
	};
}
