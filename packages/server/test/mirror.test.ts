/**
 * Pi Assistant 是唯一事实来源：每条消息先写进助理的 Pi Assistant 对话（并 Web Push），再把副本镜像到渠道。
 * - 主动提醒：App 里先有，然后扇出到所有已连接渠道的单聊（不发到群）；“只用 App”时不镜像
 * - 微信发不出去（DeferredSend）：App 里照样立刻有，只有微信那份排队
 * - 渠道里的回复（审批回答、指令）落进同一个对话，带渠道标记
 * - 定时任务结果同样先 App 后渠道
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { db, now } = await import("../src/db.ts");
db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run("ma", "小镜", "M", "#000", now());
db.prepare("UPDATE agents SET proactivity = 'high' WHERE id = 'ma'").run();
const ch = await import("../src/channels/index.ts");
const { DeferredSend } = await import("../src/channels/types.ts");
const P = await import("../src/proactive.ts");
const { currentConversation } = await import("../src/conversations.ts");
const { requests } = await import("../src/requests.ts");
const { bus } = await import("../src/bus.ts");
const push = await import("../src/push.ts");
const pushed = (title: RegExp) => push.pushLog.some((p) => title.test(p.title));

const sent: { ch: string; text: string; inApp: boolean }[] = [];
const inApp = (text: string) => !!db.prepare("SELECT 1 FROM messages WHERE agent_id = 'ma' AND instr(content, ?) > 0").get(text.split("\n").pop()!.slice(0, 20));
function fake(id: string, opts: { defer?: boolean } = {}) {
	ch._setAdapterForTest(id, {
		start: async () => {},
		stop: async () => {},
		send: async (_ctx: unknown, text: string) => {
			if (opts.defer) throw new DeferredSend("用户超过 23 小时没发消息，微信不允许现在发");
			sent.push({ ch: id, text, inApp: inApp(text) });
		},
		canPush: () => (opts.defer ? { ok: false, reason: "窗口外" } : { ok: true }),
	} as never);
}
const wait = async (pred: () => boolean, ms = 3000) => {
	for (let t = Date.now(); Date.now() - t < ms; ) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("等待超时");
};
const old = now() - 3 * 86400_000;
for (const [id, kind] of [["mf", "feishu"], ["md", "dingtalk"], ["mw", "wechat_clawbot"]] as const) {
	db.prepare("INSERT INTO channels(id, kind, name, agent_id, enabled, config, created_at) VALUES(?,?,?,?,1,'{}',?)").run(id, kind, kind, "ma", now());
	db.prepare("INSERT INTO conversations(id, agent_id, title, created_at, updated_at) VALUES(?,?,?,?,?)").run(`c_${id}`, "ma", kind, old, old);
	db.prepare("INSERT INTO channel_peers(channel_id, peer_id, allowed, conversation_id, ctx, last_at, is_group) VALUES(?,?,1,?,'{}',?,0)").run(id, `u_${id}`, `c_${id}`, old);
}
// 飞书群：不该收到主动提醒
db.prepare("INSERT INTO conversations(id, agent_id, title, created_at, updated_at) VALUES('c_grp','ma','群',?,?)").run(old, old);
db.prepare("INSERT INTO channel_peers(channel_id, peer_id, allowed, conversation_id, ctx, last_at, is_group) VALUES('mf','g_1',1,'c_grp','{}',?,1)").run(old);
// 用户在 App 里的当前对话
db.prepare("INSERT INTO conversations(id, agent_id, title, created_at, updated_at) VALUES('c_app','ma','App',?,?)").run(now(), now());
db.prepare("UPDATE agents SET conversation_id = 'c_app' WHERE id = 'ma'").run();
fake("mf");
fake("md");
fake("mw", { defer: true });
P.saveProactive("ma", { level: "high", cfg: { quiet: null, weekdaysOnly: false } });

test("主动提醒：先写进 App 对话 + Web Push，再扇出到所有渠道单聊（不发群）；微信窗口外只排队微信那份", async () => {
	const app = currentConversation("ma");
	const r = P.surface("ma", { kind: "reminder", title: "该出发了", body: "三点的会议在 5 楼", importance: 3 });
	assert.equal(r.status, "delivered");
	// App 里立刻就有（同步写库），在任何渠道发送之前
	const row = db.prepare("SELECT conversation_id FROM messages WHERE json_extract(meta, '$.proactive.id') = ?").get(r.id!) as { conversation_id: string };
	assert.equal(row.conversation_id, app, "写进助理当前的 App 对话");
	assert.ok(pushed(/该出发了/), "App 推送");
	await wait(() => sent.length >= 2);
	assert.deepEqual(sent.map((s) => s.ch).sort(), ["md", "mf"]);
	assert.ok(sent.every((s) => s.inApp), "镜像发出时 App 里已经有这条消息");
	assert.ok(sent.every((s) => /三点的会议/.test(s.text)));
	// 微信：窗口外 → 只有微信副本排队；App 消息不受影响
	await wait(() => !!db.prepare("SELECT 1 FROM channel_outbox WHERE channel_id = 'mw'").get());
	const it = db.prepare("SELECT delivered_via FROM proactive_items WHERE id = ?").get(r.id!) as { delivered_via: string };
	assert.match(it.delivered_via, /^app,/);
	for (const c of ["mf", "md", "mw"]) assert.match(it.delivered_via, new RegExp(`channel:${c}`));
	// 群没有被绑定、没有收到
	assert.equal((db.prepare("SELECT conversation_id FROM channel_peers WHERE peer_id = 'g_1'").get() as { conversation_id: string }).conversation_id, "c_grp");
});

test("渠道里的回复落进同一个对话（带渠道标记）：审批回答先记进 App 再生效", async () => {
	const app = currentConversation("ma");
	const p = requests.approval("ma", null, "send_email", {}, "发邮件给王老师", "medium", app);
	await wait(() => sent.some((s) => s.ch === "mf" && /需要你批准/.test(s.text)));
	await ch.handleInbound("mf", { userId: "u_mf", peerId: "u_mf", text: "批准", ctx: {} } as never);
	assert.equal((await p).approved, true);
	const m = db.prepare("SELECT conversation_id, meta FROM messages WHERE role = 'user' AND content = '批准' ORDER BY created_at DESC").get() as { conversation_id: string; meta: string };
	assert.equal(m.conversation_id, app);
	assert.equal(JSON.parse(m.meta).channel.id, "mf");
});

test("渠道指令（新对话）也记在 App 里，回复由镜像发回", async () => {
	sent.length = 0;
	await ch.handleInbound("md", { userId: "u_md", peerId: "u_md", text: "新对话", ctx: {} } as never);
	await wait(() => sent.some((s) => s.ch === "md" && /开始新的对话/.test(s.text)));
	assert.ok(sent.find((s) => /开始新的对话/.test(s.text))!.inApp);
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE role = 'user' AND content = '新对话' AND json_extract(meta, '$.channel.id') = 'md'").get());
});

test("只用 App：不镜像到任何渠道", async () => {
	sent.length = 0;
	P.saveProactive("ma", { cfg: { deliver: "app" } });
	const r = P.surface("ma", { kind: "reminder", title: "喝水", body: "该喝水了", importance: 3 });
	assert.equal(r.status, "delivered");
	await new Promise((x) => setTimeout(x, 200));
	assert.equal(sent.length, 0);
	assert.equal((db.prepare("SELECT delivered_via FROM proactive_items WHERE id = ?").get(r.id!) as { delivered_via: string }).delivered_via, "app");
	P.saveProactive("ma", { cfg: { deliver: "auto" } });
});

test("定时任务结果：先写进 App 对话，再镜像到渠道", async () => {
	sent.length = 0;
	await import("../src/routines.ts");
	const t = now();
	db.prepare("INSERT INTO routines(id, agent_id, name, prompt, trigger, cron, created_at, updated_at) VALUES('rt1','ma','早报','x','cron','0 8 * * *',?,?)").run(t, t);
	db.prepare("INSERT INTO routine_runs(id, routine_id, trigger, status, started_at) VALUES('rr1','rt1','cron','running',?)").run(t);
	bus.emit({ type: "task.updated", task: { id: "tk1", status: "done", result: "今天晴，25 度", error: null, routine_run_id: "rr1", conversation_id: null } } as never);
	await wait(() => sent.filter((s) => /今天晴/.test(s.text)).length >= 2);
	assert.ok(sent.every((s) => s.inApp));
	assert.ok(pushed(/定时任务完成：早报/));
});
