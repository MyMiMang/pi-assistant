/**
 * 编程工具上下文设计验收（docs/design/cli-context-ownership.md）。
 * 真页面 / 真服务 + 假 agy + 本地 Mock OpenAI 中转；随机端口、临时数据、内存凭据。
 * 中转 → agy → 中转（两轮）→ agy（续原 conversation，仅补期间对话）→ 连续三轮，
 * 再来回两次；逐轮断言没有重发旧内容、没有重开 conversation / 进程。
 * 先串行构建 web，再 node e2e/cli-context-ownership-ui.mjs；不调用真实模型。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";
import { closeModelPanel, openModelMenu } from "./model-menu-flow.mjs";
import { startMockOpenAI } from "./mock-openai.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const OUT = artifactDir("cli-context-ownership-ui");
const run = makeTempRun("pia-cli-context-ownership-");
const traceFile = join(run.runDir, "agy-trace.jsonl");
const command = join(run.runDir, "fake-agy.cjs");
// 在白名单环境之外由本次独占 wrapper 注入观测路径，只执行仓库假 agy。
// exec 的进程保持 PID、stdin 和信号关系，临时服务收尾能整组清理。
writeFileSync(command, `#!/usr/bin/env node
const {execve}=require('node:process');
execve(${JSON.stringify(process.execPath)},[${JSON.stringify(process.execPath)},${JSON.stringify(join(root, "packages/server/test/fixtures/fake-agy.mjs"))},...process.argv.slice(2)],{...process.env,FAKE_AGY_SCENARIO:'text',FAKE_AGY_TRACE:${JSON.stringify(traceFile)}});
`, { mode: 0o755 });
const readTrace = () => existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const turns = () => readTrace().filter(row => row.event === "turn");
const port = await new Promise((resolve, reject) => {
	const s = createServer();
	s.once("error", reject);
	s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
assert.notEqual(port, 8787);
const base = `http://127.0.0.1:${port}`;
const j = async (path, method = "GET", body) => {
	const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
	assert.ok(res.ok, `${method} ${path}: ${res.status} ${res.ok ? "" : await res.text()}`);
	return res.json();
};
const wait = async (fn, label, ms = 30_000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await fn()) return;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`等待超时：${label}`);
};
const relayReply = text => `中转站回复（relay-chat）：收到「${text}」`;
const agyReply = text => `你好，收到：${text}`;
let browser, server, relay, page;
try {
	relay = await startMockOpenAI();
	server = startTempServer({ root, port, run, extra: {
		PIA_AGY_COMMAND: command, PIA_CLAUDE_COMMAND: "", PIA_CODEX_COMMAND: "", PIA_OPENCODE_COMMAND: "",
	} });
	await wait(async () => {
		if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error(`临时服务提前退出：${server.logs()}`);
		try { return (await fetch(base + "/api/system", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
	}, "临时服务启动");
	await j("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
	await wait(async () => (await j("/api/models")).some(m => m.provider === "antigravity" && m.id === "claude-sonnet-5-5"), "假 agy 注册");
	const provider = await j("/api/models/custom", "POST", {
		name: "上下文验收 Mock 中转", api: "openai-completions", baseUrl: relay.url,
		apiKey: "sk-relay-test", models: [{ id: "relay-chat", contextWindow: 65536, maxTokens: 4096 }],
	});
	const relayModel = { provider: provider.id, id: "relay-chat" };
	const agyModel = { provider: "antigravity", id: "claude-sonnet-5-5" };
	const agent = await j("/api/agents", "POST", { name: "上下文切换验收", model: relayModel, thinking: "off" });
	const agentNow = async () => (await j("/api/agents")).find(a => a.id === agent.id);
	const messages = () => j(`/api/agents/${agent.id}/messages`);
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	const errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.goto(`${base}/?agent=${agent.id}`);
	await page.getByTestId("model-picker").waitFor();
	const switchModel = async (model) => {
		assert.equal((await agentNow()).status, "idle", "只在本轮完整收尾后切换");
		const menu = await openModelMenu(page);
		await page.getByTestId("model-search").fill(model.id);
		await menu.locator(`[data-testid=model-option][data-model="${model.provider}/${model.id}"]`).first().click();
		await wait(async () => { const a = await agentNow(); return a.model.provider === model.provider && a.model.id === model.id; }, "模型选择持久化");
		await closeModelPanel(page);
		assert.equal((await agentNow()).conversation_id, agent.conversation_id, "模型切换保留 Pi 对话");
	};
	const send = async (text, expected) => {
		const before = new Set((await messages()).map(m => m.id));
		const box = page.locator("main textarea:not(.pa-card textarea)");
		await box.fill(text);
		await box.press("Enter");
		await wait(async () => {
			const fresh = (await messages()).filter(m => !before.has(m.id));
			const failed = fresh.find(m => m.role === "error" || m.meta?.error);
			assert.ok(!failed, `本轮出错：${JSON.stringify(failed)}`);
			return fresh.some(m => m.role === "assistant" && m.content.trim() === expected.trim()) && (await agentNow()).status === "idle";
		}, `回复落库且空闲：${text}`);
		await page.locator("main").getByText(expected, { exact: false }).last().waitFor();
	};
	// 已被 agy 看到的标记以后必须完全消失，避免仅检验“包含新消息”而漏掉全文重发。
	const seenMarkers = [];
	let original;
	const assertOneTurn = (before, expectedParts, oldMarkers = seenMarkers, exact = false) => {
		const all = turns();
		assert.equal(all.length, before + 1, "每次发消息恰好给 agy 一轮输入");
		const current = all.at(-1);
		if (original) {
			assert.equal(current.conversationId, original.conversationId, "切回 agy 续用原 conversation");
			assert.equal(current.pid, original.pid, "连续轮次不重开进程");
		}
		assert.equal(current.seq, before + 1, "长驻进程轮次连续递增");
		let position = 0;
		const expectedText = expectedParts.join("\n");
		for (const part of expectedParts) {
			const found = current.text.indexOf(part, position);
			assert.ok(found >= position, `增量按顺序包含：${part}`);
			// 假中转会在回答里引用用户原话；按预期对话中的出现次数计数，仍能抓住重复补发。
			assert.equal(current.text.split(part).length - 1, expectedText.split(part).length - 1, `本轮内容没有重复补发：${part}`);
			position = found + part.length;
		}
		for (const marker of oldMarkers) assert.ok(!current.text.includes(marker), `不能重发已同步的旧内容：${marker}`);
		if (exact) assert.equal(current.text, expectedParts[0], "连续轮次只有本轮新消息");
		if (original && expectedParts.length > 1) assert.match(current.text, /你不在时的对话/, "补发中转期间内容时明确标出来源");
		const launches = readTrace().filter(row => row.event === "launch");
		assert.equal(launches.length, 1, "全程只新开一次 agy conversation / 进程");
		return current;
	};
	const sendAgy = async (text, extra = []) => {
		const before = turns().length;
		// 假 agy 原样回显整段输入，靠收到的独立 trace 得到本轮预期，再核对实际页面和落库。
		const box = page.locator("main textarea:not(.pa-card textarea)");
		await box.fill(text);
		await box.press("Enter");
		await wait(() => turns().length > before, `agy 收到 ${text}`);
		const current = assertOneTurn(before, [...extra, text], seenMarkers, extra.length === 0 && !!original);
		const expected = agyReply(current.text);
		await wait(async () => (await messages()).some(m => m.role === "assistant" && m.content.trim() === expected.trim()) && (await agentNow()).status === "idle", `agy 回复收尾：${text}`);
		await page.locator("main").getByText(expected, { exact: false }).last().waitFor();
		seenMarkers.push(...extra, text);
		return current;
	};

	const initial = "CTX_RELAY_INITIAL_01";
	await send(initial, relayReply(initial));
	assert.equal(turns().length, 0, "中转首轮没有调用 agy");
	await switchModel(agyModel);
	original = await sendAgy("CTX_AGY_FIRST_02", [initial, relayReply(initial)]);
	await sendAgy("CTX_AGY_DIRECT_03");
	await switchModel(relayModel);
	const gap = ["CTX_RELAY_GAP_04", "CTX_RELAY_GAP_05"];
	const beforeRelay = turns().length;
	for (const text of gap) await send(text, relayReply(text));
	assert.equal(turns().length, beforeRelay, "中转期间不向 agy 发送消息");
	await switchModel(agyModel);
	await sendAgy("CTX_AGY_RETURN_06", gap.flatMap(text => [text, relayReply(text)]));
	await page.screenshot({ path: join(OUT, "01-second-return.png") });
	for (let round = 7; round <= 9; round++) await sendAgy(`CTX_AGY_CONTINUE_${round}`);
	// 再切两次：锚点必须随每轮前进，不能反复补发同一段中转历史。
	for (let cycle = 1; cycle <= 2; cycle++) {
		await switchModel(relayModel);
		const text = `CTX_RELAY_CYCLE_${cycle}`;
		const n = turns().length;
		await send(text, relayReply(text));
		assert.equal(turns().length, n);
		await switchModel(agyModel);
		await sendAgy(`CTX_AGY_CYCLE_RETURN_${cycle}`, [text, relayReply(text)]);
		await sendAgy(`CTX_AGY_CYCLE_NEXT_${cycle}`);
	}
	const relayRequests = relay.seen.filter(req => req.url === "/v1/chat/completions").map(req => JSON.parse(req.body));
	assert.equal(relayRequests.length, 5, "五轮中转均经过本地 Mock HTTP 服务");
	assert.ok(relayRequests.every(req => req.model === "relay-chat"));
	const relayHistory = JSON.stringify(relayRequests.at(-1).messages);
	for (const marker of [initial, "CTX_AGY_FIRST_02", "CTX_AGY_CONTINUE_9"]) assert.ok(relayHistory.includes(marker), `Pi 给中转保留完整对话：${marker}`);
	assert.deepEqual(errors, [], `页面报错：${errors.join("|")}`);
	await page.screenshot({ path: join(OUT, "02-repeated-switches.png") });
	console.log(`✅ cli-context-ownership-ui：中转 5 轮、agy ${turns().length} 轮；conversation 与进程各 1 个，增量无旧内容。证据：${OUT}`);
} catch (error) {
	await page?.screenshot({ path: join(OUT, "failure.png") }).catch(() => {});
	throw error;
} finally {
	// 成败均留证据；不含真实数据、MCP 令牌或模型密钥。
	if (existsSync(traceFile)) writeFileSync(join(OUT, "agy-trace.jsonl"), readFileSync(traceFile));
	if (server) writeFileSync(join(OUT, "server.log"), server.logs());
	if (relay) writeFileSync(join(OUT, "relay-messages.json"), JSON.stringify(relay.seen.filter(req => req.url === "/v1/chat/completions").map(req => JSON.parse(req.body).messages), null, 2));
	await browser?.close().catch(() => {});
	await server?.stop();
	relay?.close();
	cleanupTempRun(run);
}
