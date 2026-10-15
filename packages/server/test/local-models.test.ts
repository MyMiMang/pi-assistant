/** 本地模型服务安全状态缓存：运行 → 停止后保留卡片，安装 / 运行状态分开，重启同 id 继续。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { localModelHint, localModelHints, rememberLocalModelStatus, resetLocalModelHints } from "../src/local-models.ts";

test("本地服务状态缓存：停止后沿用上次注册信息，安装/运行分开", () => {
	resetLocalModelHints();
	rememberLocalModelStatus({ install: { state: "installed" }, runtime: { state: "running" }, health: { device: "mps" }, registered: { provider: "local-laya", modelId: "multilingual", protocol: "typesafe-system-one" } });
	let h = localModelHint("local-laya")!;
	assert.equal(h.installed, true);
	assert.equal(h.running, true);
	assert.equal(h.device, "mps");
	assert.equal(h.modelId, "multilingual");
	// 停止：registered 为 null，用事件名对应的 provider 沿用上次 model，卡片不消失，只标暂不可用
	rememberLocalModelStatus({ install: { state: "installed" }, runtime: { state: "stopped" }, health: null, registered: null }, "local-laya");
	h = localModelHint("local-laya")!;
	assert.equal(h.installed, true);
	assert.equal(h.running, false);
	assert.equal(h.state, "stopped");
	assert.equal(h.modelId, "multilingual");
	assert.deepEqual(localModelHints().map((x) => x.provider), ["local-laya"]);
	// 重启：同 id 再注册回来继续沿用同一条缓存
	rememberLocalModelStatus({ install: { state: "installed" }, runtime: { state: "running" }, health: { device: "cuda" }, registered: { provider: "local-laya", modelId: "multilingual", protocol: "typesafe-system-one" } });
	h = localModelHint("local-laya")!;
	assert.equal(h.running, true);
	assert.equal(h.device, "cuda");
	// 不含 provider 的坏事件被忽略；已安装的不因一次停止事件丢掉
	rememberLocalModelStatus({ install: { state: "installed" }, runtime: { state: "stopped" }, registered: null });
	assert.deepEqual(localModelHints().map((x) => x.provider), ["local-laya"]);
	rememberLocalModelStatus({ runtime: { state: "running" }, registered: { modelId: "x" } });
	assert.deepEqual(localModelHints().map((x) => x.provider), ["local-laya"]);
});
