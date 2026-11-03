import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/** 群里只沟通、干活转后台（决策 0026）：让出发言位、没 @ 交给管理者、同成员改插话、停止中止后台、按大小整理。真实调度 + Mock 模型，临时数据。 */
const { db, now } = await import("../src/db.ts");
const R = await import("../src/runtime.ts");
const rooms = await import("../src/rooms/index.ts");
const { shouldDetach, interjectsCurrent, tidyInstructions } = await import("../src/rooms/logic.ts");
const { maybeTidyMember, tidyingOf } = await import("../src/rooms/after-delivery.ts");
const { memberConversation } = await import("../src/rooms/store.ts");
const { insertMessage } = await import("../src/messages.ts");

// 假的模型回合（不起模型、不付费）：每个成员的 turn 挂着，直到测试放行；工具步骤由测试触发
type Res = { ok: boolean; aborted: boolean; error?: string; text: string; tokens: number };
const live = new Map<string, { finish: (r?: Partial<Res>) => void; step: (n: number) => void }>();
const steered: { agentId: string; text: string }[] = [];
const compacted: string[] = [];
const proto = Object.getPrototypeOf(R.runtime("fm", "conv_probe")) as Record<string, unknown>;
proto.turn = function (this: { id: string }, _p: string, _f: unknown, opts: { onToolStep?: (n: number) => void } = {}) {
	return new Promise<Res>((resolve) => {
		live.set(this.id, { finish: (r = {}) => (live.delete(this.id), resolve({ ok: true, aborted: false, text: "", tokens: 0, ...r })), step: (n) => opts.onToolStep?.(n) });
	});
};
proto.send = async function (this: { id: string }, text: string) {
	steered.push({ agentId: this.id, text });
	return "steered";
};
proto.abort = async function (this: { id: string }) {
	live.get(this.id)?.finish({ ok: false, aborted: true });
};
proto.compact = async function (this: { id: string }) {
	compacted.push(this.id);
};
Object.defineProperty(proto, "busy", { get(this: { id: string }) { return live.has(this.id); } });

const mkAgent = (id: string, name: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#111", now());
mkAgent("fm", "总管");
mkAgent("fa", "阿甲");
mkAgent("fb", "阿乙");

const wait = async (fn: () => boolean, what: string, ms = 3000) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`${what}超时`);
};
const turns = (roomId: string, agent?: string) => db.prepare(`SELECT id, agent_id, reason, status FROM room_turns WHERE room_id = ? ${agent ? "AND agent_id = ?" : ""} ORDER BY created_at, rowid`).all(...(agent ? [roomId, agent] : [roomId])) as { id: string; agent_id: string; reason: string; status: string }[];
const idle = (roomId: string) => !rooms.stateOf(roomId).running && !turns(roomId).some((t) => t.status === "queued" || t.status === "running");
const bg = (roomId: string) => (rooms.stateOf(roomId) as { background?: string[] }).background ?? [];
const cur = (roomId: string) => rooms.stateOf(roomId).current?.agentId;

test("纯逻辑：做完 3 个工具步骤 / 跑满 60 秒 / 被要求让位才让出发言位", () => {
	assert.equal(shouldDetach({ toolSteps: 2, elapsedMs: 59_999 }), false);
	assert.equal(shouldDetach({ toolSteps: 3, elapsedMs: 0 }), true);
	assert.equal(shouldDetach({ toolSteps: 0, elapsedMs: 60_000 }), true);
	assert.equal(shouldDetach({ toolSteps: 0, elapsedMs: 0, yieldRequested: true }), true);
});

test("纯逻辑：没 @ 人只有管理者接插话；@ 谁给谁；引用定向照旧", () => {
	const o = { mentionedIds: [] as string[], directedIds: null as string[] | null, managerId: "m" };
	assert.equal(interjectsCurrent({ ...o, currentId: "m" }), true);
	assert.equal(interjectsCurrent({ ...o, currentId: "a" }), false);
	assert.equal(interjectsCurrent({ ...o, currentId: "a", mentionedIds: ["a"] }), true);
	assert.equal(interjectsCurrent({ ...o, currentId: "a", mentionedIds: ["b"] }), false);
	assert.equal(interjectsCurrent({ ...o, currentId: "a", directedIds: ["a"] }), true);
	assert.equal(interjectsCurrent({ ...o, currentId: "m", directedIds: ["a"] }), false);
});

test("按大小整理的说明：要求保留进行中的事，项目状态以数据库为准", () => {
	const t = tidyInstructions([{ title: "拍片", status: "active" }], [], "size");
	assert.match(t, /变长之后/);
	assert.match(t, /「拍片」：进行中/);
	assert.match(t, /进行中的任务和项目做到哪一步/);
	assert.match(t, /答应过/);
	assert.match(t, /文件的名字和路径/);
	assert.match(t, /关键决定/);
	assert.doesNotMatch(tidyInstructions([], [], "delivered"), /变长之后/);
});

test("做完 3 个工具步骤就让出发言位：下一位马上能说，原回合在后台继续，结束后照常收尾", async () => {
	const room = rooms.createRoom({ name: "步骤群", memberIds: ["fm", "fa", "fb"], managerId: "fm" });
	rooms.postUserMessage(room.id, "@阿甲 @阿乙 都说一下", { mentions: ["fa", "fb"] });
	await wait(() => cur(room.id) === "fa", "阿甲发言");
	live.get("fa")!.step(2);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(cur(room.id), "fa", "2 步还不让位");
	live.get("fa")!.step(3);
	await wait(() => cur(room.id) === "fb", "阿乙接着发言");
	assert.deepEqual(bg(room.id), ["fa"]);
	assert.equal(rooms.stateOf(room.id).running, true);
	assert.equal(turns(room.id, "fa")[0].status, "running", "回合没中断");
	live.get("fb")!.finish();
	await wait(() => turns(room.id, "fb")[0].status === "done", "阿乙说完");
	assert.deepEqual(bg(room.id), ["fa"], "阿甲还在后台干");
	live.get("fa")!.finish({ text: "做完了" });
	await wait(() => turns(room.id, "fa")[0].status === "done" && idle(room.id), "阿甲在后台做完并收尾");
	assert.deepEqual(bg(room.id), []);
});

test("跑满时间让位；同一成员排到时改插话（不另开一轮）；停止把后台回合一起中止", async () => {
	process.env.PIA_DETACH_MS = "150";
	const room = rooms.createRoom({ name: "时间群", memberIds: ["fm", "fa", "fb"], managerId: "fm" });
	rooms.postUserMessage(room.id, "@阿甲 慢慢做", { mentions: ["fa"] });
	await wait(() => bg(room.id).includes("fa") && !cur(room.id), "跑满时间转后台");
	rooms.postUserMessage(room.id, "@阿甲 顺便加一点", { mentions: ["fa"] });
	await wait(() => turns(room.id, "fa").length === 2 && turns(room.id, "fa")[1].status === "done", "第二轮记为完成");
	assert.equal(steered.filter((x) => x.agentId === "fa").length, 1, "内容当插话送进去");
	assert.match(steered[steered.length - 1].text, /顺便加一点/);
	assert.equal(turns(room.id, "fa")[0].status, "running", "原来的回合没被换掉");
	assert.equal(cur(room.id), undefined, "没有另开一轮占发言位");
	await rooms.stop(room.id, false);
	assert.deepEqual(bg(room.id), []);
	await wait(() => idle(room.id), "群停下");
	assert.equal(turns(room.id, "fa")[0].status, "cancelled", "后台回合被中止");
	assert.equal(live.has("fa"), false);
	delete process.env.PIA_DETACH_MS;
});

test("没 @ 人时发言的是成员：不塞给它，它让位，马上排管理者；管理者在后台时插话给管理者", async () => {
	const room = rooms.createRoom({ name: "路由群", memberIds: ["fm", "fa", "fb"], managerId: "fm" });
	rooms.postUserMessage(room.id, "@阿甲 做点事", { mentions: ["fa"] });
	await wait(() => cur(room.id) === "fa", "阿甲发言");
	rooms.postUserMessage(room.id, "大家现在怎么样");
	await wait(() => cur(room.id) === "fm", "马上排到管理者");
	assert.deepEqual(bg(room.id), ["fa"], "阿甲让位转后台");
	assert.equal(steered.some((x) => x.agentId === "fa" && /现在怎么样/.test(x.text)), false, "没有塞给阿甲");
	assert.equal(turns(room.id, "fa").length, 1);
	// 管理者也按同一规则让位；它在后台时，再来一条没 @ 的消息当插话送给它
	live.get("fm")!.step(3);
	await wait(() => bg(room.id).includes("fm") && !cur(room.id), "管理者转后台");
	const n = steered.length;
	rooms.postUserMessage(room.id, "再问一句");
	await wait(() => steered.length === n + 1 && steered[n].agentId === "fm", "插话给管理者");
	assert.equal(turns(room.id, "fm").length, 2);
	assert.equal(turns(room.id, "fm")[1].status, "done");
	live.get("fa")!.finish();
	live.get("fm")!.finish();
	await wait(() => idle(room.id), "都做完");
});

test("按大小整理：成员回合结束后只整理这一位（超过阈值时）；整理期间这位的下一轮先等；没超过的不整理", async () => {
	process.env.PIA_TIDY_MIN_TOKENS = "1000";
	const room = rooms.createRoom({ name: "整理群", memberIds: ["fm", "fa", "fb"], managerId: "fm" });
	const usage = (input: number) => ({ usage: { input, output: 10, cacheRead: 0, cacheWrite: 0 } });
	insertMessage({ agentId: "fa", conversationId: memberConversation(room.id, "fa"), roomId: room.id, role: "assistant", content: "好的", status: "done", meta: usage(5000) });
	insertMessage({ agentId: "fb", conversationId: memberConversation(room.id, "fb"), roomId: room.id, role: "assistant", content: "好的", status: "done", meta: usage(200) });
	compacted.length = 0;
	rooms.postUserMessage(room.id, "@阿甲 @阿乙 说一下", { mentions: ["fa", "fb"] });
	await wait(() => cur(room.id) === "fa", "阿甲发言");
	live.get("fa")!.finish();
	await wait(() => cur(room.id) === "fb", "阿乙发言");
	live.get("fb")!.finish();
	await wait(() => idle(room.id), "说完");
	await wait(() => compacted.length > 0, "开始整理");
	assert.deepEqual(compacted, ["fa"], "只整理超过阈值的这一位");
	// 整理期间下一轮先等：整理没做完时，阿甲的新回合还没开始
	let done!: () => void;
	proto.compact = function (this: { id: string }) {
		compacted.push(this.id);
		return new Promise<void>((r) => (done = r));
	};
	maybeTidyMember(room.id, "fa", memberConversation(room.id, "fa"));
	await wait(() => !!tidyingOf(room.id, "fa"), "整理开始");
	rooms.postUserMessage(room.id, "@阿甲 再来", { mentions: ["fa"] });
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(live.has("fa"), false, "整理没完，阿甲还没开始下一轮");
	done();
	await wait(() => live.has("fa"), "整理完成后开始下一轮");
	live.get("fa")!.finish();
	await wait(() => idle(room.id), "说完");
	delete process.env.PIA_TIDY_MIN_TOKENS;
});
