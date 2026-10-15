/**
 * 图片生成：服务配置（Key 走统一凭据存储）、默认模型、每个助理的选择，以及“生成 → 存进工作区 → 发到聊天”。
 *
 * 凭据统一：一个服务的 Key 存在 **统一凭据存储**（Pi 公开 `CredentialStore`，与 chat 服务同一份，按 provider id 绑定），
 * 不再写 `imageKey:<id>` settings。旧版写在 `imageKey:<id>`（sealJson）的 Key 由 `keyOf` 桥接读取（只读，不复制明文）；
 * 复用别的服务（`keyFrom`）也读同一份凭据。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { bus } from "../bus.ts";
import { getSetting, setSetting, uid } from "../db.ts";
import { deliverFromWorkspace, fileInfo, insideWorkspace, mimeOf, workspaceOf } from "../files.ts";
import { insertMessage } from "../messages.ts";
import { credentialStore } from "../models.ts";
import { openJson } from "../secrets.ts";
import { costNote, defaultCtx, generate, type Ctx, type GenResult, type ImageEndpoint, type ImageKind, ImageGenError, KINDS, kindInfo, listModels, supportsEdit } from "./providers.ts";

export interface ImageProvider {
	id: string;
	name: string;
	kind: ImageKind;
	baseUrl: string;
	models: string[];
	/** 复用某个自定义模型服务的 Key（统一凭据存储里的同一份，不再单独保存） */
	keyFrom?: string | null;
	/** 非秘密元数据：自己的 Key 已写入统一凭据存储（`keyFrom` 时不适用） */
	hasCredential?: boolean;
	/** 非秘密元数据：Key 现在存在哪（迁移 / 界面提示用，不含任何秘密） */
	keyStored?: "unified" | "legacy" | "reference";
	createdAt: number;
}
export interface ImageModelRef {
	provider: string;
	model: string;
}
export type AgentImageChoice = { mode: "default" } | { mode: "off" } | { mode: "model"; provider: string; model: string };

export const listProviders = () => getSetting<ImageProvider[]>("imageProviders", []);
export const getProvider = (id: string) => listProviders().find((p) => p.id === id);
const saveList = (l: ImageProvider[]) => (setSetting("imageProviders", l), bus.emit({ type: "settings.changed" }));

/** 生图服务在统一凭据存储里的 provider id：复用别的服务就用那个 id，否则用自己的。 */
const credentialIdOf = (p: Pick<ImageProvider, "id" | "keyFrom">) => p.keyFrom || p.id;

async function readStoredKey(providerId: string): Promise<string | undefined> {
	if (!providerId) return undefined;
	const store = credentialStore;
	if (!store) return undefined;
	const c = await store.read(providerId);
	return c?.type === "api_key" ? c.key : undefined;
}

/** 唯一写路径：Key 写进统一凭据存储（公开 `CredentialStore`），不落 settings、不写日志、不复制明文。 */
async function writeStoredKey(providerId: string, key: string | null): Promise<void> {
	const store = credentialStore;
	if (!store) throw new Error("凭据存储还没准备好，请稍后重试");
	if (key) await store.modify(providerId, async () => ({ type: "api_key", key }));
	else await store.delete(providerId);
}

/**
 * 解析服务的 Key：统一凭据存储 → legacy `imageKey:<id>` 加密设置（桥接，只读）→ `keyFrom` 引用。
 * 绝不读 env / 全局 Key，也不把 Key 写进 settings 或日志；错误信息不含 Key。
 */
async function keyOf(p: Pick<ImageProvider, "id" | "keyFrom">): Promise<string | undefined> {
	const unified = await readStoredKey(credentialIdOf(p));
	if (unified) return unified;
	// legacy 桥接：旧版写在 imageKey:<id> 的加密设置（不复制明文，仅读）
	const s = getSetting<string | null>(`imageKey:${p.id}`, null);
	return s ? openJson<string>(s) : undefined;
}
export const hasKey = (p: ImageProvider) => !!p.keyFrom || !!p.hasCredential || !!getSetting<string | null>(`imageKey:${p.id}`, null);
/** 非秘密元数据：这个服务的 Key 现在存在哪（界面提示 / 迁移用）。 */
export function keySourceOf(p: ImageProvider): ImageProvider["keyStored"] {
	if (p.keyFrom) return "reference";
	if (p.hasCredential) return "unified";
	if (getSetting<string | null>(`imageKey:${p.id}`, null)) return "legacy";
	return undefined;
}

/** 幂等、非秘密的 legacy 元数据迁移：只给每个生图服务补 `keyStored` 标记，**不读、不复制任何明文**。 */
export function migrateLegacyImageProviders(): number {
	const list = listProviders();
	let changed = 0;
	const next = list.map((p) => {
		const stored = keySourceOf(p);
		if (stored === p.keyStored) return p;
		changed++;
		return { ...p, keyStored: stored };
	});
	if (changed) setSetting("imageProviders", next);
	return changed;
}

export const providerJson = (p: ImageProvider) => ({ ...p, hasKey: hasKey(p), keyStored: keySourceOf(p), kindLabel: kindInfo(p.kind)?.label ?? p.kind });

export interface ProviderInput {
	name?: string;
	kind: ImageKind;
	baseUrl?: string;
	apiKey?: string;
	keyFrom?: string | null;
	models?: string[];
}
export async function saveProvider(id: string | null, i: ProviderInput): Promise<ImageProvider> {
	if (!KINDS.some((k) => k.kind === i.kind)) throw new Error("不支持的服务类型");
	const info = kindInfo(i.kind);
	const baseUrl = (i.baseUrl?.trim() || info.baseUrl).replace(/\/+$/, "");
	if (!/^https?:\/\//.test(baseUrl)) throw new Error("Base URL 要以 http:// 或 https:// 开头");
	const models = [...new Set((i.models ?? []).map((m) => m.trim()).filter(Boolean))];
	if (!models.length) throw new Error("至少添加一个图片模型");
	const list = listProviders();
	const cur = id ? list.find((p) => p.id === id) : undefined;
	if (id && !cur) throw new Error("服务不存在");
	const keyFrom = i.keyFrom === undefined ? (cur?.keyFrom ?? null) : (i.keyFrom || null);
	const p: ImageProvider = { id: cur?.id ?? uid("img"), name: i.name?.trim() || info.label.replace(/（.*$/, ""), kind: i.kind, baseUrl, models, keyFrom, hasCredential: keyFrom ? false : (cur?.hasCredential ?? false), createdAt: cur?.createdAt ?? Date.now() };
	if (keyFrom) {
		// 改成复用别的服务的 Key：清掉自己名下的统一凭据（不删别的服务、不动 legacy 设置）
		if (cur && !cur.keyFrom && cur.hasCredential) await writeStoredKey(cur.id, null).catch(() => {});
		p.hasCredential = false;
	} else if (i.apiKey?.trim()) {
		// 新 Key 走统一凭据存储；同时清掉 legacy 加密设置（只清引用，不复制明文）
		await writeStoredKey(p.id, i.apiKey.trim());
		p.hasCredential = true;
		if (getSetting<string | null>(`imageKey:${p.id}`, null)) setSetting(`imageKey:${p.id}`, null);
	}
	p.keyStored = keySourceOf(p);
	saveList(cur ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]);
	// 第一个配置好的模型自动成为默认
	const d = defaultImageModel();
	if (!d || (d.provider === p.id && !p.models.includes(d.model))) setDefaultImageModel({ provider: p.id, model: p.models[0] });
	return p;
}
export async function removeProvider(id: string) {
	const list = listProviders();
	const p = list.find((x) => x.id === id);
	if (!p) return false;
	setSetting(`imageKey:${id}`, null);
	// 删掉统一凭据里自己名下的 Key（keyFrom 引用别的服务的 Key 时不动别人的）
	if (!p.keyFrom) await writeStoredKey(id, null).catch(() => {});
	saveList(list.filter((p) => p.id !== id));
	if (getSetting<ImageModelRef | null>("defaultImageModel", null)?.provider === id) {
		const next = listProviders()[0];
		setDefaultImageModel(next ? { provider: next.id, model: next.models[0] } : null);
	}
	return true;
}

const valid = (r: ImageModelRef | null | undefined): r is ImageModelRef => !!r && !!getProvider(r.provider)?.models.includes(r.model);
export function defaultImageModel(): ImageModelRef | null {
	const d = getSetting<ImageModelRef | null>("defaultImageModel", null);
	if (valid(d)) return d;
	const p = listProviders()[0];
	return p ? { provider: p.id, model: p.models[0] } : null;
}
export function setDefaultImageModel(r: ImageModelRef | null) {
	if (r && !valid(r)) throw new Error("模型不存在");
	setSetting("defaultImageModel", r);
	bus.emit({ type: "settings.changed" });
}
export const agentChoice = (agentId: string) => getSetting<AgentImageChoice>(`agentImage:${agentId}`, { mode: "default" });
export function setAgentChoice(agentId: string, c: AgentImageChoice) {
	if (c.mode === "model" && !valid(c)) throw new Error("模型不存在");
	setSetting(`agentImage:${agentId}`, c.mode === "model" ? { mode: "model", provider: c.provider, model: c.model } : { mode: c.mode });
}
/** 这个助理现在用哪个图片模型；null = 不提供 generate_image */
export function imageModelFor(agentId: string): ImageModelRef | null {
	const c = agentChoice(agentId);
	if (c.mode === "off") return null;
	if (c.mode === "model" && valid(c)) return { provider: c.provider, model: c.model };
	return defaultImageModel();
}
/** 进会话缓存键：图片模型变了就重建会话（工具列表 / 说明会变） */
export const imageKey = (agentId: string) => {
	const m = imageModelFor(agentId);
	return m ? `${m.provider}/${m.model}` : "off";
};
export const labelOf = (r: ImageModelRef) => `${getProvider(r.provider)?.name ?? r.provider} / ${r.model}`;

export async function endpointOf(p: ImageProvider, overrideKey?: string): Promise<ImageEndpoint> {
	return { kind: p.kind, baseUrl: p.baseUrl, apiKey: overrideKey || (await keyOf(p)) };
}

/** 测试模型 / 自动获取：草稿（还没保存）也能用 */
export async function fetchModelsFor(i: { id?: string; kind: ImageKind; baseUrl?: string; apiKey?: string; keyFrom?: string | null }, ctx?: Ctx) {
	const info = kindInfo(i.kind);
	const saved = i.id ? getProvider(i.id) : undefined;
	const apiKey = i.apiKey?.trim() || (i.keyFrom ? await keyOf({ id: "", keyFrom: i.keyFrom }) : saved ? await keyOf(saved) : undefined);
	const ep: ImageEndpoint = { kind: i.kind, baseUrl: (i.baseUrl?.trim() || info.baseUrl).replace(/\/+$/, ""), apiKey };
	try {
		const r = await listModels(ep, ctx);
		return { ok: true, all: r.all, image: r.image, presets: info.models };
	} catch (e) {
		const err = e instanceof ImageGenError ? e : new ImageGenError("network", String(e));
		return { ok: false, error: err.message, detail: err.detail, presets: info.models };
	}
}

const MAX_INPUT = 20 * 1024 * 1024;
let testCtx: Ctx | null = null;
/** 测试用：替换 HTTP 上下文 */
export const setImageCtx = (c: Ctx | null) => void (testCtx = c);

export async function runGeneration(ref: ImageModelRef, req: { prompt: string; n?: number; aspect?: string; size?: string; quality?: "low" | "medium" | "high" | "auto"; images?: { name: string; mime: string; data: Buffer }[]; signal?: AbortSignal }): Promise<GenResult> {
	const p = getProvider(ref.provider);
	if (!p) throw new ImageGenError("model", `图片服务 ${ref.provider} 已删除`, "图片模型没有配置好");
	if (req.images?.length && !supportsEdit(p.kind, ref.model)) throw new ImageGenError("unsupported", `${labelOf(ref)} 不支持输入图片`, `当前图片模型（${ref.model}）不支持改图 / 参考图`);
	return generate(await endpointOf(p), { model: ref.model, ...req }, testCtx ?? defaultCtx());
}

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const slug = (s: string) =>
	s
		.replace(/[\\/:*?"<>|\s\n\r\t]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24) || "image";
const stamp = () => {
	const d = new Date(Date.now() + 8 * 3600_000).toISOString(); // 用户在 Asia/Shanghai
	return `${d.slice(0, 10).replace(/-/g, "")}-${d.slice(11, 19).replace(/:/g, "")}`;
};

export interface ToolArgs {
	prompt: string;
	count?: number;
	aspect_ratio?: string;
	size?: string;
	quality?: "low" | "medium" | "high" | "auto";
	input_images?: string[];
	filename?: string;
}
/** generate_image 工具：生成 → 存进工作区 images/ → 作为图片附件发到当前对话（群聊里由 insertMessage 自动带上 room_id） */
export async function generateForAgent(agentId: string, conversationId: string | null, taskId: string | null, a: ToolArgs, signal?: AbortSignal) {
	const ref = imageModelFor(agentId);
	if (!ref) throw new ImageGenError("unsupported", "没有配置图片模型", "没有可用的图片模型，请在 设置 › 模型 › 图片生成 里添加");
	const images: { name: string; mime: string; data: Buffer }[] = [];
	for (const p of a.input_images ?? []) {
		const abs = insideWorkspace(agentId, p);
		if (!abs) throw new ImageGenError("bad_request", `${p} 不在工作区里`, `只能使用工作区里的图片：${p}`);
		let st;
		try {
			st = statSync(abs);
		} catch {
			throw new ImageGenError("bad_request", `找不到 ${p}`, `找不到图片：${p}`);
		}
		if (st.size > MAX_INPUT) throw new ImageGenError("bad_request", `${p} 超过 20MB`, `图片太大（超过 20MB）：${p}`);
		const mime = mimeOf(abs);
		if (!mime.startsWith("image/") || mime === "image/svg+xml") throw new ImageGenError("bad_request", `${p} 的类型是 ${mime}`, `不是图片文件：${p}`);
		images.push({ name: basename(abs), mime, data: readFileSync(abs) });
	}
	const n = Math.min(4, Math.max(1, Math.round(a.count ?? 1)));
	const started = Date.now();
	const res = await runGeneration(ref, { prompt: a.prompt, n, aspect: a.aspect_ratio, size: a.size, quality: a.quality, images: images.length ? images : undefined, signal });
	const dir = join(workspaceOf(agentId), "images");
	mkdirSync(dir, { recursive: true });
	const base = `${stamp()}-${slug(a.filename ? basename(a.filename, extname(a.filename)) : a.prompt)}`;
	const saved: string[] = [];
	res.images.forEach((im, i) => {
		const name = `${base}${res.images.length > 1 ? `-${i + 1}` : ""}${EXT[im.mime] ?? ".png"}`;
		writeFileSync(join(dir, name), im.data);
		saved.push(relative(workspaceOf(agentId), join(dir, name)));
	});
	const rows = saved.map((p) => deliverFromWorkspace(agentId, p));
	const cost = costNote(ref.model);
	insertMessage({
		agentId,
		conversationId,
		role: "assistant",
		content: "",
		meta: { attachments: rows.map(fileInfo), fromTask: taskId, imageGen: { model: labelOf(ref), prompt: a.prompt.slice(0, 500), edit: images.length > 0, ms: Date.now() - started, cost } },
	});
	return { ref, saved, revisedPrompt: res.revisedPrompt, text: res.text, cost, ms: Date.now() - started };
}
