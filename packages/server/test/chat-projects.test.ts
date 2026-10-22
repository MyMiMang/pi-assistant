import "./setup.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 单聊也走方案流程（docs/design/group-team.md §13）：方案存取、工具防护、阶段进度、交付卡 meta、
 * 单聊规则只在单聊出现（群成员对话 / 隐藏对话没有）、HTTP 接口。
 */
const { db, now } = await import("../src/db.ts");
const { createConversation, deleteConversation } = await import("../src/conversations.ts");
const { workspaceOf } = await import("../src/files.ts");
const R = await import("../src/runtime.ts");
const rooms = await import("../src/rooms/index.ts");
const store = await import("../src/chat-projects/store.ts");
const { chatProgress, findStage } = await import("../src/chat-projects/progress.ts");
const { chatPlanRules, CHAT_PLAN_RULE, confirmWakeText, isChatConversation } = await import("../src/chat-projects/rules.ts");
const { chatProjectTools } = await import("../src/chat-projects/tools.ts");
const { mountChatProjectRoutes } = await import("../src/routes/chat-projects.ts");
const { checkPlan, normalizePlan } = await import("../src/rooms/plan.ts");
const { renderProgress } = await import("../src/rooms/progress.ts");
const { SYSTEM_RULES } = await import("../src/agent-runtime/system-rules.ts");
const { insertMessage } = await import("../src/messages.ts");
const { Hono } = await import("hono");

db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run("ca", "小助", "A", "#111", now());
db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run("cb", "小乙", "B", "#222", now());

type Def = { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
const toolsOf = (agentId: string, conv: string) => {
	const defs = new Map<string, Def>();
	chatProjectTools(agentId, conv)({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as Def) });
	return defs;
};
const call = (agentId: string, conv: string, name: string, p: Record<string, unknown>) => toolsOf(agentId, conv).get(name)!.execute("t", p).then((r) => r.content[0].text);
const plan = (o: Record<string, unknown> = {}) => ({
	title: "整理小结",
	goal: "整理一份小结",
	doneCriteria: "有要点和成稿",
	assumptions: ["按通用结构"],
	stages: [{ name: "梳理要点", output: "要点清单" }, { name: "整理成稿", output: "小结文件" }],
	checkpoints: ["要点出来后请你看一眼"],
	deliverables: "summary.md",
	...o,
});
const cards = (conv: string) => (db.prepare("SELECT meta FROM messages WHERE conversation_id = ? AND role = 'card' ORDER BY rowid").all(conv) as { meta: string }[]).map((r) => JSON.parse(r.meta) as Record<string, unknown>);
const sysTexts = (conv: string) => (db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'system' ORDER BY rowid").all(conv) as { content: string }[]).map((r) => r.content);
const userSays = (conv: string, text: string) => insertMessage({ agentId: "ca", conversationId: conv, role: "user", content: text });

test("纯逻辑：阶段进度按已完成的阶段名算；findStage 认序号 / 阶段名 / 包含；进度能用群聊的 renderProgress 渲染", () => {
	const p = normalizePlan({ stages: [{ name: "梳理要点", output: "a" }, { name: "整理成稿", output: "b" }, { name: "复查", output: "c" }] });
	const none = chatProgress(p, []);
	assert.deepEqual(none.stages.map((s) => s.state), ["doing", "todo", "todo"]);
	assert.equal(none.currentStage, 0);
	const mid = chatProgress(p, ["梳理要点"]);
	assert.deepEqual(mid.stages.map((s) => s.state), ["done", "doing", "todo"]);
	assert.equal(mid.done, 1);
	assert.equal(mid.total, 3);
	assert.equal(mid.currentStage, 1);
	assert.equal(chatProgress(p, ["梳理要点", "整理成稿", "复查"]).currentStage, null, "全做完没有当前阶段");
	assert.match(renderProgress(mid), /进度：已完成 1\/3\n1\. 梳理要点（已完成）\n2\. 整理成稿（进行中）\n3\. 复查（没开始）/);
	assert.equal(findStage(p, "2"), 1);
	assert.equal(findStage(p, "整理成稿"), 1);
	assert.equal(findStage(p, "成稿"), 1, "包含也认");
	assert.equal(findStage(p, "9"), -1);
	assert.equal(findStage(p, ""), -1);
});

test("checkPlan：单聊（solo）分工可以不写、写了也不按成员名单校验；群聊仍要求分工", () => {
	const raw = normalizePlan({ goal: "g", doneCriteria: "d", deliverables: "x", stages: [{ name: "一", output: "o" }] });
	assert.match(checkPlan(raw, [{ id: "a", name: "甲" }]).error ?? "", /roles（分工/, "群聊不写分工被拒");
	assert.equal(checkPlan(raw, [], { solo: true }).error, undefined, "单聊可以不写分工");
	const withRole = normalizePlan({ ...raw, roles: [{ member: "我", does: "做" }, { member: "帮手", does: "查资料" }] });
	assert.equal(checkPlan(withRole, [], { solo: true }).plan?.roles.length, 2, "「我」「帮手」都行");
	assert.match(checkPlan({ ...raw, goal: "" }, [], { solo: true }).error ?? "", /缺：goal/, "目标仍然不能空");
});

test("chat_plan：发方案卡（沿用 room-plan 卡 + conversationId）、校验缺项、不带分工也行；改方案重新发卡并取代旧卡", async () => {
	const conv = createConversation("ca", "方案测试", { makeCurrent: false }).id;
	assert.match(await call("ca", conv, "chat_plan", plan({ goal: "", doneCriteria: "" })), /方案还不完整，缺：/);
	const out = await call("ca", conv, "chat_plan", plan());
	const pid = out.match(/项目编号 (cp_[a-z0-9]+)/)![1];
	assert.match(out, /这一轮先停下等用户/);
	const proj = store.getChatProject(pid)!;
	assert.equal(proj.status, "proposed");
	assert.equal(proj.conversation_id, conv);
	const [card] = cards(conv);
	assert.equal(card.kind, "room-plan");
	assert.equal(card.status, "pending");
	assert.equal(card.conversationId, conv);
	assert.equal(card.projectId, pid);
	assert.equal(card.revision, false);
	// 还在等确认时改方案：同一个项目，旧卡被取代，发新卡
	assert.match(await call("ca", conv, "chat_plan", plan({ projectId: pid, goal: "整理一份更短的小结" })), /方案卡已发给用户/);
	assert.equal(store.chatProjectsOf(conv).length, 1, "还是同一个项目");
	assert.equal(store.chatProjectJson(store.getChatProject(pid)!).plan.goal, "整理一份更短的小结");
	assert.deepEqual(cards(conv).map((c) => c.status), ["superseded", "pending"]);
	// 别的对话看不到、改不了这个项目
	const other = createConversation("ca", "另一个对话", { makeCurrent: false }).id;
	assert.match(await call("ca", other, "chat_plan", plan({ projectId: pid })), /not_found|项目不存在/);
	assert.equal(store.chatProjectsOf(other).length, 0);
});

test("chat_project_start：用户没回复这张方案卡不能替用户确认；用户说话之后可以；已确认的不能再确认", async () => {
	const conv = createConversation("ca", "确认测试", { makeCurrent: false }).id;
	const pid = (await call("ca", conv, "chat_plan", plan())).match(/(cp_[a-z0-9]+)/)![1];
	assert.match(await call("ca", conv, "chat_project_start", { projectId: pid }), /用户还没回复这份方案，不能替用户确认/);
	assert.equal(store.getChatProject(pid)!.status, "proposed");
	userSays(conv, "可以");
	assert.match(await call("ca", conv, "chat_project_start", { projectId: pid }), /已确认，项目「整理小结」开始了/);
	assert.equal(store.getChatProject(pid)!.status, "active");
	assert.equal(cards(conv)[0].status, "confirmed");
	assert.ok(sysTexts(conv).some((t) => /方案已确认，项目「整理小结」开始了/.test(t)));
	assert.match(await call("ca", conv, "chat_project_start", { projectId: pid }), /已经处理过了/);
	assert.match(await call("ca", conv, "chat_project_start", { projectId: "cp_nope" }), /项目不存在/);
});

test("进行中改方案写进 draft：用户确认才覆盖，先不做则按原方案继续", async () => {
	const conv = createConversation("ca", "改方案测试", { makeCurrent: false }).id;
	const pid = (await call("ca", conv, "chat_plan", plan())).match(/(cp_[a-z0-9]+)/)![1];
	store.confirmChatProject(conv, pid);
	assert.match(await call("ca", conv, "chat_plan", plan({ projectId: pid, goal: "改后的目标" })), /这是改过的方案/);
	let j = store.chatProjectJson(store.getChatProject(pid)!);
	assert.equal(j.plan.goal, "整理一份小结", "确认前按原方案");
	assert.equal(j.draft?.goal, "改后的目标");
	assert.equal(cards(conv).at(-1)!.revision, true);
	const r = store.confirmChatProject(conv, pid);
	assert.equal(r.revised, true);
	j = store.chatProjectJson(store.getChatProject(pid)!);
	assert.equal(j.plan.goal, "改后的目标");
	assert.equal(j.draft, null);
	await call("ca", conv, "chat_plan", plan({ projectId: pid, goal: "又一个目标" }));
	store.dismissChatProject(conv, pid);
	j = store.chatProjectJson(store.getChatProject(pid)!);
	assert.equal(j.plan.goal, "改后的目标", "先不做：按原方案继续");
	assert.equal(j.status, "active");
});

test("chat_stage_done：每个阶段只记一次，聊天里一条简短进度；认序号和阶段名；没开始 / 没这个阶段的被拒", async () => {
	const conv = createConversation("ca", "阶段测试", { makeCurrent: false }).id;
	const pid = (await call("ca", conv, "chat_plan", plan())).match(/(cp_[a-z0-9]+)/)![1];
	assert.match(await call("ca", conv, "chat_stage_done", { projectId: pid, stage: "1" }), /还没开始/);
	store.confirmChatProject(conv, pid);
	assert.match(await call("ca", conv, "chat_stage_done", { projectId: pid, stage: "不存在" }), /没有这个阶段「不存在」。方案的阶段：1\. 梳理要点；2\. 整理成稿/);
	const first = await call("ca", conv, "chat_stage_done", { projectId: pid, stage: "梳理要点", note: "要点清单好了" });
	assert.match(first, /已记录（1\/2）。下一个阶段：整理成稿/);
	assert.match(sysTexts(conv).at(-1)!, /项目「整理小结」：阶段「梳理要点」完成了（1\/2）——要点清单好了/);
	const n = sysTexts(conv).length;
	assert.match(await call("ca", conv, "chat_stage_done", { projectId: pid, stage: "1" }), /之前已经标过完成/);
	assert.equal(sysTexts(conv).length, n, "重复标记不再发进度");
	assert.match(await call("ca", conv, "chat_stage_done", { projectId: pid, stage: "2" }), /所有阶段都做完了.*chat_project_done/);
	assert.equal(store.chatProjectJson(store.getChatProject(pid)!).progress.done, 2);
});

test("chat_project_done：文件找不到不结束项目；交付卡 meta 和群聊同一形状（project-delivery + files），项目变 done", async () => {
	const conv = createConversation("ca", "交付测试", { makeCurrent: false }).id;
	const pid = (await call("ca", conv, "chat_plan", plan())).match(/(cp_[a-z0-9]+)/)![1];
	assert.match(await call("ca", conv, "chat_project_done", { projectId: pid, summary: "做完了" }), /还没开始/);
	store.confirmChatProject(conv, pid);
	assert.match(await call("ca", conv, "chat_project_done", { projectId: pid, summary: "" }), /请写一句结果总结/);
	assert.match(await call("ca", conv, "chat_project_done", { projectId: pid, summary: "做完了", deliverables: ["nope.md"] }), /没有结束项目：找不到这些文件：nope\.md/);
	assert.equal(store.getChatProject(pid)!.status, "active", "文件找不到：项目没结束");
	writeFileSync(join(workspaceOf("ca"), "summary.md"), "# 小结\n");
	assert.match(await call("ca", conv, "chat_project_done", { projectId: pid, summary: "小结整理好了", deliverables: ["summary.md"], howToUse: "点开看", notDone: "无" }), /已结束，交付卡已发给用户/);
	const p = store.getChatProject(pid)!;
	assert.equal(p.status, "done");
	assert.equal(p.summary, "小结整理好了");
	const delivery = cards(conv).find((c) => c.kind === "project-delivery")!;
	assert.deepEqual(Object.keys(delivery).sort(), ["files", "howToUse", "kind", "notDone", "projectId", "summary", "title"]);
	assert.equal(delivery.projectId, pid);
	assert.equal(delivery.title, "整理小结");
	const files = delivery.files as { name: string; fileId: string }[];
	assert.equal(files.length, 1);
	assert.equal(files[0].name, "summary.md");
	assert.ok(files[0].fileId);
	assert.match(await call("ca", conv, "chat_project_done", { projectId: pid, summary: "再来一次" }), /已经结束了/);
	assert.ok(!JSON.stringify(delivery).includes("花费"), "交付卡不谈花费");
});

test("工具只挂在用户可见的单聊上：群成员的群内对话、隐藏对话都没有", async () => {
	const visible = createConversation("ca", "可见", { makeCurrent: false }).id;
	assert.deepEqual([...toolsOf("ca", visible).keys()].sort(), ["chat_plan", "chat_project_done", "chat_project_start", "chat_stage_done"]);
	const hidden = createConversation("ca", "隐藏", { makeCurrent: false }).id;
	db.prepare("UPDATE conversations SET hidden = 1 WHERE id = ?").run(hidden);
	assert.equal(toolsOf("ca", hidden).size, 0);
	assert.equal(toolsOf("ca", "").size, 0);
	const room = rooms.createRoom({ name: "工具群", memberIds: ["ca", "cb"], managerId: "ca" });
	const memberConv = rooms.memberConversation(room.id, "ca");
	assert.equal(isChatConversation(memberConv), false);
	assert.equal(toolsOf("ca", memberConv).size, 0, "群会话不挂");
	assert.equal(chatPlanRules(memberConv), null, "群会话没有单聊规则");
	await rooms.deleteRoom(room.id);
});

test("单聊规则：只在单聊出现（含大事门槛）；项目的方案和进度接在后面，进度变了会话 key 就变；群规则 / 通用规则里没有", () => {
	const generic = SYSTEM_RULES("小助", "/tmp/ws", "").join("\n");
	assert.ok(!generic.includes("chat_plan"), "通用系统规则不带单聊方案规则");
	const conv = createConversation("ca", "规则测试", { makeCurrent: false }).id;
	const empty = chatPlanRules(conv)!;
	assert.deepEqual(empty.rules, CHAT_PLAN_RULE);
	assert.match(empty.rules.join("\n"), /真正多步骤的大事/);
	assert.match(empty.rules.join("\n"), /小事、闲聊、一两步就能做完的，照常直接做/);
	assert.match(empty.rules.join("\n"), /最关键的放最前面/);
	const proj = store.proposeChatPlan({ agentId: "ca", conversationId: conv, title: "整理小结", plan: normalizePlan(plan()) }).project;
	const proposed = chatPlanRules(conv)!;
	assert.match(proposed.rules.join("\n"), new RegExp(`待用户确认的方案：\\n项目「整理小结」（项目编号 ${proj.id}）`));
	assert.notEqual(proposed.key, empty.key);
	store.confirmChatProject(conv, proj.id);
	const active = chatPlanRules(conv)!;
	const text = active.rules.join("\n");
	assert.match(text, /进行中的项目：/);
	assert.match(text, /关键点（到了请用户看一眼，用 ask_user）：要点出来后请你看一眼/, "单聊的关键点用 ask_user，不是群聊的 room_checkpoint");
	assert.ok(!text.includes("room_checkpoint"));
	assert.match(text, /进度：已完成 0\/2\n1\. 梳理要点（进行中）/);
	assert.notEqual(active.key, proposed.key);
	store.markStageDone(conv, proj.id, 0, "");
	const after = chatPlanRules(conv)!;
	assert.match(after.rules.join("\n"), /进度：已完成 1\/2\n1\. 梳理要点（已完成）\n2\. 整理成稿（进行中）/);
	assert.notEqual(after.key, active.key, "阶段进度变了，key 跟着变");
	store.stopChatProject(conv, proj.id);
	assert.deepEqual(chatPlanRules(conv)!.rules, CHAT_PLAN_RULE, "结束的项目不再进规则");
});

test("HTTP：列项目（?all=1 含已结束）、确认（叫醒助理）、先不做、停下（中止手上的活）；不存在的对话 404", async () => {
	const proto = Object.getPrototypeOf(R.runtime("ca", "conv_probe")) as Record<string, unknown>;
	const nudges: string[] = [];
	let aborted = 0;
	proto.nudge = async (text: string) => (nudges.push(text), true);
	proto.abort = async () => void aborted++;
	const app = new Hono();
	mountChatProjectRoutes(app as never);
	const post = (path: string) => app.request(path, { method: "POST" });
	const conv = createConversation("ca", "接口测试", { makeCurrent: false }).id;
	const a = store.proposeChatPlan({ agentId: "ca", conversationId: conv, title: "项目甲", plan: normalizePlan(plan()) }).project;
	const b = store.proposeChatPlan({ agentId: "ca", conversationId: conv, title: "项目乙", plan: normalizePlan(plan()) }).project;
	assert.equal((await app.request("/api/conversations/nope/projects")).status, 404);
	let list = (await (await app.request(`/api/conversations/${conv}/projects`)).json()) as { projects: { id: string; status: string; progress: { total: number } }[] };
	assert.deepEqual(list.projects.map((p) => p.id), [a.id, b.id]);
	assert.equal(list.projects[0].progress.total, 2);

	const ok = await post(`/api/conversations/${conv}/projects/${a.id}/confirm`);
	assert.equal(ok.status, 200);
	assert.equal(store.getChatProject(a.id)!.status, "active");
	assert.deepEqual(nudges, [confirmWakeText("项目甲", a.id, false)], "用户确认后叫醒助理开工");
	assert.match(nudges[0], /^（用户确认了项目「项目甲」（项目编号 cp_/);
	assert.equal((await post(`/api/conversations/${conv}/projects/${a.id}/confirm`)).status, 409, "已处理过的方案再确认 409");
	assert.equal((await post(`/api/conversations/${conv}/projects/cp_nope/confirm`)).status, 404);
	assert.equal((await post(`/api/conversations/other/projects/${a.id}/confirm`)).status, 404, "别的对话不能动这个项目");

	assert.equal((await post(`/api/conversations/${conv}/projects/${b.id}/dismiss`)).status, 200);
	assert.equal(store.getChatProject(b.id)!.status, "dismissed");
	assert.equal(nudges.length, 1, "先不做不叫醒助理");
	assert.equal((await post(`/api/conversations/${conv}/projects/${b.id}/stop`)).status, 409, "没开始的不能停");

	assert.equal((await post(`/api/conversations/${conv}/projects/${a.id}/stop`)).status, 200);
	assert.equal(store.getChatProject(a.id)!.status, "stopped");
	assert.equal(aborted, 1, "停下项目时中止助理手上的活");
	list = (await (await app.request(`/api/conversations/${conv}/projects?all=1`)).json()) as typeof list;
	assert.deepEqual(list.projects.map((p) => p.status).sort(), ["dismissed", "stopped"]);
	assert.equal((await (await app.request(`/api/conversations/${conv}/projects`)).json() as { projects: unknown[] }).projects.length, 0);
});

test("删对话：这个对话的单聊项目一并删掉，不留孤儿行", () => {
	const conv = createConversation("ca", "会被删的对话", { makeCurrent: false }).id;
	const proj = store.proposeChatPlan({ agentId: "ca", conversationId: conv, title: "要被清掉的项目", plan: normalizePlan(plan()) }).project;
	assert.ok(store.getChatProject(proj.id));
	deleteConversation(conv);
	assert.equal(store.getChatProject(proj.id), undefined);
});
