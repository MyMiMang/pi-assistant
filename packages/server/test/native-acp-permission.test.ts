import "./setup.ts";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { credentialAccessDenied } from "@pi-assistant/ext-approval";
import { createNativePermissionContext, nativePermissionInput } from "../src/agent-runtime/native-acp-permission.ts";
import { bus } from "../src/bus.ts";
import { config } from "../src/config.ts";
import { db, now } from "../src/db.ts";
import * as hc from "../src/host-control.ts";
import { requests, type RequestRow } from "../src/requests.ts";
import { isTempDataDir } from "./setup.ts";

const agentId = "native-permission-test";
const workspace = join(config.dataDir, "native-workspace");
const conversationId = "native-permission-conversation";
const savedDryRun = process.env.PIA_HOST_CONTROL_DRY_RUN;
process.env.PIA_HOST_CONTROL_DRY_RUN = "1";
assert.ok(isTempDataDir(config.dataDir), "审批只写临时数据库");
db.prepare("INSERT INTO agents(id,name,avatar,color,created_at) VALUES(?,?,?,?,?)").run(agentId, "原生权限测试", "测", "#111", now());
hc.setHostEnv({ workspaceOf: () => workspace, agentIds: () => [agentId] });

const options = [
	{ optionId: "never-use-always", kind: "allow_always", name: "始终允许" },
	{ optionId: "deny-this-call", kind: "reject_once", name: "拒绝一次" },
	{ optionId: "allow-this-call", kind: "allow_once", name: "允许一次" },
];
const permission = (rawInput: Record<string, unknown> = { path: "result.txt" }) => ({
	toolCall: { toolCallId: "native-call", title: "写入结果", rawInput },
	options,
});
const rows = () => db.prepare("SELECT * FROM requests WHERE agent_id = ? ORDER BY rowid").all(agentId) as unknown as RequestRow[];
const card = (id: string) => {
	const row = db.prepare("SELECT meta FROM messages WHERE role = 'card' AND json_extract(meta, '$.requestId') = ?").get(id) as { meta: string } | undefined;
	assert.ok(row, "真实审批入口必须创建聊天卡片");
	return JSON.parse(row.meta) as Record<string, unknown>;
};
const rowOf = (id: string) => rows().find((row) => row.id === id)!;
const approve = (id: string, approved = true, scope?: "task") => assert.equal(requests.resolve(id, { approved, ...(scope ? { scope } : {}) }, "test").ok, true);
const contextFor = (t: TestContext) => {
	const native = createNativePermissionContext({ agentId, conversationId, taskId: null, workspace });
	t.after(() => native.dispose());
	return native;
};

beforeEach(async () => {
	// 清除上一用例设置后再恢复暂停，避免恢复时连接任何实际驱动。
	hc.saveHostSettings({ enabled: false, approvedHash: undefined, agents: "all", apps: [], tiers: {}, defaultTier: "bounded", fullAck: {} });
	await hc.setHostPaused(false);
	hc.saveHostSettings({ enabled: true, approvedHash: "test-approved-plan", tiers: { [agentId]: "trusted" } });
});
after(async () => {
	hc.saveHostSettings({ enabled: false, approvedHash: undefined, agents: "all", apps: [], tiers: {}, defaultTier: "bounded", fullAck: {} });
	await hc.setHostPaused(false);
	if (savedDryRun === undefined) delete process.env.PIA_HOST_CONTROL_DRY_RUN;
	else process.env.PIA_HOST_CONTROL_DRY_RUN = savedDryRun;
});

test("native 权限输入：归一化三个路径字段及 locations，保留明确命令，忽略非字符串", () => {
	const input = nativePermissionInput({ toolCall: { rawInput: { path: "./out.txt", file_path: "../auth.json", filePath: "/absolute/file", command: "echo ok" }, locations: [{ path: "nested/a.txt" }, { path: 123 }, null] }, options }, workspace);
	assert.deepEqual(input.paths, [resolve(workspace, "out.txt"), resolve(workspace, "../auth.json"), "/absolute/file", resolve(workspace, "nested/a.txt")]);
	assert.equal(input.command, "echo ok");
	assert.deepEqual(input.options, options);
	assert.deepEqual(nativePermissionInput(null, workspace).paths, []);
	assert.equal(nativePermissionInput({ toolCall: { rawInput: { command: 3, path: false } } }, workspace).command, undefined);
});

test("native 有效 full：自动返回工具提供的 allow_once，不创建请求或卡片", async (t) => {
	hc.saveHostSettings({ tiers: { [agentId]: "full" } });
	assert.equal(hc.hostFileAccess(agentId), true);
	const native = contextFor(t);
	const count = rows().length;
	const messageCount = (db.prepare("SELECT count(*) n FROM messages WHERE agent_id = ?").get(agentId) as { n: number }).n;
	assert.equal(await native.context.requestPermission(permission()), "allow-this-call");
	assert.equal(rows().length, count);
	assert.equal((db.prepare("SELECT count(*) n FROM messages WHERE agent_id = ?").get(agentId) as { n: number }).n, messageCount);
});

for (const tier of ["observe", "bounded", "trusted"] as const) {
	test(`native ${tier}：每个请求单独出卡，批准不记住 task 范围，拒绝返回 reject_once`, { timeout: 3000 }, async (t) => {
		hc.saveHostSettings({ tiers: { [agentId]: tier }, apps: [] });
		const native = contextFor(t);
		const count = rows().length;
		const first = native.context.requestPermission(permission());
		const a = rows().at(-1)!;
		assert.equal(rows().length, count + 1);
		assert.equal(a.status, "pending");
		assert.equal(a.tool_name, "native_acp");
		assert.equal((a as RequestRow & { conversation_id: string }).conversation_id, conversationId);
		const payload = JSON.parse(a.payload);
		assert.deepEqual(payload.input, { paths: [resolve(workspace, "result.txt")] });
		assert.equal(payload.summary, "写入结果");
		assert.equal(payload.allowTask, undefined);
		assert.equal(card(a.id).allowTask, undefined);
		assert.equal(card(a.id).status, "pending");
		approve(a.id, true, "task");
		assert.equal(await first, "allow-this-call");
		assert.equal(card(a.id).status, "approved");

		const second = native.context.requestPermission(permission());
		const b = rows().at(-1)!;
		assert.notEqual(b.id, a.id);
		assert.equal(rows().length, count + 2, "同类请求也必须再出一张卡");
		assert.equal(b.status, "pending");
		approve(b.id, false);
		assert.equal(await second, "deny-this-call");
		assert.equal(card(b.id).status, "rejected");
	});
}

test("native full 需当前宿主授权有效：关闭、未确认计划或移出名单都退回审批", { timeout: 3000 }, async (t) => {
	const native = contextFor(t);
	for (const patch of [{ enabled: false }, { approvedHash: undefined }, { agents: [] as string[] }]) {
		hc.saveHostSettings({ enabled: true, approvedHash: "test-approved-plan", agents: "all", tiers: { [agentId]: "full" }, ...patch });
		assert.equal(hc.hostFileAccess(agentId), false);
		const count = rows().length;
		const pending = native.context.requestPermission(permission());
		assert.equal(rows().length, count + 1);
		approve(rows().at(-1)!.id, false);
		assert.equal(await pending, "deny-this-call");
	}
});

test("native 凭据拒绝先于 full：复用 ext-approval，路径别名 / locations / 命令命中不出卡", async (t) => {
	hc.saveHostSettings({ tiers: { [agentId]: "full" } });
	const native = contextFor(t);
	const cases = [
		permission({ path: "../.ssh/id_rsa" }),
		permission({ file_path: "auth.json" }),
		permission({ filePath: "/private/Library/Keychains/login.keychain-db" }),
		{ ...permission({}), toolCall: { locations: [{ path: "../.aws/credentials" }] } },
		permission({ command: "cat ../.gnupg/private-keys-v1.d/key" }),
	];
	const count = rows().length;
	for (const params of cases) {
		const normalized = nativePermissionInput(params, workspace);
		assert.equal(credentialAccessDenied(normalized), true, "已有共享凭据规则应命中测试输入");
		assert.equal(await native.context.requestPermission(params), "deny-this-call");
	}
	assert.equal(rows().length, count, "凭据请求不得变成可批准的卡片");
});

test("native 暂停：full 也立即拒绝新请求，不创建卡片", async (t) => {
	hc.saveHostSettings({ tiers: { [agentId]: "full" } });
	const native = contextFor(t);
	await hc.setHostPaused(true);
	assert.equal(native.context.isPaused(), true);
	const count = rows().length;
	assert.equal(await native.context.requestPermission(permission()), "deny-this-call");
	assert.equal(rows().length, count);
});

test("native 暂停事件：拒绝全部本运行待审批并更新卡片，通知 onPause，解除订阅生效", { timeout: 3000 }, async (t) => {
	const native = contextFor(t);
	let pauses = 0;
	const off = native.context.onPause(() => { pauses++; });
	const first = native.context.requestPermission(permission({ path: "one.txt" }));
	const a = rows().at(-1)!;
	const second = native.context.requestPermission(permission({ path: "two.txt" }));
	const b = rows().at(-1)!;
	bus.emit({ type: "host.changed" });
	assert.equal(rowOf(a.id).status, "pending", "未暂停的普通变更不应取消审批");
	assert.equal(pauses, 0);
	await hc.setHostPaused(true);
	assert.deepEqual(await Promise.all([first, second]), ["deny-this-call", "deny-this-call"]);
	for (const id of [a.id, b.id]) {
		assert.equal(rowOf(id).status, "rejected");
		assert.equal(card(id).status, "rejected");
		assert.equal(requests.resolve(id, { approved: true }, "late-user").ok, false, "取消的卡片不能迟到批准");
	}
	assert.equal(pauses, 1);
	off();
	bus.emit({ type: "host.changed" });
	assert.equal(pauses, 1);
});

test("native 缺 allow_once / reject_once：拒绝，不能回退永久选项或任意允许", async (t) => {
	hc.saveHostSettings({ tiers: { [agentId]: "full" } });
	const native = contextFor(t);
	const count = rows().length;
	for (const [provided, expected] of [
		[options.filter((o) => o.kind !== "allow_once"), "deny-this-call"],
		[options.filter((o) => o.kind !== "reject_once"), undefined],
		[[{ kind: "allow_always", optionId: "permanent-allow" }, { kind: "reject_always", optionId: "permanent-deny" }], undefined],
		[[{ kind: "allow_once", optionId: 7 }, options[1]], "deny-this-call"],
		[[], undefined],
	] as const) assert.equal(await native.context.requestPermission({ ...permission(), options: provided }), expected);
	assert.equal(rows().length, count);
});

test("native 批准后立刻暂停：已批准卡片也不能让等待中的操作放行", { timeout: 3000 }, async (t) => {
	const native = contextFor(t);
	const pending = native.context.requestPermission(permission());
	const id = rows().at(-1)!.id;
	// resolve 同步释放 Promise，暂停发生于 requestPermission 的 await 恢复之前。
	approve(id);
	await hc.setHostPaused(true);
	assert.equal(await pending, "deny-this-call");
	assert.equal(rowOf(id).status, "approved", "保留用户当时的决定，执行返回仍拒绝");
});

test("native cancelPending：只取消所属运行，同助理同对话的另一个运行和提问保持等待", { timeout: 3000 }, async (t) => {
	const native = contextFor(t);
	const other = contextFor(t);
	const first = native.context.requestPermission(permission());
	const a = rows().at(-1)!;
	const second = other.context.requestPermission(permission());
	const b = rows().at(-1)!;
	const question = requests.question(agentId, null, "保留的提问", ["好"], false, conversationId);
	const q = rows().at(-1)!;
	t.after(() => requests.resolve(q.id, { answer: "清理" }, "system"));
	native.context.cancelPending!();
	assert.equal(await first, "deny-this-call");
	assert.equal(card(a.id).status, "rejected");
	assert.equal(rowOf(b.id).status, "pending");
	assert.equal(card(b.id).status, "pending");
	assert.equal(rowOf(q.id).status, "pending");
	approve(b.id);
	assert.equal(await second, "allow-this-call");
	requests.resolve(q.id, { answer: "好" }, "test");
	assert.equal((await question).answer, "好");
});

test("requests signal：只拒绝绑定的卡片，已取消 signal 不挂起，晚到取消不修改已批准卡", { timeout: 3000 }, async (t) => {
	const cancelled = new AbortController();
	const kept = new AbortController();
	t.after(() => { cancelled.abort(); kept.abort(); });
	const first = requests.approval(agentId, null, "native_acp", {}, "取消这一张", "medium", conversationId, { signal: cancelled.signal });
	const a = rows().at(-1)!;
	const second = requests.approval(agentId, null, "native_acp", {}, "保留这一张", "medium", conversationId, { signal: kept.signal });
	const b = rows().at(-1)!;
	cancelled.abort();
	assert.equal((await first).approved, false);
	assert.equal(rowOf(a.id).status, "rejected");
	assert.equal(card(a.id).status, "rejected");
	assert.equal(rowOf(b.id).status, "pending");
	approve(b.id);
	assert.equal((await second).approved, true);
	kept.abort();
	assert.equal(rowOf(b.id).status, "approved");
	assert.equal(card(b.id).status, "approved");
	const alreadyAborted = requests.approval(agentId, null, "native_acp", {}, "预先取消", "medium", conversationId, { signal: cancelled.signal });
	const c = rows().at(-1)!;
	assert.equal((await alreadyAborted).approved, false);
	assert.equal(rowOf(c.id).status, "rejected");
	assert.equal(card(c.id).status, "rejected");
});

test("native dispose：清理待审批与 bus 订阅，不再接收暂停回调", { timeout: 3000 }, async (t) => {
	const clients = bus.clientCount;
	const native = contextFor(t);
	let pauses = 0;
	native.context.onPause(() => { pauses++; });
	assert.equal(bus.clientCount, clients + 1);
	const pending = native.context.requestPermission(permission());
	const id = rows().at(-1)!.id;
	native.dispose();
	assert.equal(await pending, "deny-this-call");
	assert.equal(card(id).status, "rejected");
	assert.equal(bus.clientCount, clients);
	await hc.setHostPaused(true);
	assert.equal(pauses, 0);
});
