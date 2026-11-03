/**
 * cua 的 structuredContent 给模型看（纯逻辑）。
 * 背景：cua 把 target_id / tab_id / refs / elements / next_call / hint 等关键信息放在 MCP 结果的 structuredContent 里，
 * content 文本只有一行摘要；Pi 的 AgentToolResult.structuredContent 又不发给模型，模型拿不到 tab_id 就会反复被拒。
 * Pi 的 MCP 适配把整个 CallToolResult（去掉 _meta）放进 tool_result 事件的 structuredContent：
 * 即 { content, structuredContent, isError }，cua 的结构化结果在里面一层。这里解开那一层，压成紧凑 JSON，
 * 由 tool_result 钩子追加成一个 text 块。只用公开的钩子返回值，不改 Pi。
 */

/** 单次追加的字符上限 */
export const STRUCTURED_MAX_CHARS = 12_000;
const HEAD = "结构化结果：";
/** 截断时优先保留的字段（顺序即优先级） */
const PRIORITY = [
	"target_id", "tab_id", "binding_quality", "mutation_allowed", "status", "ok", "error", "code", "effect",
	"detail", "hint", "next_call", "tabs", "snapshot_id", "session", "refs", "continuation", "scope_ref", "elements",
];

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);

/** 取出 cua 自己的结构化结果：兼容 Pi 的包装（{content, structuredContent, isError}）和直接就是结构化对象 */
export function unwrapStructured(raw: Json): Record<string, Json> | null {
	if (!isObj(raw)) return null;
	if ("structuredContent" in raw) return isObj(raw.structuredContent) ? raw.structuredContent : null;
	// 只有 content / isError 的包装：没有结构化结果
	const keys = Object.keys(raw);
	if (keys.length > 0 && keys.every((k) => k === "content" || k === "isError")) return null;
	return raw;
}

/** 递归收缩：长字符串截断，长数组只留前 maxArr 项并写明总数 */
function shrink(v: Json, maxArr: number, maxStr: number, depth = 0): Json {
	if (typeof v === "string") return v.length > maxStr ? `${v.slice(0, maxStr)}…(共${v.length}字)` : v;
	if (Array.isArray(v)) {
		const head = v.slice(0, maxArr).map((x) => shrink(x, maxArr, maxStr, depth + 1));
		return v.length > maxArr ? [...head, `…另有 ${v.length - maxArr} 项未显示（共 ${v.length} 项）`] : head;
	}
	if (isObj(v)) {
		if (depth > 6) return "…";
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, maxArr, maxStr, depth + 1)]));
	}
	return v;
}

/** 返回要追加给模型的文本；没有结构化结果或内容里已经完整包含时返回 null */
export function structuredNote(raw: Json, existingText = "", max = STRUCTURED_MAX_CHARS): string | null {
	const unwrapped = unwrapStructured(raw);
	if (!unwrapped || Object.keys(unwrapped).length === 0) return null;
	// 上面文本里已经有的长字符串（比如 tree_markdown 树）不再发第二遍，只留一个说明
	const flat = existingText.replace(/\s+/g, "");
	const sc = Object.fromEntries(Object.entries(unwrapped).map(([k, v]) => [k, typeof v === "string" && v.length > 200 && flat.includes(v.replace(/\s+/g, "")) ? "（同上面的文本）" : v]));
	const full = JSON.stringify(sc);
	// 文本里已经有一模一样的 JSON（cua 没给 content 时 Pi 会把结构化结果转成文本）
	if (flat.includes(full) || Object.values(sc).every((v) => v === "（同上面的文本）")) return null;
	if (full.length + HEAD.length <= max) return `${HEAD}${full}`;
	const keys = Object.keys(sc);
	const ordered = [...PRIORITY.filter((k) => k in sc), ...keys.filter((k) => !PRIORITY.includes(k))];
	for (const [maxArr, maxStr] of [[60, 600], [30, 400], [15, 300], [8, 200], [4, 120]] as const) {
		const out: Record<string, Json> = {};
		const dropped: string[] = [];
		for (const k of ordered) {
			const priority = PRIORITY.includes(k);
			const piece = shrink(sc[k], priority ? maxArr : Math.min(maxArr, 5), priority ? maxStr : Math.min(maxStr, 150));
			const next = JSON.stringify({ ...out, [k]: piece });
			// 优先字段尽量保留；其他字段放不下就丢，只记名字
			if (next.length + 200 <= max) out[k] = piece;
			else dropped.push(k);
		}
		const body = JSON.stringify(out);
		if (body.length + 200 <= max || maxArr === 4) {
			const note = `（结果太长已截断${dropped.length ? `，未显示字段：${dropped.join("、")}` : ""}；大数组只显示前几项并写明总数。要看更多：get_window_state 用 query / max_elements，get_browser_state 用 query / scope_ref / continuation 续读）`;
			return `${HEAD}${body}${note}`;
		}
	}
	return null;
}
