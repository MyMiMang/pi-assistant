import { config } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";
import { PiModels } from "./pi-adapter/index.ts";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "./pi-adapter/mock-provider.ts";
import { EncryptedCredentialStore } from "./secrets.ts";
import { join } from "node:path";

export let models: PiModels;
export let credentialBackend = "";

export async function initModels() {
	const store = new EncryptedCredentialStore();
	credentialBackend = store.backend;
	models = await PiModels.create({ credentials: store, modelsPath: join(config.dataDir, "models.json"), allowNetwork: config.allowModelNetwork });
	if (config.mock) await registerMockProvider(models);
	if (config.mock && !getSetting("defaultModel", null)) setSetting("defaultModel", { provider: MOCK_PROVIDER, id: MOCK_MODEL });
}

export function defaultModel(): { provider: string; id: string } | null {
	const m = getSetting<{ provider: string; id: string } | null>("defaultModel", null);
	if (m && models.getModel(m.provider, m.id)) return m;
	return null;
}
