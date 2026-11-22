/** Rev1: production directory parser → browser add → restart → browser send → loopback wire value. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";
import { closeModelPanel, openCompact } from "./model-menu-flow.mjs";
import { startMockOpenAI } from "./mock-openai.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const gateway = "https://ai-gateway.vercel.sh/v1";
const custom = "/api/models/custom";
const api = "openai-completions";
const goodId = "fixture/unlisted-future-r162";
const manualId = "fixture/manual-unlisted-r163";
const negative = [
	{ id: "fixture/boolean-only-r164", reasoning: true },
	{ id: "fixture/parameter-only-r165", supported_parameters: ["reasoning_effort"] },
	{ id: "fixture/invalid-enum-r166", reasoning_options: [{ type: "effort", values: ["max", "unknown"] }] },
];
const rows = [{ id: goodId, reasoning_options: [{ type: "effort", values: ["max"] }] }, ...negative];
const levels = { max: "max" };
const catalogHits = [];
const directory = createServer((req, res) => {
	catalogHits.push([req.method, req.url]);
	if (req.method !== "GET" || req.url !== "/v1/models") return res.writeHead(404).end();
	res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: rows }));
});
const listen = (server) => new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const until = async (fn, label) => {
	for (const end = Date.now() + 15000; Date.now() < end; await delay(80)) if (await fn()) return;
	assert.fail(`Timed out: ${label}`);
};
assert.ok(existsSync(new URL("../apps/web/dist/index.html", import.meta.url)), "build @pi-assistant/web first");
const probe = createServer();
const port = await listen(probe);
await close(probe);
const base = `http://127.0.0.1:${port}`;
const run = makeTempRun("pia-channel-directory-effort-");
let server, chat, browser;
const json = async (path, method = "GET", body) => {
	const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
	assert.ok(res.ok, `${method} ${path} ${res.status}: ${res.ok ? "" : await res.text()}`);
	return res.json();
};
try {
	const directoryPort = await listen(directory);
	chat = await startMockOpenAI({ key: "not-needed" }); // SDK placeholder for noKey, not a credential.
	const adapter = new URL("./fixtures/channel-model-add-directory-fetch.mjs", import.meta.url).href;
	const start = async () => {
		server = startTempServer({ root, port, run, extra: {
			PIA_HOST: "127.0.0.1",
			NODE_OPTIONS: `--import=${adapter}`,
			PIA_E2E_DIRECTORY_URL: `http://127.0.0.1:${directoryPort}/v1/models`,
			PIA_E2E_CHAT_URL: `${chat.url}/chat/completions`,
		} });
		await until(() => fetch(`${base}/api/system`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false), "service ready");
	};
	await start();
	await json("/api/settings", "PUT", { onboarded: true });
	const created = await json(custom, "POST", { name: "本地目录档位测试", api, baseUrl: gateway, noKey: true, models: [{ id: "fixture-existing-r161" }] });
	const path = `${custom}/${created.id}`;
	const model = (models, id) => { const entry = models.find((m) => m.id === id); assert.ok(entry, `Missing ${id}`); return entry; };
	const checkProvider = (provider) => {
		assert.equal(provider.api, api);
		assert.equal(provider.baseUrl, gateway);
		assert.equal(provider.noKey, true);
		assert.equal(Object.hasOwn(provider, "capabilityScope"), false);
	};
	const checkDirectory = (m) => {
		assert.deepEqual(m.listEvidence, { provider: created.id, model: goodId, api, baseUrl: gateway, reasoning: true, levels });
		assert.equal(m.effectiveCapability.reasoning, true);
		assert.equal(m.effectiveCapability.levelsSource, "/models");
		assert.deepEqual(m.effectiveCapability.levels, levels);
		assert.equal(m.effectiveCapability.off, "unknown");
	};
	const checkUnknown = (m, reasoning) => {
		assert.equal(m.effectiveCapability.reasoning, reasoning);
		assert.equal(m.effectiveCapability.levels, undefined);
		assert.equal(m.listEvidence?.levels, undefined);
		assert.equal(m.thinkingLevelMap, undefined);
	};
	checkProvider(created);
	const fetched = (await json(`${custom}/fetch-models`, "POST", { id: created.id, api, baseUrl: gateway })).models;
	checkDirectory(model(fetched, goodId));
	for (const row of negative) checkUnknown(model(fetched, row.id), row.reasoning);
	// A manual lookup of a catalog ID must not gain directory proof merely by matching its name.
	checkUnknown((await json(`${path}/add-preview`, "POST", { modelId: goodId })).model, undefined);
	console.log("PASS HTTP: exact Chat URL, trusted per-model max; boolean-only, parameter-only, invalid enum and manual ID do not gain levels");

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run), args: ["--disable-background-networking"] });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
	await context.route("**/*", (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
	const errors = [];
	const newPage = async () => {
		const p = await context.newPage();
		p.setDefaultTimeout(8000);
		p.on("pageerror", (e) => errors.push(e.message));
		return p;
	};
	let page = await newPage();
	const openDetail = async () => {
		await page.goto(`${base}/?settings=models`);
		const toggle = page.getByTestId(`service-toggle-${created.id}`);
		if (!(await toggle.isVisible())) await page.getByTestId("service-list-toggle").click();
		await toggle.click();
	};
	await openDetail();
	const detail = page.getByTestId(`relay-detail-${created.id}`);
	const panel = detail.getByTestId("relay-add-panel");
	const open = () => detail.getByTestId("relay-add-open").click();
	const save = async () => {
		const [res] = await Promise.all([
			page.waitForResponse((r) => r.url() === base + path && r.request().method() === "PUT"),
			panel.getByTestId("relay-add-save").click(),
		]);
		assert.ok(res.ok(), await res.text());
		await panel.waitFor({ state: "hidden" });
		const body = res.request().postDataJSON();
		assert.equal(Object.hasOwn(body, "capabilityScope"), false);
		assert.ok(body.models.every((m) => !Object.hasOwn(m, "effectiveCapability")));
		return body.models;
	};
	await open();
	for (const row of rows) {
		const checkbox = panel.getByRole("checkbox", { name: row.id, exact: true });
		const capability = checkbox.locator("xpath=ancestor::label").getByTestId("relay-add-capability");
		const text = await capability.innerText();
		if (row.id === goodId) assert.match(text, /可选：最大/);
		else { assert.match(text, /待确认/); assert.doesNotMatch(text, /可选：/); }
		await checkbox.check();
	}
	assert.deepEqual(model(await save(), goodId).listEvidence.levels, levels);
	await openDetail(); // Start the manual flow from the newly loaded saved configuration.
	await open();
	await panel.getByRole("button", { name: "手动输入型号" }).click();
	await panel.getByTestId("relay-add-input").fill(manualId);
	const manual = panel.getByTestId("relay-add-preview");
	await manual.getByText(manualId, { exact: true }).waitFor().catch(async (error) => {
		throw new Error(`Manual preview did not load: ${await panel.innerText()} (page errors: ${errors.join(", ")})`, { cause: error });
	});
	assert.match(await manual.innerText(), /待确认/);
	assert.doesNotMatch(await manual.innerText(), /可选：/);
	assert.equal(model(await save(), manualId).listEvidence, undefined);
	console.log("PASS browser: added confirmed and unknown rows; save did not write capabilityScope or derived UI fields");

	const snapshot = async () => (await json(custom)).providers.find((p) => p.id === created.id);
	const verify = async () => {
		const saved = await snapshot();
		checkProvider(saved);
		checkDirectory(model(saved.models, goodId));
		for (const row of [...negative, { id: manualId }]) checkUnknown(model(saved.models, row.id), row.reasoning);
		const models = (await json("/api/models")).filter((m) => m.provider === created.id);
		assert.deepEqual(model(models, goodId).thinking, ["max"]);
		assert.equal(model(models, goodId).thinkingLevelMap.max, "max");
		for (const row of [...negative, { id: manualId }]) {
			assert.equal(model(models, row.id).reasoning, row.reasoning);
			assert.equal(model(models, row.id).thinkingLevelMap, undefined);
		}
	};
	await verify();
	const agent = await json("/api/agents", "POST", { name: "目录档位测试助理", model: { provider: created.id, id: goodId }, thinking: "off" });
	const preRestartHits = catalogHits.length;
	await page.close(); // Don't leave background requests running into the deliberate shutdown.
	const previousPid = server.child.pid;
	await server.stop();
	await start();
	assert.notEqual(server.child.pid, previousPid);
	await verify();
	assert.equal(catalogHits.length, preRestartHits, "restart must use saved evidence, not fetch the catalog");
	console.log("PASS restart: persisted per-model evidence and picker levels, no catalog re-fetch or scope");

	page = await newPage();
	await page.goto(`${base}/?agent=${agent.id}`);
	const compact = await openCompact(page);
	await compact.getByRole("button", { name: "选择最大", exact: true }).click();
	await until(async () => (await json("/api/agents")).find((a) => a.id === agent.id)?.thinking === "max", "browser persisted max");
	await closeModelPanel(page);
	const text = "directory-effort-wire-regression";
	await page.locator(".pa-composer textarea").fill(text);
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await page.getByText(`中转站回复（${goodId}）：收到「${text}」`, { exact: true }).waitFor();
	assert.equal(chat.seen.length, 1);
	const [wire] = chat.seen;
	assert.deepEqual([wire.method, wire.url], ["POST", "/v1/chat/completions"]);
	const payload = JSON.parse(wire.body);
	assert.equal(payload.model, goodId);
	assert.equal(payload.reasoning_effort, "max");
	assert.equal(Object.hasOwn(payload, "reasoning"), false);
	assert.equal(catalogHits.length, preRestartHits);
	assert.ok(catalogHits.length >= 2 && catalogHits.every(([method, url]) => method === "GET" && url === "/v1/models"));
	assert.deepEqual(errors, []);
	console.log(`PASS loopback: POST /v1/chat/completions model=${payload.model} reasoning_effort=${JSON.stringify(payload.reasoning_effort)} (one request)`);
} catch (error) {
	console.error(server?.logs());
	throw error;
} finally {
	await browser?.close();
	await server?.stop();
	chat?.close();
	directory.closeAllConnections();
	await close(directory);
	cleanupTempRun(run);
}
