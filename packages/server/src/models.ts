import { join } from "node:path";
import { config } from "./config.ts";
import { db, getSetting, setSetting } from "./db.ts";
import { CustomProviders, type CustomProviderMeta } from "./pi-adapter/custom-providers.ts";
import { PiModels, setLimitsLearner, type CredentialStore } from "./pi-adapter/index.ts";
import { cliServices } from "./cli-services.ts";
import { refreshModelDb } from "./model-db.ts";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "./pi-adapter/mock-provider.ts";
import { EncryptedCredentialStore, openJson, sealJson } from "./secrets.ts";

export let models: PiModels;
export let customProviders: CustomProviders;
export let credentialBackend = "";
/** 统一凭据存储（公开 `CredentialStore` 接口）：chat / 生图等所有服务共用这一份，按 provider id 绑定一份 key。 */
export let credentialStore: CredentialStore | undefined;
/** 显式注入过的凭据后端：同一进程内后续无参 initModels 复用它，不再重复构造会走 OS 钥匙串的后端。 */
let injectedCredentials: CredentialStore | undefined;

/** 快速操作模型设置可能存在的 storage key：旧的全局 + 每台电脑 scope（旧版快速候选选择器留下的设置，该功能已删除，这里只用于清理）。 */
const FAST_COMPUTER_KEYS = ["fastComputer", "fastComputer:hostpc", "fastComputer:computer"];

export async function initModels(credentials?: CredentialStore) {
	// 测试可注入公开的内存 CredentialStore，避免构造会走 OS 钥匙串的安全后端（见 test/in-memory-credentials.ts）；
	// 注入过的后端在后续无参调用中复用，保证一个进程最多构造一次安全后端。
	if (credentials) injectedCredentials = credentials;
	const store: CredentialStore = credentials ?? injectedCredentials ?? new EncryptedCredentialStore();
	credentialStore = store;
	if (store instanceof EncryptedCredentialStore) credentialBackend = store.backend;
	const modelsPath = join(config.dataDir, "models.json");
	models = await PiModels.create({ credentials: store, modelsPath, allowNetwork: config.allowModelNetwork });
	customProviders = new CustomProviders(models, modelsPath, {
		loadMeta: () => getSetting<CustomProviderMeta[]>("customProviders", []),
		saveMeta: (l) => setSetting("customProviders", l),
		loadHeaders: (id) => {
			const s = getSetting<string | null>(`customHeaders:${id}`, null);
			return s ? openJson<Record<string, string>>(s) : {};
		},
		saveHeaders: (id, h) => setSetting(`customHeaders:${id}`, h ? sealJson(h) : null),
		readKey: async (id) => {
			const c = await store.read(id);
			return c?.type === "api_key" ? c.key : undefined;
		},
		loadFastReferences: () => FAST_COMPUTER_KEYS.map((key) => ({ storageKey: key, ...getSetting<{ kind?: string; provider: string; id: string }>(key, { provider: "", id: "" }) })).filter((r) => r.provider || r.id),
		saveFastReference: (ref, storageKey) => {
			const key = storageKey ?? "fastComputer";
			setSetting(key, { ...getSetting<Record<string, unknown>>(key, {}), ...ref });
		},
	});
	customProviders.applyEnv();
	setLimitsLearner((p, m, l) => customProviders.learnLimits(p, m, l));
	// 每周刷新一次 models.dev 模型参数库（离线就用安装包里的快照）；刷新后按新数据重算“已知 / 默认”
	if (config.allowModelNetwork && !config.mock) void refreshModelDb().then(() => customProviders.backfillLimits()).catch(() => {});
	await models.reloadConfig();
	await customProviders.backfillLimits().catch((e) => console.error("[models] 补齐自定义模型上下文长度失败", e));
	if (config.mock) await registerMockProvider(models);
	for (const svc of cliServices) await svc.ensure(models).catch((e) => console.error(`[models] 注册 ${svc.id} 渠道失败`, e));
	// classifier 只能经扩展注册，reloadConfig/backfill 后按保存的公开元数据重新注册（凭据仍走 Pi 原 provider）。
	customProviders.reapplyClassifiers();
	if (config.mock && !getSetting("defaultModel", null)) setSetting("defaultModel", { provider: MOCK_PROVIDER, id: MOCK_MODEL });
}

export function defaultModel(): { provider: string; id: string } | null {
	const m = getSetting<{ provider: string; id: string } | null>("defaultModel", null);
	if (m && models.getModel(m.provider, m.id)) return m;
	return null;
}

/** Pi SDK 允许的思考档位（ModelThinkingLevel），存设置 / 接口校验用同一份 */
export { THINKING_LEVEL_ORDER as THINKING_LEVELS, isThinkingLevel } from "@pi-assistant/shared";

/** 新助理的默认思考强度（每个模型实际用的会按它支持的档位收敛） */
export const defaultThinking = (): string => getSetting<string>("defaultThinking", "medium");

/** 界面显示的服务名：自定义服务用用户起的名字（内部 id 如 custom-xxxx 不给用户看） */
export function providerNames() {
	const m = new Map(models.listProviders().map((p) => [p.id, p.name || p.id]));
	for (const cp of customProviders.list()) m.set(cp.id, cp.name || cp.id);
	return m;
}
export const withProviderName = <T extends { provider: string }>(x: T, names = providerNames()) => ({ ...x, providerName: names.get(x.provider) ?? x.provider });

/** 某个模型服务被哪些设置 / 助理引用（删除前告诉用户影响，删除后据此清理） */
export interface ProviderReferences {
	defaultModel: boolean;
	visionModel: boolean;
	/** 主模型指向这个服务的助理名字（含群聊成员） */
	agents: string[];
	/** 已废弃：全局不再有子代理固定模型，恒为 false（保留字段兼容界面） */
	subagents: boolean;
	/** 候选池里引用了这个服务的助理 id */
	subagentAgents: string[];
	/** 生图服务复用了这个服务的 Key（删除后它们需要重新配 Key，不会被误删） */
	imageProviders: string[];
}

const refProvider = (v: unknown): string | undefined =>
	v && typeof v === "object" && "provider" in v ? String((v as { provider?: unknown }).provider ?? "") : undefined;

/** 哪些助理的候选池引用了这个服务（兼容旧「固定一个模型」形状）。 */
function subagentPoolRefs(id: string): string[] {
	const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'subagentModel:%'").all() as { key: string; value: string }[];
	const agents: string[] = [];
	for (const r of rows) {
		try {
			const c = JSON.parse(r.value) as { pool?: { provider?: string }[]; mode?: string; model?: { provider?: string } };
			const pool = Array.isArray(c.pool) ? c.pool : c.mode === "fixed" && c.model ? [c.model] : [];
			if (pool.some((m) => m?.provider === id)) agents.push(r.key.slice("subagentModel:".length));
		} catch {
			/* 坏数据忽略 */
		}
	}
	return agents;
}

/** 生图服务里 `keyFrom = id`（复用这个自定义服务 Key）的条目名（只读引用关系，不碰凭据）。 */
function imageProvidersKeyedFrom(id: string): { id: string; name: string }[] {
	const rows = getSetting<{ id?: string; name?: string; keyFrom?: string | null }[]>("imageProviders", []);
	return rows.filter((p) => p.keyFrom === id && p.id).map((p) => ({ id: String(p.id), name: p.name || String(p.id) }));
}

/** 复用某个自定义服务 Key 的生图服务：清掉 keyFrom（不动这些服务自己的配置与凭据）。 */
function clearImageKeyFrom(id: string): string[] {
	const rows = getSetting<{ id?: string; name?: string; keyFrom?: string | null }[]>("imageProviders", []);
	const hit = rows.filter((p) => p.keyFrom === id);
	if (!hit.length) return [];
	setSetting("imageProviders", rows.map((p) => (p.keyFrom === id ? { ...p, keyFrom: null } : p)));
	return hit.map((p) => p.name || p.id || "");
}

export function providerReferences(id: string): ProviderReferences {
	return {
		defaultModel: refProvider(getSetting("defaultModel", null)) === id,
		visionModel: refProvider(getSetting("visionModel", null)) === id,
		agents: (db.prepare("SELECT name FROM agents WHERE model_provider = ?").all(id) as { name: string }[]).map((r) => r.name),
		subagents: false,
		subagentAgents: subagentPoolRefs(id),
		imageProviders: imageProvidersKeyedFrom(id).map((p) => p.name),
	};
}

/** 删除模型服务后清掉引用它的设置与助理模型：能回到默认 / 自动的回落，不留悬空引用。用量历史不动。 */
export function clearProviderReferences(id: string): ProviderReferences {
	const refs = providerReferences(id);
	if (refs.defaultModel) setSetting("defaultModel", null);
	if (refs.visionModel) setSetting("visionModel", null);
	// 子代理候选池：把被删的服务从池里去掉（保存时会按现有模型校验，留着会报“模型尚未配置”）
	for (const agentId of refs.subagentAgents) {
		const cur = getSetting<{ pool?: { provider?: string }[] }>(`subagentModel:${agentId}`, {});
		setSetting(`subagentModel:${agentId}`, { pool: (Array.isArray(cur.pool) ? cur.pool : []).filter((m) => m?.provider !== id) });
	}
	// 快速操作模型：引用被删服务的 classifier → 清掉引用（回落为未选择，fail-closed）
	const fast = getSetting<{ kind?: string; provider?: string; id?: string } | null>("fastComputer", null);
	if (fast && fast.provider === id) setSetting("fastComputer", { ...fast, provider: "", id: "" });
	// 生图服务复用被删服务的 Key → 清掉 keyFrom，让其提示重新配 Key（不删生图服务本身）
	if (refs.imageProviders.length) clearImageKeyFrom(id);
	if (refs.agents.length) db.prepare("UPDATE agents SET model_provider = NULL, model_id = NULL WHERE model_provider = ?").run(id);
	return refs;
}
