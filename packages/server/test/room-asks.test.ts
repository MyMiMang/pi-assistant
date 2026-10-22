/**
 * 成员直接协作（决策 0019 第 4 步，docs/design/group-team.md 第 5 节）：可追踪的提问（ask_colleague / answer_colleague）、
 * 轮数上限与超时交给管理者、上游有问题（report_upstream / work_rework）、上游出新版本交给下游。环境见 work-items-harness.ts。
 */
import "./work-items-harness.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ASK_TIMEOUT_MS, MAX_ASK_ROUNDS, askIdOf, askStep } from "../src/rooms/ask-logic.ts";
import { findByName } from "../src/work-items/store.ts";
import { askTools } from "../src/rooms/ask-tools.ts";
import { getAsk, asksOfItem } from "../src/rooms/asks.ts";
import { type Call, R, S, W, calls, db, mgr, now, room, rooms, row, runRows, settle, submit, user } from "./work-items-harness.ts";

// 帮手 driver 换成能记录「插话」的版本（harness 的 driver 把插话丢掉了）；群会话的假回合可以按成员指定回复文字
const steered: { helperId: string; conv: string; text: string }[] = [];
S.setSubagentDriver({
	run: (r, connect, input) =>
		new Promise<string>((resolve, reject) => {
			const c: Call = { agentId: r.agent_id, conv: r.conversation_id, prompt: input?.text ?? r.task, helperId: r.id, done: false, finish: (x = {}) => { if (c.done) return; c.done = true; if (x.error) reject(new Error(x.error)); else resolve(x.text ?? ""); } };
			calls.push(c);
			connect(async () => c.finish({ aborted: true }), async (text: string) => void steered.push({ helperId: r.id, conv: r.conversation_id, text }));
		}),
	notify: async () => {},
});
const replies = new Map<string, string>();
(Object.getPrototypeOf(R.runtime("wm", "conv_probe")) as Record<string, unknown>).turn = function (this: { id: string; conversationId: string }, prompt: string) {
	calls.push({ agentId: this.id, conv: this.conversationId, prompt, done: true, finish: () => {} });
	return Promise.resolve({ ok: true, aborted: false, text: replies.get(this.id) ?? "", tokens: 0 });
};

type Tools = Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>;
function toolsFor(agentId: string, itemId?: string): Tools {
	const defs: Tools = new Map();
	askTools(room.id, agentId, itemId)({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
	return defs;
}
const call = async (t: Tools, name: string, p: Record<string, unknown>) => (await t.get(name)!.execute("t", p)).content[0].text;
const until = async (fn: () => boolean, what: string, ms = 3000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`${what}超时`);
};
const msgs = (kind: string) => (db.prepare("SELECT agent_id, content, meta FROM messages WHERE room_id = ? ORDER BY rowid").all(room.id) as { agent_id: string; content: string; meta: string }[]).map((m) => ({ ...m, meta: JSON.parse(m.meta) as Record<string, unknown> })).filter((m) => m.meta.kind === kind);
const promptTo = (agentId: string, re: RegExp) => calls.some((c) => c.agentId === agentId && c.done && re.test(c.prompt));
const startItem = async (owner: string, title: string, o: Partial<{ after: string[] }> = {}) => {
	const id = W.createWorkItem({ roomId: room.id, title, requirement: "写一份可检查的结果", doneCriteria: "结果里能看到检查点", ownerAgentId: owner, start: true, ...o }, user).item.id;
	await settle();
	return id;
};
const submitWith = (c: Call, p: { result: string; handoff?: string }) => W.submitWorkItem({ workItemId: W.execOf(c.conv)!.work_item_id, conversationId: c.conv, actor: { kind: "agent", agentId: c.agentId }, ...p });
const execCall = (itemId: string) => [...calls].reverse().find((c) => W.execOf(c.conv)?.work_item_id === itemId && !c.done);

test("askStep / 名字解析 / 提问编号（纯逻辑）", () => {
	const base = { now: 100_000, updatedAt: 99_000, timeoutMs: 20 * 60_000 };
	assert.equal(askStep({ ...base, rounds: 0, status: "open" }), "ok");
	assert.equal(askStep({ ...base, rounds: 2, status: "answered" }), "ok");
	assert.equal(askStep({ ...base, rounds: MAX_ASK_ROUNDS, status: "answered" }), "too_many_rounds");
	assert.equal(askStep({ ...base, rounds: 1, status: "open", now: 99_000 + 20 * 60_000 }), "timeout");
	assert.equal(askStep({ ...base, rounds: 1, status: "answered", now: 99_000 + 60 * 60_000 }), "ok", "已回答的不算超时");
	assert.equal(askStep({ ...base, rounds: 5, status: "escalated" }), "ok", "已交给管理者的不再判");
	assert.equal(findByName([{ name: "甲" }, { name: "Bob" }], "@bob")?.name, "Bob");
	assert.equal(findByName([{ name: "甲" }], " "), undefined);
	assert.equal(askIdOf("甲 向你提问（提问编号 ask_abc123x）：…"), "ask_abc123x");
	assert.equal(ASK_TIMEOUT_MS(), 20 * 60_000);
});

test("ask_colleague 新提问：记录 + 群里一条 peer-ask + 叫醒被问的人（带提问编号）；回答送回在跑的提问者；只有被问的人能答", async () => {
	const itemA = await startItem("wa", "提问者的任务");
	const t = toolsFor("wa", itemA);
	const out = await call(t, "ask_colleague", { to: "乙", question: "数据口径按哪个版本？" });
	assert.match(out, /已经问了 乙.*先做不依赖这个答案的部分/);
	const ask = (db.prepare("SELECT id FROM room_asks WHERE from_item = ?").get(itemA) as { id: string }).id;
	assert.deepEqual([getAsk(ask)!.status, getAsk(ask)!.rounds, getAsk(ask)!.kind], ["open", 0, "question"]);
	const q = msgs("peer-ask").pop()!;
	assert.equal(q.agent_id, "wa");
	assert.match(q.content, /^@乙 数据口径/);
	assert.deepEqual([q.meta.askId, q.meta.to, q.meta.toName, q.meta.from, q.meta.rounds], [ask, "wb", "乙", "wa", 1]);
	await until(() => promptTo("wb", new RegExp(`提问编号 ${ask}`)), "乙被叫醒");
	assert.match(await call(toolsFor("wa"), "answer_colleague", { askId: ask, answer: "不对" }), /只有被问的人/);
	assert.match(await call(toolsFor("wm"), "answer_colleague", { askId: ask, answer: "不对" }), /只有被问的人/);
	assert.match(await call(t, "ask_colleague", { to: "不存在", question: "x" }), /找不到成员/);
	assert.match(await call(t, "ask_colleague", { to: "甲", question: "x" }), /不能问自己/);
	assert.match(await call(t, "ask_colleague", { to: "乙", question: "再问", askId: ask }), /还没回答/);

	const s0 = steered.length;
	assert.match(await call(toolsFor("wb"), "answer_colleague", { askId: ask, answer: "按第一版口径" }), /已回答/);
	const a = getAsk(ask)!;
	assert.deepEqual([a.status, a.rounds], ["answered", 1]);
	const ans = msgs("peer-answer").pop()!;
	assert.deepEqual([ans.agent_id, ans.content, ans.meta.askId, ans.meta.rounds], ["wb", "按第一版口径", ask, 1]);
	assert.equal(steered.length, s0 + 1, "回答递进了提问者正在跑的任务会话");
	assert.match(steered[s0].text, /乙 回答了你的提问.*按第一版口径/);
	assert.match(await call(toolsFor("wb"), "answer_colleague", { askId: ask, answer: "再答" }), /已经回答过/);
	assert.deepEqual(asksOfItem(itemA).map((x) => [x.id, x.toName, x.status, x.rounds, x.question]), [[ask, "乙", "answered", 1, "数据口径按哪个版本？"]]);
	execCall(itemA)?.finish();
	await W.cancelWorkItem({ workItemId: itemA, actor: user });
});

test("追问：同一段对话；来回到上限后再追问不再递给对方，交给管理者（系统通知 + 唤醒管理者带摘要和编号）", async () => {
	const t = toolsFor("wa");
	await call(t, "ask_colleague", { to: "乙", question: "第一问" });
	const ask = (db.prepare("SELECT id FROM room_asks WHERE from_agent = 'wa' AND from_item IS NULL ORDER BY created_at DESC, rowid DESC").get() as { id: string }).id;
	for (let n = 1; n <= MAX_ASK_ROUNDS; n++) {
		await call(toolsFor("wb"), "answer_colleague", { askId: ask, answer: `第${n}答` });
		assert.equal(getAsk(ask)!.rounds, n);
		if (n < MAX_ASK_ROUNDS) {
			assert.match(await call(t, "ask_colleague", { to: "乙", question: `第${n + 1}问`, askId: ask }), /追问了 乙/);
			assert.deepEqual([getAsk(ask)!.status, getAsk(ask)!.rounds], ["open", n], "追问把同一条提问改回等待回答");
			assert.equal(msgs("peer-ask").filter((m) => m.meta.askId === ask).pop()!.meta.rounds, n + 1);
		}
	}
	const asksBefore = msgs("peer-ask").length;
	const w0 = calls.filter((c) => /任务看板有变化/.test(c.prompt)).length;
	const peerTurnsToB = () => calls.filter((c) => c.agentId === "wb" && new RegExp(`提问编号 ${ask}`).test(c.prompt)).length;
	const b0 = peerTurnsToB();
	assert.match(await call(t, "ask_colleague", { to: "乙", question: "第4问", askId: ask }), /交给管理者/);
	assert.equal(getAsk(ask)!.status, "escalated");
	assert.equal(msgs("peer-ask").length, asksBefore + 1, "追问的话仍然发在群里");
	assert.ok(msgs("peer-ask-escalated").some((m) => m.meta.askId === ask && /来回 3 轮还没解决，已交给管理者/.test(m.content)));
	await until(() => calls.filter((c) => /任务看板有变化/.test(c.prompt)).length > w0, "管理者被唤醒");
	const wake = calls.filter((c) => /任务看板有变化/.test(c.prompt)).pop()!.prompt;
	assert.match(wake, new RegExp(`提问编号 ${ask}`));
	assert.match(wake, /第3答/);
	assert.equal(peerTurnsToB(), b0, "第 4 轮没有再递给乙");
	assert.match(await call(t, "ask_colleague", { to: "乙", question: "又问", askId: ask }), /已经交给管理者/);
	// 管理者可以代答，回答送回提问者（这里提问者没有在跑的执行，只发在群里）
	assert.match(await call(toolsFor("wm"), "answer_colleague", { askId: ask, answer: "管理者定：按第一版" }), /已回答/);
	assert.equal(getAsk(ask)!.status, "answered");
	assert.equal(msgs("peer-answer").pop()!.meta.onBehalfOf, "wb");
});

test("超时：提问 open 超过 ASK_TIMEOUT_MS 没人答 → 定时检查交给管理者；已回答的不受影响", async () => {
	process.env.PIA_ASK_TIMEOUT_MS = "60000";
	try {
		const t = toolsFor("wa");
		await call(t, "ask_colleague", { to: "乙", question: "没人回的问题" });
		const ask = (db.prepare("SELECT id FROM room_asks WHERE from_agent = 'wa' ORDER BY created_at DESC, rowid DESC").get() as { id: string }).id;
		const w0 = calls.filter((c) => /任务看板有变化/.test(c.prompt)).length;
		rooms.runRoomChecks(now() + 30_000);
		assert.equal(getAsk(ask)!.status, "open", "还没到时间");
		rooms.runRoomChecks(now() + 61_000);
		assert.equal(getAsk(ask)!.status, "escalated");
		assert.ok(msgs("peer-ask-escalated").some((m) => m.meta.askId === ask && /问题「没人回的问题」1 分钟没回，已交给管理者/.test(m.content)));
		await until(() => calls.filter((c) => /任务看板有变化/.test(c.prompt)).length > w0 && calls.some((c) => c.agentId === "wm" && c.prompt.includes(`提问编号 ${ask}`)), "管理者被叫醒并带编号");
	} finally {
		delete process.env.PIA_ASK_TIMEOUT_MS;
	}
});

test("回答送回提问者：没有在跑的执行但任务还在进行 → 带着问题和回答重新开始一次；任务已结束 → 只发在群里", async () => {
	const item = await startItem("wa", "会中断的任务");
	const t = toolsFor("wa", item);
	await call(t, "ask_colleague", { to: "乙", question: "问一件事" });
	const ask = (db.prepare("SELECT id FROM room_asks WHERE from_item = ?").get(item) as { id: string }).id;
	execCall(item)!.finish({ text: "没提交就结束了" }); // 执行结束、没提交：任务还是进行中
	await settle();
	assert.equal(row(item).status, "active");
	const runs0 = runRows(item).length;
	const retries = row(item).autoRetries;
	assert.match(await call(toolsFor("wb"), "answer_colleague", { askId: ask, answer: "答案是甲方案" }), /重新开始/);
	await settle();
	assert.equal(runRows(item).length, runs0 + 1, "重新跑了一次");
	const c = execCall(item)!;
	assert.match(c.prompt, /派活说明：乙 回答了你的提问「问一件事」.*答案是甲方案/s);
	assert.equal(row(item).autoRetries, retries, "不占自动重试次数");
	c.finish();
	await W.cancelWorkItem({ workItemId: item, actor: user });
	// 任务已取消：只发在群里
	await call(toolsFor("wa"), "ask_colleague", { to: "乙", question: "又问", workItemId: item });
	const ask2 = (db.prepare("SELECT id FROM room_asks WHERE from_item = ? ORDER BY created_at DESC, rowid DESC").get(item) as { id: string }).id;
	const n = runRows(item).length;
	assert.match(await call(toolsFor("wb"), "answer_colleague", { askId: ask2, answer: "晚了" }), /已发在群里/);
	assert.equal(runRows(item).length, n);
});

test("被问的人只在回合里说了话没调 answer_colleague：这段话就是回答（不再重复发群），照样送回提问者", async () => {
	const item = await startItem("wa", "兜底回答的任务");
	replies.set("wb", "我觉得就这样");
	try {
		const s0 = steered.length;
		const before = msgs("peer-answer").length;
		await call(toolsFor("wa", item), "ask_colleague", { to: "乙", question: "随便问问" });
		const ask = (db.prepare("SELECT id FROM room_asks WHERE from_item = ?").get(item) as { id: string }).id;
		await until(() => getAsk(ask)!.status === "answered", "回合文字被当作回答", 5000);
		assert.equal(msgs("peer-answer").length, before, "已经在群里说过，不重复发");
		assert.match(steered[s0].text, /我觉得就这样/);
	} finally {
		replies.delete("wb");
	}
	execCall(item)?.finish();
	await W.cancelWorkItem({ workItemId: item, actor: user });
});

test("问管理者：用唤醒管理者的方式带问题和编号", async () => {
	const w0 = calls.length;
	await call(toolsFor("wa"), "ask_colleague", { to: "经理", question: "目标范围要不要扩大？" });
	const ask = (db.prepare("SELECT id FROM room_asks WHERE to_agent = 'wm' ORDER BY created_at DESC, rowid DESC").get() as { id: string }).id;
	await until(() => calls.slice(w0).some((c) => c.agentId === "wm" && c.prompt.includes(`提问编号 ${ask}`) && /目标范围要不要扩大/.test(c.prompt)), "管理者被叫醒");
	assert.match(calls.slice(w0).find((c) => c.agentId === "wm" && c.prompt.includes(ask))!.prompt, /任务看板有变化/);
	assert.match(await call(toolsFor("wm"), "answer_colleague", { askId: ask, answer: "不扩大" }), /已回答/);
});

test("report_upstream 只能针对自己任务的前置任务；work_rework 只有被指出问题（有 open 的上游提问）时负责人本人才能用", async () => {
	const up = await startItem("wa", "上游成果");
	const cu = execCall(up)!;
	submitWith(cu, { result: "上游做完", handoff: "成果在 out.txt" });
	cu.finish();
	await settle();
	await W.verifyWorkItem({ workItemId: up, actor: mgr, verdict: "pass", note: "第一次通过" });
	const down = await startItem("wb", "下游任务", { after: [up] });
	assert.equal(row(down).status, "active");
	const other = await startItem("wb", "无关任务");
	const tb = toolsFor("wb", down);
	assert.match(await call(toolsFor("wb", other), "report_upstream", { workItemId: up, issue: "x" }), /不是你负责的任务的前置任务/);
	assert.match(await call(tb, "report_upstream", { workItemId: "不存在", issue: "x" }), /找不到任务/);
	assert.match(await call(toolsFor("wa", up), "report_upstream", { workItemId: up, issue: "x" }), /不是你负责的任务的前置任务/);

	assert.match(await call(toolsFor("wa"), "work_rework", { workItemId: up, why: "想重做" }), /没有同事指出/);
	assert.match(await call(tb, "report_upstream", { workItemId: "上游成果", issue: "第 3 行没有来源链接" }), /已经告诉 甲/);
	const ask = (db.prepare("SELECT id, kind, target_item, to_agent, from_item FROM room_asks WHERE kind = 'upstream' ORDER BY created_at DESC, rowid DESC").get() as { id: string; kind: string; target_item: string; to_agent: string; from_item: string });
	assert.deepEqual([ask.kind, ask.target_item, ask.to_agent, ask.from_item], ["upstream", up, "wa", down]);
	assert.match(msgs("peer-ask").pop()!.content, /^@甲 「上游成果」的成果有问题：第 3 行没有来源链接/);
	await until(() => promptTo("wa", new RegExp(`提问编号 ${ask.id}[\\s\\S]*work_rework`)), "上游负责人被叫醒");
	assert.deepEqual(asksOfItem(up).map((x) => x.id), [ask.id], "任务详情的提问也包含被指有问题的上游任务");
	assert.match(await call(toolsFor("wb"), "work_rework", { workItemId: up, why: "我来改" }), /只有任务负责人/);

	// 上游负责人确认有问题：重开成新修订并马上重做，提问标 answered
	const rev = row(up).revision;
	assert.match(await call(toolsFor("wa"), "work_rework", { workItemId: up, why: "补上第 3 行的来源链接" }), /已重开「上游成果」/);
	await settle();
	assert.equal(row(up).status, "active");
	assert.equal(row(up).revision, rev + 1);
	assert.deepEqual([getAsk(ask.id)!.status, getAsk(ask.id)!.rounds], ["answered", 1]);
	const c2 = execCall(up)!;
	assert.match(c2.prompt, /派活说明：按同事指出的问题重做：补上第 3 行的来源链接/);
	assert.ok(steered.some((s) => /甲 回答了你的提问.*确认有问题，已重开重做/s.test(s.text)), "下游收到回答");

	// 重新提交 + 核验通过：在跑的下游收到「出了新版本」+ 交接单
	const s0 = steered.length;
	submitWith(c2, { result: "补上了来源链接", handoff: "新版成果在 out.txt，第 3 行有来源" });
	c2.finish();
	await settle();
	await W.verifyWorkItem({ workItemId: up, actor: mgr, verdict: "pass", note: "第二次通过" });
	const got = steered.slice(s0).filter((s) => /出了新版本/.test(s.text));
	assert.equal(got.length, 1);
	assert.match(got[0].text, /上游任务「上游成果」出了新版本/);
	assert.match(got[0].text, /交接说明：新版成果在 out\.txt/);
	assert.equal(got[0].helperId, (db.prepare("SELECT exec_id FROM work_item_runs WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC").get(down) as { exec_id: string }).exec_id);

	// 已经 done 的下游：叫醒管理者决定要不要跟着改（不直接动它）
	const done = W.createWorkItem({ roomId: room.id, title: "已完成的下游", requirement: "r", doneCriteria: "d", ownerAgentId: "wb", start: false, after: [up] }, user).item.id;
	db.prepare("UPDATE work_items SET status = 'done' WHERE id = ?").run(done);
	const w0 = calls.length;
	W.deliverNewVersion(W.itemRow(up)!);
	await until(() => calls.slice(w0).some((c) => c.agentId === "wm" && /上游任务「上游成果」重新核验通过、出了新版本.*「已完成的下游」/s.test(c.prompt)), "管理者被叫醒");
	assert.equal(row(done).status, "done");
	execCall(down)?.finish();
	await W.cancelWorkItem({ workItemId: down, actor: user });
	await W.cancelWorkItem({ workItemId: other, actor: user }).catch(() => {});
});

test("第一次核验通过不算新版本：下游不会被打扰", async () => {
	const up = await startItem("wa", "第一次交付");
	const down = await startItem("wb", "等第一次的下游", { after: [up] }).catch(() => ""); // 前置没完成：停在待安排
	const c = execCall(up)!;
	submit(c, { result: "完成" });
	c.finish();
	await settle();
	const s0 = steered.length;
	await W.verifyWorkItem({ workItemId: up, actor: mgr, verdict: "pass", note: "通过" });
	assert.equal(steered.slice(s0).filter((s) => /出了新版本/.test(s.text)).length, 0);
	if (down) await W.cancelWorkItem({ workItemId: down, actor: user });
});
