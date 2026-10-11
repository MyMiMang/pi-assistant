import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { EncryptedCredentialStore } from "../src/secrets.ts";

test("凭据加密落盘，可读回，可删除", async () => {
	const s = new EncryptedCredentialStore();
	await s.modify("openai", async () => ({ type: "api_key", key: "sk-secret-123" }));
	const raw = readFileSync(join(config.dataDir, "credentials.enc"));
	assert.ok(!raw.toString("latin1").includes("sk-secret-123"), "文件中不应出现明文");
	const s2 = new EncryptedCredentialStore();
	assert.deepEqual(await s2.read("openai"), { type: "api_key", key: "sk-secret-123" });
	assert.deepEqual(await s2.list(), [{ providerId: "openai", type: "api_key" }]);
	await s2.delete("openai");
	assert.equal(await s2.read("openai"), undefined);
});
