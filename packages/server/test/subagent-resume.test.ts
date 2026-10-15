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
import { assessResumeSafety, classifyResume, shouldAutoRetry, shouldAutoRetrySafely, transportBackoffMs, TRANSPORT_RETRY, TRANSPORT_RETRY_PROMPT } from "../src/subagent-resume.ts";

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

test("自动续跑只发「先核验、不重做」的续跑提示，不重发原任务（避免重放已执行的副作用）", () => {
	const p = TRANSPORT_RETRY_PROMPT;
	assert.ok(/先检查工作区|先核验/.test(p), "要先核验已持久的结果");
	assert.ok(/不要重做/.test(p) && /不要重复/.test(p), "要禁止重做与重复副作用");
	assert.ok(/可能已经执行、也可能没有执行/.test(p), "要承认副作用结果未知，不承诺 exactly-once");
	// 提示里不含任务正文占位：自动续跑绝不把原任务重新发一遍
	assert.equal(p.includes("${task}"), false);
});

test("全任务最长运行时间超时不误判为连接类（不自动重试）", () => {
	// subagents.ts stopSubagent(id,"timeout") 的文案；必须与「请求超时」区分，绝不自动重跑整个任务
	const info = classifyResume("已超过最长运行时间");
	assert.equal(info.auto, false);
	assert.equal(shouldAutoRetry("已超过最长运行时间", 1), false);
	// 真正的请求级超时仍然可自动续
	assert.equal(shouldAutoRetry("request timed out after 60s", 1), true);
});

test("有界自动重试：次数上限、指数退避 + 抖动、封顶", () => {
	// 连接类才允许；未知/停止不允许
	assert.equal(shouldAutoRetry("ECONNRESET", 1), true);
	assert.equal(shouldAutoRetry("ECONNRESET", TRANSPORT_RETRY.maxAttempts - 1), true);
	assert.equal(shouldAutoRetry("ECONNRESET", TRANSPORT_RETRY.maxAttempts), false);
	assert.equal(shouldAutoRetry("模型返回了奇怪的输出", 1), false);
	assert.equal(shouldAutoRetry("用户停止了任务", 1), false);
	// 429 / 5xx 已由 Pi 自身请求重试 + 池内 fallback 处理，不在 app 层重复退避（否则每轮多等一个 Pi 重试周期）
	assert.equal(shouldAutoRetry("429 Too Many Requests", 1), false);
	assert.equal(shouldAutoRetry("503 Service Unavailable", 1), false);
	// 第 1 次 ≤ base*1.5；单调增（固定抖动）；封顶 maxMs
	assert.ok(transportBackoffMs(1, () => 0.5) > 0);
	assert.ok(transportBackoffMs(1, () => 1) <= TRANSPORT_RETRY.baseMs * 1.5);
	assert.ok(transportBackoffMs(3, () => 1) >= transportBackoffMs(2, () => 1));
	assert.ok(transportBackoffMs(20, () => 1) <= TRANSPORT_RETRY.maxMs);
});

const assistantWithCalls = (...calls: { id: string; name: string }[]) => ({ role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })) });
const toolResult = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "ok" }] });

// —— 副作用核验：判断自动续跑是否安全。用户要求「提示别重做」不能当作幂等保证，必须有状态证据 ——
test("续跑安全：工具调用与结果都落库 → 可安全自动续跑", () => {
	const s = assessResumeSafety([{ role: "user", content: "任务" }, assistantWithCalls({ id: "c1", name: "bash" }), toolResult("c1"), { role: "assistant", content: [{ type: "text", text: "继续" }] }]);
	assert.equal(s.safe, true);
	assert.deepEqual(s.pendingToolCalls, []);
});

test("续跑不安全：工具调用已派发、结果未落库 → 禁止自动重试", () => {
	const s = assessResumeSafety([{ role: "user", content: "任务" }, assistantWithCalls({ id: "c1", name: "send_email" })]);
	assert.equal(s.safe, false);
	assert.deepEqual(s.pendingToolCalls.map((p) => p.name), ["send_email"]);
	assert.match(s.reason, /需人工或主模型核验/);
});

test("续跑不安全：多个调用里只要有一个结果缺失就算不安全（保守）", () => {
	const s = assessResumeSafety([assistantWithCalls({ id: "a", name: "read" }, { id: "b", name: "pay" }), toolResult("a")]);
	assert.equal(s.safe, false);
	assert.deepEqual(s.pendingToolCalls, [{ id: "b", name: "pay" }]);
});

test("续跑安全：纯模型连接失败（助手消息无工具调用）、空会话、只有工具结果都算安全", () => {
	assert.equal(assessResumeSafety([]).safe, true);
	assert.equal(assessResumeSafety([{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "ECONNRESET" }]).safe, true);
	assert.equal(assessResumeSafety([toolResult("x")]).safe, true);
});

test("合并判定：只有「连接类 + 会话安全」才自动续跑；有未知副作用一律停", () => {
	const ok = assessResumeSafety([assistantWithCalls({ id: "c1", name: "bash" }), toolResult("c1")]);
	const unknown = assessResumeSafety([assistantWithCalls({ id: "c1", name: "bash" })]);
	assert.equal(shouldAutoRetrySafely("ECONNRESET", 1, ok), true);
	assert.equal(shouldAutoRetrySafely("ECONNRESET", 1, unknown), false, "结果未知绝不自动重放");
	assert.equal(shouldAutoRetrySafely("用户停止了任务", 1, ok), false);
});
