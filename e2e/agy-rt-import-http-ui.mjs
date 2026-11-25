/** `node --import tsx e2e/agy-rt-import-http-ui.mjs` — isolated browser → real RT route, no real CLI or OAuth. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { build } from "esbuild";
import { Hono } from "hono";
import { chromium } from "playwright-core";
import { agyAccountGate } from "../packages/server/src/cli-agents/agy-account-gate.ts";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { browserEnv, cleanupTempRun, makeTempRun } from "./fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const path = "/api/agy-rt-import";
const a = { subject: "A", email: "a@fixture.test" };
const b = { subject: "B", email: "b@fixture.test" };
const materialA = "fixture-only-material-A";
const materialB = "fixture-only-material-B";
const ready = account => ({ ...account, state: "ready" });
const status = (current, accounts) => ({ available: true, current, accounts: accounts.map(ready) });

// Reuses the component-only mount from artifacts/agy-rt-ui-mock.mjs. The RT requests
// below are not fulfilled by Playwright: only the unrelated model status is a stub.
const { outputFiles: [{ text: script }] } = await build({
	stdin: {
		contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
		import { CliAgentCard } from './apps/web/src/components/CliAgentCard';
		createRoot(document.getElementById('root')).render(<CliAgentCard kind="antigravity" />);`,
		loader: "tsx", resolveDir: root,
	},
	bundle: true, write: false, jsx: "automatic",
	alias: { "@pi-assistant/shared": join(root, "packages/shared/src/index.ts") },
});

const run = makeTempRun("pia-agy-rt-http-ui-");
process.env.PIA_DATA_DIR = run.data;
process.env.PIA_SECRETS = "file";
const { mountAgyRtImport } = await import("../packages/server/src/routes/agy-rt-import.ts");
const active = join(run.data, "active.json");
const staged = join(run.data, "staged.json");
const read = async file => JSON.parse(await readFile(file, "utf8"));
const readActive = () => read(active).catch(error => {
	if (error.code === "ENOENT") return null;
	throw error;
});
const write = (file, account) => writeFile(file, JSON.stringify(account), { mode: 0o600 });
const records = new Map([[a.subject, { account: a, material: materialA }]]);
const calls = [];
const evidence = [];
const addStarted = Promise.withResolvers();
const addRelease = Promise.withResolvers();
let wrongCandidate = true;
let failCommitReadback = false;
let unreadableOnce = false;
const backend = {
	current: async () => {
		if (!unreadableOnce) return readActive();
		unreadableOnce = false;
		calls.push(["commit_readback_unverified", (await read(active)).subject]);
		return null;
	},
	list: async () => [...records.values()].map(({ account }) => ready(account)),
	verify: async material => {
		if (material === materialA) return a;
		if (material !== materialB) return null;
		addStarted.resolve();
		await addRelease.promise;
		return b;
	},
	remember: async (account, material) => {
		calls.push(["remember", account.subject]);
		records.set(account.subject, { account, material });
	},
	stored: async subject => records.get(subject)?.material ?? null,
	markInvalid: async () => assert.fail("Fixture materials should remain valid"),
	stage: async (_material, account) => {
		await write(staged, wrongCandidate ? a : account);
		return {
			readAccount: async () => {
				const actual = await read(staged);
				calls.push(["read_staged", actual.subject]);
				return actual;
			},
			discard: () => rm(staged, { force: true }),
		};
	},
	activate: async (_candidate, expected, signal) => {
		if ((await readActive())?.subject !== expected?.subject) return false;
		signal.throwIfAborted();
		await rename(staged, active);
		calls.push(["activate", (await read(active)).subject]);
		unreadableOnce = failCommitReadback;
		return true;
	},
	rollback: async (_candidate, previous) => {
		calls.push(["rollback", previous?.subject ?? null]);
		if (previous) {
			await write(staged, previous);
			await rename(staged, active);
		} else await rm(active, { force: true });
	},
	removeInactive: async subject => (await readActive())?.subject !== subject && records.delete(subject),
};

const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/test.js"></script></html>';
function mountFixture(adapter) {
	const app = new Hono();
	app.use("/api/*", (c, next) => {
		const ip = c.env.incoming.socket.remoteAddress;
		c.set("caller", { local: ip === "127.0.0.1", ip, deviceId: null });
		return next();
	});
	app.get("/", c => c.html(html));
	app.get("/test.js", c => c.body(script, 200, { "Content-Type": "text/javascript" }));
	app.get("/api/models/antigravity", c => c.json({ installed: true, platformSupported: true, loggedIn: false }));
	mountAgyRtImport(app, adapter);
	return app;
}

const servers = [];
const listen = async app => {
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
	servers.push(server);
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
};
let browser;
try {
	await write(active, a);
	const base = await listen(mountFixture(backend));
	const disabledBase = await listen(mountFixture());
	browser = await chromium.launch({
		executablePath: process.env.CHROME ?? (process.platform === "darwin"
			? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"),
		headless: true, env: browserEnv(run),
		args: ["--disable-background-networking", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
	});
	const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 800 } });
	const escapedRequests = [];
	await context.route("**/*", route => {
		const { origin } = new URL(route.request().url());
		if (origin === base || origin === disabledBase) return route.continue();
		escapedRequests.push(origin);
		return route.abort();
	});
	const page = await context.newPage();
	page.setDefaultTimeout(5000);
	const errors = [];
	const writes = [];
	page.on("pageerror", error => errors.push(error.message));
	page.on("request", request => {
		const url = new URL(request.url());
		if (url.origin === base && request.method() === "POST") writes.push(url.pathname);
	});
	const button = (scope, name) => scope.getByRole("button", { name, exact: true });
	const text = (scope, value) => scope.getByText(value, { exact: true }).waitFor();
	const card = page.getByTestId("antigravity-card");
	const dialog = page.getByRole("dialog", { name: "管理账号" });
	const row = account => dialog.getByRole("listitem").filter({ hasText: account.email });
	const current = (scope, account) => text(scope, `当前账号：${account.email}`);
	const observed = pending => {
		// Cleanup must not let a rejected waiter hide the original test failure.
		void pending.catch(() => {});
		return pending;
	};
	const response = (origin, suffix = "", method = "GET") => observed(page.waitForResponse(r => r.url() === origin + path + suffix && r.request().method() === method));
	const checkHttp = async (pending, code, expected) => {
		const res = await pending;
		assert.equal(res.status(), code);
		assert.equal(res.headers()["cache-control"], "no-store");
		const body = await res.json();
		assert.deepEqual(body, expected);
		return { code, body };
	};
	// Match the browser's status request initiated after the write response, not a test-side fetch.
	const mutation = (suffix = "") => {
		const post = response(base, suffix, "POST");
		const readback = observed(post.then(() => response(base)));
		return { post, readback };
	};

	let get = response(base);
	await page.goto(base);
	await checkHttp(get, 200, status(a, [a]));
	await current(card, a);
	get = response(base);
	await button(card, "用 RT 导入账号").click();
	await checkHttp(get, 200, status(a, [a]));
	await current(dialog, a);
	assert.equal(await dialog.locator("input").count(), 1);
	const token = dialog.getByLabel("刷新令牌（RT）");
	assert.equal(await token.getAttribute("type"), "password");
	await token.fill(materialB);
	const add = mutation();
	try {
		await button(dialog, "添加账号").click();
		await Promise.race([addStarted.promise, add.post.then(() => assert.fail("Add responded without verification"))]);
		await text(dialog, "正在处理…");
		assert.equal(await token.inputValue(), "");
	} finally { addRelease.resolve(); }
	const added = await checkHttp(add.post, 200, { email: b.email });
	const afterAdd = await checkHttp(add.readback, 200, status(a, [a, b]));
	await current(dialog, a);
	await current(card, a);
	await text(row(a), "当前使用 · 可用");
	await text(row(b), "可用");
	assert.deepEqual(await read(active), a);
	assert.deepEqual(calls, [["remember", "B"]]);
	assert.deepEqual(writes, [path]);
	evidence.push({ step: "add B without switching A", post: added, readback: afterAdd, active: await read(active), uiCurrent: a.email });
	console.log("PASS add B: HTTP 200, browser status and active fixture still A; no switch request");

	for (const value of [materialB, "fixture-invalid-material"]) {
		await button(dialog, "用 RT 导入账号").click();
		await token.fill(value);
		const again = mutation();
		await button(dialog, "添加账号").click();
		assert.deepEqual((await again.post).request().postDataJSON(), { refreshToken: value });
		const valid = value === materialB;
		await checkHttp(again.post, valid ? 200 : 400, valid ? { email: b.email } : { error: "invalid_account" });
		await checkHttp(again.readback, 200, status(a, [a, b]));
		assert.equal(await row(b).count(), 1);
		assert.deepEqual(await read(active), a);
	}
	console.log("PASS RT only: provider identity, duplicate and invalid preserve A");
	const rejected = mutation("/switch");
	await button(row(b), "切换到此账号").click();
	const failure = await checkHttp(rejected.post, 400, { error: "cli_unverified" });
	const afterFailure = await checkHttp(rejected.readback, 200, status(a, [a, b]));
	await text(dialog, "未能确认账号已切换，请核对当前账号。");
	await current(dialog, a);
	await current(card, a);
	await text(row(a), "当前使用 · 可用");
	await text(row(b), "可用");
	assert.deepEqual(await read(active), a);
	assert.deepEqual(calls, [["remember", "B"], ["remember", "B"], ["read_staged", "A"]]);
	await assert.rejects(readFile(staged), { code: "ENOENT" });
	evidence.push({ step: "reject switch with mismatched staged account", post: failure, readback: afterFailure, active: await read(active), uiCurrent: a.email });
	console.log("PASS failed switch: HTTP 400 cli_unverified, staging discarded, UI reads actual A");

	wrongCandidate = false;
	// Hold the real shared gate as a fake live CLI process, without launching one.
	const releaseProcess = agyAccountGate.start();
	assert.ok(releaseProcess);
	try {
		const occupied = mutation("/switch");
		await button(row(b), "切换到此账号").click();
		const post = await checkHttp(occupied.post, 409, { error: "occupied" });
		const readback = await checkHttp(occupied.readback, 200, status(a, [a, b]));
		await text(dialog, "账号正在使用或处理，请稍后再试。");
		await current(dialog, a);
		assert.deepEqual(await read(active), a);
		assert.deepEqual(calls, [["remember", "B"], ["remember", "B"], ["read_staged", "A"]]);
		evidence.push({ step: "shared gate blocks switch while CLI lease held", post, readback, active: await read(active) });
	} finally { releaseProcess(); }
	console.log("PASS shared gate: HTTP 409 while a synthetic CLI lease is held; active remains A");

	failCommitReadback = true;
	const rolledBack = mutation("/switch");
	await button(row(b), "切换到此账号").click();
	const commitFailure = await checkHttp(rolledBack.post, 400, { error: "cli_unverified" });
	const afterRollback = await checkHttp(rolledBack.readback, 200, status(a, [a, b]));
	await text(dialog, "未能确认账号已切换，请核对当前账号。");
	await current(dialog, a);
	await current(card, a);
	await text(row(a), "当前使用 · 可用");
	assert.deepEqual(await read(active), a);
	assert.deepEqual(calls.slice(3), [["read_staged", "B"], ["activate", "B"], ["commit_readback_unverified", "B"], ["rollback", "A"]]);
	await assert.rejects(readFile(staged), { code: "ENOENT" });
	evidence.push({ step: "post-activation readback failure rolls back to A", post: commitFailure, readback: afterRollback, active: await read(active), uiCurrent: a.email });
	console.log("PASS commit readback failure: B was written, then rolled back to A before browser status");

	failCommitReadback = false;
	const switched = mutation("/switch");
	await button(row(b), "切换到此账号").click();
	const success = await checkHttp(switched.post, 200, { email: b.email });
	const afterSwitch = await checkHttp(switched.readback, 200, status(b, [a, b]));
	await current(dialog, b);
	await current(card, b);
	await text(row(b), "当前使用 · 可用");
	assert.equal(await dialog.getByRole("alert").count(), 0);
	assert.deepEqual(await read(active), b);
	await assert.rejects(readFile(staged), { code: "ENOENT" });
	assert.deepEqual(calls.slice(7), [["read_staged", "B"], ["activate", "B"]]);
	assert.deepEqual(writes, [path, path, path, ...Array(4).fill(`${path}/switch`)]);
	get = response(base);
	await page.reload();
	const reload = await checkHttp(get, 200, status(b, [a, b]));
	await current(card, b);
	assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
	evidence.push({ step: "switch B and reload", post: success, readback: afterSwitch, active: await read(active), uiCurrent: b.email, reload });
	console.log("PASS switch B: HTTP 200, actual B confirmed by browser readback, fixture file and reload");

	get = response(base);
	await button(card, "管理账号").click();
	await checkHttp(get, 200, status(b, [a, b]));
	await button(row(a), "移除").click();
	const removal = mutation("/remove");
	await text(page.getByTestId("confirm-dialog"), "移除账号？");
	await page.getByTestId("confirm-ok").click();
	await checkHttp(removal.post, 200, { ok: true });
	await checkHttp(removal.readback, 200, status(b, [b]));
	await current(dialog, b);
	assert.equal(await row(a).count(), 0);
	assert.deepEqual(await read(active), b);
	console.log("PASS removal: confirmed removal of inactive A, B still active");

	get = response(disabledBase);
	await page.goto(disabledBase);
	const unavailable = { available: false, current: null, accounts: [] };
	await checkHttp(get, 200, unavailable);
	get = response(disabledBase);
	await button(card, "管理账号").click();
	const gated = await checkHttp(get, 200, unavailable);
	await text(dialog, "此版本暂不支持多账号管理，请使用原来的登录方式。");
	assert.equal(await button(page, "用 RT 导入账号").count(), 0);
	assert.equal(await button(page, "用 Google 登录添加").count(), 0);
	await button(card, "登录").waitFor({ state: "attached" });
	assert.deepEqual(errors, []);
	assert.deepEqual(escapedRequests, []);
	evidence.push({ step: "no injected adapter", readback: gated, importButton: false, officialLoginVisibleInCard: true });
	console.log("PASS capability off: real route without adapter reports unavailable; no browser import action");

	const output = join(artifactDir("agy-rt-import-http-ui"), "result.json");
	await write(output, {
		result: "pass",
		scope: "Isolated Chrome → loopback HTTP → real mountAgyRtImport and service → synthetic adapter/temp files; no production server, OAuth or CLI",
		steps: evidence, adapterCalls: calls, browserWritePaths: writes, nonFixtureBrowserRequests: escapedRequests,
	});
	console.log(`Evidence: ${output}`);
} finally {
	addRelease.resolve();
	try { await browser?.close(); } finally {
		try {
			await Promise.all(servers.map(server => new Promise(resolve => {
				server.close(resolve);
				server.closeAllConnections();
			})));
		} finally { cleanupTempRun(run); }
	}
}
