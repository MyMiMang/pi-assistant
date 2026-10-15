/**
 * 子代理失败分类与恢复决策的单测（纯函数，不依赖数据库 / 模型 / 凭据）。
 *
 * 对照用户 2026-10-22 的分类要求：
 * - 网络/连接/DNS/超时/429 retry-after/5xx/provider 临时不可用 → 可有界退避自动续跑；
 * - 上下文超限 / 永久 401·403 / 配置错 / 余额不足 / 模型被删 / 会话损坏 → 用户修好后手动续；
 * - 用户 cancel/stop / 权限拒绝 → 不自动恢复（停止保留会话，允许显式继续）；
 * - 未知错误不做全量白名单，不自动重试。
 */
import "../test/setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyResume, shouldAutoRetry, transportBackoffMs, TRANSPORT_RETRY } from "../src/subagent-resume.ts";

test("连接类 / 超时：可自动续跑", () => {
	for (const msg of [
		"ECONNRESET socket hang up",
		"connect ECONNREFUSED 127.0.0.1:443",
		"getaddrinfo ENOTFOUND api.example.com",
		"EAI_AGAIN 临时 DNS 失败",
		"fetch failed",
		"网络连接被重置",
		"request timed out after 60s",
		"ETIMEDOUT",
	]) {
		const info = classifyResume(msg);
		assert.equal(info.auto, true, msg);
		assert.equal(info.manual, true, msg);
		assert.ok(["transport", "transient"].includes(info.cls), msg);
	}
});

test("服务临时不可用 / 限流：可自动续跑，且 5xx / 429 也认", () => {
	for (const msg of ["429 Too Many Requests", "retry-after: 30", "503 Service Unavailable", "502 Bad Gateway", "provider 暂时不可用", "overloaded"]) {
		const info = classifyResume(msg);
		assert.equal(info.auto, true, msg);
		assert.ok(["transport", "transient"].includes(info.cls), msg);
	}
});

test("配置 / 凭据 / 上下文 / 会话：不自动续跑，但可手动用原 id 续", () => {
	for (const msg of [
		"401 Unauthorized: invalid api key",
		"403 Forbidden",
		"余额不足，请充值",
		"maximum context length exceeded",
		"模型不存在：foo/bar",
		"session file is corrupt",
	]) {
		const info = classifyResume(msg);
		assert.equal(info.auto, false, msg);
		assert.equal(info.manual, true, msg);
	}
});

test("用户停止 / 权限拒绝：不自动恢复，保留会话允许显式继续", () => {
	for (const msg of ["用户或主会话停止了任务", "aborted by user", "permission denied by user", "用户拒绝了这次审批"]) {
		const info = classifyResume(msg);
		assert.equal(info.cls, "blocked", msg);
		assert.equal(info.auto, false, msg);
		assert.equal(info.manual, true, msg);
	}
});

test("未知/空原因：不全量白名单、不自动重试，可核验后手动续", () => {
	for (const msg of ["模型返回了奇怪的输出", "", undefined, null]) {
		const info = classifyResume(msg);
		assert.equal(info.auto, false, String(msg));
		assert.equal(info.manual, true, String(msg));
	}
});

test("有界自动重试：次数上限、指数退避 + 抖动、封顶", () => {
	// 连接类才允许；未知/停止不允许
	assert.equal(shouldAutoRetry("ECONNRESET", 1), true);
	assert.equal(shouldAutoRetry("ECONNRESET", TRANSPORT_RETRY.maxAttempts - 1), true);
	assert.equal(shouldAutoRetry("ECONNRESET", TRANSPORT_RETRY.maxAttempts), false);
	assert.equal(shouldAutoRetry("模型返回了奇怪的输出", 1), false);
	assert.equal(shouldAutoRetry("用户停止了任务", 1), false);
	// 第 1 次 ≤ base*1.5；单调增（固定抖动）；封顶 maxMs
	assert.ok(transportBackoffMs(1, () => 0.5) > 0);
	assert.ok(transportBackoffMs(1, () => 1) <= TRANSPORT_RETRY.baseMs * 1.5);
	assert.ok(transportBackoffMs(3, () => 1) >= transportBackoffMs(2, () => 1));
	assert.ok(transportBackoffMs(20, () => 1) <= TRANSPORT_RETRY.maxMs);
});
