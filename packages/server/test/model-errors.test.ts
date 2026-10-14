import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyModelError, isRecoverableModelError } from "../src/model-errors.ts";

test("可恢复的模型故障：限流 / 服务不可用 / 模型不存在 / 鉴权不通 / 超时", () => {
	assert.equal(classifyModelError("429 Too Many Requests")?.kind, "rate_limit");
	assert.equal(classifyModelError("rate limit exceeded, please retry")?.kind, "rate_limit");
	assert.equal(classifyModelError("503 Service Unavailable")?.kind, "unavailable");
	assert.equal(classifyModelError("model not found: gpt-x")?.kind, "model_missing");
	assert.equal(classifyModelError("模型不存在：foo/bar")?.kind, "model_missing");
	assert.equal(classifyModelError("401 Unauthorized: invalid api key")?.kind, "auth");
	assert.equal(classifyModelError("request timed out after 60s")?.kind, "timeout");
	assert.equal(isRecoverableModelError("502 Bad Gateway"), true);
});

test("不是模型故障：工具 / 命令失败、权限拒绝、未知错误一律不换模型", () => {
	assert.equal(isRecoverableModelError("命令执行失败：ENOENT"), false);
	assert.equal(isRecoverableModelError("tool error: bash exited 1"), false);
	assert.equal(isRecoverableModelError("用户拒绝了这次审批"), false);
	assert.equal(isRecoverableModelError("permission denied by user"), false);
	assert.equal(isRecoverableModelError("模型返回了奇怪的输出"), false);
	assert.equal(isRecoverableModelError(""), false);
	assert.equal(isRecoverableModelError(undefined), false);
	assert.equal(isRecoverableModelError(null), false);
});
