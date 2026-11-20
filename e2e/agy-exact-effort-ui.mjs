/** 真浏览器 + 临时 Mock 服务 + 仓库假 agy；不安装、不登录。先构建 Web，再单独运行本脚本。 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";
import { closeModelPanel, openCompact, openModelMenu } from "./model-menu-flow.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = artifactDir("agy-exact-effort-ui");
const run = makeTempRun("pia-agy-exact-effort-");
const provider = "antigravity";
const neon = "gemini-4-neon", hydrogen = "gemini-4-hydrogen";
const highOnly = "fixture-only-high-family", maxFamily = "fixture-true-max", fixed = "fixture-fixed-max";
const unknown = "fixture-missing-family";
const rows = [
	[neon, "Synthetic Neon"],
	[`${neon}-low`, "Synthetic Neon (Low)"],
	[`${neon}-high`, "Synthetic Neon (High)"],
	[`${neon}-xhigh`, "Synthetic Neon (XHigh)"],
	[`${hydrogen}-low`, "Synthetic Hydrogen (Low)"],
	[`${hydrogen}-medium`, "Synthetic Hydrogen (Medium)"],
	[`${hydrogen}-xhigh`, "Synthetic Hydrogen (XHigh)"],
	[`${highOnly}-high`, "Only High (High)"],
	[`${maxFamily}-high`, "True Max (High)"],
	[`${maxFamily}-max`, "True Max (Max)"],
	[fixed, "Fixed Max (Preview)"], // 后缀不是档位：显示名与目录都无佐证。
];
const command = join(run.runDir, "fake-agy.cjs");
const fixture = join(root, "packages/server/test/fixtures/fake-agy.mjs");
const traceFile = join(run.runDir, "agy-trace.jsonl");
const trace = () => existsSync(traceFile) ? readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const wait = async (fn, label, ms = 30_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`等待超时：${label}`);
};

let server, browser, page;
try {
	// 环境白名单不传测试变量，由临时 wrapper 注入；除本地目录响应外，复用已有假 agy 的 launch/turn 记录。
	writeFileSync(command, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'models') process.stdout.write(${JSON.stringify(`Fetching available models...\n${rows.map(row => row.join("\t")).join("\n")}\n`)});
else process.execve(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, ${JSON.stringify(fixture)}, ...args], {...process.env, FAKE_AGY_SCENARIO:'text', FAKE_AGY_SCENARIO_FILE:'', FAKE_AGY_LOG:'', FAKE_AGY_TRACE:${JSON.stringify(traceFile)}});
`, { mode: 0o755 });
	const port = await new Promise((resolve, reject) => {
		const socket = createServer();
		socket.once("error", reject);
		socket.listen(0, "127.0.0.1", () => { const port = socket.address().port; socket.close(() => resolve(port)); });
	});
	const base = `http://127.0.0.1:${port}`;
	server = startTempServer({ root, port, run, extra: {
		PIA_HOST: "127.0.0.1", PIA_HEADLESS: "0", NODE_OPTIONS: "", PIA_AGY_COMMAND: command,
		PIA_CLAUDE_COMMAND: "", PIA_CODEX_COMMAND: "", PIA_OPENCODE_COMMAND: "",
	} });
	const request = (path, method = "GET", body) => fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
	const j = async (path, method, body) => {
		const response = await request(path, method, body);
		assert.ok(response.ok, `${method ?? "GET"} ${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
		return response.json();
	};
	await wait(async () => {
		if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error(`临时服务提前退出：${server.logs()}`);
		return (await request("/api/system").catch(() => null))?.ok;
	}, "临时服务启动");
	await j("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
	const list = async () => (await j("/api/models")).filter(model => model.provider === provider);
	await wait(async () => (await list()).length > 0, "假 agy 注册");
	assert.deepEqual((await list()).map(model => model.id).sort(), [neon, hydrogen, highOnly, maxFamily, fixed].sort());

	const makeAgent = name => j("/api/agents", "POST", { name });
	const agent = await makeAgent("精确档位");
	const legacy = await makeAgent("旧完整模型 ID");
	const stale = await makeAgent("旧存档位已不可用");
	const staleSingle = await makeAgent("旧存单档模型的无效档位");
	const missing = await makeAgent("目录缺失的家族");
	// 只在本次临时库构造升级前的持久化状态，不让当前的写入校验替测试改掉旧数据。
	const db = new DatabaseSync(join(run.data, "data.db"));
	try {
		db.exec("PRAGMA busy_timeout=5000");
		const seed = db.prepare("UPDATE agents SET model_provider=?, model_id=?, thinking=?, thinking_explicit=0 WHERE id=?");
		for (const [target, model, effort] of [[legacy, `${neon}-xhigh`, null], [stale, hydrogen, "max"], [staleSingle, highOnly, "low"], [missing, unknown, null]]) {
			assert.equal(seed.run(provider, model, effort, target.id).changes, 1);
		}
	} finally { db.close(); }
	const agentNow = async (id = agent.id) => (await j("/api/agents")).find(entry => entry.id === id);
	const messages = id => j(`/api/agents/${id}/messages`);
	const errors = [];
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(12_000);
	page.on("pageerror", error => errors.push(error.message));
	const showChat = async target => {
		await page.goto(`${base}/?agent=${target.id}`);
		await page.getByTestId("model-picker").waitFor();
	};
	const selectModel = async (id, target = agent) => {
		const menu = await openModelMenu(page);
		await page.getByTestId("model-search").fill(id);
		const option = menu.locator(`[data-testid=model-option][data-model="${provider}/${id}"]`).first();
		await option.click();
		await wait(async () => (await agentNow(target.id)).model?.id === id, `保存模型 ${id}`);
		await closeModelPanel(page);
	};
	const selectableIds = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const assertLevels = async (compact, expected) => {
		await compact.getByTestId("thinking-current").waitFor();
		for (const id of selectableIds) assert.equal(await compact.getByTestId(`thinking-${id}`).count(), Number(expected.includes(id)), `可选档位必须与目录一致：${id}`);
	};
	const pick = async (compact, level, target = agent) => {
		await compact.getByTestId(`thinking-${level}`).click();
		await wait(async () => (await agentNow(target.id)).thinkingSetting === level, `保存档位 ${level}`);
		await closeModelPanel(page);
	};
	const sendFromBrowser = async text => {
		const box = page.locator("main textarea:not(.pa-card textarea)");
		await box.fill(text);
		await box.press("Enter");
	};
	const sendOk = async (target, text, model, newProcess) => {
		const before = trace();
		const snapshot = new Set((await messages(target.id)).map(m => m.id));
		await sendFromBrowser(text);
		await wait(async () => (await agentNow(target.id)).status === "idle" && (await messages(target.id)).some(m => !snapshot.has(m.id) && m.role === "assistant" && m.content.includes(text) && !m.meta?.error), `浏览器发消息并收到假 agy 回复：${text}`);
		const fresh = trace().slice(before.length);
		assert.deepEqual(fresh.map(row => row.event), newProcess ? ["launch", "turn"] : ["turn"], text);
		const turn = fresh.at(-1);
		assert.ok(turn.text.includes(text), text);
		const launch = trace().find(row => row.event === "launch" && row.pid === turn.pid && row.conversationId === turn.conversationId);
		assert.ok(launch, `${text} 缺少对应的真实启动记录`);
		assert.equal(launch.argv.filter(arg => arg === "--model").length, 1);
		assert.equal(launch.argv[launch.argv.indexOf("--model") + 1], model, `${text} 实际 --model 必须精确匹配`);
		return { launch, turn };
	};

	await showChat(agent);
	await selectModel(neon);
	let compact = await openCompact(page);
	await compact.getByTestId("thinking-model").getByText(/Synthetic Neon/).waitFor();
	await assertLevels(compact, ["low", "high", "xhigh"]);
	await pick(compact, "low");
	await page.reload();
	compact = await openCompact(page);
	await compact.getByTestId("thinking-current").getByText("低", { exact: true }).waitFor();
	await assertLevels(compact, ["low", "high", "xhigh"]);
	await closeModelPanel(page);
	const low = await sendOk(agent, "AGY_NEON_LOW_01", `${neon}-low`, true);
	const conversation = (await agentNow()).conversation_id;
	assert.ok(conversation, "应建立 Pi 对话");
	await pick(await openCompact(page), "high");
	const explicitHigh = await sendOk(agent, "AGY_NEON_HIGH_02", `${neon}-high`, true);
	assert.equal(explicitHigh.launch.conversation, low.turn.conversationId);
	await pick(await openCompact(page), "xhigh");
	const high = await sendOk(agent, "AGY_NEON_XHIGH_02", `${neon}-xhigh`, true);
	assert.notEqual(high.turn.pid, explicitHigh.turn.pid, "换档不能复用旧档位进程");
	assert.equal(high.launch.conversation, explicitHigh.turn.conversationId, "换档应续用 agy 对话");
	assert.equal(high.turn.conversationId, low.turn.conversationId);
	const again = await sendOk(agent, "AGY_NEON_XHIGH_03", `${neon}-xhigh`, false);
	assert.equal(again.turn.pid, high.turn.pid, "同档复用进程");
	assert.equal(again.turn.seq, high.turn.seq + 1);
	assert.equal((await agentNow()).conversation_id, conversation, "换档与复用始终在同一 Pi 对话");

	const checkFresh = async (name, id, levels, effort, actualModel) => {
		const target = await makeAgent(name);
		await showChat(target);
		await selectModel(id, target);
		const panel = await openCompact(page);
		await panel.getByTestId("thinking-model").getByText(name, { exact: false }).waitFor();
		await assertLevels(panel, levels);
		if (effort) {
			await pick(panel, effort, target);
			await page.reload();
			const restored = await openCompact(page);
			await restored.getByTestId("thinking-model").getByText(name, { exact: false }).waitFor();
			await assertLevels(restored, levels);
			assert.equal((await agentNow(target.id)).thinkingSetting, effort);
		} else {
			if (levels.length < 2) assert.equal(await panel.getByRole("slider").count(), 0, `${id} 不应有可调滑块`);
			if (id === highOnly) {
				assert.deepEqual((await list()).find(model => model.id === id).thinking, ["high"]);
				await panel.getByRole("button", { name: "选择高", exact: true }).waitFor();
			}
			assert.equal((await agentNow(target.id)).thinkingSetting, null, `${id} 不应伪造 off 档`);
		}
		await closeModelPanel(page);
		await sendOk(target, `AGY_EXACT_${id}`, actualModel, true);
	};
	await checkFresh("Synthetic Neon", neon, ["low", "high", "xhigh"], null, neon);
	await checkFresh("Synthetic Hydrogen", hydrogen, ["low", "medium", "xhigh"], "xhigh", `${hydrogen}-xhigh`);
	await checkFresh("Only High", highOnly, ["high"], null, `${highOnly}-high`);
	await checkFresh("True Max", maxFamily, ["high", "max"], "max", `${maxFamily}-max`);
	await checkFresh("Fixed Max", fixed, [], null, fixed);

	await showChat(legacy);
	const old = await agentNow(legacy.id);
	assert.equal(old.model.id, neon, "旧完整 ID 的有效模型归到家族");
	assert.equal(old.model_id, `${neon}-xhigh`, "读取旧存档不可偷偷改写原 ID");
	await sendOk(legacy, "AGY_LEGACY_FULL_ID", `${neon}-xhigh`, true);
	assert.equal((await agentNow(legacy.id)).model_id, `${neon}-xhigh`);
	for (const [target, model, level, error] of [[stale, hydrogen, "max", /档位|思考强度/], [staleSingle, highOnly, "low", /档位|思考强度/], [missing, unknown, null, /目录|模型/]]) {
		if (target === stale) {
			await showChat(target);
			const panel = await openCompact(page);
			await panel.getByTestId("thinking-current").getByText("原档位不可用", { exact: true }).waitFor();
			await assertLevels(panel, ["low", "medium", "xhigh"]);
			await page.screenshot({ path: join(out, "stale-selection.png") });
			await page.reload();
		}
		const persisted = await agentNow(target.id);
		assert.equal(persisted.model.id, model);
		assert.equal(persisted.thinkingSetting, level);
		const before = trace();
		const response = await request(`/api/agents/${target.id}/messages`, "POST", { text: `AGY_REJECT_${model}` });
		if (response.ok) {
			await wait(async () => (await agentNow(target.id)).status === "idle" && (await messages(target.id)).some(m => m.role !== "user" && error.test(`${m.content}\n${JSON.stringify(m.meta ?? {})}`)), `服务端拒绝 ${model}/${level}`);
		} else {
			assert.ok(response.status >= 400 && response.status < 500);
			assert.match(await response.text(), error);
		}
		assert.deepEqual(trace(), before, `${model}/${level} 拒绝时不得有推理 argv 或复用进程 stdin`);
		assert.equal((await agentNow(target.id)).thinkingSetting, level, "拒绝不得偷偷改掉用户原档位");
	}
	assert.deepEqual(errors, [], `页面报错：${errors.join("|")}`);
	console.log(`✅ agy-exact-effort-ui：精确目录、保存刷新、argv、拒绝与同会话续用；证据：${out}`);
} catch (error) {
	await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
	throw error;
} finally {
	await browser?.close().catch(() => {});
	await server?.stop();
	if (server) writeFileSync(join(out, "server.log"), server.logs());
	if (existsSync(traceFile)) writeFileSync(join(out, "agy-trace.jsonl"), readFileSync(traceFile));
	cleanupTempRun(run);
}
