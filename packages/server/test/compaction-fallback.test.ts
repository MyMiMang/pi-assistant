import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactWithFallback, compactionFallbackExtension, isProviderRefusal, refusalWillRetry } from "../src/pi-adapter/compaction-fallback.ts";
import { compactSession } from "../src/pi-adapter/index.ts";

const refusal = 'Summarization failed: 400: {"message":"内容审计命中风险规则，请调整输入后重试","type":"invalid_request_error"}';
const fallback = { provider: "backup", id: "summary" };

// 复用现有 compactSession 测试的假会话方式：Mock echo 没有摘要 400 场景，不更改公共 Mock 行为。
test("摘要拒绝分类：4xx（429 除外），不把网络或无须整理当拒绝", () => {
	assert.equal(isProviderRefusal(refusal), true);
	for (const message of ["Summarization failed: 429", "Nothing to compact", "fetch failed", "Summarization failed: 500", "400 other error"]) assert.equal(isProviderRefusal(message), false);
	assert.equal(isProviderRefusal("Summarization failed: 403: forbidden"), true);
});

test("手动回退：原样传说明，只重试一次，备用选择限本会话且 finally 清除", async () => {
	let handler!: (event: unknown, ctx: unknown) => Promise<unknown>;
	await compactionFallbackExtension({ on: (_event: string, fn: typeof handler) => { handler = fn; } } as never);
	const lookedUp: unknown[] = [];
	const probe = (sessionId: string) => handler({}, {
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: { find: (provider: string, id: string) => { lookedUp.push({ provider, id }); return undefined; } },
	});
	let calls = 0;
	const s = {
		sessionId: "fallback-test", model: { provider: "primary", id: "chat" },
		compact: async (instructions?: string) => {
			assert.equal(instructions, "保留待办");
			assert.equal(refusalWillRetry(s.sessionId, refusal), ++calls === 1, "只有第一次尝试隐藏拒绝消息");
			assert.equal(refusalWillRetry(s.sessionId, "Summarization failed: 429"), false);
			assert.equal(refusalWillRetry("other-session", refusal), false);
			if (calls === 1) throw new Error(refusal);
			assert.equal(await probe("other-session"), undefined);
			await assert.rejects(probe(s.sessionId), /备用模型不存在/);
			return { tokensBefore: 42, summary: "摘要" };
		},
	};
	assert.deepEqual(await compactSession(s as never, "保留待办", fallback), { tokensBefore: 42, summary: "摘要" });
	assert.equal(calls, 2);
	assert.equal(refusalWillRetry(s.sessionId, refusal), false, "成功后清理重试状态");
	assert.deepEqual(lookedUp, [fallback]);
	assert.equal(await probe(s.sessionId), undefined, "成功后临时映射已清除");
	calls = 0;
	s.compact = async () => {
		if (++calls === 1) throw new Error(refusal);
		throw new Error("backup failed");
	};
	await assert.rejects(compactWithFallback(s as never, undefined, fallback), /backup failed/);
	assert.equal(calls, 2);
	assert.equal(await probe(s.sessionId), undefined, "失败后临时映射也清除");
	assert.equal(refusalWillRetry(s.sessionId, refusal), false, "失败后也清理重试状态");
});

test("无默认模型、同模型、非拒绝错误不重试", async () => {
	for (const [message, backup] of [[refusal, undefined], [refusal, fallback], ["Summarization failed: 429", { provider: "other", id: "x" }], ["network error", fallback]] as const) {
		let calls = 0;
		const error = new Error(message);
		const s = {
			sessionId: "no-retry", model: fallback,
			compact: async () => {
				calls++;
				if (!backup || backup === fallback) assert.equal(refusalWillRetry(s.sessionId, refusal), false);
				assert.equal(refusalWillRetry(s.sessionId, message), false);
				throw error;
			},
		};
		await assert.rejects(compactWithFallback(s as never, undefined, backup), (e) => e === error);
		assert.equal(calls, 1);
		assert.equal(refusalWillRetry(s.sessionId, refusal), false);
	}
});
