import { join } from "node:path";
import { config } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";
import { CustomProviders, type CustomProviderMeta } from "./pi-adapter/custom-providers.ts";
import { PiModels } from "./pi-adapter/index.ts";
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
	await models.reloadConfig();
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
