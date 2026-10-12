/**
 * 高级记忆（Hindsight）设置：三个模型各自可选 + 运行方式 + 镜像。
 *  - 记忆用模型（LLM）：任何已配置的 Pi / 自定义渠道里的模型；默认挑同渠道里便宜快速的（与聊天模型分开）
 *  - 向量模型：默认本地多语言 ONNX（multilingual-e5-small），可选 bge-m3（更好、更大），或在线 OpenAI 兼容接口
 *  - 重排序：本地（flashrank 多语言）/ 在线（硅基流动、阿里云百炼）/ 关闭（RRF 融合）
 * 密钥（在线向量/重排序、远程 Hindsight）单独加密保存，接口返回时打码。
 */
import { randomBytes } from "node:crypto";
import { getSetting, setSetting } from "../../db.ts";
import { openJson, sealJson } from "../../secrets.ts";

export type EmbeddingCfg =
	| { kind: "local"; model: "intfloat/multilingual-e5-small" | "BAAI/bge-m3" }
	| { kind: "openai"; baseUrl: string; model: string; dimensions?: number };
export type RerankerCfg = { kind: "local"; model: string } | { kind: "siliconflow"; model: string; baseUrl?: string } | { kind: "alibaba"; model: string } | { kind: "off" };
export type Mirror = "auto" | "official" | "china";

export interface HindsightSettings {
	mode: "local" | "remote";
	remoteUrl?: string;
	/** null = 自动挑选 */
	llm: { provider: string; id: string } | null;
	embedding: EmbeddingCfg;
	reranker: RerankerCfg;
	mirror: Mirror;
}
export interface HindsightSecrets {
	tenantKey: string;
	embeddingKey?: string;
	rerankerKey?: string;
	remoteKey?: string;
}

export const DEFAULTS: HindsightSettings = {
	mode: "local",
	llm: null,
	embedding: { kind: "local", model: "intfloat/multilingual-e5-small" },
	reranker: { kind: "local", model: "ms-marco-MultiBERT-L-12" },
	mirror: "auto",
};
export const LOCAL_EMBEDDINGS = [
	{ id: "intfloat/multilingual-e5-small", name: "multilingual-e5-small（默认，约 470 MB，384 维）", dims: 384, bytes: 470e6 },
	{ id: "BAAI/bge-m3", name: "bge-m3（效果更好，约 2.3 GB，1024 维）", dims: 1024, bytes: 2.3e9 },
];
export const LOCAL_RERANKERS = [
	{ id: "ms-marco-MultiBERT-L-12", name: "MultiBERT-L-12（多语言，默认，约 150 MB）", bytes: 150e6 },
	{ id: "ms-marco-MiniLM-L-12-v2", name: "MiniLM-L-12（英文为主，约 35 MB）", bytes: 35e6 },
];

export function hindsightSettings(): HindsightSettings {
	return { ...DEFAULTS, ...getSetting<Partial<HindsightSettings>>("hindsight", {}) };
}
export function hindsightSecrets(): HindsightSecrets {
	const raw = getSetting<string | null>("hindsightSecrets", null);
	const s = raw ? openJson<HindsightSecrets>(raw) : ({} as HindsightSecrets);
	if (!s.tenantKey) {
		s.tenantKey = randomBytes(24).toString("base64url");
		setSetting("hindsightSecrets", sealJson(s));
	}
	return s;
}

const MASK = "••••••";
export function validate(s: HindsightSettings) {
	if (s.mode === "remote") {
		if (!s.remoteUrl || !/^https?:\/\//.test(s.remoteUrl)) throw new Error("请填写远程 Hindsight 地址（http/https）");
	}
	if (s.embedding.kind === "openai") {
		if (!/^https?:\/\//.test(s.embedding.baseUrl ?? "")) throw new Error("请填写向量接口地址");
		if (!s.embedding.model) throw new Error("请填写向量模型名");
	} else if (!LOCAL_EMBEDDINGS.some((e) => e.id === s.embedding.model)) throw new Error("未知的本地向量模型");
	if ((s.reranker.kind === "siliconflow" || s.reranker.kind === "alibaba") && !s.reranker.model) throw new Error("请填写重排序模型名");
	if (!["auto", "official", "china"].includes(s.mirror)) throw new Error("未知的镜像设置");
}

/** 保存设置；密钥字段传打码值或不传 = 保持原值，传空串 = 清除 */
export function saveHindsightSettings(input: Partial<HindsightSettings> & { embeddingKey?: string; rerankerKey?: string; remoteKey?: string }) {
	const cur = hindsightSettings();
	const next: HindsightSettings = {
		mode: input.mode ?? cur.mode,
		remoteUrl: input.remoteUrl !== undefined ? input.remoteUrl.trim() || undefined : cur.remoteUrl,
		llm: input.llm !== undefined ? input.llm : cur.llm,
		embedding: input.embedding ?? cur.embedding,
		reranker: input.reranker ?? cur.reranker,
		mirror: input.mirror ?? cur.mirror,
	};
	validate(next);
	const sec = hindsightSecrets();
	for (const k of ["embeddingKey", "rerankerKey", "remoteKey"] as const) {
		const v = input[k];
		if (v === undefined || v === MASK) continue;
		if (v === "") delete sec[k];
		else sec[k] = v;
	}
	setSetting("hindsight", next);
	setSetting("hindsightSecrets", sealJson(sec));
	return { before: cur, after: next };
}

/** 设置页用：密钥打码 */
export function publicSettings() {
	const s = hindsightSettings();
	const sec = hindsightSecrets();
	return { ...s, embeddingKey: sec.embeddingKey ? MASK : "", rerankerKey: sec.rerankerKey ? MASK : "", remoteKey: sec.remoteKey ? MASK : "" };
}

/** 向量配置的“指纹”：变了就需要用新模型重建向量（我们本地有全部原文，会自动重新写入） */
export const embeddingSignature = (e: EmbeddingCfg) => (e.kind === "local" ? `local:${e.model}` : `openai:${e.baseUrl}|${e.model}|${e.dimensions ?? ""}`);

/** 便宜快速模型的名字特征 */
const CHEAP = /(flash|mini|haiku|lite|small|nano|turbo|air|fast|instant|8b|7b|4b|3b|1\.5b)/i;
/**
 * 自动挑记忆用模型：优先“与默认聊天模型同一渠道里”名字像便宜快速的；没有就用默认聊天模型。
 * models：已配置渠道里的全部模型
 */
export function pickMemoryModel(models: { provider: string; id: string; reasoning?: boolean }[], chat: { provider: string; id: string } | null) {
	if (!models.length) return null;
	const same = chat ? models.filter((m) => m.provider === chat.provider) : [];
	const cheap = (l: typeof models) => l.filter((m) => CHEAP.test(m.id)).sort((a, b) => Number(!!a.reasoning) - Number(!!b.reasoning) || a.id.length - b.id.length)[0];
	const m = cheap(same) ?? (chat && models.find((x) => x.provider === chat.provider && x.id === chat.id)) ?? cheap(models) ?? models[0];
	return m ? { provider: m.provider, id: m.id } : null;
}
