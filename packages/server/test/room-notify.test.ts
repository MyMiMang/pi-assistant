/**
 * 进度通知、关键点确认与交付卡（docs/design/group-team.md §6–9，决策 0019 第 5 步）：
 * newlyDoneStages / stageDoneReason 是纯函数；阶段完成只通知一次、room_checkpoint、room_project_done 交付卡、任务通知带 projectId 是集成测试。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALL_DONE_MARK, newlyDoneStages, projectProgress, stageDoneReason } from "../src/rooms/progress.ts";
import type { ProjectPlan } from "../src/rooms/plan.ts";
import type { WorkItemSummary, WorkStatus } from "../src/work-items.ts";

const { db, now } = await import("../src/db.ts");
const R = await import("../src/runtime.ts");
const rooms = await import("../src/rooms/index.ts");
const projects = await import("../src/rooms/projects.ts");
const { projectTools } = await import("../src/rooms/project-tools.ts");
const { workspaceOf } = await import("../src/files.ts");
const { requests } = await import("../src/requests.ts");
const W = await import("../src/work-items.ts");

// ---------------------------------------------------------------- 纯函数

function item(o: Partial<WorkItemSummary> & { id: string; title: string; status: WorkStatus }): WorkItemSummary {
	return {
		roomId: "r", projectId: "p", ownerAgentId: "a", ownerName: "甲", latestProgress: "", blocker: null, needsUser: null, escalation: null,
		revision: 1, autoRetries: 0, updatedAt: 0, createdAt: 0, runState: "none", board: "doing", boardLabel: "进行中", dependsOn: [], stage: null,
		statusLabel: o.status, ...o,
	};
}
const plan = (names: string[]): ProjectPlan => ({ goal: "g", doneCriteria: "d", assumptions: [], roles: [], stages: names.map((name) => ({ name, output: "" })), checkpoints: ["草稿方向"], deliverables: "x", needs: "", scale: "" });

test("newlyDoneStages：只给刚完成、还没通知过的阶段；全部完成只报一次；有阶段外没做完的任务不算全部完成", () => {
	const items = [item({ id: "1", title: "a", status: "done", stage: "准备" }), item({ id: "2", title: "b", status: "active", stage: "完成" })];
	const p1 = projectProgress(plan(["准备", "完成"]), items);
	assert.deepEqual(newlyDoneStages(p1, []), { names: ["准备"], allDone: false });
	assert.deepEqual(newlyDoneStages(p1, ["准备"]), { names: [], allDone: false }, "通知过的不再通知");
	const p2 = projectProgress(plan(["准备", "完成"]), [items[0], item({ id: "2", title: "b", status: "done", stage: "完成" })]);
	assert.deepEqual(newlyDoneStages(p2, ["准备"]), { names: ["完成"], allDone: true });
	assert.deepEqual(newlyDoneStages(p2, ["准备", "完成", ALL_DONE_MARK]), { names: [], allDone: false }, "全部完成也只通知一次");
	const p3 = projectProgress(plan(["准备"]), [items[0], item({ id: "9", title: "杂项", status: "active", stage: null })]);
	assert.equal(newlyDoneStages(p3, []).allDone, false, "方案外还有没做完的任务，不算全部完成");
	assert.deepEqual(newlyDoneStages(projectProgress(plan([]), [items[0]]), []), { names: [], allDone: false }, "没有阶段不通知");
});

test("stageDoneReason：阶段完成是通知不是提问，有关键点时提示先走 room_checkpoint；全部完成提示核对完成标准并交付；都不提花费", () => {
	const stage = stageDoneReason({ title: "报告", projectId: "pj_1", names: ["草稿"], allDone: false, checkpoints: ["草稿方向"] });
	assert.match(stage, /项目「报告」（项目编号 pj_1）的阶段「草稿」完成了/);
	assert.match(stage, /这是通知，不是提问/);
	assert.match(stage, /关键点（草稿方向）[\s\S]*room_checkpoint/);
	assert.doesNotMatch(stageDoneReason({ title: "报告", projectId: "pj_1", names: ["草稿"], allDone: false, checkpoints: [] }), /room_checkpoint/);
	const all = stageDoneReason({ title: "报告", projectId: "pj_1", names: ["定稿"], allDone: true, checkpoints: ["草稿方向"] });
	assert.match(all, /所有阶段都完成了[\s\S]*room_project_done/);
	assert.doesNotMatch(`${stage}${all}`, /花费|费用|多少钱|成本/);
});

// ---------------------------------------------------------------- 集成

const prompts: string[] = [];
const proto = Object.getPrototypeOf(R.runtime("nm", "conv_probe")) as Record<string, unknown>;
proto.turn = async function (this: { id: string; conversationId: string }, prompt: string) {
	if (W.execOf(this.conversationId)) return new Promise(() => {});
	if (this.id === "nm") prompts.push(prompt);
	return { ok: true, aborted: false, text: "", tokens: 0 };
};
proto.abort = async () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, what: string, ms = 3000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await sleep(10);
	}
	throw new Error(`${what}超时`);
};
const idle = (roomId: string) => !rooms.stateOf(roomId).running;
for (const [id, name] of [["nm", "组长"], ["na", "甲"]]) db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#111", now());

function toolsOf(roomId: string, agentId: string) {
	const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
	projectTools(roomId, agentId)({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
	return (name: string, p: Record<string, unknown>) => defs.get(name)!.execute("t", p).then((r) => r.content[0].text);
}
const fullPlan = () => ({
	title: "写报告", goal: "写一份报告", doneCriteria: "报告有结论", assumptions: [],
	roles: [{ member: "组长", does: "统筹" }, { member: "甲", does: "撰写" }],
	stages: [{ name: "草稿", output: "初稿" }, { name: "定稿", output: "终稿" }],
	checkpoints: ["草稿出来后看方向"], deliverables: "report.md",
});
const metaOf = (roomId: string, where: string) => (db.prepare(`SELECT meta FROM messages WHERE room_id = ? AND ${where} ORDER BY rowid DESC LIMIT 1`).get(roomId) as { meta: string } | undefined)?.meta;

/** 建群 + 进行中的项目 + 每个阶段一个任务（待核验状态，直接用 verifyWorkItem 通过） */
async function setup(name: string) {
	const room = rooms.createRoom({ name, memberIds: ["nm", "na"], managerId: "nm" });
	const call = toolsOf(room.id, "nm");
	await call("room_plan", fullPlan());
	const pid = projects.projectsOf(room.id)[0].id;
	projects.confirmProject(room.id, pid, "manager");
	await until(() => idle(room.id), "开始后的唤醒跑完");
	const mk = (title: string, stage: string) => {
		const id = W.createWorkItem({ roomId: room.id, title, requirement: "写", doneCriteria: "有结果", ownerAgentId: "na", start: false, projectId: pid, stage }, { kind: "user" }).item.id;
		db.prepare("UPDATE work_items SET status = 'review' WHERE id = ?").run(id);
		return id;
	};
	return { room, pid, call, wi1: mk("写初稿", "草稿"), wi2: mk("写终稿", "定稿") };
}
const pass = (id: string) => W.verifyWorkItem({ workItemId: id, actor: { kind: "user" }, verdict: "pass", note: "看过了，符合" });
const reasonsOf = () => prompts.filter((p) => p.includes("唤醒原因："));

test("阶段完成：核验通过后叫醒管理者一次（含项目编号和阶段名），同一阶段不重复通知；最后一个阶段换成「所有阶段都完成了」；任务通知带 projectId", async () => {
	const { room, pid, wi1, wi2 } = await setup("阶段群");
	prompts.length = 0;
	await pass(wi1);
	await until(() => idle(room.id) && reasonsOf().some((p) => p.includes("的阶段「草稿」完成了")), "阶段通知");
	const first = reasonsOf().find((p) => p.includes("的阶段「草稿」完成了"))!;
	assert.match(first, new RegExp(`项目编号 ${pid}`));
	assert.match(first, /关键点（草稿出来后看方向）/);
	const n = reasonsOf().length;
	const { stageMaybeDone } = await import("../src/rooms/stages.ts");
	stageMaybeDone(pid);
	await sleep(100);
	assert.equal(reasonsOf().length, n, "同一阶段不重复通知");
	assert.deepEqual(JSON.parse(projects.getProject(pid)!.stages_done!), ["草稿"]);
	await pass(wi2);
	await until(() => reasonsOf().some((p) => p.includes("所有阶段都完成了")), "全部完成通知");
	assert.ok(!reasonsOf().some((p) => p.includes("的阶段「定稿」完成了")), "最后一个阶段只发「所有阶段都完成了」");
	// 任务相关的系统通知带 projectId（界面按项目筛选）
	const meta = JSON.parse(metaOf(room.id, `role = 'system' AND content LIKE '任务「写初稿」核验通过%'`)!);
	assert.equal(meta.projectId, pid);
	assert.equal(meta.workItemId, wi1);
	await until(() => idle(room.id), "跑完");
	await projects.finishProject(room.id, pid, "测试结束");
	await rooms.deleteRoom(room.id);
});

test("room_checkpoint：出提问卡（带项目、关键点）、设 waiting；用户答复后清掉并把答复发到群里叫醒管理者；同一项目同时只有一个", async () => {
	const { room, pid, call } = await setup("关键点群");
	writeFileSync(join(workspaceOf("nm"), "draft.md"), "# 草稿\n");
	assert.match(await toolsOf(room.id, "na")("room_checkpoint", { projectId: pid, checkpoint: "x", message: "y" }), /只有管理者/);
	assert.match(await call("room_checkpoint", { projectId: pid, checkpoint: "", message: "y" }), /写清是哪个关键点/);
	assert.match(await call("room_checkpoint", { projectId: pid, checkpoint: "草稿方向", message: "看看", files: ["不存在.md"] }), /找不到这些文件：不存在\.md/);
	assert.equal(projects.projectJson(projects.getProject(pid)!).waiting, null, "失败不留 waiting");
	const out = await call("room_checkpoint", { projectId: pid, checkpoint: "草稿方向", message: "草稿出来了，先看方向对不对", options: ["方向 A", "方向 B"], files: ["draft.md"] });
	assert.match(out, /已请用户看。不受这个关键点影响的任务照常推进/);
	const w = projects.projectJson(projects.getProject(pid)!).waiting!;
	assert.equal(w.checkpoint, "草稿方向");
	assert.deepEqual(w.options, ["方向 A", "方向 B"]);
	const card = JSON.parse(metaOf(room.id, `role = 'card' AND json_extract(meta, '$.requestId') = '${w.requestId}'`)!);
	assert.equal(card.kind, "question");
	assert.equal(card.projectId, pid);
	assert.match(card.question, /^关键点：草稿方向\n草稿出来了/);
	assert.deepEqual(card.options, ["方向 A", "方向 B"]);
	const att = JSON.parse(metaOf(room.id, `role = 'assistant' AND meta LIKE '%draft.md%'`)!);
	assert.equal(att.projectId, pid, "附上的文件消息也标明项目");
	assert.equal(att.attachments[0].name, "draft.md");
	assert.match(await call("room_checkpoint", { projectId: pid, checkpoint: "另一个", message: "z" }), /已经有一个关键点「草稿方向」在等用户看了/);
	// 停群不撤回要用户看的卡片
	await rooms.stop(room.id);
	assert.equal((db.prepare("SELECT status FROM requests WHERE id = ?").get(w.requestId) as { status: string }).status, "pending");
	prompts.length = 0;
	requests.resolve(w.requestId, { answer: "方向 B" }, "user");
	await until(() => projects.projectJson(projects.getProject(pid)!).waiting === null, "waiting 清掉");
	const said = db.prepare("SELECT content FROM messages WHERE room_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1").get(room.id) as { content: string };
	assert.equal(said.content, "关于关键点「草稿方向」：方向 B");
	await until(() => prompts.some((p) => p.includes("关于关键点「草稿方向」：方向 B")), "管理者按答复被叫醒");
	await until(() => idle(room.id), "跑完");
	await projects.finishProject(room.id, pid, "测试结束");
	await rooms.deleteRoom(room.id);
});

test("room_checkpoint：项目停下时清掉 waiting 并收掉卡片；系统收尾不算用户答复", async () => {
	const { room, pid, call } = await setup("停下群");
	await call("room_checkpoint", { projectId: pid, checkpoint: "方向", message: "看看" });
	const w = projects.projectJson(projects.getProject(pid)!).waiting!;
	assert.deepEqual(w.options, ["可以，继续", "要改"], "不给选项就是默认两项");
	await projects.stopProject(room.id, pid);
	assert.equal(projects.projectJson(projects.getProject(pid)!).waiting, null);
	assert.equal((db.prepare("SELECT status FROM requests WHERE id = ?").get(w.requestId) as { status: string }).status, "answered");
	await sleep(50);
	assert.ok(!db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND role = 'user' AND content LIKE '关于关键点%'").get(room.id), "系统收尾不往群里发用户的话");
	await until(() => idle(room.id), "跑完");
	await rooms.deleteRoom(room.id);
});

test("room_project_done：交付卡带做成了什么 / 文件 / 怎么用 / 还没做的；群里已有的文件不重复登记；找不到文件就不结束；系统通知精简成一句，不提花费", async () => {
	const { room, pid, call } = await setup("交付群");
	writeFileSync(join(workspaceOf("nm"), "report.md"), "# 报告\n");
	assert.match(await toolsOf(room.id, "na")("room_project_done", { projectId: pid, summary: "x" }), /只有管理者/);
	assert.match(await call("room_project_done", { projectId: pid, summary: "做完了", deliverables: ["没有这个.md"] }), /没有结束项目：找不到这些文件：没有这个\.md/);
	assert.equal(projects.getProject(pid)!.status, "active", "文件找不到就不结束项目");
	// 先把文件发到群里（检查点附件），交付时按名字找到，不再登记第二份
	await call("room_checkpoint", { projectId: pid, checkpoint: "方向", message: "看看", files: ["report.md"] });
	const before = (db.prepare("SELECT COUNT(*) AS n FROM files WHERE name = 'report.md'").get() as { n: number }).n;
	assert.match(await call("room_project_done", { projectId: pid, summary: "报告写好了，三节齐全", deliverables: ["report.md"], howToUse: "打开 report.md 看", notDone: "图表还没做" }), /项目「写报告」已结束，交付卡已发到群里/);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM files WHERE name = 'report.md'").get() as { n: number }).n, before, "群里已有的文件不重复登记");
	const card = JSON.parse(metaOf(room.id, `role = 'card' AND json_extract(meta, '$.kind') = 'project-delivery'`)!);
	assert.equal(card.projectId, pid);
	assert.equal(card.title, "写报告");
	assert.equal(card.summary, "报告写好了，三节齐全");
	assert.equal(card.howToUse, "打开 report.md 看");
	assert.equal(card.notDone, "图表还没做");
	assert.equal(card.files.length, 1);
	assert.equal(card.files[0].name, "report.md");
	assert.ok(card.files[0].fileId);
	assert.equal(card.files[0].mime, "text/markdown", "文件信息和群里文件附件同一形状（fileInfo）");
	assert.ok(card.files[0].size > 0);
	const notice = db.prepare("SELECT content FROM messages WHERE room_id = ? AND meta LIKE '%room-project%' ORDER BY rowid DESC LIMIT 1").get(room.id) as { content: string };
	assert.equal(notice.content, "项目「写报告」已完成，成果见下面的交付卡。");
	assert.doesNotMatch(JSON.stringify(card) + notice.content, /花费|费用|多少钱|成本/);
	assert.equal(projects.projectJson(projects.getProject(pid)!).waiting, null, "项目结束清掉 waiting");
	await until(() => idle(room.id), "跑完");
	await rooms.deleteRoom(room.id);
});
