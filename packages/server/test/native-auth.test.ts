import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { authenticateNative, detectNative, nativeAuthMethods, nativeModels } from "../src/cli-agents/native-auth.ts";
import { geminiProfile } from "../src/cli-agents/native-profile.ts";

test("Agent Auth 默认 agent；拒绝 terminal 与 API key", () => {
 assert.deepEqual(nativeAuthMethods([{ id: "gemini-api-key" }, { id: "oauth-personal", name: "Google" }, { id: "terminal", type: "terminal" }]), [{ id: "oauth-personal", name: "Google" }]);
 assert.deepEqual(nativeModels([{ id: "x", category: "model", options: [{ options: [{ value: "a", name: "A" }] }] }], true), [{ id: "a", name: "A", image: true }]);
 assert.deepEqual(nativeModels([{ id: "model", options: [{ value: "a" }] }], false), []);
 assert.deepEqual(nativeModels([], false, { availableModels: [{ modelId: "official", name: "Official" }, { id: "not-protocol" }] }), [{ id: "official", name: "Official", image: false }]);
});
for (const scenario of ["meta", "auth-required", "no-config", "server-error", "no-http", "stdio-mixed"]) test(`只读探测 ${scenario} 不发 prompt 或 authenticate`, async () => {
 const dataDir = mkdtempSync(join(tmpdir(), "native-auth-"));
 const log = join(dataDir, "log");
 const input = { id: "gemini" as const, command: process.execPath, args: [resolve("test/fixtures/fake-native-acp.mjs")], dataDir,
  profile: { ...geminiProfile, env: (i: Parameters<typeof geminiProfile.env>[0]) => ({ ...geminiProfile.env(i), FAKE_NATIVE_SCENARIO: scenario, FAKE_NATIVE_LOG: log }) } };
 try {
  const result = await detectNative(input);
  assert.equal(result.loggedIn, !["auth-required", "server-error"].includes(scenario));
  assert.equal(!!result.loginUnverified, scenario === "server-error");
  assert.equal(result.models.length, ["meta", "no-http", "stdio-mixed"].includes(scenario) ? 2 : 0);
  if (result.loggedIn) {
   assert.equal(result.bridgeTransport, ["no-http", "stdio-mixed"].includes(scenario) ? "stdio" : "http");
   assert.equal(result.error, undefined);
  }
  const methods = readFileSync(log, "utf8");
  assert.ok(!methods.includes('"session/prompt"'));
  assert.ok(!methods.includes('"authenticate"'));
 } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
test("Google OAuth 选择正确且认证可取消", async () => {
 const dataDir = mkdtempSync(join(tmpdir(), "native-login-"));
 const log = join(dataDir, "log");
 const base = { id: "gemini" as const, command: process.execPath, args: [resolve("test/fixtures/fake-native-acp.mjs")], dataDir };
 try {
  await authenticateNative({ ...base, profile: { ...geminiProfile, env: (i) => ({ ...geminiProfile.env(i), FAKE_NATIVE_LOG: log }) } });
  assert.match(readFileSync(log, "utf8"), /"methodId":"oauth-personal"/);
  const controller = new AbortController();
  const pending = authenticateNative({ ...base, signal: controller.signal, profile: { ...geminiProfile, env: (i) => ({ ...geminiProfile.env(i), FAKE_NATIVE_SCENARIO: "auth-hang" }) } });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending);
 } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
