import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERJECTION_RULE, isStopCommand } from "../src/interject.ts";
import { createConversation } from "../src/conversations.ts";
import { db, now, setSetting } from "../src/db.ts";
import { getMessage, insertMessage } from "../src/messages.ts";
import { initModels, models } from "../src/models.ts";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "../src/pi-adapter/mock-provider.ts";
import { disposeConversationRuntime, runtime } from "../src/runtime.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

process.env.PIA_MOCK = "1";
await initModels(memoryCredentialStore());
await registerMockProvider(models);
setSetting("defaultModel", { provider: MOCK_PROVIDER, id: MOCK_MODEL });
const AGENT = "interject-reply";
db.prepare("INSERT INTO agents(id, name, avatar, color, created_at, model_provider, model_id) VALUES(?,?,?,?,?,?,?)")
	.run(AGENT, "提问助理", "Q", "#000", now(), MOCK_PROVIDER, MOCK_MODEL);

const waitFor = async (fn: () => boolean) => {
	const end = Date.now() + 10_000;
	while (!fn()) {
		if (Date.now() > end) throw new Error("等待条件超时");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};

test("停止指令：整条消息就是停止词才算", () => {
	for (const t of ["停", "停止", "停下。", "别做了", "不用做了！", "取消", "算了吧", "stop", "/stop", "STOP!", " 先停下 ", "请停止"]) assert.equal(isStopCommand(t), true, t);
	for (const t of ["停止这个服务", "帮我取消明天的会议", "不要停", "stop the server", "", "停车场在哪", "继续"]) assert.equal(isStopCommand(t), false, t);
});
test("系统提示里有插话处理规则", () => {
	assert.match(INTERJECTION_RULE, /你工作时用户发来的新消息/);
	assert.match(INTERJECTION_RULE, /停/);
});

test("等待自由输入提问时，文字直接回答，不新增插话排队", async () => {
	const conv = createConversation(AGENT, "自由输入回答");
	const r = runtime(AGENT, conv.id);
	try {
		assert.equal(await r.send("问我一个问题"), "started");
		const pending = () => db.prepare("SELECT id FROM requests WHERE conversation_id = ? AND kind = 'question' AND status = 'pending' AND task_id IS NULL AND json_extract(payload, '$.allowFreeText') = 1").get(conv.id) as { id: string } | undefined;
		await waitFor(() => r.busy && !!pending());
		const id = pending()!.id;
		const text = "先整理邮件";
		const msg = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: text });
		const queued = r.session!.getSteeringMessages().length;
		assert.equal(await r.send(text, [], { messageId: msg.id }), "steered");
		assert.deepEqual({ ...db.prepare("SELECT status, answer, resolved_by FROM requests WHERE id = ?").get(id) },  { status: "answered", answer: text, resolved_by: "user" });
		assert.equal(r.session!.getSteeringMessages().length, queued);
		assert.equal(r.recallSteering(msg.id), false);
		assert.equal(getMessage(msg.id)!.meta.delivery, "delivered");
		assert.equal(typeof getMessage(msg.id)!.meta.deliveredAt, "number");
	} finally {
		await disposeConversationRuntime(conv.id);
	}
});

test("等待审批卡时，文字仍然走插话，不回答审批", async () => {
	const conv = createConversation(AGENT, "审批不变");
	const r = runtime(AGENT, conv.id);
	try {
		assert.equal(await r.send("慢慢数"), "started");
		await waitFor(() => r.busy);
		// 复用 Mock 的慢任务制造忙会话，直接插入审批记录，不修改 Mock。
		const id = "interject-approval";
		db.prepare("INSERT INTO requests(id, agent_id, conversation_id, task_id, kind, payload, status, created_at) VALUES(?,?,?,NULL,'approval',?,'pending',?)")
			.run(id, AGENT, conv.id, JSON.stringify({ summary: "等待批准" }), now());
		const msg = insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "继续整理" });
		const queued = r.session!.getSteeringMessages().length;
		assert.equal(await r.send("继续整理", [], { messageId: msg.id }), "steered");
		assert.deepEqual({ ...db.prepare("SELECT status, answer FROM requests WHERE id = ?").get(id) },  { status: "pending", answer: null });
		assert.equal(r.session!.getSteeringMessages().length, queued + 1);
		assert.equal(getMessage(msg.id)!.meta.delivery, "queued");
	} finally {
		await disposeConversationRuntime(conv.id);
	}
});
