/**
 * 消息引用「真实 HTTP 闭环」集成测试（合并 message-replies-backend + message-replies-ui 后）。
 *
 * 目的：纯前端 fixture（page.route 拦 /api）通过**不代表整合可用**。本测试启动**真实服务进程**
 * （`test/launch-memory.ts`：经公开注入点用内存 CredentialStore，绕开 OS 钥匙串；PIA_MOCK=1 假模型；
 * PIA_DATA_DIR / PIA_WORKSPACE 指向进程专属临时目录），再用真实 HTTP 打通：
 *   POST /api/agents/:id/messages（replyToId / clientId）→ 返回的 Message.reply 契约
 *   POST /api/rooms/:rid/messages（replyToId / clientId）
 *   GET  /api/messages/:mid 与 /api/messages/:mid/context?limit=&roomId=|conversationId=
 * 并另开本进程只读 sqlite 连接，核对**真实服务进程**写入的 room_turns（群路由：引用谁只叫谁、@ 优先）。
 *
 * 边界：不读真实用户数据 / 不碰钥匙串 / 不调付费模型；不在此文件改任何生产逻辑。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

const serverDir = join(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "pia-replies-http-"));
const port = 21000 + Math.floor(Math.random() * 3000);
const base = `http://127.0.0.1:${port}`;

let srv: ReturnType<typeof spawn> | undefined;
let out = "";
type Json = Record<string, any>;

const start = async () => {
	srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "test/launch-memory.ts"], {
		cwd: serverDir,
		env: {
			...process.env,
			PIA_DATA_DIR: dataDir,
			PIA_WORKSPACE: join(dataDir, "workspace"),
			PIA_PORT: String(port),
			PIA_HOST: "127.0.0.1",
			PIA_MOCK: "1",
			PIA_OFFLINE: "1",
			PIA_SETUP_CHECK_MS: "9999999",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	srv.stdout?.on("data", (b) => (out += b));
	srv.stderr?.on("data", (b) => (out += b));
	await waitFor(async () => (await fetch(`${base}/api/system/public`)).status === 200, 60_000);
};

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await Promise.resolve(cond()).catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 120));
	}
	throw new Error(`等待超时。服务输出：\n${out.slice(-2500)}`);
}

/** 真实 HTTP 请求（回环免登录，同生产非 headless 模式）。 */
async function req(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Json }> {
	const r = await fetch(base + path, {
		method: init.method ?? "GET",
		headers: init.body !== undefined ? { "content-type": "application/json" } : {},
		body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
	});
	let parsed: Json = {};
	try {
		parsed = (await r.json()) as Json;
	} catch {
		/* 非 JSON 响应 */
	}
	return { status: r.status, body: parsed };
}

const mkAgent = async (name: string): Promise<Json> => {
	const r = await req("/api/agents", { method: "POST", body: { name } });
	assert.equal(r.status, 200, `建助理失败：${JSON.stringify(r.body)}`);
	assert.ok(r.body.id && r.body.conversation_id, "助理应有 id 与当前对话");
	return r.body;
};

/** 本进程只读查看真实服务写入的 sqlite（跨进程核对路由，不依赖服务内部接口）。 */
const openDb = () => new DatabaseSync(join(dataDir, "data.db"));
const turnRows = (rid: string, sinceRowid: number) =>
	openDb().prepare("SELECT rowid AS seq, agent_id, reason, status FROM room_turns WHERE room_id = ? AND rowid > ? ORDER BY rowid").all(rid, sinceRowid) as { seq: number; agent_id: string; reason: string; status: string }[];

before(async () => {
	await start();
});
after(() => {
	srv?.kill();
});

test("单聊：HTTP 引用发送返回精确 ReplySnapshot，clientId 幂等不重复落库", async () => {
	const A = await mkAgent("HTTP甲");
	const conv = A.conversation_id as string;

	const m1 = (await req(`/api/agents/${A.id}/messages`, { method: "POST", body: { text: "第一条用户消息" } })).body;
	assert.equal(m1.role, "user");
	assert.equal(m1.replyToId, null, "无引用回读 null");
	assert.equal(m1.reply, null, "无引用回读 null");

	const r1 = await req(`/api/agents/${A.id}/messages`, { method: "POST", body: { text: "引用回复一", replyToId: m1.id, clientId: "cid-1" } });
	assert.equal(r1.status, 200, JSON.stringify(r1.body));
	const m2 = r1.body;

	// —— 与 apps/web/src/types.ts ReplySnapshot 逐字段对齐（exact shape，不多不少）——
	assert.equal(m2.replyToId, m1.id);
	assert.deepEqual(Object.keys(m2.reply).sort(), ["author", "createdAt", "edited", "excerpt", "messageId", "source", "truncated"]);
	assert.equal(m2.reply.messageId, m1.id);
	assert.deepEqual(m2.reply.author, { id: "", name: "用户", role: "user" });
	assert.deepEqual(m2.reply.source, { kind: "conversation", id: conv });
	assert.equal(m2.reply.excerpt, "第一条用户消息");
	assert.equal(m2.reply.truncated, false);
	assert.equal(m2.reply.edited, false);
	assert.equal(typeof m2.reply.createdAt, "number");
	// 内部列不泄漏
	for (const k of ["reply_to_id", "reply_snapshot", "client_id"]) assert.ok(!(k in m2), `不应泄漏内部列 ${k}`);

	// 幂等：同 clientId 重复投递返回同一条，且只落一条
	const again = (await req(`/api/agents/${A.id}/messages`, { method: "POST", body: { text: "引用回复一", replyToId: m1.id, clientId: "cid-1" } })).body;
	assert.equal(again.id, m2.id, "同 clientId 返回已存在消息");
	const list = (await req(`/api/agents/${A.id}/messages`)).body as unknown as Json[];
	const dups = list.filter((m) => m.content === "引用回复一");
	assert.equal(dups.length, 1, `同 clientId 只落一条，实际 ${dups.length}`);
});

test("单聊：错误分支返回稳定 code 且不泄露内容（404 not_found / 403 cross_scope）", async () => {
	const A = await mkAgent("HTTP甲2");
	const B = await mkAgent("HTTP乙2");
	const bList = (await req(`/api/agents/${B.id}/messages`)).body as unknown as Json[];
	const bMsg = bList[0];

	const nf = await req(`/api/agents/${A.id}/messages`, { method: "POST", body: { text: "引用不存在", replyToId: "m_nope" } });
	assert.equal(nf.status, 404);
	assert.equal(nf.body.code, "reply_not_found");

	const cross = await req(`/api/agents/${A.id}/messages`, { method: "POST", body: { text: "跨对话引用", replyToId: bMsg.id } });
	assert.equal(cross.status, 403);
	assert.equal(cross.body.code, "reply_cross_scope");

	// GET 单条：容器不匹配 403、不存在 404，都不泄露存在性
	assert.equal((await req(`/api/messages/m_nope`)).status, 404);
	assert.equal((await req(`/api/messages/${bMsg.id}?conversationId=${A.conversation_id}`)).status, 403);
	assert.equal((await req(`/api/messages/${bMsg.id}?conversationId=${B.conversation_id}`)).status, 200);
});

test("单聊：GET /context 有界返回升序 Message[]，含 seq 且 limit 生效", async () => {
	const A = await mkAgent("HTTP甲3");
	const conv = A.conversation_id as string;
	const ids: string[] = [];
	for (let i = 0; i < 5; i++) ids.push((await req(`/api/agents/${A.id}/messages`, { method: "POST", body: { text: `第${i}条` } })).body.id);

	const full = (await req(`/api/messages/${ids[2]}/context?limit=50&conversationId=${conv}`)).body as unknown as Json[];
	assert.ok(Array.isArray(full) && full.length >= 1);
	assert.ok(full.some((m) => m.id === ids[2]), "上下文含目标消息");
	for (const m of full) {
		assert.ok("seq" in m, "每项带 seq");
		assert.ok("replyToId" in m && "reply" in m, "每项带 replyToId / reply（向后兼容）");
	}
	const seqs = full.map((m) => m.seq as number);
	assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "升序");

	const bounded = (await req(`/api/messages/${ids[2]}/context?limit=3&conversationId=${conv}`)).body as unknown as Json[];
	assert.ok(bounded.length <= 3, `limit=3 应有界，实际 ${bounded.length}`);

	// 跨容器 context 403
	const other = await mkAgent("HTTP甲3b");
	const oList = (await req(`/api/agents/${other.id}/messages`)).body as unknown as Json[];
	assert.equal((await req(`/api/messages/${oList[0].id}/context?conversationId=${conv}`)).status, 403);
});

test("群聊：真实服务写 room_turns —— 引用谁只叫谁、@ 优先于引用、clientId 重试不再排回合", async () => {
	const A = await mkAgent("群甲");
	const B = await mkAgent("群乙");
	const C = await mkAgent("群丙"); // 管理者
	const room = (await req("/api/rooms", { method: "POST", body: { name: "HTTP引用群", memberIds: [A.id, B.id, C.id], managerId: C.id } })).body;
	assert.ok(room.id, JSON.stringify(room));
	const rid = room.id as string;

	// @A 触发 A 说一句（拿到可引用的助理消息）
	await req(`/api/rooms/${rid}/messages`, { method: "POST", body: { text: `@群甲 你先说一句`, mentions: [A.id] } });
	const aMsg = await waitForMsg(rid, (m) => m.agent_id === A.id && m.role === "assistant");
	await waitIdle(rid);

	// 1) 无 @ 引用 A 的助理消息 ⇒ 只叫 A，不叫管理者 C（也不叫 B）
	let since = maxTurnRow(rid);
	const q1 = await req(`/api/rooms/${rid}/messages`, { method: "POST", body: { text: "只看甲这一条", replyToId: aMsg.id } });
	assert.equal(q1.status, 200, JSON.stringify(q1.body));
	assert.equal(q1.body.reply.author.id, A.id);
	assert.equal(q1.body.reply.author.role, "assistant");
	assert.deepEqual(q1.body.reply.source, { kind: "room", id: rid });
	await waitFor(() => turnRows(rid, since).length >= 1);
	let turns = turnRows(rid, since);
	assert.deepEqual([...new Set(turns.map((t) => t.agent_id))], [A.id], `无 @ 引用甲应只叫甲，实际 ${JSON.stringify(turns)}`);
	assert.ok(turns.every((t) => t.agent_id !== C.id), "不误唤管理者");
	await waitIdle(rid);

	// 2) 引用 A 但 @B ⇒ 只叫 B（@ 优先于引用）
	since = maxTurnRow(rid);
	await req(`/api/rooms/${rid}/messages`, { method: "POST", body: { text: `@群乙 你来说`, mentions: [B.id], replyToId: aMsg.id } });
	await waitFor(() => turnRows(rid, since).length >= 1);
	turns = turnRows(rid, since);
	assert.deepEqual([...new Set(turns.map((t) => t.agent_id))], [B.id], `引用甲但 @乙应只叫乙，实际 ${JSON.stringify(turns)}`);
	await waitIdle(rid);

	// 3) 同 clientId 重试：返回同一条，且不再新增回合（不 double wake）
	const before = maxTurnRow(rid);
	const first = (await req(`/api/rooms/${rid}/messages`, { method: "POST", body: { text: "幂等群消息", replyToId: aMsg.id, clientId: "gcid-1" } })).body;
	await new Promise((r) => setTimeout(r, 400));
	const afterFirst = maxTurnRow(rid);
	const retry = (await req(`/api/rooms/${rid}/messages`, { method: "POST", body: { text: "幂等群消息", replyToId: aMsg.id, clientId: "gcid-1" } })).body;
	assert.equal(retry.id, first.id, "同 clientId 返回已存在消息");
	await new Promise((r) => setTimeout(r, 600));
	const afterRetry = maxTurnRow(rid);
	assert.equal(afterRetry, afterFirst, "同 clientId 重试不再排新回合");
	assert.ok(afterFirst >= before + 1, "首次投递确实排了回合");
});

// ---------------------------------------------------------------- helpers（群内轮询）

const ridCache = new Map<string, true>();
async function waitForMsg(rid: string, pred: (m: Json) => boolean): Promise<Json> {
	let found: Json | undefined;
	await waitFor(async () => {
		const list = (await req(`/api/rooms/${rid}/messages`)).body as unknown as Json[];
		found = [...list].reverse().find(pred);
		return !!found;
	}, 30_000);
	return found!;
}
async function waitIdle(rid: string): Promise<void> {
	await waitFor(async () => {
		const r = await req(`/api/rooms/${rid}`);
		return r.status === 200 && !r.body?.state?.running && !(r.body?.state?.queue?.length);
	}, 30_000).catch(() => {});
}
function maxTurnRow(rid: string): number {
	ridCache.set(rid, true);
	const row = openDb().prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM room_turns WHERE room_id = ?").get(rid) as { n: number };
	return row.n;
}
