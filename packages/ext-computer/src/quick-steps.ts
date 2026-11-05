/**
 * 快速执行者（computer_quick_steps）的纯逻辑：候选解析、过滤排序、问题构造、判断、拼 cua 调用、核对。
 *
 * 分工：大模型一次写好几步（`{do, what, value}`），执行循环每步读一次页面结构、列候选、问决策模型挑一个、
 * 用 cua 执行、再读一次核对。**要填的值只来自大模型写的 `value`，决策模型只挑元素编号**。
 * 本文件不做任何 I/O（不调模型、不调工具），便于单测；执行循环见 quick-steps-tool.ts。
 * 设计见 docs/design/fast-executor.md 和 docs/design/fast-executor-impl.md。
 */

export type StepKind = "click" | "type" | "select" | "check" | "press" | "upload";
/** 大模型写的一步：`what` 是屏幕上看得到的名字，`value` 是要填的内容（只有大模型能写） */
export interface QuickStep {
	do: StepKind;
	what: string;
	value?: string;
	files?: string[];
	key?: string;
}
/** 操作目标：网页（cua 的 CDP 浏览器）或者一个窗口 */
export type QuickTarget = { kind: "browser"; tab_id: string; target_id?: string; session?: string } | { kind: "window"; pid: number; window_id: number };
/** 候选元素：`id` 是给决策模型看的编号（c1、c2…），`handle` 是网页 ref 或窗口 element_token */
export interface Candidate {
	id: string;
	handle: string;
	role: string;
	name: string;
	value?: string;
	actions?: string[];
}
export interface Observation {
	candidates: Candidate[];
	title?: string;
	url?: string;
	/** 页面内容摘要（网页取 outline，窗口取 elements）；可以是空串，不进 fingerprint */
	summary: string;
	fingerprint: string;
	screenshot?: { data: string; mimeType: string };
}
export type Decision = { kind: "pick"; candidate: Candidate; probability: number } | { kind: "reobserve" } | { kind: "stop"; reason: string };
/** 一步的结果（给 summarize 用） */
export interface StepResult {
	index: number;
	step: QuickStep;
	picked: Candidate | null;
	probability: number;
	/** 名字完全对上、没问决策模型 */
	exact: boolean;
	note: string;
	ms: number;
}
/** 停下时的位置、原因和当时看到的页面（给大模型接着用普通工具做） */
export interface StopInfo {
	index: number;
	reason: string;
	obs: Observation;
}

export const MAX_STEPS = 20;
export const MAX_CANDIDATES = 24;
export const MIN_PROBABILITY = 0.6;

export const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asStr = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const asList = (v: unknown): string[] | undefined => {
	if (Array.isArray(v)) return v.map(asStr).filter(Boolean);
	return typeof v === "string" && v ? [v] : undefined;
};
/** 网页 ref 的样子：`p<快照>:<序号>` */
const REF = /^p[^:\s]+:\d+$/;

/** 拼一个候选；空值不写进去（`undefined` 不进 JSON） */
function candidate(handle: string, role: string, name: string, value: string, actions: string[] | undefined): Candidate {
	return { id: "", handle, role, name, ...(value ? { value } : {}), ...(actions?.length ? { actions } : {}) };
}

/** 同一个 handle 只留第一个，按出现顺序编号 c1…cN */
function numbered(list: Candidate[]): Candidate[] {
	const seen = new Set<string>();
	const out: Candidate[] = [];
	for (const c of list) {
		if (seen.has(c.handle)) continue;
		seen.add(c.handle);
		out.push({ ...c, id: `c${out.length + 1}` });
	}
	return out;
}

/** 窗口：`get_window_state` 的 structuredContent.elements（没有 element_token 的跳过） */
function windowCandidates(s: Record<string, unknown> | null): Candidate[] {
	const els = Array.isArray(s?.elements) ? s.elements : [];
	const out: Candidate[] = [];
	for (const raw of els) {
		const e = asObj(raw);
		if (!e) continue;
		const handle = asStr(e.element_token);
		if (!handle) continue;
		out.push(candidate(handle, asStr(e.role), asStr(e.label) || asStr(e.title), asStr(e.value), asList(e.actions)));
	}
	return out;
}

/** 网页：cua 的字段名还没在真机确认，按几种可能的名字逐个试，取第一个有结果的 */
function browserCandidates(s: Record<string, unknown> | null, text: string): Candidate[] {
	for (const key of ["refs", "actions", "elements", "action_refs"]) {
		const arr = s?.[key];
		if (!Array.isArray(arr)) continue;
		const out: Candidate[] = [];
		for (const raw of arr) {
			const e = asObj(raw);
			if (!e) continue;
			const handle = asStr(e.ref) || asStr(e.id);
			if (!REF.test(handle)) continue;
			const role = asStr(e.role) || asStr(e.type) || asStr(e.kind);
			const name = asStr(e.name) || asStr(e.label) || asStr(e.text) || asStr(e.accessible_name);
			out.push(candidate(handle, role, name, asStr(e.value), asList(e.actions)));
		}
		if (out.length) return out;
	}
	return textCandidates(text);
}

/** 只有文本时：每行找 ref，剩下的文字里第一个词当 role，引号里的当 name，没有引号就整行（截 80 字） */
function textCandidates(text: string): Candidate[] {
	const out: Candidate[] = [];
	for (const line of (text ?? "").split("\n")) {
		const m = /\b(p[\w-]+:\d+)\b/.exec(line);
		if (!m) continue;
		const handle = m[1]!;
		// 去掉 ref，再去掉行首的列表标记（[3] / - / 1.）
		const rest = `${line.slice(0, m.index)} ${line.slice(m.index + handle.length)}`.trim().replace(/^(?:\[[^\]]*\]|[-*•]|\d+[.)])\s*/, "");
		if (!rest) continue;
		const quoted = /["“「]([^"”」]{1,80})["”」]/.exec(rest);
		const role = (rest.split(/\s+/)[0] ?? "").replace(/[:：]$/, "");
		out.push(candidate(handle, role, quoted ? quoted[1]! : rest.slice(0, 80), "", undefined));
	}
	return out;
}

/** 32 位 FNV-1a（不引依赖）；**不放 handle**：每次快照 ref 都会变 */
export function fingerprintOf(url: string, title: string, list: Candidate[], extra: string): string {
	const s = `${url}|${title}|${list.map((c) => c.role + c.name + (c.value ?? "")).join("\u0001")}|${extra}`;
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/** 去掉方向控制字符（计算器之类的显示文本里常见 U+200E / U+200F） */
const clean = (s: string) => s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();

/**
 * 从 `get_window_state` 的文字树里取出**没有 `[N]` 编号**的行（只用来显示、不能操作的文字元素）。
 * 例：`    - AXStaticText = "‎1,234‎×‎5,678"` → `AXStaticText=1,234×5,678`；
 * `    - AXHeading (标题)` → `AXHeading「标题」`。名字和值都为空的行丢掉，最多 60 行。
 */
export function windowTextRows(text: string): string[] {
	const out: string[] = [];
	for (const raw of (text ?? "").split("\n")) {
		const line = raw.trim();
		if (!line.startsWith("- ")) continue;
		const body = line.slice(2).trim();
		if (!body || body.startsWith("[")) continue;
		const role = body.split(/\s+/)[0] ?? "";
		const name = clean(/\(([^)]*)\)/.exec(body)?.[1] ?? "");
		const value = clean(/=\s*"([^"]*)"/.exec(body)?.[1] ?? "");
		if (!name && !value) continue;
		out.push(`${role}${name ? `「${name}」` : ""}${value ? `=${value}` : ""}`);
		if (out.length >= 60) break;
	}
	return out;
}

/** 页面内容摘要：网页用 outline（没有再退回 content_refs），窗口用文字树里不可操作的行 + elements；截到 2500 字 */
function summaryOf(target: QuickTarget, s: Record<string, unknown> | null, text: string): string {
	const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(asObj).filter((x): x is Record<string, unknown> => !!x) : []);
	const text2 =
		target.kind === "window"
			? [...windowTextRows(text), ...rows(s?.elements).map((e) => {
					const label = asStr(e.label) || asStr(e.title);
					const value = asStr(e.value);
					return label || value ? `${asStr(e.role)}「${label}」${value ? `=${value}` : ""}` : "";
				})]
					.filter(Boolean)
					.join("\n")
			: typeof s?.outline === "string" && s.outline.trim()
				? s.outline
				: rows(s?.content_refs)
						.map((e) => `${asStr(e.role)}「${asStr(e.name) || asStr(e.label) || asStr(e.text)}」`)
						.join("\n");
	return text2.length > 2500 ? `${text2.slice(0, 2500)}…（共 ${text2.length} 字）` : text2;
}

/** 读工具的结果 → 候选（宽松解析，字段名对不上就退回文本；有单测） */
export function parseObservation(target: QuickTarget, structured: unknown, text: string, content: { type: string; data?: string; mimeType?: string }[]): Observation {
	const s = asObj(structured);
	const page = asObj(s?.page);
	const list = numbered(target.kind === "window" ? windowCandidates(s) : browserCandidates(s, text));
	const title = asStr(s?.title) || asStr(page?.title);
	const url = asStr(s?.url) || asStr(page?.url);
	const shot = (content ?? []).find((c) => c.type === "image" && c.data && c.mimeType);
	const summary = summaryOf(target, s, text);
	return {
		candidates: list,
		...(title ? { title } : {}),
		...(url ? { url } : {}),
		summary,
		fingerprint: fingerprintOf(url, title, list, summary),
		...(shot ? { screenshot: { data: shot.data!, mimeType: shot.mimeType! } } : {}),
	};
}

/** 读不到页面时用的空观察（停下时要给大模型一个当前状态） */
export const emptyObservation = (): Observation => ({ candidates: [], summary: "", fingerprint: fingerprintOf("", "", [], "") });

/** 按动作种类过滤候选；过滤后为空就返回原列表，让决策模型自己判断（它可以选「拿不准」） */
export function filterByKind(kind: StepKind, list: Candidate[]): Candidate[] {
	if (kind === "press") return [];
	const out = list.filter((c) => {
		const role = roleKey(c.role);
		if (kind === "upload") return role.includes("file") || (c.actions ?? []).some((a) => a.toLowerCase().includes("upload"));
		if (KIND_ROLES[kind].includes(role)) return true;
		if (kind === "click") return (c.actions ?? []).some((a) => /^(click|press)$/i.test(a));
		return false;
	});
	return out.length ? out : list;
}

/** macOS 的 role 可能是 `AXButton`：先小写、去掉 ax 前缀再比 */
export const roleKey = (role: string) => {
	const r = role.trim().toLowerCase();
	return r.startsWith("ax") && r.length > 2 ? r.slice(2) : r;
};

export const KIND_ROLES: Record<Exclude<StepKind, "press" | "upload">, string[]> = {
	type: ["textbox", "searchbox", "textarea", "textfield", "text field", "combobox", "spinbutton", "input"],
	select: ["combobox", "listbox", "popupbutton", "popup button", "select", "menuitem"],
	check: ["checkbox", "radio", "radiobutton", "switch", "toggle"],
	click: ["button", "link", "menuitem", "tab", "option", "checkbox", "radio", "switch", "cell", "row", "listitem", "image"],
};

/** 分词：英文 / 数字按小写单词，中文按逐字 bigram */
function tokens(s: string): string[] {
	const out: string[] = [...(s.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
	for (const h of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
		if (h.length === 1) out.push(h);
		else for (let i = 0; i < h.length - 1; i++) out.push(h.slice(i, i + 2));
	}
	return out;
}

/** 相似度 = 二元组（multiset）的 Dice 系数 */
export function similarity(a: string, b: string): number {
	const x = tokens(a);
	const y = tokens(b);
	if (!x.length || !y.length) return 0;
	const left = new Map<string, number>();
	for (const t of x) left.set(t, (left.get(t) ?? 0) + 1);
	let hit = 0;
	for (const t of y) {
		const n = left.get(t) ?? 0;
		if (n > 0) {
			hit++;
			left.set(t, n - 1);
		}
	}
	return (2 * hit) / (x.length + y.length);
}

/** 按和 `what` 的相近程度排序，取前 limit 个；稳定排序，**id 不变** */
export function rankCandidates(what: string, list: Candidate[], limit = MAX_CANDIDATES): Candidate[] {
	return list
		.map((c, i) => ({ c, i, score: similarity(what, `${c.name} ${c.value ?? ""}`) }))
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.slice(0, limit)
		.map((x) => x.c);
}

/** 去空白、去标点、小写 */
export const normalize = (s: string) => s.toLowerCase().replace(/[\s\p{P}]+/gu, "");

/** 名字完全对上的**恰好只有一个** → 直接用，省一次决策模型请求 */
export function exactMatch(what: string, list: Candidate[]): Candidate | null {
	const want = normalize(what);
	if (!want) return null;
	const hits = list.filter((c) => normalize(c.name) === want);
	return hits.length === 1 ? hits[0]! : null;
}

/** 一步的大白话（也用在返回给大模型的说明里）；**不把要填的值写进 type 的说明** */
export function describeStep(step: QuickStep): string {
	switch (step.do) {
		case "click":
			return `点击「${step.what}」`;
		case "type":
			return `在「${step.what}」里填写`;
		case "select":
			return `在「${step.what}」里选择「${step.value ?? ""}」`;
		case "check":
			return `勾选「${step.what}」`;
		case "upload":
			return `上传文件到「${step.what}」`;
		case "press":
			return `按「${step.key ?? step.value ?? ""}」`;
	}
}

export const describeCandidate = (c: Candidate): string => `${c.role}「${c.name}」${c.value ? `（当前值：${c.value.slice(0, 40)}）` : ""}`;

const PICK_INSTRUCTIONS =
	"这是电脑操作里的一步。从候选元素里挑出这一步要操作的那一个。只根据元素的角色、名字、当前值（和截图，如果有）判断。没有合适的、或者有两个以上都可能，就选 abstain；页面看起来还没加载完、要操作的元素可能马上出现，就选 reobserve。";

/** 拼分类请求：状态 + 候选 + 「重新读一次」「拿不准」两个出口 */
export function buildClassifierContext(step: QuickStep, index: number, total: number, done: string[], obs: Observation, list: Candidate[], withImage: boolean) {
	const criteria: Record<string, string> = Object.fromEntries(list.map((c) => [c.id, describeCandidate(c)]));
	criteria.reobserve = "页面还没准备好，等一下再看一次";
	criteria.abstain = "拿不准，或者候选里没有要找的元素";
	return {
		state: {
			任务: `第 ${index + 1}/${total} 步：${describeStep(step)}`,
			已完成: done.slice(-5),
			页面: { 标题: obs.title ?? "", 地址: obs.url ?? "" },
			候选: Object.fromEntries(list.map((c) => [c.id, describeCandidate(c)])),
		},
		...(withImage && obs.screenshot ? { images: [{ type: "image" as const, data: obs.screenshot.data, mimeType: obs.screenshot.mimeType }] } : {}),
		questions: { pick: { type: "choice" as const, instructions: PICK_INSTRUCTIONS, criteria } },
	};
}

/** 决策模型的回答 → 决定：概率不够、拿不准、页面一直没准备好都停下交回大模型 */
export function decide(answer: unknown, list: Candidate[], reobserved: boolean): Decision {
	const a = asObj(answer);
	if (!a || a.type !== "choice" || typeof a.choice !== "string") return { kind: "stop", reason: "决策模型没有给出选择" };
	const choice = a.choice;
	if (choice === "abstain") return { kind: "stop", reason: "决策模型拿不准" };
	if (choice === "reobserve") return reobserved ? { kind: "stop", reason: "页面一直没准备好" } : { kind: "reobserve" };
	const probs = asObj(a.probabilities) ?? {};
	const raw = probs[choice] ?? a.confidence ?? 0;
	const p = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
	const picked = list.find((c) => c.id === choice);
	if (!picked) return { kind: "stop", reason: `决策模型选了一个不存在的候选（${choice}）` };
	if (p < MIN_PROBABILITY) {
		const top = list
			.map((c) => ({ c, p: typeof probs[c.id] === "number" ? (probs[c.id] as number) : 0 }))
			.sort((x, y) => y.p - x.p)
			.slice(0, 3)
			.filter((x) => x.p > 0)
			.map((x) => describeCandidate(x.c));
		return { kind: "stop", reason: `决策模型把握不够（最高 ${p.toFixed(2)}）${top.length ? `：${top.join("、")}` : ""}` };
	}
	return { kind: "pick", candidate: picked, probability: p };
}

/**
 * 拼具体的 cua 调用。参数不全（要填的值 / 文件 / 按键）直接报错，不猜；
 * 网页里按键、窗口里上传文件这一版不支持，交回大模型用普通工具做。
 */
export function buildCall(step: QuickStep, c: Candidate | null, target: QuickTarget, prefix: string): { tool: string; args: Record<string, unknown> } | { error: string } {
	if ((step.do === "type" || step.do === "select") && !step.value) return { error: `${describeStep(step)}这一步没有 value（要填的内容只能由你写）` };
	if (step.do === "upload" && !(step.files ?? []).length) return { error: `${describeStep(step)}这一步没有 files` };
	if (step.do === "press" && !(step.key ?? step.value)) return { error: `${describeStep(step)}这一步没有 key` };
	if (target.kind === "browser") {
		if (step.do === "press") return { error: "网页里按键这一步请用普通工具做" };
		if (!c) return { error: `${describeStep(step)}：没有可操作的元素` };
		const base: Record<string, unknown> = { tab_id: target.tab_id };
		if (target.target_id) base.target_id = target.target_id;
		if (target.session) base.session = target.session;
		if (step.do === "click" || step.do === "check") return { tool: `${prefix}browser_click`, args: { ...base, ref: c.handle } };
		if (step.do === "type") return { tool: `${prefix}browser_type`, args: { ...base, ref: c.handle, text: step.value ?? "", replace: true } };
		if (step.do === "select") return { tool: `${prefix}browser_select`, args: { ...base, ref: c.handle, label: step.value ?? "" } };
		return { tool: `${prefix}browser_set_input_files`, args: { ...base, ref: c.handle, files: step.files ?? [] } };
	}
	const base = { pid: target.pid, window_id: target.window_id };
	if (step.do === "press") return { tool: `${prefix}press_key`, args: { ...base, key: step.key ?? step.value ?? "" } };
	if (step.do === "upload") return { error: "窗口里上传文件请用普通工具做" };
	if (!c) return { error: `${describeStep(step)}：没有可操作的元素` };
	if (step.do === "click" || step.do === "check") return { tool: `${prefix}click`, args: { ...base, element_token: c.handle } };
	return { tool: `${prefix}set_value`, args: { ...base, element_token: c.handle, value: step.value ?? "" } };
}

/**
 * 核对一步有没有真的生效：填写 / 选择要看到值变了（ref 变了就按角色 + 名字找），
 * 点击 / 勾选 / 上传要看到页面有变化（按键不核对）。找不到原来的输入框不算失败（页面可能已经跳走了）。
 */
export function verifyStep(step: QuickStep, picked: Candidate | null, before: Observation, after: Observation): { ok: true; note: string } | { ok: false; reason: string } {
	if (step.do === "type" || step.do === "select") {
		const want = picked ?? before.candidates.find((c) => normalize(c.name) === normalize(step.what));
		if (!want) return { ok: true, note: "页面变了，没找到原来的输入框，交给后面的步骤" };
		const now = after.candidates.find((c) => roleKey(c.role) === roleKey(want.role) && c.name === want.name);
		if (!now) return { ok: true, note: "页面变了，没找到原来的输入框，交给后面的步骤" };
		if (normalize(now.value ?? "").includes(normalize(step.value ?? ""))) return { ok: true, note: `值已是「${now.value ?? ""}」` };
		return { ok: false, reason: `填了但值没变（现在是「${now.value ?? ""}」）` };
	}
	// 按 Tab / 方向键这类键页面不一定有看得出的变化，不核对（按回车提交之类的结果由后面的步骤或大模型核对）
	if (step.do === "press") return { ok: true, note: "已按键（不核对页面变化）" };
	if (after.fingerprint !== before.fingerprint) return { ok: true, note: "页面有变化" };
	return { ok: false, reason: "点了但页面没有变化" };
}

/** 结果末尾那段「最后的页面内容」（快速执行和目标模式共用；没有内容返回空串） */
export const lastPageText = (summary?: string) => (summary ? `最后的页面内容（不用再读一遍）：\n${summary}` : "");

/** 把两段 summary 按行拆开，返回在 after 里、不在 before 里的行（去重，最多 max 字） */
export function changedText(before: string, after: string, max = 600): string {
	const old = new Set((before ?? "").split("\n").map((s) => s.trim()).filter(Boolean));
	const seen = new Set<string>();
	const parts: string[] = [];
	let total = 0;
	for (const raw of (after ?? "").split("\n")) {
		const line = raw.trim();
		if (!line || old.has(line) || seen.has(line)) continue;
		seen.add(line);
		const sep = parts.length ? 1 : 0;
		const room = max - total - sep;
		if (room <= 0) break;
		const piece = line.length > room ? line.slice(0, room) : line;
		parts.push(piece);
		total += piece.length + sep;
		if (piece.length < line.length) break;
	}
	return parts.join("\n");
}

/** 「页面上新出现 / 变了的内容」那一行（快速执行和目标模式共用；没有变化返回空串） */
export function changedNote(before: string | undefined, after: string): string {
	const changed = before === undefined ? "" : changedText(before, after);
	return changed ? `页面上新出现 / 变了的内容：\n${changed}` : "";
}

/** 返回给大模型的说明：每步一行；停下 / 做完都附上「新出现 / 变了的内容」和最后的页面内容 */
export function summarize(results: StepResult[], stopped?: StopInfo, lastObs?: Observation, firstObs?: Observation): string {
	const lines = results.map((r) => {
		const p = r.exact ? `${r.probability.toFixed(2)}（名字完全对上，没问决策模型）` : r.probability.toFixed(2);
		const what = r.picked ? `选了 ${describeCandidate(r.picked)}（${r.picked.handle}），概率 ${p}` : "直接执行";
		return `${r.index + 1}. ${describeStep(r.step)} → ${what}，${r.note}，${r.ms} 毫秒`;
	});
	const changedLine = (after: string) => changedNote(firstObs?.summary, after);
	if (stopped) {
		const els = stopped.obs.candidates.slice(0, 30).map((c) => `${c.handle} ${c.role}「${c.name}」`);
		lines.push(`第 ${stopped.index + 1} 步停下：${stopped.reason}。后面的步骤没做。当前页面可操作的元素（前 30 个）：${els.length ? `\n${els.join("\n")}` : "（没读到元素）"}`);
		const summary = stopped.obs.summary || lastObs?.summary || "";
		const changed = changedLine(summary);
		if (changed) lines.push(changed);
		const tail = lastPageText(summary);
		if (tail) lines.push(tail);
		return lines.join("\n");
	}
	const total = results.reduce((n, r) => n + r.ms, 0);
	lines.push(`全部 ${results.length} 步做完，共 ${total} 毫秒。`);
	const summary = lastObs?.summary || "";
	const changed = changedLine(summary);
	if (changed) lines.push(changed);
	const tail = lastPageText(summary);
	if (tail) lines.push(tail);
	return lines.join("\n");
}
