/**
 * 桌宠（DESIGN §19）：托盘程序在桌面上放一个透明置顶小窗（/pet 页面），宠物跟着助理状态动。
 * - 状态：从数据库和事件总线算出来（谁在忙、在调什么工具、有没有等你批准、刚做完 / 出错）
 * - 宠物包：Codex 宠物格式（pet.json + 8x9 精灵图，每格 192x208；v2 是 8x11）。内置宠物在网页静态目录 /pets/<id>/；
 *   用户导入 / 孵化的宠物存在 数据目录/pets/<id>/
 * - 设置：settings 表的 pet（开关、跟随哪个助理、默认宠物、大小）与 petOf:<agentId>（每个助理一只）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { db, getSetting, setSetting } from "../db.ts";

export const CELL_W = 192;
export const CELL_H = 208;
export const COLS = 8;
/** v1 = 9 行；v2 多两行“看向不同方向” = 11 行 */
export const ROWS_V1 = 9;
export const ROWS_V2 = 11;

export const PRESETS = [
	{ id: "miao", name: "喵喵", description: "一只橘色的 Q 版小猫。" },
	{ id: "tuanzi", name: "团子", description: "软乎乎的粉白团子。" },
	{ id: "xiaotie", name: "小铁", description: "屏幕脸的小机器人。" },
	{ id: "jiujiu", name: "啾啾", description: "圆滚滚的小黄鸡。" },
] as const;
export const DEFAULT_PET = "miao";

export interface PetSettings {
	enabled: boolean;
	/** auto = 跟着最需要你关注的助理（等批准 > 正在忙 > 最近聊过）；否则是助理 id */
	follow: string;
	defaultPet: string;
	/** 显示大小（0.6 ~ 1.4） */
	scale: number;
	/** 安静模式：不冒完成 / 出错气泡（等批准仍会提示） */
	quiet: boolean;
}
const DEFAULTS: PetSettings = { enabled: false, follow: "auto", defaultPet: DEFAULT_PET, scale: 0.8, quiet: false };
export const petSettings = (): PetSettings => ({ ...DEFAULTS, ...getSetting<Partial<PetSettings>>("pet", {}) });
export function savePetSettings(p: Partial<PetSettings>) {
	const cur = petSettings();
	const next: PetSettings = {
		enabled: typeof p.enabled === "boolean" ? p.enabled : cur.enabled,
		follow: typeof p.follow === "string" && p.follow ? p.follow : cur.follow,
		defaultPet: typeof p.defaultPet === "string" && petExists(p.defaultPet) ? p.defaultPet : cur.defaultPet,
		scale: typeof p.scale === "number" && Number.isFinite(p.scale) ? Math.min(1.4, Math.max(0.6, p.scale)) : cur.scale,
		quiet: typeof p.quiet === "boolean" ? p.quiet : cur.quiet,
	};
	setSetting("pet", next);
	bus.emit({ type: "pet.changed" });
	return next;
}
export const petOf = (agentId: string) => {
	const id = getSetting<string | null>(`petOf:${agentId}`, null);
	return id && petExists(id) ? id : petSettings().defaultPet;
};
export function setPetOf(agentId: string, petId: string | null) {
	if (petId && !petExists(petId)) throw new Error("宠物不存在");
	setSetting(`petOf:${agentId}`, petId);
	bus.emit({ type: "pet.changed" });
}

// ---------------------------------------------------------------- 宠物包
export interface PetInfo {
	id: string;
	name: string;
	description: string;
	builtin: boolean;
	/** 精灵图地址（网页可直接加载） */
	url: string;
	/** 9 = v1，11 = v2 */
	rows: number;
	createdAt?: number;
	/** 孵化时的描述 */
	prompt?: string;
}
export const petsDir = () => join(config.dataDir, "pets");
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const isPreset = (id: string) => PRESETS.some((p) => p.id === id);
export const petExists = (id: string) => isPreset(id) || (SAFE_ID.test(id) && existsSync(join(petsDir(), id, "pet.json")));

interface StoredManifest {
	id: string;
	displayName: string;
	description?: string;
	spritesheetPath: string;
	spriteVersionNumber?: number;
	/** 我们自己加的字段（Codex 会忽略） */
	createdAt?: number;
	prompt?: string;
}
function readUserPet(id: string): PetInfo | null {
	try {
		const m = JSON.parse(readFileSync(join(petsDir(), id, "pet.json"), "utf8")) as StoredManifest;
		const file = join(petsDir(), id, m.spritesheetPath);
		if (!existsSync(file)) return null;
		const dims = imageSize(readFileSync(file));
		return { id, name: m.displayName || id, description: m.description ?? "", builtin: false, url: `/api/pets/${id}/sheet?v=${m.createdAt ?? 0}`, rows: dims && dims.h === CELL_H * ROWS_V2 ? ROWS_V2 : ROWS_V1, createdAt: m.createdAt, prompt: m.prompt };
	} catch {
		return null;
	}
}
export function listPets(): PetInfo[] {
	const builtin = PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description, builtin: true, url: `/pets/${p.id}/spritesheet.png`, rows: ROWS_V1 }));
	const dir = petsDir();
	const mine = existsSync(dir)
		? readdirSync(dir)
				.filter((d) => SAFE_ID.test(d) && !isPreset(d))
				.map(readUserPet)
				.filter((p): p is PetInfo => !!p)
				.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
		: [];
	return [...builtin, ...mine];
}
export const getPet = (id: string) => listPets().find((p) => p.id === id);
export function petSheetPath(id: string): { path: string; mime: string } | null {
	if (!SAFE_ID.test(id) || isPreset(id)) return null;
	try {
		const m = JSON.parse(readFileSync(join(petsDir(), id, "pet.json"), "utf8")) as StoredManifest;
		const path = join(petsDir(), id, m.spritesheetPath);
		if (!existsSync(path)) return null;
		return { path, mime: m.spritesheetPath.endsWith(".webp") ? "image/webp" : "image/png" };
	} catch {
		return null;
	}
}

/** 读 PNG / WebP 的宽高（不解码像素） */
export function imageSize(b: Buffer): { w: number; h: number; type: "png" | "webp" } | null {
	if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: "png" };
	if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
		const chunk = b.toString("ascii", 12, 16);
		if (chunk === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, type: "webp" };
		if (chunk === "VP8L") {
			const bits = b.readUInt32LE(21);
			return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, type: "webp" };
		}
		if (chunk === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), type: "webp" };
	}
	return null;
}
/** 检查是不是合格的 Codex 宠物精灵图；不合格返回原因 */
export function checkSheet(b: Buffer): { ok: true; rows: number; type: "png" | "webp" } | { ok: false; error: string } {
	if (b.length > 20 * 1024 * 1024) return { ok: false, error: "图片超过 20MB" };
	const s = imageSize(b);
	if (!s) return { ok: false, error: "精灵图要是 PNG 或 WebP" };
	if (s.w !== CELL_W * COLS || (s.h !== CELL_H * ROWS_V1 && s.h !== CELL_H * ROWS_V2)) return { ok: false, error: `精灵图尺寸要是 1536×1872（v1）或 1536×2288（v2），这张是 ${s.w}×${s.h}` };
	return { ok: true, rows: s.h / CELL_H, type: s.type };
}

const slugOf = (name: string) => {
	const ascii = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return ascii || "pet";
};
/** 保存一个宠物包（导入 / 孵化都走这里）；同名自动加后缀，返回宠物信息 */
export function savePet(i: { name: string; description?: string; sheet: Buffer; idHint?: string; prompt?: string }): PetInfo {
	const chk = checkSheet(i.sheet);
	if (!chk.ok) throw new Error(chk.error);
	const name = i.name.trim().slice(0, 40) || "我的宠物";
	let id = slugOf(i.idHint && SAFE_ID.test(i.idHint) ? i.idHint : name);
	if (id === "pet" || !/[a-z]/.test(id)) id = `pet-${Date.now().toString(36)}`;
	let n = 2;
	const base = id;
	while (isPreset(id) || existsSync(join(petsDir(), id))) id = `${base}-${n++}`;
	const dir = join(petsDir(), id);
	mkdirSync(dir, { recursive: true });
	const file = `spritesheet.${chk.type}`;
	writeFileSync(join(dir, file), i.sheet);
	const m: StoredManifest = { id, displayName: name, description: (i.description ?? "").slice(0, 200), spritesheetPath: file, ...(chk.rows === ROWS_V2 ? { spriteVersionNumber: 2 } : {}), createdAt: Date.now(), ...(i.prompt ? { prompt: i.prompt.slice(0, 500) } : {}) };
	writeFileSync(join(dir, "pet.json"), `${JSON.stringify(m, null, 2)}\n`);
	bus.emit({ type: "pet.changed" });
	return readUserPet(id)!;
}
/** 解析导入的 pet.json（宽松：字段缺了用文件名兜底） */
export function parseManifest(text: string | undefined): { name?: string; description?: string; id?: string } {
	if (!text) return {};
	try {
		const j = JSON.parse(text) as Partial<StoredManifest>;
		return { name: typeof j.displayName === "string" ? j.displayName : undefined, description: typeof j.description === "string" ? j.description : undefined, id: typeof j.id === "string" ? j.id.toLowerCase() : undefined };
	} catch {
		throw new Error("pet.json 不是有效的 JSON");
	}
}
export function deletePet(id: string) {
	if (isPreset(id)) throw new Error("内置宠物不能删除");
	if (!SAFE_ID.test(id) || !existsSync(join(petsDir(), id))) return false;
	rmSync(join(petsDir(), id), { recursive: true, force: true });
	const s = petSettings();
	if (s.defaultPet === id) savePetSettings({ defaultPet: DEFAULT_PET });
	for (const r of db.prepare("SELECT key FROM settings WHERE key LIKE 'petOf:%' AND value = ?").all(JSON.stringify(id)) as { key: string }[]) setSetting(r.key, null);
	bus.emit({ type: "pet.changed" });
	return true;
}

// ---------------------------------------------------------------- 状态
export type PetState = "idle" | "thinking" | "working" | "computer" | "done" | "error" | "approval" | "question";
export interface PetStatus {
	enabled: boolean;
	scale: number;
	agent: { id: string; name: string; avatar: string; color: string } | null;
	pet: PetInfo;
	state: PetState;
	/** 气泡里的一句话（可能为空） */
	text: string;
	/** 等你处理的请求（批准 / 提问），最多 1 个；还有几个在排队 */
	request: { id: string; kind: "approval" | "question"; agentName: string; summary: string; risk?: string; question?: string; options?: string[]; allowFreeText?: boolean; allowTask?: boolean } | null;
	queued: number;
	/** 其他正在忙的助理数 */
	busyOthers: number;
}

/** 助理最近一次从忙变闲的时间（用来显示“做完了”几秒） */
const finishedAt = new Map<string, number>();
bus.on((e) => {
	if (e.type === "agent.status" && e.status === "idle" && typeof e.agentId === "string") finishedAt.set(e.agentId, Date.now());
});
/** 测试用 */
export const _markFinished = (agentId: string, at = Date.now()) => finishedAt.set(agentId, at);

const DONE_MS = 6_000;
const ERROR_MS = 60_000;
const COMPUTER_TOOL = /hostpc|computer|desktop|mouse|click|screenshot|type_text|press_key|scroll|window|launch_app/i;
const TOOL_LABEL: [RegExp, string][] = [
	[/hostpc|mouse|click|type_text|press_key|launch_app/i, "正在操作你的电脑"],
	[/^browser|browser_/i, "正在用浏览器"],
	[/desktop|computer|screenshot/i, "正在用助理电脑"],
	[/bash|shell|exec|run/i, "正在运行命令"],
	[/write|edit|file/i, "正在处理文件"],
	[/search|fetch|web/i, "正在查资料"],
	[/image/i, "正在画图"],
	[/memory/i, "正在回忆"],
];
const toolLabel = (name: string) => TOOL_LABEL.find(([re]) => re.test(name))?.[1] ?? "正在干活";

interface AgentLite {
	id: string;
	name: string;
	avatar: string;
	color: string;
	status: string;
}
interface ReqRow {
	id: string;
	agent_id: string;
	kind: "approval" | "question";
	payload: string;
	created_at: number;
}
function lastActive(agentId: string) {
	return (db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE agent_id = ?").get(agentId) as { t: number | null }).t ?? 0;
}

export function petStatus(): PetStatus {
	const s = petSettings();
	const agents = db.prepare("SELECT id, name, avatar, color, status FROM agents ORDER BY sort, created_at").all() as unknown as AgentLite[];
	const pending = db.prepare("SELECT id, agent_id, kind, payload, created_at FROM requests WHERE status = 'pending' ORDER BY created_at").all() as unknown as ReqRow[];
	const byId = new Map(agents.map((a) => [a.id, a]));
	const followed = s.follow !== "auto" ? byId.get(s.follow) : undefined;
	// 关注谁：指定的助理；否则 等你处理 > 正在忙（最近动过的）> 最近聊过的
	let focus: AgentLite | undefined = followed;
	if (!focus) {
		const req = pending.find((r) => byId.has(r.agent_id));
		focus = req ? byId.get(req.agent_id) : undefined;
	}
	if (!focus) {
		const busy = agents.filter((a) => a.status === "running").sort((a, b) => lastActive(b.id) - lastActive(a.id));
		focus = busy[0];
	}
	if (!focus) focus = [...agents].sort((a, b) => lastActive(b.id) - lastActive(a.id))[0];

	// 等你处理的请求：指定跟随时只看这个助理的；否则全部（最早的先处理）
	const mine = followed ? pending.filter((r) => r.agent_id === followed.id) : pending;
	const r = mine[0];
	let request: PetStatus["request"] = null;
	if (r) {
		const p = JSON.parse(r.payload) as { summary?: string; risk?: string; question?: string; options?: string[]; allowFreeText?: boolean; allowTask?: boolean };
		request = { id: r.id, kind: r.kind, agentName: byId.get(r.agent_id)?.name ?? "", summary: String(p.summary ?? ""), risk: p.risk, question: p.question, options: p.options, allowFreeText: p.allowFreeText, allowTask: p.allowTask };
	}

	let state: PetState = "idle";
	let text = "";
	if (request) {
		state = request.kind === "approval" ? "approval" : "question";
		text = request.kind === "approval" ? "需要你批准" : "有个问题想问你";
	} else if (focus) {
		const last = db.prepare("SELECT role, status, meta, created_at FROM messages WHERE agent_id = ? AND role IN ('assistant','tool') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(focus.id) as
			| { role: string; status: string; meta: string; created_at: number }
			| undefined;
		if (focus.status === "running") {
			if (last?.role === "tool" && last.status === "running") {
				const name = String((JSON.parse(last.meta || "{}") as { toolName?: string }).toolName ?? "");
				state = COMPUTER_TOOL.test(name) ? "computer" : "working";
				text = toolLabel(name);
			} else {
				state = "thinking";
				text = last?.role === "assistant" && last.status === "streaming" ? "正在回复…" : "正在想…";
			}
		} else if (last?.role === "assistant" && last.status === "error" && Date.now() - last.created_at < ERROR_MS) {
			state = "error";
			text = s.quiet ? "" : "出错了，点我看看";
		} else if (Date.now() - (finishedAt.get(focus.id) ?? 0) < DONE_MS) {
			state = "done";
			// 气泡里给一句最新回复（去掉 Markdown 符号）
			const reply = db.prepare("SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' AND status = 'done' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(focus.id) as { content: string } | undefined;
			const snip = (reply?.content ?? "").replace(/[#*_`>|~-]+/g, " ").replace(/\s+/g, " ").trim();
			text = s.quiet ? "" : snip ? (snip.length > 60 ? `${snip.slice(0, 60)}…` : snip) : "做完啦";
		}
	}
	const petId = focus ? petOf(focus.id) : s.defaultPet;
	return {
		enabled: s.enabled,
		scale: s.scale,
		agent: focus ? { id: focus.id, name: focus.name, avatar: focus.avatar, color: focus.color } : null,
		pet: getPet(petId) ?? getPet(DEFAULT_PET)!,
		state,
		text,
		request,
		queued: Math.max(0, mine.length - 1),
		busyOthers: agents.filter((a) => a.status === "running" && a.id !== focus?.id).length,
	};
}
