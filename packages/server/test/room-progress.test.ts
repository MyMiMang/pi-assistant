/**
 * 项目进度清单与项目级进度检查（docs/design/group-team.md §4、§6；决策 0019 第 3 步）：
 * projectProgress / renderProgress / projectStallStep 是纯函数；checkProjectStall / resumeProject 是集成测试。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectProgress, projectStallStep, renderProgress } from "../src/rooms/progress.ts";
import type { ProjectPlan } from "../src/rooms/plan.ts";
import type { WorkItemSummary, WorkStatus } from "../src/work-items.ts";

process.env.PIA_MOCK = "1";
const { db, now } = await import("../src/db.ts");
const { memoryCredentialStore } = await import("./in-memory-credentials.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore()); // 只用内存凭据：resumeProject 集成测试要真的派一次活，帮手按 mock 模型登记
const R = await import("../src/runtime.ts");
const rooms = await import("../src/rooms/index.ts");
const projects = await import("../src/rooms/projects.ts");
const { projectTools } = await import("../src/rooms/project-tools.ts");
const W = await import("../src/work-items.ts");

// ---------------------------------------------------------------- 纯函数

function item(o: Partial<WorkItemSummary> & { id: string; title: string; status: WorkStatus }): WorkItemSummary {
	return {
		roomId: "r", projectId: "p", ownerAgentId: "a", ownerName: "甲", latestProgress: "", blocker: null, needsUser: null, escalation: null,
		revision: 1, autoRetries: 0, updatedAt: 0, createdAt: 0, runState: "none", board: "doing", boardLabel: "进行中", dependsOn: [], stage: null,
		statusLabel: o.status, ...o,
	};
}
const plan = (stages: { name: string; output: string }[]): ProjectPlan => ({ goal: "g", doneCriteria: "d", assumptions: [], roles: [], stages, checkpoints: [], deliverables: "x", needs: "", scale: "" });

test("projectProgress：按阶段分组，阶段状态按里面任务算，没写 stage 或对不上进 other", () => {
	const items = [
		item({ id: "1", title: "草稿", status: "done", stage: "准备" }),
		item({ id: "2", title: "定稿", status: "active", stage: "完成", dependsOn: [{ id: "1", title: "草稿", status: "done", statusLabel: "已完成" }] }),
		item({ id: "3", title: "杂项", status: "pending", stage: null }),
		item({ id: "4", title: "已取消的", status: "cancelled", stage: "完成" }),
	];
	const p = projectProgress(plan([{ name: "准备", output: "草稿" }, { name: "完成", output: "定稿" }]), items);
	assert.equal(p.total, 3, "已取消的不计入 total");
	assert.equal(p.done, 1);
	assert.deepEqual(p.stages.map((s) => s.state), ["done", "doing"]);
	assert.equal(p.stages[1].items[0].waitingFor.length, 0, "前置已完成，不在等谁");
	assert.deepEqual(p.other.map((x) => x.id), ["3"]);
	assert.equal(p.currentStage, 1, "第一个没完成的阶段下标");
});

test("projectProgress：前置没完成时 waitingFor 列出标题；全部阶段完成 currentStage 为 null；没有阶段也是 null", () => {
	const done = projectProgress(plan([{ name: "A", output: "" }]), [item({ id: "1", title: "A1", status: "done", stage: "A" })]);
	assert.equal(done.currentStage, null);
	const waiting = item({ id: "2", title: "B1", status: "pending", stage: "A", dependsOn: [{ id: "x", title: "前置X", status: "active", statusLabel: "进行中" }] });
	assert.deepEqual(projectProgress(plan([{ name: "A", output: "" }]), [waiting]).stages[0].items[0].waitingFor, ["前置X"]);
	assert.equal(projectProgress(plan([]), [item({ id: "1", title: "无阶段方案", status: "active" })]).currentStage, null, "没有阶段时为 null");
});

test("renderProgress：阶段一行（名字 + 状态）+ 任务行（状态 / 负责人 / 等谁）", () => {
	const p = projectProgress(plan([{ name: "准备", output: "草稿" }]), [
		item({ id: "1", title: "写草稿", status: "active", ownerName: "甲", stage: "准备", dependsOn: [{ id: "0", title: "调研", status: "active", statusLabel: "进行中" }] }),
	]);
	const text = renderProgress(p);
	assert.match(text, /进度：已完成 0\/1/);
	assert.match(text, /1\. 准备（进行中）/);
	assert.match(text, /- 写草稿：.*，负责人 甲，等：调研/);
});

test("projectStallStep（纯函数，覆盖抖动）：指纹变了 −1 但不清零，没变 +1，impossible 额外 +1，第一次只记起点", () => {
	assert.equal(projectStallStep({ stalls: 0, lastSig: null, sig: "a", impossible: false }), 0, "第一次检查只记起点，不计入阶梯");
	assert.equal(projectStallStep({ stalls: 2, lastSig: "a", sig: "a", impossible: false }), 3, "指纹没变 +1");
	assert.equal(projectStallStep({ stalls: 2, lastSig: "a", sig: "b", impossible: false }), 1, "指纹变了 −1");
	assert.equal(projectStallStep({ stalls: 0, lastSig: "a", sig: "b", impossible: false }), 0, "−1 不会跌到负数");
	assert.equal(projectStallStep({ stalls: 5, lastSig: "a", sig: "b", impossible: false }), 4, "有进展只 −1，不会被直接清零（抖动也不会一下子回到 0）");
	// 抖动：指纹在 a/b 之间来回变化，每次都算「有进展」而 −1；只有连续撞在同一个指纹上才 +1
	let s = 3;
	let prevSig = "a";
	for (const sig of ["b", "a", "b", "b"]) {
		s = projectStallStep({ stalls: s, lastSig: prevSig, sig, impossible: false });
		prevSig = sig;
	}
	assert.equal(s, 1, "前 3 次指纹都在变（3→2→1→0），第 4 次撞在同一个指纹上 +1（0→1）");
	assert.equal(projectStallStep({ stalls: 2, lastSig: "a", sig: "b", impossible: true }), 2, "这次有 impossible：先 −1 再 +1");
});

// ---------------------------------------------------------------- 集成：checkProjectStall / resumeProject

const mkAgent = (id: string, name: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#111", now());
mkAgent("rpm", "组长2");
mkAgent("rpa", "甲2");
const proto = Object.getPrototypeOf(R.runtime("rpm", "conv_probe2")) as Record<string, unknown>;
proto.turn = async function (this: { id: string; conversationId: string }, prompt: string) {
	if (W.execOf(this.conversationId)) return new Promise(() => {});
	return { ok: true, aborted: false, text: "", tokens: 0 };
};
proto.abort = async () => {};
proto.modelFor = () => ({ provider: "mock", id: "echo" });
// resumeProject 会真的把暂停的任务派给负责人的帮手：装一个一直挂起的假帮手驱动（不关心执行结果，只要派活不报错）。
const { setSubagentDriver } = await import("../src/subagents.ts");
setSubagentDriver({
	run: (_r, connect) => new Promise<string>(() => void connect(async () => {}, async () => {})),
	notify: async () => {},
});
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
function projToolsOf(roomId: string, agentId: string) {
	const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
	projectTools(roomId, agentId)({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
	return defs;
}
const callProj = (roomId: string, agentId: string, name: string, p: Record<string, unknown>) => projToolsOf(roomId, agentId).get(name)!.execute("t", p).then((r) => r.content[0].text);
const noticesOf = (roomId: string) => db.prepare("SELECT content FROM messages WHERE room_id = ? AND role = 'system' AND meta LIKE '%room-project%' ORDER BY rowid").all(roomId) as { content: string }[];

const fullPlan = (o: Record<string, unknown> = {}) => ({
	title: "项目级检查", goal: "做成一件事", doneCriteria: "完成标准", assumptions: [], roles: [{ member: "组长2", does: "统筹" }, { member: "甲2", does: "执行" }],
	stages: [{ name: "阶段A", output: "产出A" }], checkpoints: [], deliverables: "x", needs: "", scale: "", ...o,
});

test("checkProjectStall：连续没进展到 3 次返回 replan；改过计划 ≥2 次后再卡到 3 次返回 exhausted 并推送用户", async () => {
	const room = rooms.createRoom({ name: "卡住检测群", memberIds: ["rpm", "rpa"], managerId: "rpm" });
	await callProj(room.id, "rpm", "room_plan", fullPlan());
	const pid = projects.projectsOf(room.id)[0].id;
	projects.confirmProject(room.id, pid, "manager");
	await until(() => idle(room.id), "开始后的唤醒跑完");

	const p = () => projects.getProject(pid)!;
	assert.equal(projects.checkProjectStall(p()), "ok", "第一次检查只记起点");
	assert.equal(projects.checkProjectStall(p()), "ok", "第 2 次没进展：stalls=1");
	assert.equal(projects.checkProjectStall(p()), "ok", "第 3 次没进展：stalls=2");
	assert.equal(projects.checkProjectStall(p()), "replan", "第 4 次没进展：stalls=3，要求改计划");
	assert.equal(p().stalls, 3);

	const defs = projToolsOf(room.id, "rpm");
	await defs.get("room_project_replan")!.execute("t", { projectId: pid, why: "方向不对", change: "approach", detail: "换一种做法" });
	assert.equal(projects.getProject(pid)!.stalls, 0, "改计划后清零");
	assert.equal(projects.getProject(pid)!.replans, 1);
	assert.match(noticesOf(room.id).pop()!.content, /项目「项目级检查」卡住了：方向不对。改法：换一种做法——换一种做法/);

	// 再改一次计划（第 2 次），之后再卡到 3 次就该直接报告用户，不再要求管理者自己改
	for (let i = 0; i < 3; i++) projects.checkProjectStall(p());
	await defs.get("room_project_replan")!.execute("t", { projectId: pid, why: "还是不对", change: "retry", detail: "带改进意见重做" });
	assert.equal(projects.getProject(pid)!.replans, 2);

	const { pushLog } = await import("../src/push.ts");
	const n0 = pushLog.length;
	for (let i = 0; i < 2; i++) assert.equal(projects.checkProjectStall(p()), "ok");
	assert.equal(projects.checkProjectStall(p()), "exhausted", "改过 2 次计划后又卡到 3 次：不再要求管理者自己改");
	assert.equal(projects.getProject(pid)!.stalls, 0, "报告后清零，避免每次都重复报告");
	assert.match(noticesOf(room.id).pop()!.content, /反复卡住，已经换过 2 次办法仍没有新进展/);
	assert.ok(pushLog.length > n0 && pushLog.slice(n0).some((x) => /需要你看一下/.test(x.title)));

	await rooms.deleteRoom(room.id);
});

test("checkProjectStall：退回 / 受阻 / 改修订号不算进展，只有提交结果和完成才算", async () => {
	const room = rooms.createRoom({ name: "进展口径群", memberIds: ["rpm", "rpa"], managerId: "rpm" });
	await callProj(room.id, "rpm", "room_plan", fullPlan({ title: "进展口径" }));
	const pid = projects.projectsOf(room.id)[0].id;
	projects.confirmProject(room.id, pid, "manager");
	await until(() => idle(room.id), "开始后的唤醒跑完");
	const wi = W.createWorkItem({ roomId: room.id, title: "反复失败的任务", requirement: "写", doneCriteria: "有结果", ownerAgentId: "rpa", start: false, projectId: pid }, { kind: "user" }).item.id;
	const p = () => projects.getProject(pid)!;
	projects.checkProjectStall(p());
	// 来回失败：状态和修订号一直在变，但没有任何产出
	for (const [status, rev] of [["blocked", 2], ["active", 3], ["blocked", 4]] as const) {
		db.prepare("UPDATE work_items SET status = ?, revision = ? WHERE id = ?").run(status, rev, wi);
		projects.checkProjectStall(p());
	}
	assert.equal(p().stalls, 3, "反复失败不算进展，卡住计数照样涨到 3");
	// 成员真的提交了结果 → 算进展，−1
	db.prepare("INSERT INTO work_item_events(id, work_item_id, kind, actor, revision, detail, created_at) VALUES(?,?,?,?,?,?,?)").run("ev_t1", wi, "submitted", "rpa", 4, "{}", now());
	projects.checkProjectStall(p());
	assert.equal(p().stalls, 2, "有提交：−1");
	db.prepare("UPDATE work_items SET status = 'done' WHERE id = ?").run(wi);
	projects.checkProjectStall(p());
	assert.equal(p().stalls, 1, "有任务完成：再 −1");
	await rooms.deleteRoom(room.id);
});

test("resumeProject：只对 stopped 生效，恢复暂停的任务并叫醒管理者；room_project_resume 工具需要用户在停下之后发过话", async () => {
	const room = rooms.createRoom({ name: "接着做群", memberIds: ["rpm", "rpa"], managerId: "rpm" });
	await callProj(room.id, "rpm", "room_plan", fullPlan({ title: "接着做项目" }));
	const pid = projects.projectsOf(room.id)[0].id;
	projects.confirmProject(room.id, pid, "manager");
	await until(() => idle(room.id), "开始后的唤醒跑完");
	await assert.rejects(() => projects.resumeProject(room.id, pid), /正在进行中，不用恢复/);

	const wi = W.createWorkItem({ roomId: room.id, title: "写初稿", requirement: "写", doneCriteria: "有结果", ownerAgentId: "rpa", start: false, projectId: pid }, { kind: "user" }).item.id;
	db.prepare("UPDATE work_items SET status = 'active' WHERE id = ?").run(wi);
	await projects.stopProject(room.id, pid);
	assert.equal((db.prepare("SELECT status FROM work_items WHERE id = ?").get(wi) as { status: string }).status, "paused");

	const defs = projToolsOf(room.id, "rpm");
	assert.match(await defs.get("room_project_resume")!.execute("t", { projectId: pid }).then((r) => r.content[0].text), /项目停下之后用户还没有再发话/, "不能自己恢复");
	rooms.postUserMessage(room.id, "接着做吧");
	await until(() => idle(room.id), "用户发话的回合跑完");
	assert.match(await defs.get("room_project_resume")!.execute("t", { projectId: pid }).then((r) => r.content[0].text), /已恢复，项目「接着做项目」接着做/);
	assert.equal(projects.getProject(pid)!.status, "active");
	assert.equal((db.prepare("SELECT status FROM work_items WHERE id = ?").get(wi) as { status: string }).status, "active", "暂停的任务恢复成进行中");
	assert.match(noticesOf(room.id).pop()!.content, /项目「接着做项目」接着做，从停下的地方继续/);
	await until(() => idle(room.id), "恢复后的唤醒跑完");

	await W.cancelWorkItem({ workItemId: wi, actor: { kind: "user" } });
	await projects.finishProject(room.id, pid, "测试结束");
	await rooms.deleteRoom(room.id);
});
