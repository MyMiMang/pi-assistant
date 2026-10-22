import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 项目（docs/design/group-team.md §1–3、决策 0019）：方案卡、按钮确认 / 取消、群里说「可以」确认、
 * 进行中改方案、完成 / 停下、迁移旧的自主推进。调度机制（唤醒、兜底、空聊、@）的覆盖在 group-collab.test.ts。
 */
const { db, now } = await import("../src/db.ts");
const R = await import("../src/runtime.ts");
const rooms = await import("../src/rooms/index.ts");
const projects = await import("../src/rooms/projects.ts");
const logic = await import("../src/rooms/logic.ts");
const { projectTools } = await import("../src/rooms/project-tools.ts");
const { roomTools } = await import("../src/rooms/tools.ts");
const W = await import("../src/work-items.ts");

const replies = new Map<string, (prompt: string) => string>();
const proto = Object.getPrototypeOf(R.runtime("pm", "conv_probe")) as Record<string, unknown>;
proto.turn = async function (this: { id: string; conversationId: string }, prompt: string) {
	if (W.execOf(this.conversationId)) return new Promise(() => {});
	return { ok: true, aborted: false, text: replies.get(this.id)?.(prompt) ?? "", tokens: 0 };
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
const turnsOf = (roomId: string, reason?: string) => db.prepare(`SELECT agent_id, reason, status FROM room_turns WHERE room_id = ? ${reason ? "AND reason = ?" : ""} ORDER BY created_at, rowid`).all(...([roomId, ...(reason ? [reason] : [])] as never[])) as { agent_id: string; reason: string; status: string }[];
const idleHintsOf = (roomId: string) => (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND meta LIKE '%room-idle%'").get(roomId) as { n: number }).n;

const mkAgent = (id: string, name: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#111", now());
mkAgent("pm", "组长");
mkAgent("pa", "甲");
mkAgent("pb", "乙");

function projToolsOf(roomId: string, agentId: string) {
	const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
	projectTools(roomId, agentId)({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
	return defs;
}
function roomToolsOf(roomId: string, agentId: string) {
	const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
	roomTools(roomId, agentId)({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
	return defs;
}
const callProj = (roomId: string, agentId: string, name: string, p: Record<string, unknown>) => projToolsOf(roomId, agentId).get(name)!.execute("t", p).then((r) => r.content[0].text);
/** 项目行（含已解析的 plan / draft），测试断言用 */
const pj = (id: string) => projects.projectJson(projects.getProject(id)!);
const cardOf = (roomId: string) => { const r = db.prepare("SELECT meta FROM messages WHERE room_id = ? AND role = 'card' ORDER BY rowid DESC LIMIT 1").get(roomId) as { meta: string } | undefined; return r && (JSON.parse(r.meta) as Record<string, unknown>); };
const noticesOf = (roomId: string) => db.prepare("SELECT content FROM messages WHERE room_id = ? AND role = 'system' AND meta LIKE '%room-project%' ORDER BY rowid").all(roomId) as { content: string }[];

const fullPlan = (o: Record<string, unknown> = {}) => ({
	title: "写一份报告",
	goal: "写一份报告",
	doneCriteria: "报告有结论和来源",
	assumptions: ["按常见格式写", "交付前请你确认一次"],
	roles: [{ member: "组长", does: "统筹与核验" }, { member: "甲", does: "撰写初稿" }],
	stages: [{ name: "草稿", output: "初稿" }, { name: "定稿", output: "最终报告" }],
	checkpoints: ["初稿出来后请你看看方向"],
	deliverables: "report.md",
	needs: "",
	scale: "两三天",
	...o,
});

test("看板指纹（纯逻辑）：项目进行中只认 work_items 状态变化算进展，普通派活（plainAssignsDone）完成多少次都不改变指纹", () => {
	const items = [{ id: "wi_1", status: "active" }];
	const a = logic.boardSig({ items, plainAssignsDone: 1, projectActive: true });
	const b = logic.boardSig({ items, plainAssignsDone: 7, projectActive: true });
	assert.equal(a, b, "项目进行中：plainAssignsDone 从 1 涨到 7 不算进展，指纹不变");
	assert.notEqual(logic.boardSig({ items: [{ id: "wi_1", status: "done" }], plainAssignsDone: 1, projectActive: true }), a, "work_item 状态真的变了才算进展");
	assert.notEqual(logic.boardSig({ items, plainAssignsDone: 1, projectActive: false }), logic.boardSig({ items, plainAssignsDone: 2, projectActive: false }), "非项目场景沿用旧逻辑：plainAssignsDone 也算一部分指纹");
});

test("room_plan：只有管理者能出方案卡；分工里不是群成员的名字被拒；通过后发卡、按名字解析补上 agentId", async () => {
	const room = rooms.createRoom({ name: "方案群", memberIds: ["pm", "pa", "pb"], managerId: "pm" });
	assert.match(await callProj(room.id, "pa", "room_plan", fullPlan()), /只有管理者/);
	assert.match(await callProj(room.id, "pm", "room_plan", fullPlan({ roles: [{ member: "路人", does: "干活" }] })), /不是群成员：路人/);
	assert.match(await callProj(room.id, "pm", "room_plan", fullPlan({ goal: "", doneCriteria: "" })), /方案还不完整，缺：/);
	const out = await callProj(room.id, "pm", "room_plan", fullPlan());
	assert.match(out, /方案卡已发给用户（项目编号 pj_/);
	const proj = projects.projectsOf(room.id)[0];
	assert.equal(proj.status, "proposed");
	assert.equal(pj(proj.id).plan.roles.find((r) => r.member === "甲")?.agentId, "pa", "按名字解析补上 agentId");
	const meta = cardOf(room.id)!;
	assert.equal(meta.kind, "room-plan");
	assert.equal(meta.status, "pending");
	assert.equal(meta.projectId, proj.id);
	await until(() => idle(room.id), "没有待跑的回合");
	await rooms.deleteRoom(room.id);
});

test("按钮确认 / 先不做：proposed → active / dismissed；确认后群里有 started 告知并唤醒管理者", async () => {
	const room = rooms.createRoom({ name: "按钮群", memberIds: ["pm", "pa"], managerId: "pm" });
	replies.set("pm", () => "收到");
	await callProj(room.id, "pm", "room_plan", fullPlan());
	const proj = projects.projectsOf(room.id)[0];
	projects.confirmProject(room.id, proj.id, "user");
	assert.equal(projects.getProject(proj.id)!.status, "active");
	assert.equal(cardOf(room.id)!.status, "confirmed");
	assert.match(noticesOf(room.id).pop()!.content, /方案已确认，项目「写一份报告」开始了/);
	await until(() => turnsOf(room.id, "check").some((t) => t.status === "done"), "用户确认后唤醒管理者");

	const out2 = await callProj(room.id, "pm", "room_plan", fullPlan({ title: "做个原型", goal: "做个原型" }));
	const pid2 = out2.match(/项目编号 (pj_[a-z0-9]+)/)![1];
	projects.dismissProject(room.id, pid2);
	assert.equal(projects.getProject(pid2)!.status, "dismissed");
	assert.equal(cardOf(room.id)!.status, "dismissed");
	assert.match(noticesOf(room.id).pop()!.content, /这份方案先不做了/);
	replies.clear();
	await until(() => idle(room.id), "跑完");
	await rooms.deleteRoom(room.id);
});

test("群里说「可以」后 room_project_start 成功；用户还没回复这份方案时被拒，不能替用户确认", async () => {
	const room = rooms.createRoom({ name: "口头确认群", memberIds: ["pm", "pa"], managerId: "pm" });
	await callProj(room.id, "pm", "room_plan", fullPlan());
	const proj = projects.projectsOf(room.id)[0];
	assert.match(await callProj(room.id, "pm", "room_project_start", { projectId: proj.id }), /用户还没回复这份方案，不能替用户确认/);
	assert.equal(projects.getProject(proj.id)!.status, "proposed");
	replies.set("pm", () => "好的");
	rooms.postUserMessage(room.id, "可以");
	await until(() => idle(room.id), "用户发言的回合跑完");
	assert.match(await callProj(room.id, "pm", "room_project_start", { projectId: proj.id }), /已确认，项目「写一份报告」开始了/);
	assert.equal(projects.getProject(proj.id)!.status, "active");
	assert.match(await callProj(room.id, "pm", "room_project_start", { projectId: proj.id }), /已经处理过了/, "已确认的项目不能再确认一次");
	replies.clear();
	await until(() => idle(room.id), "跑完");
	await rooms.deleteRoom(room.id);
});

test("进行中改方案：带 projectId 写进 draft 发 revision 卡；确认覆盖原方案，取消则按原方案继续", async () => {
	const room = rooms.createRoom({ name: "改方案群", memberIds: ["pm", "pa"], managerId: "pm" });
	replies.set("pm", () => "好的");
	await callProj(room.id, "pm", "room_plan", fullPlan());
	const pid = projects.projectsOf(room.id)[0].id;
	projects.confirmProject(room.id, pid, "manager");
	await until(() => idle(room.id), "开始后的唤醒跑完");

	const rev1 = await callProj(room.id, "pm", "room_plan", fullPlan({ projectId: pid, goal: "写一份更详细的报告", doneCriteria: "报告有结论、来源和图表" }));
	assert.match(rev1, /这是改过的方案，等用户重新确认/);
	assert.equal(projects.getProject(pid)!.status, "active", "进行中改方案：项目本身还是 active");
	assert.equal(pj(pid).draft?.goal, "写一份更详细的报告");
	assert.equal(cardOf(room.id)!.revision, true);
	projects.confirmProject(room.id, pid, "user");
	assert.equal(pj(pid).plan.goal, "写一份更详细的报告", "确认后 draft 覆盖 plan");
	assert.equal(pj(pid).draft, null);
	assert.match(noticesOf(room.id).pop()!.content, /改过的方案已确认，项目「写一份报告」按新方案继续/);
	await until(() => idle(room.id), "确认改方案后的唤醒跑完");

	await callProj(room.id, "pm", "room_plan", fullPlan({ projectId: pid, goal: "再改一版加问卷", doneCriteria: "报告有结论、来源、图表和问卷" }));
	projects.dismissProject(room.id, pid);
	assert.equal(pj(pid).plan.goal, "写一份更详细的报告", "取消改方案：保留当前生效的方案");
	assert.equal(pj(pid).draft, null);
	replies.clear();
	await until(() => idle(room.id), "跑完");
	await rooms.deleteRoom(room.id);
});

test("room_project_done：只有管理者、项目要在进行中才能结束；结束后把结果总结发到群里", async () => {
	const room = rooms.createRoom({ name: "完成群", memberIds: ["pm", "pa"], managerId: "pm" });
	replies.set("pm", () => "好的");
	await callProj(room.id, "pm", "room_plan", fullPlan());
	const pid = projects.projectsOf(room.id)[0].id;
	assert.match(await callProj(room.id, "pa", "room_project_done", { projectId: pid, summary: "完成了" }), /只有管理者/);
	assert.match(await callProj(room.id, "pm", "room_project_done", { projectId: pid, summary: "完成了" }), /还没开始/);
	projects.confirmProject(room.id, pid, "manager");
	await until(() => idle(room.id), "开始后的唤醒跑完");
	assert.match(await callProj(room.id, "pm", "room_project_done", { projectId: pid, summary: "" }), /请写一句结果总结/);
	assert.match(await callProj(room.id, "pm", "room_project_done", { projectId: pid, summary: "报告在 report.md，三节齐全" }), /项目「写一份报告」已结束/);
	assert.equal(projects.getProject(pid)!.status, "done");
	assert.match(noticesOf(room.id).pop()!.content, /项目「写一份报告」已完成，成果见下面的交付卡/);
	assert.equal((JSON.parse((db.prepare("SELECT meta FROM messages WHERE room_id = ? AND role = 'card' ORDER BY rowid DESC LIMIT 1").get(room.id) as { meta: string }).meta) as { summary: string }).summary, "报告在 report.md，三节齐全");
	replies.clear();
	await until(() => idle(room.id), "跑完");
	await rooms.deleteRoom(room.id);
});

test("stop：active → stopped，暂停这个项目下进行中的任务，保留进度", async () => {
	const room = rooms.createRoom({ name: "停下群", memberIds: ["pm", "pa"], managerId: "pm" });
	replies.set("pm", () => "好的");
	await callProj(room.id, "pm", "room_plan", fullPlan());
	const pid = projects.projectsOf(room.id)[0].id;
	projects.confirmProject(room.id, pid, "manager");
	await until(() => idle(room.id), "开始后的唤醒跑完");
	const wi = W.createWorkItem({ roomId: room.id, title: "写初稿", requirement: "写", doneCriteria: "有结果", ownerAgentId: "pa", start: false, projectId: pid }, { kind: "user" }).item.id;
	db.prepare("UPDATE work_items SET status = 'active' WHERE id = ?").run(wi);
	await projects.stopProject(room.id, pid);
	assert.equal(projects.getProject(pid)!.status, "stopped");
	assert.equal((db.prepare("SELECT status FROM work_items WHERE id = ?").get(wi) as { status: string }).status, "paused", "项目下的任务被暂停，进度保留");
	assert.match(noticesOf(room.id).pop()!.content, /项目「写一份报告」已停下，进度保留/);
	await rooms.deleteRoom(room.id);
});

test("roomJson.projects 只含 proposed / active；active 项目时不按每轮发言次数暂停", async () => {
	const room = rooms.createRoom({ name: "看板项目群", memberIds: ["pm", "pa", "pb"], managerId: "pm", caps: { maxTurns: 1 } });
	await callProj(room.id, "pm", "room_plan", fullPlan());
	const pid = projects.projectsOf(room.id)[0].id;
	assert.equal(rooms.roomJson(rooms.getRoom(room.id)!).projects.length, 1, "proposed 算在内");
	projects.confirmProject(room.id, pid, "manager");
	assert.equal(rooms.roomJson(rooms.getRoom(room.id)!).projects[0].status, "active");
	await until(() => idle(room.id), "开始后的唤醒跑完");

	// 管理者只在「开工」这一回合派活（真实模型不会对着已经分配过的活反复重派）；之后被叫醒（idleWake）只简单回一句，不再派。
	let assigned = false;
	replies.set("pm", () => {
		if (!assigned) {
			assigned = true;
			void roomToolsOf(room.id, "pm").get("room_assign")!.execute("t", { assignments: [{ agent: "甲", task: "写第一节" }, { agent: "乙", task: "写第二节" }] });
			return "分好了";
		}
		return "都在做了，等结果。";
	});
	rooms.postUserMessage(room.id, "开工");
	await until(() => idle(room.id), "跑完");
	assert.equal(turnsOf(room.id, "assign").filter((t) => t.status === "done").length, 2, "超过每轮上限（1）两条 assign 都照常执行，不暂停");
	assert.ok(!db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND meta LIKE '%room-paused%'").get(room.id), "项目进行中不会生成「本轮已暂停」");

	await projects.finishProject(room.id, pid, "两节都写完了");
	assert.equal(rooms.roomJson(rooms.getRoom(room.id)!).projects.length, 0, "done 不再出现在 roomJson.projects");
	replies.clear();
	await until(() => idle(room.id), "跑完");
	await rooms.deleteRoom(room.id);
});

test("idleWake 不会被管理者反复重派同一份活（没建 work_item）骗成「一直有进展」而无限叫醒：有限步内转成提示用户", async () => {
	const room = rooms.createRoom({ name: "空转防护群", memberIds: ["pm", "pa"], managerId: "pm" });
	await callProj(room.id, "pm", "room_plan", fullPlan());
	const pid = projects.projectsOf(room.id)[0].id;
	projects.confirmProject(room.id, pid, "manager");
	await until(() => idle(room.id), "开始后的唤醒跑完");
	// 管理者每次被叫醒都只会用 room_assign 重派同一份活（不建 work_item，模拟没有真正推进的模型）。
	replies.set("pm", () => {
		void roomToolsOf(room.id, "pm").get("room_assign")!.execute("t", { assignments: [{ agent: "甲", task: "写一段" }] });
		return "分好了";
	});
	rooms.wakeManager(room.id, "看看");
	await until(() => idle(room.id) && idleHintsOf(room.id) === 1, "反复重派同样的活不算进展：被兜底叫醒一次后就提示用户、不再无限叫醒", 10000);
	assert.ok(turnsOf(room.id, "check").length <= 3, "兜底唤醒次数有限，没有无限循环");
	replies.clear();
	await projects.stopProject(room.id, pid);
	await rooms.deleteRoom(room.id);
});

test("迁移：旧的 rooms.autonomy 转成一个 active 项目，进行中的任务挂上 project_id，autonomy 清空；跑两次幂等", async () => {
	const room = rooms.createRoom({ name: "待迁移群", memberIds: ["pm", "pa"], managerId: "pm" });
	const startedAt = now() - 10_000;
	db.prepare("UPDATE rooms SET autonomy = ? WHERE id = ?").run(JSON.stringify({ goal: "写季度报告", doneCriteria: "三节齐全、每个结论有来源", startedAt }), room.id);
	const wiActive = W.createWorkItem({ roomId: room.id, title: "写第一节", requirement: "写", doneCriteria: "有结果", ownerAgentId: "pa", start: false }, { kind: "user" }).item.id;
	db.prepare("UPDATE work_items SET status = 'active' WHERE id = ?").run(wiActive);
	const wiDone = W.createWorkItem({ roomId: room.id, title: "已完成的", requirement: "写", doneCriteria: "有结果", ownerAgentId: "pa", start: false }, { kind: "user" }).item.id;
	db.prepare("UPDATE work_items SET status = 'done' WHERE id = ?").run(wiDone);

	const n1 = projects.migrateAutonomy();
	assert.ok(n1 >= 1);
	const proj = projects.activeProjects(room.id)[0];
	assert.ok(proj, "旧自主推进迁移成一个 active 项目");
	assert.equal(pj(proj.id).plan.goal, "写季度报告");
	assert.equal(pj(proj.id).plan.doneCriteria, "三节齐全、每个结论有来源");
	assert.equal((db.prepare("SELECT project_id FROM work_items WHERE id = ?").get(wiActive) as { project_id: string | null }).project_id, proj.id, "进行中的任务挂上了项目");
	assert.equal((db.prepare("SELECT project_id FROM work_items WHERE id = ?").get(wiDone) as { project_id: string | null }).project_id, null, "已完成的任务不回填");
	assert.equal((db.prepare("SELECT autonomy FROM rooms WHERE id = ?").get(room.id) as { autonomy: string | null }).autonomy, null, "autonomy 清空");

	const n2 = projects.migrateAutonomy();
	await until(() => idle(room.id), "迁移期间没有安排回合");
	assert.equal(projects.activeProjects(room.id).length, 1, "跑两次幂等：没有重复建项目");
	assert.equal(n2, 0, "第二次没有新数据可迁移");
	await projects.stopProject(room.id, proj.id);
	await rooms.deleteRoom(room.id);
});
