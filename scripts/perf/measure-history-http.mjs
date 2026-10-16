/**
 * 测量合成历史的首屏加载成本（HTTP 层）：**不读真实聊天数据 / 不连外网**。
 *
 * 用法：
 *   PIA_DATA_DIR=/tmp/xxx node scripts/perf/measure-history-http.mjs
 * 前置：先用 seed-synthetic-history.mjs 在该目录写入 seed.json。
 *
 * 输出：<DATA>/measure-http.json + stdout JSON。指标 = 响应条数 / 解压后字节 / 端到端毫秒（本机回环，
 * 只反映服务端查询 + JSON 序列化成本，不代表真实手机网络；手机网络另由 Playwright 限速 fixture 测）。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const canonical = (p) => (existsSync(p) ? realpathSync(p) : resolve(p));
const trusted = [tmpdir(), "/tmp", "/private/tmp"].map(canonical);
const within = (c, p) => {
	const r = relative(p, c);
	return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const dataDir = process.env.PIA_DATA_DIR?.trim() ?? "";
if (!dataDir || !trusted.some((t) => within(canonical(dataDir), t))) throw new Error(`PIA_DATA_DIR 必须是可信临时目录：${dataDir}`);
const seed = JSON.parse(readFileSync(join(dataDir, "seed.json"), "utf8"));

const port = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const base = `http://127.0.0.1:${port}`;
const srv = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
	cwd: resolve(import.meta.dirname, "..", ".."),
	env: { ...process.env, PIA_DATA_DIR: dataDir, PIA_WORKSPACE: join(dataDir, "workspace"), PIA_PORT: String(port), PIA_MOCK: "1", PIA_OFFLINE: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
srv.stdout.on("data", (d) => (out += d));
srv.stderr.on("data", (d) => (out += d));
const waitFor = async (fn, ms = 40000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn().catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`服务未就绪：\n${out.slice(-2000)}`);
};
await waitFor(async () => (await fetch(`${base}/api/system`)).ok);

/** 一次 GET：返回条数 / 字节 / 毫秒 */
const get = async (path) => {
	const t = performance.now();
	const r = await fetch(base + path);
	const buf = Buffer.from(await r.arrayBuffer());
	const ms = performance.now() - t;
	let n = 0;
	try {
		const j = JSON.parse(buf.toString("utf8"));
		n = Array.isArray(j) ? j.length : 0;
	} catch {
		/* ignore */
	}
	return { path, status: r.status, count: n, bytes: buf.byteLength, ms: Math.round(ms * 10) / 10 };
};

const results = { seed: { count: seed.count, roomCount: seed.roomCount }, firstPage: {}, paging: {} };

for (const limit of [500, 300, 200, 100, 50]) results.firstPage[`agent-limit-${limit}`] = await get(`/api/agents/${seed.agentId}/messages?limit=${limit}&conversation=${seed.conversationId}`);
for (const limit of [200, 100, 50]) results.firstPage[`room-limit-${limit}`] = await get(`/api/rooms/${seed.roomId}/messages?limit=${limit}`);

// 全量逐页：模拟一直向上翻到顶，记录总页数 / 总字节 / 总毫秒，并校验有无重复 / 漏项
const pageThrough = async (kind) => {
	const seen = new Set();
	let before;
	let pages = 0;
	let totalBytes = 0;
	const t = performance.now();
	for (;;) {
		const limit = kind === "room" ? 100 : 50;
		const url = kind === "room" ? `/api/rooms/${seed.roomId}/messages?limit=${limit}${before ? `&before=${before}` : ""}` : `/api/agents/${seed.agentId}/messages?limit=${limit}&conversation=${seed.conversationId}${before ? `&before=${before}` : ""}`;
		const r = await fetch(base + url);
		const buf = Buffer.from(await r.arrayBuffer());
		totalBytes += buf.byteLength;
		const arr = JSON.parse(buf.toString("utf8"));
		if (!arr.length) break;
		pages++;
		for (const m of arr) seen.add(m.id);
		const oldest = arr[0];
		before = kind === "room" ? oldest.seq : oldest.created_at;
		if (pages > 500) break;
	}
	return { pages, totalBytes, totalMs: Math.round(performance.now() - t), unique: seen.size };
};
results.paging.agentAll = await pageThrough("agent");
results.paging.roomAll = await pageThrough("room");
results.expectedAgentTotal = seed.count;
results.expectedRoomTotal = seed.roomCount;

const dest = join(dataDir, "measure-http.json");
writeFileSync(dest, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
srv.kill("SIGKILL");
process.exit(0);
