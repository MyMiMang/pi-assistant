import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
// @ts-expect-error 复用临时数据目录、内存凭据与 Mock 启动夹具（.mjs）。
import { cleanupTempRun, makeTempRun, startTempServer } from "../../../e2e/fixtures/temp-server.mjs";

const root = join(import.meta.dirname, "../../..");
const run = makeTempRun("pia-agent-folders-");
const dbPath = join(run.data, "data.db");
const path = "/api/agent-folders";
const legacyId = "legacy-agent";
let base: string;
let server: ReturnType<typeof startTempServer> | undefined;

type Folder = { id: string; name: string };
type Agent = { id: string; name: string; folderId: string | null; conversation_id: string; scope: string; last: { content: string } };

async function api<T = unknown>(method: string, route: string, input?: unknown, status = 200, headers?: Record<string, string>): Promise<T> {
	const r = await fetch(base + route, { method, headers: { "content-type": "application/json", ...headers }, body: input === undefined ? undefined : JSON.stringify(input) });
	const data = await r.json();
	assert.equal(r.status, status, `${method} ${route}: ${JSON.stringify(data)}`);
	return data as T;
}

const folders = () => api<Folder[]>("GET", path);
const agents = () => api<Agent[]>("GET", "/api/agents");
const newFolder = (name: string) => api<Folder>("POST", path, { name });
const newAgent = (name: string, folderId?: string | null) => api<Agent>("POST", "/api/agents", { name, folderId });
const move = (agentIds: unknown, folderId: unknown, status = 200) => api("POST", `${path}/move`, { agentIds, folderId }, status);

async function start() {
	const port = await new Promise<number>((resolve) => {
		const socket = createServer().listen(0, "127.0.0.1", () => {
			const { port } = socket.address() as { port: number };
			socket.close(() => resolve(port));
		});
	});
	base = `http://127.0.0.1:${port}`;
	server = startTempServer({ root, port, run });
	for (let i = 0; i < 200; i++) {
		if (await fetch(`${base}/api/system/public`).then(async (r) => { await r.arrayBuffer(); return r.ok; }).catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`临时服务没能启动：${server?.logs()}`);
}

before(async () => {
	const db = new DatabaseSync(dbPath);
	try {
		// 升级前的 agents 基础表没有任何归类字段。
		db.exec(`CREATE TABLE agents (
			id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL, color TEXT NOT NULL,
			persona TEXT NOT NULL DEFAULT '', model_provider TEXT, model_id TEXT,
			status TEXT NOT NULL DEFAULT 'idle', session_file TEXT, unread INTEGER NOT NULL DEFAULT 0,
			sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
			INSERT INTO agents(id, name, avatar, color, created_at) VALUES ('${legacyId}', '旧助理', '旧', '#6366f1', 1);`);
	} finally {
		db.close();
	}
	await start();
});
after(async () => {
	await server?.stop();
	cleanupTempRun(run);
});

test("旧助理默认未分类；文件夹及归类重启后仍在，解散保留助理、对话和消息", async () => {
	assert.deepEqual(await folders(), []);
	assert.equal((await agents()).find((a) => a.id === legacyId)?.folderId, null);
	await api("POST", path, { name: "  " }, 400);
	const folder = await newFolder("   工作   ");
	assert.equal(folder.name, "工作");
	assert.deepEqual(await api("PATCH", `${path}/${folder.id}`, { name: "项目" }), { ...folder, name: "项目" });
	const created = await newAgent("从文件夹创建", folder.id);
	assert.equal(created.folderId, folder.id);
	assert.match(created.last.content, /从文件夹创建/);
	await move([legacyId], folder.id);

	await server?.stop();
	await start();
	assert.deepEqual(await folders(), [{ ...folder, name: "项目" }]);
	for (const id of [legacyId, created.id]) assert.equal((await agents()).find((a) => a.id === id)?.folderId, folder.id);
	await api("DELETE", `${path}/${folder.id}`);
	assert.deepEqual(await folders(), []);
	const remaining = await agents();
	assert.equal(remaining.find((a) => a.id === legacyId)?.folderId, null);
	assert.deepEqual(remaining.find((a) => a.id === created.id), { ...created, folderId: null });
	await api("DELETE", `${path}/${folder.id}`, undefined, 404);
});

test("批量移动全批校验；加入群的个人助理仍可分类，群专属助理不可分类", async () => {
	const source = await newFolder("来源");
	const destination = await newFolder("目标");
	const first = await newAgent("原已归类", source.id);
	const second = await newAgent("原未分类", null);
	const room = await api<{ id: string }>("POST", "/api/rooms", { name: "测试群", memberIds: [first.id, second.id] });
	const scoped = await api<Agent>("POST", "/api/rooms/builtin-manager", { roomId: room.id });
	assert.equal(scoped.scope, "room");
	assert.equal(scoped.folderId, null);

	assert.deepEqual(await move([first.id, scoped.id], destination.id, 400), { error: "room_agent" });
	assert.deepEqual(await move([first.id, scoped.id], null, 400), { error: "room_agent" });
	assert.deepEqual(await move([second.id, "missing-agent"], destination.id, 404), { error: "agent_not_found" });
	assert.deepEqual(await move([first.id, second.id], "missing-folder", 404), { error: "folder_not_found" });
	for (const ids of [[], [first.id, 42], [first.id, " "]]) await move(ids, destination.id, 400);
	await move([first.id], undefined, 400);
	const original = await agents();
	assert.equal(original.find((a) => a.id === first.id)?.folderId, source.id);
	assert.equal(original.find((a) => a.id === second.id)?.folderId, null);
	assert.equal(original.find((a) => a.id === scoped.id)?.folderId, null);

	await move([first.id, second.id, first.id], destination.id);
	const moved = await agents();
	for (const id of [first.id, second.id]) assert.equal(moved.find((a) => a.id === id)?.folderId, destination.id);
	await move([first.id, second.id], null);
	const unclassified = await agents();
	for (const id of [first.id, second.id]) assert.equal(unclassified.find((a) => a.id === id)?.folderId, null);
});

test("新建助理先校验文件夹和模型；无效请求不留下助理、对话或欢迎消息", async () => {
	const folder = await newFolder("可用目录");
	const counts = () => {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			return db.prepare("SELECT (SELECT COUNT(*) FROM agents) AS agents, (SELECT COUNT(*) FROM conversations) AS conversations, (SELECT COUNT(*) FROM messages) AS messages").get();
		} finally {
			db.close();
		}
	};
	const initial = counts();
	await api("POST", "/api/agents", { name: "错误目录", folderId: "not-a-folder" }, 404);
	await api("POST", "/api/agents", { name: "错误类型", folderId: 42 }, 400);
	await api("POST", "/api/agents", { name: "错误模型", folderId: folder.id, model: { provider: "mock", id: "missing" } }, 400);
	assert.deepEqual(counts(), initial);
});

test("文件夹沿用助理读写权限：未登录远程拒绝，已配对普通设备可操作", async () => {
	const remote = { "cf-connecting-ip": "192.0.2.1" };
	const before = await folders();
	await api("GET", path, undefined, 401, remote);
	await api("POST", path, { name: "不应创建" }, 401, remote);
	await api("POST", path, { name: "沙盒不能创建" }, 403, { origin: "null" });
	assert.deepEqual(await folders(), before);

	const start = await api<{ directUrl: string }>("POST", "/api/pair/start", { preApproved: true });
	const code = new URLSearchParams(new URL(start.directUrl).hash.slice(1)).get("c");
	const { deviceId } = await api<{ deviceId: string }>("POST", "/api/pair/claim", { code, name: "测试手机", platform: "ios" }, 200, remote);
	const { token } = await api<{ token: string }>("GET", `/api/pair/status/${deviceId}`);
	assert.match(token, /^hh_/);
	const paired = { ...remote, authorization: `Bearer ${token}` };
	const folder = await api<Folder>("POST", path, { name: "手机归类" }, 200, paired);
	assert.ok((await api<Folder[]>("GET", path, undefined, 200, paired)).some((f) => f.id === folder.id));
	await api("POST", `${path}/move`, { agentIds: [legacyId], folderId: folder.id }, 200, paired);
	assert.equal((await agents()).find((a) => a.id === legacyId)?.folderId, folder.id);
	await api("DELETE", `${path}/${folder.id}`, undefined, 200, paired);
});
