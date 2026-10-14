import { join } from "node:path";
import { config } from "./config.ts";
import { db, getSetting, setSetting } from "./db.ts";
import { CustomProviders, type CustomProviderMeta } from "./pi-adapter/custom-providers.ts";
import { PiModels, setLimitsLearner } from "./pi-adapter/index.ts";
import { refreshModelDb } from "./model-db.ts";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "./pi-adapter/mock-provider.ts";
import { EncryptedCredentialStore, openJson, sealJson } from "./secrets.ts";

export let models: PiModels;
export let customProviders: CustomProviders;
export let credentialBackend = "";

export async function initModels() {
	const store = new EncryptedCredentialStore();
	credentialBackend = store.backend;
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
	});
	customProviders.applyEnv();
	setLimitsLearner((p, m, l) => customProviders.learnLimits(p, m, l));
	// 每周刷新一次 models.dev 模型参数库（离线就用安装包里的快照）；刷新后按新数据重算“已知 / 默认”
	if (config.allowModelNetwork && !config.mock) void refreshModelDb().then(() => customProviders.backfillLimits()).catch(() => {});
	await models.reloadConfig();
	await customProviders.backfillLimits().catch((e) => console.error("[models] 补齐自定义模型上下文长度失败", e));
	if (config.mock) await registerMockProvider(models);
	if (config.mock && !getSetting("defaultModel", null)) setSetting("defaultModel", { provider: MOCK_PROVIDER, id: MOCK_MODEL });
}

export function defaultModel(): { provider: string; id: string } | null {
	const m = getSetting<{ provider: string; id: string } | null>("defaultModel", null);
	if (m && models.getModel(m.provider, m.id)) return m;
	return null;
}

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

export function providerReferences(id: string): ProviderReferences {
	return {
		defaultModel: refProvider(getSetting("defaultModel", null)) === id,
		visionModel: refProvider(getSetting("visionModel", null)) === id,
		agents: (db.prepare("SELECT name FROM agents WHERE model_provider = ?").all(id) as { name: string }[]).map((r) => r.name),
		subagents: false,
		subagentAgents: subagentPoolRefs(id),
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
	if (refs.agents.length) db.prepare("UPDATE agents SET model_provider = NULL, model_id = NULL WHERE model_provider = ?").run(id);
	return refs;
}
