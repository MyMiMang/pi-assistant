/** 独立临时 HTTP 回归：node --test e2e/agy-legacy-default-http.mjs（无需 Web 构建，不执行真实 agy）。 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const provider = "antigravity", neon = "gemini-4-neon";
const legacy = { provider, id: `${neon}-xhigh` };
const missing = { provider, id: "fixture-missing-xhigh" };
const mock = { provider: "mock", id: "echo" };
const rows = [[neon, "Synthetic Neon"], ...["low", "high", "xhigh"].map(level => [`${neon}-${level}`, `Synthetic Neon (${level})`])];
const selection = "model_provider, model_id, thinking, thinking_explicit";
const noSelection = { model_provider: null, model_id: null, thinking: null, thinking_explicit: 0 };
const ref = model => model && { provider: model.provider, id: model.id };

async function wait(read, label, ms = 15_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await read();
		if (value) return value;
		await sleep(100);
	}
	throw new Error(`等待超时：${label}`);
}

test("旧全局 Antigravity 默认模型：真实 HTTP + 假 agy argv", { timeout: 120_000 }, async t => {
	const run = makeTempRun("pia-agy-legacy-default-http-");
	const out = artifactDir(process.env.AGY_HTTP_ARTIFACT ?? "agy-legacy-default-http");
	const command = join(run.runDir, "fake-agy.cjs");
	const fixture = join(root, "packages/server/test/fixtures/fake-agy.mjs");
	const traceFile = join(run.runDir, "agy-trace.jsonl");
	const startup = join(run.runDir, "startup.json");
	const trace = () => existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
	let server, db;
	try {
		// 与 agy-exact-effort-ui 同样只替换目录，其他命令直接交给原始 fixture。
		writeFileSync(command, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'models') process.stdout.write(${JSON.stringify(`Fetching available models...\n${rows.map(row => row.join("\t")).join("\n")}\n`)});
else process.execve(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, ${JSON.stringify(fixture)}, ...args], {...process.env, FAKE_AGY_SCENARIO:'text', FAKE_AGY_SCENARIO_FILE:'', FAKE_AGY_LOG:'', FAKE_AGY_TRACE:${JSON.stringify(traceFile)}});
`, { mode: 0o755 });
		// agy 工具桥使用配置端口，不能把实际监听端口只留在 startup.json。
		const port = await new Promise((resolve, reject) => {
			const socket = createServer();
			socket.once("error", reject);
			socket.listen(0, "127.0.0.1", () => {
				const { port } = socket.address();
				socket.close(error => error ? reject(error) : resolve(port));
			});
		});
		server = startTempServer({ root, port, run, extra: {
			NODE_ENV: "test", NODE_OPTIONS: "", PIA_HOST: "127.0.0.1", PIA_HEADLESS: "0", PIA_SETUP_CHECK_MS: "9999999",
			PIA_AGY_COMMAND: command, PIA_CLAUDE_COMMAND: "", PIA_CODEX_COMMAND: "", PIA_OPENCODE_COMMAND: "",
			PIA_TEST_STARTUP_FILE: startup,
		} });
		const ready = await wait(() => {
			assert.equal(server.child.exitCode, null, server.logs());
			assert.equal(server.child.signalCode, null, server.logs());
			return existsSync(startup) && JSON.parse(readFileSync(startup, "utf8"));
		}, "本次临时服务启动", 45_000);
		assert.ok(ready.storeCalls > 0, "模型凭据须走注入的内存后端");
		assert.equal(ready.port, port);
		const request = (path, method = "GET", body) => fetch(`http://127.0.0.1:${ready.port}${path}`, {
			method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
		});
		const j = async (path, method, body) => {
			const response = await request(path, method, body);
			assert.ok(response.ok, `${method ?? "GET"} ${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
			return response.json();
		};
		await j("/api/settings", "PUT", { onboarded: true });
		const defaults = () => j("/api/models/defaults");
		const refresh = async () => assert.equal((await j("/api/models/antigravity/recheck", "POST")).registered, true);
		const list = () => j("/api/models");
		await refresh();
		assert.deepEqual((await list()).filter(m => m.provider === provider).map(m => m.id), [neon]);
		db = new DatabaseSync(join(run.data, "data.db"));
		db.exec("PRAGMA busy_timeout=5000");
		db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('proactive.defaultLevel', ?)").run(JSON.stringify("off"));
		// 旧完整 ID 曾经落库，现在不能用当前设置接口来构造旧数据。
		const putOldDefault = model => assert.equal(db.prepare("UPDATE settings SET value=? WHERE key='defaultModel'").run(JSON.stringify(model)).changes, 1);
		const rawDefault = () => db.prepare("SELECT value FROM settings WHERE key='defaultModel'").get().value;
		const stored = id => ({ ...db.prepare(`SELECT ${selection} FROM agents WHERE id=?`).get(id) });
		const agent = id => listAgents().then(agents => agents.find(a => a.id === id));
		const listAgents = () => j("/api/agents");
		const make = (name, input = {}) => j("/api/agents", "POST", { name, ...input });
		const route = id => `/api/agents/${id}/messages`;
		const reply = async (id, before) => wait(async () => {
			if ((await agent(id)).status !== "idle") return;
			return (await j(route(id))).find(m => !before.has(m.id) && (m.role === "assistant" || (m.role === "system" && m.status === "error")));
		}, "本轮回复或拒绝");
		const send = async (id, text) => {
			const before = new Set((await j(route(id))).map(m => m.id));
			const res = await request(route(id), "POST", { text });
			return { status: res.status, reply: res.ok ? await reply(id, before) : await res.text() };
		};
		const exact = async (id, text) => {
			const before = trace().length;
			const result = await send(id, text);
			const fresh = trace().slice(before);
			const launch = fresh.find(row => row.event === "launch");
			const modelArgs = launch?.argv.flatMap((arg, i) => arg === "--model" ? [launch.argv[i + 1]] : []) ?? [];
			const actual = { status: result.status, events: fresh.map(row => row.event), modelArgs, readModel: ref((await agent(id)).model), persisted: stored(id), reply: result.reply };
			t.diagnostic(`${text}: ${JSON.stringify(actual)}`);
			assert.ok(result.status >= 200 && result.status < 300 && result.reply.role === "assistant" && result.reply.status !== "error" && !result.reply.meta?.error && result.reply.content.includes(text), JSON.stringify(actual));
			assert.deepEqual(actual.events, ["launch", "turn"]);
			assert.deepEqual(modelArgs, [legacy.id]);
			assert.ok(fresh[1].text.includes(text) && fresh[1].pid === launch.pid && fresh[1].conversationId === launch.conversationId);
		};
		const reject = async (id, text, reason) => {
			const before = trace();
			const result = await send(id, text);
			const detail = typeof result.reply === "string" ? result.reply : `${result.reply.content}\n${JSON.stringify(result.reply.meta ?? {})}`;
			const delta = trace().length - before.length;
			t.diagnostic(`${text}: ${JSON.stringify({ status: result.status, agyDelta: delta, reply: result.reply })}`);
			assert.deepEqual(trace(), before, "拒绝必须零推理启动、零 stdin turn");
			assert.ok(result.status >= 400 && result.status < 500 || result.status >= 200 && result.status < 300 && result.reply.status === "error");
			assert.match(detail, reason);
		};

		const oldAgent = await make("旧库无模型行");
		assert.equal(db.prepare("UPDATE agents SET model_provider=NULL, model_id=NULL, thinking=NULL, thinking_explicit=0 WHERE id=?").run(oldAgent.id).changes, 1);
		putOldDefault(legacy);
		assert.deepEqual((await defaults()).modelSetting, legacy);
		const newAgent = await make("不带模型新建");
		await t.test("新建时未传模型：发送使用旧默认的 xhigh argv", async () => {
			await exact(newAgent.id, "AGY_DEFAULT_NEW");
			assert.deepEqual(stored(newAgent.id), noSelection);
		});
		await t.test("旧库模型列为空：发送使用旧默认的 xhigh argv", async () => {
			assert.deepEqual(stored(oldAgent.id), noSelection);
			await exact(oldAgent.id, "AGY_DEFAULT_EXISTING");
			assert.deepEqual(stored(oldAgent.id), noSelection);
		});
		await t.test("显式 high 与旧全局 xhigh 冲突：拒绝并零启动", async () => {
			const a = await make("显式冲突", { thinking: "high" });
			const before = stored(a.id);
			assert.equal(before.thinking_explicit, 1);
			await reject(a.id, "AGY_DEFAULT_CONFLICT", /冲突|档位|思考强度/);
			assert.deepEqual(stored(a.id), before);
		});
		await t.test("重新检测与 HTTP 读回不覆写旧全局 ID 或助理模型/档位", async () => {
			const before = [stored(newAgent.id), stored(oldAgent.id)];
			await refresh();
			const d = await defaults();
			const read = [await agent(newAgent.id), await agent(oldAgent.id)];
			assert.equal(rawDefault(), JSON.stringify(legacy));
			assert.deepEqual(d.modelSetting, legacy);
			assert.deepEqual([stored(newAgent.id), stored(oldAgent.id)], before);
			assert.deepEqual(stored(oldAgent.id), noSelection);
			t.diagnostic(`刷新 HTTP/数据库 ${JSON.stringify({ defaults: d, agents: read.map(a => ({ model: ref(a.model), thinking: a.thinking, thinkingSetting: a.thinkingSetting, thinkingDefault: a.thinkingDefault })), rawDefault: rawDefault(), stored: before })}`);
			assert.deepEqual(ref(d.model), { provider, id: neon });
			assert.equal(d.thinking, "xhigh");
			assert.deepEqual(read.map(a => ref(a.model)), [{ provider, id: neon }, { provider, id: neon }]);
			assert.deepEqual(read.map(a => a.thinking), ["xhigh", "xhigh"]);
			assert.deepEqual(read.map(a => a.thinkingDefault), ["xhigh", "xhigh"]);
		});
		await t.test("旧全局 ID 不在目录：拒绝并零启动，不回退 Mock", async () => {
			putOldDefault(missing);
			await reject(oldAgent.id, "AGY_DEFAULT_MISSING", /目录|模型.*不存在|模型.*不可用/);
			assert.equal(rawDefault(), JSON.stringify(missing));
			assert.deepEqual(stored(oldAgent.id), noSelection);
		});
		await t.test("非 agy 默认：仍使用本地 Mock，不启动 agy", async () => {
			putOldDefault(mock);
			assert.deepEqual((await defaults()).model, mock);
			assert.deepEqual(ref((await agent(oldAgent.id)).model), mock);
			const fresh = await make("普通默认新建");
			assert.deepEqual(ref(fresh.model), mock);
			assert.deepEqual(stored(fresh.id), { ...noSelection, model_provider: mock.provider, model_id: mock.id });
			const before = trace();
			const result = await send(fresh.id, "AGY_DEFAULT_CONTROL");
			assert.ok(result.status >= 200 && result.status < 300 && !result.reply.meta?.error && result.reply.content.includes("AGY_DEFAULT_CONTROL"), JSON.stringify(result));
			assert.deepEqual(trace(), before);
			assert.deepEqual(stored(oldAgent.id), noSelection);
			t.diagnostic(`AGY_DEFAULT_CONTROL: status=${result.status} agy delta=0 reply=${result.reply.content}`);
		});
	} finally {
		db?.close();
		await server?.stop();
		if (server) writeFileSync(join(out, "server.log"), server.logs());
		writeFileSync(join(out, "agy-trace.jsonl"), existsSync(traceFile) ? readFileSync(traceFile) : "");
		cleanupTempRun(run);
	}
});
