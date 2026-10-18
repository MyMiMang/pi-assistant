/**
 * 消息里的 Fast 状态文案（纯函数，界面与测试共用）。
 *
 * 事实边界（来自 OpenAI 文档 + sub2api 公开源码审计）：
 * - 请求成功 ≠ 加速成功。Responses / Codex 只有**终止事件**的 tier 才可能是实际档位；
 *   非终止事件（`response.created`）与 Chat Completions 桥接 chunk 回显的往往是 requested。
 * - 回显 `default` **不等于**按标准档计费、也不等于没走 Fast（Codex OAuth 常见 default 回显但仍按 priority 计）。
 *   所以这里只写「服务回显 default（实际加速未确认）」，不写「被降级为标准档」。
 * - 费用以服务商账单为准：部分站点约 2 倍或更高，也可能配置成按标准价；不做通用倍率承诺。
 * - 关掉开关绝不补 `auto` / `default`，所以关灯不能宣称「本次标准档」——除非请求里本来就有服务配置的档位。
 */
export type FastCapability = "supported" | "requestable-unverified" | "unsupported";
export type FastObservedKind = "fast" | "standard" | "other" | "unknown";

/** 服务端写进消息 meta.fast 的短对象（不存 raw payload / body / header）。 */
export interface MessageFastMeta {
	/** 这次请求时开关是否开着（开着但协议不支持 / 请求体异常时，界面要能说明「本次没发」） */
	enabled?: boolean;
	requested: boolean;
	status: string;
	capability: FastCapability;
	api: string | null;
	/** 终止事件回显（可能是实际档位） */
	observed: string | null;
	observedKind: FastObservedKind;
	/** 非终止回显（created / chunk），来源可能是 requested，不证明加速 */
	reported?: string | null;
	reportedKind?: FastObservedKind;
	reason?: string;
}

/** 消息下方的一行短状态；不相关（关着且什么都没发生）返回 null，不占位。 */
export function fastStatusText(meta: MessageFastMeta | undefined | null): string | null {
	if (!meta) return null;
	// 普通响应也经常回显 default / auto；这不是用户开启 Fast，不该每条都画警告。
	// 旧消息可能没有 enabled，用实际请求与状态保留当时确实尝试 Fast 的事实。
	const engaged = meta.enabled === true || meta.requested || ["injected", "unsupported-api", "bad-payload", "conflict"].includes(meta.status);
	if (!engaged) {
		const off = meta.enabled === false ? "；Fast 开关未开启" : "";
		if (meta.observedKind === "fast") return `服务档位 · 回显 ${meta.observed ?? "priority"}（实际加速未确认${off}）`;
		if (meta.reportedKind === "fast") return `服务档位 · 回显 ${meta.reported ?? "priority"}（来源未确认${off}）`;
		return null;
	}
	if (meta.enabled === false && meta.status === "externally-configured" && meta.requested) return "Fast · 服务配置已带 priority（本开关未开启）";
	if (meta.observedKind === "fast") return `Fast · 服务回显 ${meta.observed ?? "Fast"}`;
	if (meta.observedKind === "standard") return "Fast · 服务回显 default（实际加速未确认）";
	if (meta.observedKind === "other") return `Fast · 服务回显 ${meta.observed}（实际加速未确认）`;
	if (meta.reportedKind === "fast") return `Fast · 服务回显 ${meta.reported ?? "priority"}（来源未确认）`;
	if (meta.reportedKind === "standard") return "Fast · 服务回显 default（实际加速未确认）";
	if (meta.reportedKind === "other") return `Fast · 服务回显 ${meta.reported}（实际加速未确认）`;
	if (meta.status === "unsupported-api") return "Fast · 本次未请求（当前接口暂未接入 Fast）";
	if (meta.status === "bad-payload") return "Fast · 本次未请求（请求体异常）";
	if (meta.status === "conflict") return "Fast · 请求里已有其他档位，本次未改写";
	if (meta.status === "externally-configured") return meta.requested ? "Fast · 请求里已带 priority" : "Fast · 请求里已带服务配置的档位";
	if (meta.requested) return "Fast · 已请求，服务未回显实际档位";
	return null;
}

/** 悬停说明：把「为什么不是已加速」讲清楚，不把 200 当成功。 */
export function fastStatusDetail(meta: MessageFastMeta): string {
	const lines: string[] = [];
	if (meta.enabled === false) lines.push("本次请求时 Fast 开关未开启；本开关没有附加 priority，服务配置或响应回显不代表你开启了它。");
	if (meta.observedKind === "fast") lines.push("服务在终止事件里回显了 priority / fast；这不保证实际耗时一定更快。");
	else if (meta.observedKind === "standard") lines.push("服务在终止事件里回显 default：这不等于按标准档计费，也不等于没走 Fast（部分账号/中转常见），实际加速未确认。");
	else if (meta.observedKind === "other") lines.push(`服务在终止事件里回显 ${meta.observed ?? "未知档位"}，不是 priority / fast。`);
	else if (meta.reportedKind && meta.reportedKind !== "unknown") lines.push("这是请求流里的非终止回显（可能是 requested），不能证明实际用了快档。");
	else if (meta.status === "unsupported-api") lines.push("当前模型的接口协议没有这个参数，本次没有附加任何 tier；换成 OpenAI 兼容协议后再试。");
	else if (meta.status === "bad-payload") lines.push("这次请求体不是普通对象，安全起见没有附加参数。");
	else if (meta.requested) lines.push("我们已请求 priority，但服务没有回显实际档位：不能据此说已经加速。");
	if (meta.reason) lines.push(meta.reason);
	if (meta.capability === "requestable-unverified") lines.push("这个服务是否支持 Fast、是否额外收费未知。");
	lines.push("费用可能增加（部分站点约 2 倍或更高，也可能配置成标准价），以服务商账单为准。");
	return lines.join("\n");
}
