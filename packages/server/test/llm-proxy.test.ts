process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const modelsMod = await import("../src/models.ts");
const { LlmProxy, extractJson, toChatRequest } = await import("../src/llm-proxy.ts");
await modelsMod.initModels();

test("网关：OpenAI 消息 → 中性请求（system 合并、tool 调用往返、JSON 模式提示）", () => {
	const r = toChatRequest({
		model: "x",
		messages: [
			{ role: "system", content: "你是助手" },
			{ role: "user", content: [{ type: "text", text: "查天气" }] },
			{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "weather", arguments: '{"city":"上海"}' } }] },
			{ role: "tool", tool_call_id: "c1", content: "晴" },
		],
		tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
		response_format: { type: "json_object" },
	});
	assert.match(r.systemPrompt!, /你是助手[\s\S]*JSON/);
	assert.equal(r.messages.length, 3);
	assert.deepEqual(r.messages[1], { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "weather", arguments: { city: "上海" } }] });
	assert.deepEqual(r.messages[2], { role: "tool", toolCallId: "c1", name: "weather", text: "晴" });
	assert.equal(r.tools![0].name, "weather");
	assert.equal(extractJson('好的：\n```json\n{"a":1}\n```'), '{"a":1}');
	assert.equal(extractJson('结果 {"a":[1,2]} 完'), '{"a":[1,2]}');
});

test("网关：只认随机令牌；经 Pi（mock 模型）补全；别名；流式；/models", async () => {
	const p = await new LlmProxy({ complete: (a, b, c) => modelsMod.models.complete(a, b, c), listModels: () => [{ provider: "mock", id: "echo" }] }).start();
	p.alias("memory", () => ({ provider: "mock", id: "echo" }));
	try {
		const call = (body: unknown, token = p.token) => fetch(`${p.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await call({ model: "memory", messages: [] }, "wrong")).status, 401);
		assert.equal((await fetch(`${p.baseUrl}/models`)).status, 401);
		const models = await (await fetch(`${p.baseUrl}/models`, { headers: { authorization: `Bearer ${p.token}` } })).json();
		assert.deepEqual(models.data.map((m: { id: string }) => m.id), ["memory", "mock/echo"]);
		const ok = await (await call({ model: "memory", messages: [{ role: "user", content: "Say 'ok'" }] })).json();
		assert.equal(ok.choices[0].message.content, "ok");
		// Hindsight 的事实抽取请求（JSON 模式）
		const ex = await (await call({ model: "mock/echo", response_format: { type: "json_object" }, messages: [{ role: "system", content: "Extract SIGNIFICANT facts from text." }, { role: "user", content: "Extract facts from the following chunk.\nContent:\n我叫张伟。喜欢简洁的回答。" }] })).json();
		const facts = JSON.parse(ex.choices[0].message.content).facts;
		assert.deepEqual(facts.map((f: { what: string }) => f.what), ["我叫张伟", "喜欢简洁的回答"]);
		const st = await call({ model: "memory", stream: true, messages: [{ role: "user", content: "Say 'ok'" }] });
		const sse = await st.text();
		assert.match(sse, /"content":"ok"/);
		assert.match(sse, /data: \[DONE\]/);
		assert.equal((await call({ model: "nope", messages: [] })).status, 400);
		assert.ok(p.stats.requests >= 3);
	} finally {
		await p.stop();
	}
});
