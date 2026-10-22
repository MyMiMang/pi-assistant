/**
 * 任务依赖与自动交接（docs/design/group-team.md §4、决策 0019 第 3 步）：防环、前置没完成先停在待安排、
 * 核验通过后自动开始下游并带交接单和文件、前置取消时下游标受阻、验收「这条路走不通」。环境见 work-items-harness.ts。
 */
import "./work-items-harness.ts";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { wouldCycle } from "../src/work-items/deps.ts";
import { workspaceOf } from "../src/files.ts";
import { W, calls, db, mgr, now, room, rooms, row, settle, started, submit, user, makeItem, wakes } from "./work-items-harness.ts";

function toolsOf(factory: (pi: { registerTool: (t: unknown) => void }) => void) {
	const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
	factory({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
	return defs;
}

test("wouldCycle（纯函数）：加一条边会不会和现有依赖图成环", () => {
	const edges: Record<string, string[]> = { a: ["b"], b: ["c"] }; // a 依赖 b，b 依赖 c
	assert.equal(wouldCycle(edges, "c", "a"), true, "c 依赖 a：a→b→c→a 成环");
	assert.equal(wouldCycle(edges, "d", "a"), false, "d 是新节点，不会成环");
	assert.equal(wouldCycle({}, "x", "x"), true, "自己依赖自己直接算环");
});

test("work_create after：解析不到前置任务报错并列出可选任务；按编号或名字都能解析", () => {
	assert.throws(() => W.createWorkItem({ roomId: room.id, title: "下游0", ownerAgentId: "wb", requirement: "r", doneCriteria: "d", after: ["不存在的任务"] }, user), /找不到前置任务：不存在的任务/);
	const up = W.createWorkItem({ roomId: room.id, title: "阶段一", ownerAgentId: "wa", requirement: "r", doneCriteria: "d", start: false }, user).item;
	const byId = W.createWorkItem({ roomId: room.id, title: "按编号依赖", ownerAgentId: "wb", requirement: "r", doneCriteria: "d", after: [up.id] }, user).item;
	const byName = W.createWorkItem({ roomId: room.id, title: "按名字依赖", ownerAgentId: "wb", requirement: "r", doneCriteria: "d", after: ["阶段一"] }, user).item;
	assert.deepEqual(byId.dependsOn.map((d) => d.id), [up.id]);
	assert.deepEqual(byName.dependsOn.map((d) => d.id), [up.id]);
	assert.equal(byId.dependsOn[0].statusLabel, "待安排");
});

test("有前置且前置没全部完成：建成 pending、不派执行；前置都完成才照常开始", async () => {
	const up = makeItem("wa", false); // pending，未开始
	const before = calls.length;
	const down = W.createWorkItem({ roomId: room.id, title: "等前置的下游", ownerAgentId: "wb", requirement: "审核", doneCriteria: "审核通过", after: [up] }, user).item;
	assert.equal(down.status, "pending");
	assert.match(down.latestProgress, /等前置任务完成/);
	assert.equal(calls.length, before, "没有派出执行");
	await W.cancelWorkItem({ workItemId: up, actor: user });
	await W.cancelWorkItem({ workItemId: down.id, actor: user });
});

test("前置任务核验通过后依赖它的 pending 任务自动开始，执行提示里带交接说明和放进工作区的文件", async () => {
	const up = W.createWorkItem({ roomId: room.id, title: "写初稿", ownerAgentId: "wa", requirement: "写初稿", doneCriteria: "有初稿", start: true }, user).item;
	const down = W.createWorkItem({ roomId: room.id, title: "审核初稿", ownerAgentId: "wb", requirement: "审核", doneCriteria: "审核通过", after: [up.id] }, user).item;
	assert.equal(down.status, "pending");
	const c = await started(up.id);
	writeFileSync(`${workspaceOf("wa")}/draft.md`, "初稿内容");
	const sub = W.submitWorkItem({ workItemId: up.id, conversationId: c.conv, actor: { kind: "agent", agentId: "wa" }, result: "写好了初稿", handoff: "初稿在 draft.md，还没配图", files: ["draft.md"] });
	assert.equal(sub.applied, true);
	assert.deepEqual(sub.missingFiles, []);
	c.finish({ text: "已提交" });
	await settle();
	await W.verifyWorkItem({ workItemId: up.id, actor: mgr, verdict: "pass", note: "读了 draft.md，初稿没问题" });
	assert.equal(row(up.id).status, "done");
	assert.equal(row(down.id).status, "active", "下游自动开始");
	assert.ok(W.getWorkItemDetail(down.id).events.some((e) => e.kind === "started" && (e.detail as { auto?: boolean }).auto));
	const c2 = await started(down.id);
	assert.match(c2.prompt, /前置任务交给你的东西：/);
	assert.match(c2.prompt, /前置任务「写初稿」（编号 wi_\w+，负责人 甲）已完成/);
	assert.match(c2.prompt, /交接说明：初稿在 draft\.md，还没配图/);
	const path = c2.prompt.match(/相关文件（已放进你的工作区）：(\S+)/)?.[1];
	assert.ok(path, "执行提示里带着文件路径");
	assert.ok(existsSync(`${workspaceOf("wb")}/${path}`), "文件真的放进了乙的工作区");
	c2.finish();
	await W.cancelWorkItem({ workItemId: down.id, actor: user });
});

test("前置任务完成但负责人不可用：下游标受阻待改派并叫醒管理者", async () => {
	const up = W.createWorkItem({ roomId: room.id, title: "上游2", ownerAgentId: "wa", requirement: "r", doneCriteria: "d", start: true }, user).item;
	const down = W.createWorkItem({ roomId: room.id, title: "下游2", ownerAgentId: "wb", requirement: "r2", doneCriteria: "d2", after: [up.id] }, user).item;
	const c = await started(up.id);
	submit(c, { result: "完成了" });
	c.finish();
	await settle();
	// 直接把乙在这个群的会员状态标成「已离开」（绕开 rooms.updateRoom 的移出钩子，单独测「负责人不可用」这一刻）
	db.prepare("UPDATE room_members SET left_at = ? WHERE room_id = ? AND agent_id = ?").run(now(), room.id, "wb");
	try {
		const w0 = wakes(room.id);
		await W.verifyWorkItem({ workItemId: up.id, actor: mgr, verdict: "pass", note: "通过" });
		const after = row(down.id);
		assert.equal(after.status, "blocked");
		assert.match(after.blocker ?? "", /负责人不可用，待改派/);
		assert.ok(wakes(room.id) > w0, "叫醒管理者处理");
	} finally {
		db.prepare("UPDATE room_members SET left_at = NULL WHERE room_id = ? AND agent_id = ?").run(room.id, "wb");
	}
	await W.cancelWorkItem({ workItemId: down.id, actor: user });
});

test("前置任务被取消：依赖它、还没开始的下游标受阻并叫醒管理者", async () => {
	const up = makeItem("wa", false);
	const down = W.createWorkItem({ roomId: room.id, title: "等取消的下游", ownerAgentId: "wb", requirement: "r", doneCriteria: "d", after: [up] }, user).item;
	const w0 = wakes(room.id);
	await W.cancelWorkItem({ workItemId: up, actor: user });
	const after = row(down.id);
	assert.equal(after.status, "blocked");
	assert.match(after.blocker ?? "", /前置任务「.*」已取消/);
	assert.ok(wakes(room.id) > w0);
	await W.cancelWorkItem({ workItemId: down.id, actor: user });
});

test("editWorkItem：改 after 会检测环；改 stage 没有项目限制时原样记录", () => {
	const A = makeItem("wa", false);
	const B = W.createWorkItem({ roomId: room.id, title: "B 任务", ownerAgentId: "wb", requirement: "r", doneCriteria: "d", after: [A] }, user).item.id;
	assert.throws(() => W.editWorkItem({ workItemId: A, actor: user, after: [B] }), /循环依赖/, "A 改成依赖 B 会和 B 依赖 A 成环");
	assert.throws(() => W.editWorkItem({ workItemId: A, actor: user, after: [A] }), /找不到前置任务/, "不能依赖自己");
	const edited = W.editWorkItem({ workItemId: A, actor: user, stage: "阶段一" });
	assert.equal(edited.item.stage, "阶段一");
	const cleared = W.editWorkItem({ workItemId: A, actor: user, stage: "" });
	assert.equal(cleared.item.stage, null);
});

test("验收「这条路走不通」：标受阻、不计入 auto_retries、不自动重做，事件 verified.impossible", async () => {
	const id = makeItem("wa", true);
	const c = await started(id);
	submit(c, { result: "试了但走不通" });
	c.finish();
	await settle();
	const before = row(id).autoRetries;
	await assert.rejects(() => W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "impossible", note: "" }), /检查结论/);
	await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "impossible", note: "这个方法本身做不到" });
	const after = row(id);
	assert.equal(after.status, "blocked");
	assert.match(after.blocker ?? "", /^这条路走不通：这个方法本身做不到/);
	assert.equal(after.autoRetries, before, "不计入 auto_retries");
	assert.ok(W.getWorkItemDetail(id).events.some((e) => e.kind === "verified.impossible"));
	await W.cancelWorkItem({ workItemId: id, actor: user });

	// HTTP 用户核验接口（userAction 的 verify）也接受 verdict: "impossible"
	const id2 = makeItem("wa", true);
	const c2 = await started(id2);
	submit(c2, { result: "另一次试了但走不通" });
	c2.finish();
	await settle();
	await W.userAction(id2, "verify", { verdict: "impossible", note: "HTTP 接口也接受 impossible" });
	assert.match(row(id2).blocker ?? "", /^这条路走不通：HTTP 接口也接受 impossible/);
	await W.cancelWorkItem({ workItemId: id2, actor: user });
});

test("stage：项目有阶段时按名字匹配（大小写不敏感），匹配不到报错并列出阶段", async () => {
	const sRoom = rooms.createRoom({ name: "阶段验证群", memberIds: ["wm", "wa", "wb"], managerId: "wm" });
	const projects = await import("../src/rooms/projects.ts");
	const plan = {
		goal: "g", doneCriteria: "d", assumptions: [] as string[], roles: [{ member: "甲", does: "x" }], stages: [{ name: "阶段A", output: "" }, { name: "阶段B", output: "" }],
		checkpoints: [] as string[], deliverables: "x", needs: "", scale: "",
	};
	const { project } = projects.proposePlan({ roomId: sRoom.id, managerId: "wm", title: "阶段项目", plan });
	projects.confirmProject(sRoom.id, project.id, "manager");
	await settle();
	assert.throws(
		() => W.createWorkItem({ roomId: sRoom.id, title: "任务X", ownerAgentId: "wa", requirement: "r", doneCriteria: "d", projectId: project.id, stage: "没有的阶段" }, user),
		/不是项目「.*」的阶段。可选阶段：阶段A、阶段B/,
	);
	const item = W.createWorkItem({ roomId: sRoom.id, title: "任务Y", ownerAgentId: "wa", requirement: "r", doneCriteria: "d", projectId: project.id, stage: "阶段a" }, user).item;
	assert.equal(item.stage, "阶段A", "大小写不敏感，匹配到标准写法");
	await rooms.deleteRoom(sRoom.id);
});

test("work_submit：有下游等着但没写交接说明时提醒，不拒绝提交；找不到的文件单独列出", async () => {
	const up = W.createWorkItem({ roomId: room.id, title: "被等待的任务", ownerAgentId: "wa", requirement: "r", doneCriteria: "d", start: true }, user).item;
	W.createWorkItem({ roomId: room.id, title: "等待的下游", ownerAgentId: "wb", requirement: "r2", doneCriteria: "d2", after: [up.id] }, user);
	const c = await started(up.id);
	const execTools = toolsOf(W.workExecTools(up.id, "wa", c.conv));
	const res = await execTools.get("work_submit")!.execute("t", { result: "完成了", files: ["不存在的文件.txt"] });
	assert.match(res.content[0].text, /有别的任务在等你的成果，建议补一段交接说明/);
	assert.match(res.content[0].text, /找不到这些文件，没有登记：不存在的文件\.txt/);
});
