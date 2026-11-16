import "./setup.ts";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Hono } from "hono";
import { recentPersonaMessages, personaReviewPrompt, parsePersonaReview, PERSONA_REVIEW_SYSTEM } from "../src/persona-review.ts";
import { mountPersonaReviewRoutes } from "../src/routes/persona-review.ts";
import type { Env } from "../src/routes/common.ts";
import { db, now, setSetting } from "../src/db.ts";
import { initModels, models } from "../src/models.ts";
import { registerMockProvider, resetMockStats, mockStats } from "../src/pi-adapter/mock-provider.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";
import { createConversation } from "../src/conversations.ts";
import { insertMessage } from "../src/messages.ts";

const app = new Hono<Env>();
mountPersonaReviewRoutes(app);
const request = (id: string) => app.request(`/api/agents/${id}/persona-review`, { method: "POST" });
function agent(id: string, provider = "mock", model = "echo") {
	db.prepare("INSERT INTO agents(id,name,avatar,color,persona,model_provider,model_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, id, "🤖", "#fff", "保留原有要求。", provider, model, now());
	return createConversation(id);
}
before(async () => {
	await initModels(memoryCredentialStore());
	await registerMockProvider(models);
	setSetting("defaultModel", { provider: "mock", id: "echo" });
});

test("裁剪取最近80条，按时间与同毫秒序号还原顺序，过滤群/任务/工具", () => {
	const rows = Array.from({ length: 100 }, (_, seq) => ({ role: seq % 2 ? "user" : "assistant", content: String(seq), created_at: 1, seq }));
	const result = recentPersonaMessages([...rows, ...["tool", "system", "card"].map(role => ({ role, content: "不能取", created_at: 2 })), { role: "user", content: "群", created_at: 3, room_id: "r" }, { role: "assistant", content: "任务", created_at: 3, task_id: "t" }, { role: "assistant", content: "帮手", created_at: 3, subagent_id: "s" }]);
	assert.equal(result.length, 80);
	assert.equal(result[0].content, "20");
	assert.equal(result.at(-1)!.content, "99");
});
test("总字数不超过30000；跨消息预算和单条超长保留最近尾部", () => {
	assert.deepEqual(recentPersonaMessages([{ role: "user", content: "旧".repeat(20000), created_at: 1 }, { role: "assistant", content: "新".repeat(20000), created_at: 2 }]).map(m => m.content.length), [10000, 20000]);
	const result = recentPersonaMessages([{ role: "user", content: "旧".repeat(30001) + "尾", created_at: 1 }]);
	assert.equal(result[0].content.length, 30000);
	assert.ok(result[0].content.endsWith("尾"));
	assert.deepEqual(recentPersonaMessages([]), []);
});
test("提示词保留当前人设和用户/助理角色，规定只整理长期做事要求", () => {
	assert.deepEqual(JSON.parse(personaReviewPrompt("原人设", [{ role: "user", content: "要求", created_at: 1 }])), { persona: "原人设", messages: [{ role: "user", content: "要求" }] });
	for (const word of ["反复", "明确纠正", "个人事实", "一次性任务", "原样保留", "不编造"]) assert.ok(PERSONA_REVIEW_SYSTEM.includes(word));
});
test("JSON解析容忍代码围栏；无改动保持原文；坏结构与超长返回中文错", () => {
	const good = { persona: "新", changes: ["增加格式要求"] };
	for (const text of [JSON.stringify(good), `\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``, `\`\`\`\n${JSON.stringify(good)}\n\`\`\``]) assert.deepEqual(parsePersonaReview(text, "原"), good);
	assert.deepEqual(parsePersonaReview('{"persona":"模型误改","changes":[]}', "原"), { persona: "原", changes: [] });
	for (const text of ["没有JSON", "null", "[]", '{"persona":3,"changes":[]}', '{"persona":"新","changes":[1]}', '{"persona":"","changes":["改动"]}', JSON.stringify({ persona: "字".repeat(8001), changes: ["过长"] })]) assert.throws(() => parsePersonaReview(text, "原"), /没能读懂整理结果/);
});
test("接口找不到助理404", async () => { assert.equal((await request("missing")).status, 404); });
test("模型不可用不切默认模型，本机渠道复用现有中文错", async () => {
	for (const [id, provider, pattern] of [["missing-api", "gone", /选择的模型不可用/], ["missing-cli", "claude-code", /暂时没连上.*没有改用其他模型/]] as const) {
		agent(id, provider, "missing");
		resetMockStats();
		const res = await request(id);
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, pattern);
		assert.equal(mockStats.steps, 0);
	}
});
test("接口无补充返回原人设", async () => {
	agent("review-no-change");
	const res = await request("review-no-change");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { persona: "保留原有要求。", changes: [] });
});
test("接口使用助理指定模型，补全错误及无效JSON可见且不写库", async (t) => {
	agent("review-failure", "mock", "echo-think");
	let invalid = false;
	t.mock.method(models, "complete", async (provider: string, model: string) => {
		assert.equal(provider, "mock");
		assert.equal(model, "echo-think");
		return { text: invalid ? "不是JSON" : "", stopReason: invalid ? "stop" : "error", error: invalid ? undefined : "模型暂时无法完成请求", toolCalls: [], usage: { input: 0, output: 0 } };
	});
	for (const pattern of [/模型暂时无法完成请求/, /没能读懂整理结果/]) {
		const res = await request("review-failure");
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, pattern);
		invalid = true;
	}
	assert.equal((db.prepare("SELECT persona FROM agents WHERE id = ?").get("review-failure") as { persona: string }).persona, "保留原有要求。");
});
test("接口只取自己可见单聊，调用一次自己的模型，返回不写库", async () => {
	const conv = agent("review-success", "mock", "echo-think");
	insertMessage({ agentId: "review-success", conversationId: conv.id, role: "user", content: "请简洁回答，先说结论。这是明确纠正。" });
	insertMessage({ agentId: "review-success", conversationId: conv.id, role: "assistant", content: "收到。" });
	const hidden = createConversation("review-success", "隐藏", { makeCurrent: false });
	db.prepare("UPDATE conversations SET hidden = 1 WHERE id = ?").run(hidden.id);
	insertMessage({ agentId: "review-success", conversationId: hidden.id, role: "user", content: "隐藏对话不能取" });
	insertMessage({ agentId: "review-success", conversationId: conv.id, roomId: "room", role: "user", content: "群聊不能取" });
	insertMessage({ agentId: "review-success", conversationId: conv.id, subagentId: "helper", role: "assistant", content: "帮手不能取" });
	const other = agent("review-other");
	insertMessage({ agentId: "review-other", conversationId: other.id, role: "user", content: "别的助理不能取" });
	resetMockStats();
	const res = await request("review-success");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { persona: "保留原有要求。\n回答先说结论，再简洁说明。", changes: ["补充了先说结论、简洁说明的要求"] });
	assert.equal(mockStats.steps, 1);
	const prompt = JSON.parse(mockStats.lastUserText);
	assert.deepEqual(prompt.messages.map((m: { content: string }) => m.content), ["请简洁回答，先说结论。这是明确纠正。", "收到。"]);
	assert.equal((db.prepare("SELECT persona FROM agents WHERE id = ?").get("review-success") as { persona: string }).persona, "保留原有要求。");
});
