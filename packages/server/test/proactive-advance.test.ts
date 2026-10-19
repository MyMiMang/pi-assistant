/**
 * 主动推进的真实链路（Mock 模型 + 真实 Pi 会话 + 真实 runtime 扩展，不花钱、不联网、不碰用户凭据）：
 *  跟进 / 普通巡检发现「用户已经明确交代」的待办 → 模型调用 proactive_advance →
 *  相关对话的主会话真的做出无害、可核验的产物（工作区文件）→ 结果留在原会话；
 *  同一件事不重复推进（事件去重）；用户停止时清掉排队、不派发，也不影响别的对话。
 *
 * 边界同样被测：提示里写明“只做原授权内、需求不清先问、不扩大目标、停止/预算照旧”，
 * 系统准入（off / 去重 / 停止）不依赖模型自报的 authorized。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createConversation } from "../src/conversations.ts";
import { db, now, setSetting } from "../src/db.ts";
import { workspaceOf } from "../src/files.ts";
import { insertMessage } from "../src/messages.ts";
import { initModels, models } from "../src/models.ts";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "../src/pi-adapter/mock-provider.ts";
import { disposeConversationRuntime, runtime } from "../src/runtime.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";
import * as P from "../src/proactive.ts";

process.env.PIA_MOCK = "1";
await initModels(memoryCredentialStore());
await registerMockProvider(models);
setSetting("defaultModel", { provider: MOCK_PROVIDER, id: MOCK_MODEL });

const AGENT = "pv";
db.prepare("INSERT INTO agents(id, name, avatar, color, created_at, model_provider, model_id) VALUES(?,?,?,?,?,?,?)").run(AGENT, "推进助理", "P", "#000", now(), MOCK_PROVIDER, MOCK_MODEL);

const waitFor = async (fn: () => boolean, ms = 25_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return true;
		await new Promise((r) => setTimeout(r, 30));
	}
	return false;
};
const assistantTexts = (conversationId: string) =>
	(db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at").all(conversationId) as { content: string }[]).map((m) => m.content);

test("真实 Mock 链：跟进巡检发现明确待办 → proactive_advance → 相关对话做出可核验产物 → 结果留在原会话；重复不重复推进；停止只影响那个对话", async () => {
	const conv = createConversation(AGENT, "用户对话");
	P.saveProactive(AGENT, { level: "normal", cfg: { quiet: null } });
	insertMessage({ agentId: AGENT, conversationId: conv.id, role: "user", content: "整理季度报告核验清单，写入 proactive-advance.md，必须含数据核对、来源链接、结论检查三项，完成后汇报文件名" });

	// 跟进到点（可控触发，不依赖真实时钟）：心跳任务带着备注 + 可信 conversation id
	const note = "整理季度报告核验清单，写入proactive-advance.md，含数据核对、来源链接、结论检查";
	const runId = P.runHeartbeat(AGENT, "followup", { followup: { note, conversationId: conv.id, createdAt: now() } });
	assert.ok(runId, "跟进应该唤醒一次巡检");

	const advanced = await waitFor(() => P.listAdvances({ agentId: AGENT, conversationId: conv.id }).some((a) => a.status === "started" || a.status === "done"));
	assert.ok(advanced, `没有在相关对话里开始推进：${JSON.stringify(P.listAdvances({ agentId: AGENT }))}`);
	assert.ok(await waitFor(() => !runtime(AGENT, conv.id).busy), "相关对话这一轮应该自然结束");

	const row = P.listAdvances({ agentId: AGENT, conversationId: conv.id })[0];
	assert.match(row.text, /^（主动推进）/, "送进对话的是推进指令，不是一条提醒");
	assert.match(row.text, /不要只发一条提醒/);
	assert.match(row.text, /不要自行扩大目标/);
	// 相关对话里真的做了事（Mock 在推进时用 write 工具产出文件），结果留在原会话
	const artifact = join(workspaceOf(AGENT), "proactive-advance.md");
	assert.ok(existsSync(artifact), `相关对话没有真的做出产物：${artifact}`);
	const body = readFileSync(artifact, "utf8");
	for (const point of ["季度报告", "数据核对", "来源链接", "结论检查"]) assert.ok(body.includes(point), `真实产物缺少验收点：${point}`);
	const texts = assistantTexts(conv.id);
	assert.ok(texts.some((t) => /已按原授权完成/.test(t)), `原会话里没有结果：${texts.join("\n---\n").slice(0, 500)}`);
	const item = db.prepare("SELECT status, delivered_via FROM proactive_items WHERE id = ?").get(row.item_id!) as { status: string; delivered_via: string };
	assert.equal(item.status, "delivered");
	assert.equal(item.delivered_via, "advance-started");
	assert.equal(P.deliveredToday(AGENT), 0, "推进不占每日“提醒推送”预算");

	// 同一件事再来一次：事件去重，不会重复推进、不会多出回合
	const before = assistantTexts(conv.id).length;
	P.runHeartbeat(AGENT, "followup", { followup: { note, conversationId: conv.id, createdAt: now() } });
	await waitFor(() => !P.listAdvances({ agentId: AGENT }).some((a) => a.status === "queued"));
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(P.listAdvances({ agentId: AGENT, conversationId: conv.id }).length, 1, "同一件事只推进一次");
	assert.equal(assistantTexts(conv.id).length, before, "没有重复插回合");

	// 普通巡检也要推进（不只是跟进）：后台任务失败 = 明确的待办，带着可信 conversation id
	const conv3 = createConversation(AGENT, "失败任务对话");
	insertMessage({ agentId: AGENT, conversationId: conv3.id, role: "user", content: note });
	db.prepare("INSERT INTO subagents(id, agent_id, conversation_id, title, task, context, model_provider, model_id, model_reason, status, error_reason, last_activity_at, created_at, finished_at, kind) VALUES('t-checklist','pv',?,'整理季度报告核验清单','写入proactive-advance.md，含数据核对、来源链接、结论检查','','mock','echo','','failed','模拟本地执行中断',?,?,?,'task')").run(conv3.id, now() - 60_000, now() - 60_000, now() - 60_000);
	await waitFor(() => !db.prepare("SELECT 1 FROM proactive_runs WHERE agent_id = ? AND status = 'running'").get(AGENT));
	assert.ok(P.runHeartbeat(AGENT, "heartbeat"), "普通巡检应该唤醒一次");
	assert.ok(await waitFor(() => P.listAdvances({ agentId: AGENT, conversationId: conv3.id }).length === 1), "普通巡检没有推进明确待办");
	assert.ok(await waitFor(() => !runtime(AGENT, conv3.id).busy), "推进这一轮应该自然结束");
	assert.ok(await waitFor(() => assistantTexts(conv3.id).some((t) => /已按原授权完成/.test(t))), "普通巡检推进的结果没有留在相关对话");

	// 用户停止：另一条对话正忙时排队的推进被取消，不再派发；这条对话已完成的结果不受影响
	const conv2 = createConversation(AGENT, "另一个对话");
	void runtime(AGENT, conv2.id).send("慢慢数到 5");
	assert.ok(await waitFor(() => runtime(AGENT, conv2.id).busy, 10_000), "另一个对话进入忙状态");
	const q = await P.advanceConversation(AGENT, { conversationId: conv2.id, kind: "reminder", title: "另一件事", body: "把清单整理好", importance: 3, dedupeKey: "iso:1" });
	assert.equal(q.status, "queued");
	await runtime(AGENT, conv2.id).abort();
	assert.equal(P.listAdvances({ agentId: AGENT, conversationId: conv2.id, status: "queued" }).length, 0, "真实runtime.abort清掉这个对话的排队，不依赖手调辅助函数");
	assert.equal(P.listAdvances({ agentId: AGENT, conversationId: conv.id }).length, 1, "别的对话的推进不受影响");
	await runtime(AGENT, conv2.id).abort().catch(() => {});
	await waitFor(() => !runtime(AGENT, conv2.id).busy);
	P.drainAdvances(AGENT, conv2.id);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(assistantTexts(conv2.id).filter((t) => /已按原授权完成/.test(t)).length, 0, "停止后没有再推进");
});

test("删除尚未装载runtime的会话也取消持久推进，不牵连别的会话", async () => {
	const closing = createConversation(AGENT, "准备删除");
	const other = createConversation(AGENT, "保留对话");
	P.setAdvanceHooks({ busy: () => true, send: async () => "none" });
	try {
		for (const conversationId of [closing.id, other.id]) {
			const r = await P.advanceConversation(AGENT, { conversationId, kind: "followup", title: "核对清单", body: "延后处理", importance: 3, dedupeKey: `delete:${conversationId}` });
			assert.equal(r.status, "queued");
		}
		await disposeConversationRuntime(closing.id);
		assert.equal(P.listAdvances({ conversationId: closing.id, status: "queued" }).length, 0);
		assert.equal(P.listAdvances({ conversationId: closing.id, status: "cancelled" }).length, 1);
		assert.equal(P.listAdvances({ conversationId: other.id, status: "queued" }).length, 1);
	} finally {
		P.cancelAdvances(AGENT, other.id);
		P.setAdvanceHooks(null);
	}
});
