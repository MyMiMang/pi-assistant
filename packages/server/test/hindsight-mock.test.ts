process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { hindsightReply } from "../src/pi-adapter/mock-provider.ts";
import { toChatRequest, LlmProxy } from "../src/llm-proxy.ts";
const modelsMod = await import("../src/models.ts");
await modelsMod.initModels();

const system = "CRITICAL: You MUST ONLY use information from retrieved tool results.";
const done = {
	type: "object",
	properties: { answer: { type: "string" }, answer_found: { type: "boolean" }, memory_ids: { type: "array" } },
	required: ["answer", "answer_found", "memory_ids"],
};
const request = (schema: object) => ({
	model: "mock/echo",
	messages: [
		{ role: "system" as const, content: system },
		{ role: "user" as const, content: 'Result of `recall`:\n{"results":[{"text":"用户喜欢简洁的回答"}]}' },
		{ role: "user" as const, content: "Call `done` now. Reply with only its arguments, as one JSON object." },
	],
	response_format: { type: "json_schema" as const, json_schema: { name: "response", schema } },
});

test("Hindsight 1.2：JSON Schema 工具参数和普通 user 检索结果经网关仍返回完整答案", async () => {
	const p = await new LlmProxy({ complete: (a, b, c) => modelsMod.models.complete(a, b, c), listModels: () => [] }).start();
	try {
		const res = await fetch(`${p.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" },
			body: JSON.stringify(request(done)),
		});
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.choices[0].finish_reason, "stop");
		const args = JSON.parse(body.choices[0].message.content);
		assert.match(args.answer, /简洁/);
		assert.equal(args.answer_found, true);
		assert.deepEqual(args.memory_ids, []);
	} finally {
		await p.stop();
	}
});

test("Hindsight 1.2：强制检索参数、nullable 类型、下一步 answer_ready 和 directive_compliance", () => {
	const reply = (schema: object) => {
		const chat = toChatRequest(request(schema));
		return JSON.parse(hindsightReply([], chat.systemPrompt!) as string);
	};
	assert.deepEqual(reply({ properties: { query: { type: "string" }, max_tokens: { type: ["integer", "null"] } }, required: ["query", "max_tokens"] }), {
		query: "根据记忆：用户喜欢简洁的回答。", max_tokens: 1024,
	});
	assert.deepEqual(reply({ properties: { call: { anyOf: [
		{ properties: { name: { enum: ["recall"] }, arguments: { properties: { query: { type: "string" } }, required: ["query"] } } },
		{ properties: { name: { enum: ["answer_ready"] }, arguments: { properties: {}, required: [] } } },
	] } }, required: ["call"] }), { call: { name: "answer_ready", arguments: {} } });
	assert.deepEqual(reply({ ...done, properties: { ...done.properties, directive_compliance: { type: "object" } }, required: [...done.required, "directive_compliance"] }).directive_compliance, {});
});

test("Hindsight 原生工具路径仍在检索后返回 done 和 answer_found", () => {
	const result = hindsightReply([{ role: "toolResult", content: "用户喜欢简洁" }], system, [{ name: "done", parameters: done }]);
	assert.equal(typeof result, "object");
	assert.equal((result as { args: Record<string, unknown> }).args.answer_found, true);
});
