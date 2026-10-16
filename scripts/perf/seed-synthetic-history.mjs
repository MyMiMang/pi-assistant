/**
 * 合成聊天历史（性能测量专用）：**不读任何真实聊天数据**。
 *
 * 用法（PIA_DATA_DIR 必须是可信临时目录；脚本自身再兜底一次）：
 *   PIA_DATA_DIR=/tmp/xxx PIA_SEED_MESSAGES=1000 node --import tsx scripts/perf/seed-synthetic-history.mjs
 * 写入：<DATA>/seed.json（agentId / conversationId / roomId / 条数）。
 *
 * 只为「首屏加载慢」的量化提供输入；产物是一次性临时库，用完即弃。
 */
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const canonical = (p) => (existsSync(p) ? realpathSync(p) : resolve(p));
const trusted = [tmpdir(), "/tmp", "/private/tmp"].map(canonical);
const within = (c, p) => {
	const r = relative(p, c);
	return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const rawDir = process.env.PIA_DATA_DIR?.trim() ?? "";
if (!rawDir || !trusted.some((t) => within(canonical(rawDir), t))) {
	const fresh = mkdtempSync(join(tmpdir(), "pia-perf-seed-"));
	process.stderr.write(`[seed] 不可信 PIA_DATA_DIR=${JSON.stringify(rawDir)} → ${fresh}\n`);
	process.env.PIA_DATA_DIR = fresh;
}
process.env.PIA_WORKSPACE = join(process.env.PIA_DATA_DIR, "workspace");
process.env.PIA_OFFLINE = "1";

const count = Number(process.env.PIA_SEED_MESSAGES ?? 300);
if (!Number.isFinite(count) || count < 1 || count > 200000) throw new Error(`非法 PIA_SEED_MESSAGES=${process.env.PIA_SEED_MESSAGES}`);

// 触发 schema 建表 / 迁移（config.ts 此时已读到临时数据目录）
const { db, now } = await import("../../packages/server/src/db.ts");

const t0 = now();
const agentId = "a_perf";
const convId = "c_perf";
db.prepare("INSERT OR REPLACE INTO agents(id, name, avatar, color, persona, status, unread, sort, created_at, conversation_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(agentId, "性能测量助理", "🧪", "#336699", "", "idle", 0, 0, t0, convId);
db.prepare("INSERT OR REPLACE INTO conversations(id, agent_id, title, session_file, created_at, updated_at) VALUES(?,?,?,?,?,?)").run(convId, agentId, "性能测量对话", null, t0, t0);

const roomId = "r_perf";
db.prepare("INSERT OR REPLACE INTO rooms(id, name, purpose, manager_id, caps, unread, paused, sort, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(roomId, "性能测量群", "", agentId, "{}", 0, null, 0, t0, t0);
db.prepare("INSERT OR REPLACE INTO room_members(room_id, agent_id, conversation_id, cursor, name, avatar, color, sort, joined_at) VALUES(?,?,?,?,?,?,?,?,?)").run(roomId, agentId, convId, null, "性能测量助理", "🧪", "#336699", 0, t0);

// 有代表性的正文长度：约 2400 字符，正好踩到服务端的截断上限（thinking 20k / result 4k）
const para = (n, seed = 0) => {
	const line = "这是一段用于测量聊天首屏渲染成本的合成文本，包含中文、English words、数字 12345 和代码 `const x = 1`。";
	let s = `# 标题 ${n}\n\n`;
	while (s.length < n) s += line + (seed % 5) + "\n\n";
	return s.slice(0, n);
};

const insMsg = db.prepare(
	"INSERT INTO messages(id, agent_id, conversation_id, task_id, role, content, meta, status, created_at, updated_at, room_id, subagent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
);
const insRoom = db.prepare(
	"INSERT INTO messages(id, agent_id, conversation_id, task_id, role, content, meta, status, created_at, updated_at, room_id, subagent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
);

let t = t0 - count * 60_000;
const write = (i, room) => {
	const kind = i % 10;
	const base = { agent_id: agentId, conversation_id: room ? null : convId, room_id: room ? roomId : null, subagent_id: null, task_id: null, created_at: t, updated_at: t + 800 };
	if (kind < 3) {
		// 用户消息：短
		insMsg.run(`m_perf_${room ? "r" : "c"}_${i}`, base.agent_id, base.conversation_id, null, "user", `用户第 ${i} 条：帮我看一下这个。`, "{}", "done", base.created_at, base.updated_at, base.room_id, null);
	} else if (kind < 7) {
		// 助理回答：正文 + usage + 部分带 thinking（贴近真实截断上限）
		const meta = { model: "mock/measure", usage: { input: 1200, output: 300, cacheRead: 900, cacheWrite: 0, cost: 0.0012, reasoning: 0 } };
		if (i % 3 === 0) meta.thinking = para(20000, i);
		insMsg.run(`m_perf_${room ? "r" : "c"}_${i}`, base.agent_id, base.conversation_id, null, "assistant", para(2400, i), JSON.stringify(meta), "done", base.created_at, base.updated_at, base.room_id, null);
	} else if (kind < 9) {
		// 工具步骤：args + result（贴近截断上限）
		const meta = { toolName: "read", args: { path: `/Users/dengdeng/some/very/long/path/to/file-${i}.ts` }, toolCallId: `tc_${i}`, result: para(4000, i) };
		insMsg.run(`m_perf_${room ? "r" : "c"}_${i}`, base.agent_id, base.conversation_id, null, "tool", "", JSON.stringify(meta), "done", base.created_at, base.updated_at, base.room_id, null);
	} else {
		// 附件元数据（不内联图片）
		const meta = { attachments: [{ fileId: `f_perf_${i}`, name: `报告-${i}.pdf`, mime: "application/pdf", size: 240000 }] };
		insMsg.run(`m_perf_${room ? "r" : "c"}_${i}`, base.agent_id, base.conversation_id, null, "assistant", `已生成报告 ${i}。`, JSON.stringify(meta), "done", base.created_at, base.updated_at, base.room_id, null);
	}
	t += 60_000;
};

const tx = db.prepare("BEGIN");
tx.run();
for (let i = 0; i < count; i++) write(i, false);
// 群历史：另一半数量，模拟群里消息通常更密集
const roomCount = Math.max(50, Math.round(count / 2));
t = t0 - roomCount * 60_000;
for (let i = 0; i < roomCount; i++) write(i, true);
db.prepare("COMMIT").run();

const info = { agentId, conversationId: convId, roomId, count, roomCount, dataDir: process.env.PIA_DATA_DIR };
writeFileSync(join(process.env.PIA_DATA_DIR, "seed.json"), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
