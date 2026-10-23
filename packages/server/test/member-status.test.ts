/** 前端纯逻辑：助理工作状态（apps/web/src/member-status.ts），群成员条和单聊顶部共用。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentActivity, memberActivity, pendingCardOf, roomSummary, type HelperBrief } from "../../../apps/web/src/member-status.ts";

const helper = (agentId: string, title: string, status = "running", kind = "work"): HelperBrief => ({ agentId, kind, title, status, live: ["running", "stalled", "queued"].includes(status) });
const base = { current: null, queue: [] as string[], helpers: [] as HelperBrief[] };

test("群成员：说话中按回合原因写在做什么，排队、空闲分开", () => {
	assert.deepEqual(memberActivity({ ...base, agentId: "a", current: { agentId: "a", reason: "mention" } }), { state: "work", text: "在群里回复" });
	assert.equal(memberActivity({ ...base, agentId: "a", current: { agentId: "a", reason: "followup" } }).text, "在总结");
	assert.equal(memberActivity({ ...base, agentId: "a", current: { agentId: "a", reason: "check" } }).text, "在看任务进度");
	assert.deepEqual(memberActivity({ ...base, agentId: "b", current: { agentId: "a", reason: "mention" }, queue: ["b"] }), { state: "work", text: "排队等发言" });
	assert.deepEqual(memberActivity({ ...base, agentId: "c", current: { agentId: "a", reason: "mention" }, queue: ["b"] }), { state: "idle", text: "空闲" });
});

test("群成员：帮手在做群任务时写任务名（去掉「任务：」前缀），结束的帮手不算", () => {
	assert.deepEqual(memberActivity({ ...base, agentId: "a", helpers: [helper("a", "任务：写分镜脚本")] }), { state: "work", text: "做任务「写分镜脚本」" });
	assert.equal(memberActivity({ ...base, agentId: "a", helpers: [helper("a", "查资料", "running", "subagent")] }).text, "帮手在做「查资料」");
	assert.equal(memberActivity({ ...base, agentId: "a", helpers: [helper("a", "任务：剪片", "queued")] }).text, "任务「剪片」排队中");
	assert.equal(memberActivity({ ...base, agentId: "a", helpers: [helper("a", "任务：剪片", "done")] }).state, "idle");
	assert.equal(memberActivity({ ...base, agentId: "a", helpers: [helper("b", "任务：剪片")] }).state, "idle", "别人的帮手不算");
	// 在跑的优先于排队的；群里说话优先于帮手
	assert.equal(memberActivity({ ...base, agentId: "a", helpers: [helper("a", "任务：A", "queued"), helper("a", "任务：B")] }).text, "做任务「B」");
	assert.equal(memberActivity({ ...base, agentId: "a", current: { agentId: "a", reason: "mention" }, helpers: [helper("a", "任务：B")] }).text, "在群里回复");
});

test("等你最优先：有没处理的审批 / 提问卡就是等你", () => {
	const list = [
		{ role: "card", agent_id: "a", meta: { kind: "approval", status: "done" } },
		{ role: "card", agent_id: "a", meta: { kind: "question", status: "pending" } },
		{ role: "card", agent_id: "b", meta: { kind: "subagent", status: "pending" } },
	];
	assert.equal(pendingCardOf(list, "a"), "question");
	assert.equal(pendingCardOf(list, "b"), undefined, "别的卡片不算");
	assert.deepEqual(memberActivity({ ...base, agentId: "a", current: { agentId: "a", reason: "mention" }, pending: "approval" }), { state: "wait", text: "等你审批" });
});

test("群总状态：等你 > 在干活 > 都停下了（带最后动静时间）", () => {
	const work = { state: "work" as const, text: "" }, wait = { state: "wait" as const, text: "" }, idle = { state: "idle" as const, text: "" };
	assert.deepEqual(roomSummary([work, wait, idle]), { state: "wait", text: "1 人等你 · 1 人在干活" });
	assert.deepEqual(roomSummary([wait, idle]), { state: "wait", text: "1 人等你" });
	assert.deepEqual(roomSummary([work, work, idle]), { state: "work", text: "2 人在干活" });
	assert.deepEqual(roomSummary([idle, idle], "3 分钟前"), { state: "idle", text: "都停下了 · 3 分钟前" });
	assert.deepEqual(roomSummary([]), { state: "idle", text: "都停下了" });
});

test("单聊：主会话在跑 / 帮手在做 / 等你 / 空闲", () => {
	assert.deepEqual(agentActivity({ running: true, helpers: [] }), { state: "work", text: "正在工作" });
	assert.deepEqual(agentActivity({ running: false, helpers: [helper("a", "整理周报", "running", "task")] }), { state: "work", text: "帮手在做「整理周报」" });
	assert.equal(agentActivity({ running: false, helpers: [helper("a", "A", "running", "task"), helper("a", "B", "queued", "task")] }).text, "2 个帮手在做");
	assert.deepEqual(agentActivity({ running: true, pending: "approval", helpers: [] }), { state: "wait", text: "等你审批" });
	assert.deepEqual(agentActivity({ running: false, helpers: [helper("a", "A", "failed", "task")] }), { state: "idle", text: "空闲" });
});
