// macOS: sandbox-exec -f e2e/fixtures/desktop-peer-browser-loopback.sb node e2e/desktop-peer-ui.mjs
// Uses the real App and local Mock service; only DesktopPeerPort crosses a test seam.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("./fixtures/desktop-peer-app.tsx", import.meta.url));
const run = makeTempRun("pia-e2e-desktop-peer-");
const ready = join(run.runDir, "startup.json");
const srv = startTempServer({ root, run, port: 0, baseEnv: { PATH: "/usr/bin:/bin" }, extra: {
	PIA_HOST: "127.0.0.1", PIA_TEST_STARTUP_FILE: ready, PIA_WORKSPACE: join(run.data, "workspace"),
} });

const peer = "fixture-peer";
const name = "远端测试电脑";
const agent = "fixture-remote-agent";
const chats = [
	{ agent, conversation: "slow", title: "远端慢会话" },
	{ agent, conversation: "current", title: "远端当前会话" },
];
const currentHistory = "只有远端当前会话有这条消息";
const staleHistory = "迟到的旧会话消息，不应显示";
const fixturePath = "/__desktop_peer_fixture/";
const slow = Promise.withResolvers();
let connection = "online", vite, browser;
const posts = [], unexpected = [];

async function waitUntil(test, description) {
	for (const end = Date.now() + 20_000; Date.now() < end;) {
		if (test()) return;
		await delay(50);
	}
	assert.fail(`Timed out: ${description}`);
}

try {
	await waitUntil(() => {
		assert.equal(srv.child.exitCode, null, srv.logs());
		return existsSync(ready);
	}, "temporary service startup");
	const { port } = JSON.parse(readFileSync(ready, "utf8"));
	assert.ok(port > 0);
	const local = `http://127.0.0.1:${port}`;
	async function seed(path, method, body) {
		const response = await fetch(local + path, {
			method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
			redirect: "error", signal: AbortSignal.timeout(10_000),
		});
		assert.ok(response.ok, `${method} ${path}: ${response.status}`);
	}
	await seed("/api/settings", "PUT", { onboarded: true });
	await seed("/api/agents", "POST", { name: "本机测试助理" });

	vite = await createServer({
		root: join(root, "apps/web"), envDir: false, cacheDir: join(run.runDir, "vite-cache"),
		plugins: [{ name: "desktop-peer-test-entry", transformIndexHtml(html) {
			assert.ok(html.includes('/src/main.tsx'), "App entry missing from index.html");
			return html.replace("/src/main.tsx", encodeURI(`/@fs${entry}`));
		} }],
		server: {
			host: "127.0.0.1", port: 0, fs: { allow: [root] },
			proxy: { "/api": local, "/ws": { target: `ws://127.0.0.1:${port}`, ws: true } },
		},
	});
	await vite.listen();
	const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
	const { HOME, TMPDIR } = browserEnv(run);
	browser = await chromium.launch({
		executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		env: { HOME, TMPDIR, PATH: "/usr/bin:/bin" }, headless: true,
		args: ["--no-sandbox", "--use-mock-keychain", "--disable-quic", "--proxy-server=http://127.0.0.1:1",
			"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
	});
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN", serviceWorkers: "block" });
	await ctx.routeWebSocket("**/*", ws => {
		const url = new URL(ws.url());
		const appEvents = url.pathname === "/ws" && !url.search;
		const viteDevClient = url.pathname === "/" && url.searchParams.get("token") === vite.config.webSocketToken;
		if (url.origin === base.replace("http:", "ws:") && (appEvents || viteDevClient)) ws.connectToServer();
		else { unexpected.push(`${url.origin}${url.pathname}`); return ws.close(); }
	});
	await ctx.route("**/*", async route => {
		const req = route.request();
		const url = new URL(req.url());
		// The local chat uses a bodyless POST to mark itself read on activation/focus.
		const localReadReceipt = url.origin === base && /^\/api\/agents\/[^/]+\/read$/.test(url.pathname) && req.postData() === null;
		if (req.method() === "POST" && !localReadReceipt) posts.push({ path: url.pathname, body: req.postData() });
		if (url.origin !== base) { unexpected.push(req.url()); return route.abort(); }
		if (!url.pathname.startsWith(fixturePath)) return route.continue();

		const op = url.pathname.slice(fixturePath.length);
		const p = url.searchParams;
		const ok = json => route.fulfill({ json });
		if (op === "list") return ok([{ id: peer, name, state: connection }]);
		if (op === "send" && req.method() === "POST") return route.fulfill({ status: 204 });
		if (p.get("peer") === peer) {
			if (op === "status") return ok(connection);
			if (op === "chats") return ok(chats);
			if (p.get("agent") === agent && chats.some(c => c.conversation === p.get("conversation"))) {
				if (op === "read-delivered") return ok(null);
				if (op === "read") {
					const isSlow = p.get("conversation") === "slow";
					if (isSlow) await slow.promise;
					return ok([{ role: "assistant", id: p.get("conversation"), content: isSlow ? staleHistory : currentHistory }]);
				}
			}
		}
		unexpected.push(`${req.method()} ${url.pathname}${url.search}`);
		return route.fulfill({ status: 400 });
	});

	const page = await ctx.newPage();
	page.setDefaultTimeout(15_000);
	const errors = [];
	page.on("pageerror", error => errors.push(error.message));
	const button = (scope, name) => scope.getByRole("button", { name, exact: true });
	const openPeer = async () => {
		await button(page, "切换电脑").click();
		await button(page, `${name} · 在线`).click();
		await dialog.waitFor();
	};
	const dialog = page.getByTestId("desktop-peer-chat");
	const box = dialog.getByRole("textbox", { name: "远端消息", exact: true });
	const send = button(dialog, `发送到${name}`);
	const pending = (op, conversation) => req => {
		const url = new URL(req.url());
		return url.pathname === fixturePath + op && url.searchParams.get("conversation") === conversation;
	};

	await page.goto(base, { waitUntil: "domcontentloaded" });
	await page.getByText("本机测试助理", { exact: true }).first().click();
	const localBox = page.getByPlaceholder("给 本机测试助理 发消息…", { exact: true });
	const localDraft = "这段本机草稿不能发到远端";
	await localBox.fill(localDraft);
	const firstRead = page.waitForRequest(pending("read", "slow"));
	await openPeer();
	await button(dialog, chats[0].title).click();
	await firstRead;
	await button(dialog, "本机").click();
	await dialog.waitFor({ state: "hidden" });
	assert.equal(await localBox.inputValue(), localDraft);

	await openPeer();
	await button(dialog, chats[1].title).click();
	const current = dialog.getByText(currentHistory, { exact: true });
	await current.waitFor();
	assert.equal(await box.inputValue(), "", "remote composer must not inherit the local draft");
	const late = page.waitForResponse(r => pending("read-delivered", "slow")(r.request()) && r.ok());
	slow.resolve();
	await late;
	assert.equal(await current.isVisible(), true, "late response must not replace current history");
	assert.equal(await page.getByText(staleHistory, { exact: true }).count(), 0);
	console.log("通过：正式入口切换、会话读取、迟到响应隔离、本机草稿保留");

	const remoteDraft = "断线期间保留的远端草稿";
	await box.fill(remoteDraft);
	const refresh = button(dialog, "刷新连接");
	const status = dialog.getByRole("status");
	connection = "offline";
	await refresh.click();
	await status.filter({ hasText: /^已断线$/ }).waitFor();
	assert.equal(await send.isDisabled(), true);
	assert.equal(await box.inputValue(), remoteDraft);
	// The remote textarea inserts a line break, not a send, on Enter.
	await box.press("End");
	await box.press("Enter");
	await box.pressSequentially("offline");
	const offlineDraft = `${remoteDraft}\noffline`;
	assert.equal(await box.inputValue(), offlineDraft);
	assert.deepEqual(posts, [], "offline: no local or remote POST");

	connection = "online";
	const reloaded = page.waitForResponse(r => pending("read-delivered", "current")(r.request()) && r.ok());
	await refresh.click();
	await status.filter({ hasText: /^在线$/ }).waitFor();
	await reloaded;
	assert.equal(await send.isEnabled(), true);
	assert.equal(await box.inputValue(), offlineDraft);
	assert.deepEqual(posts, [], "reconnect: no replay and no local POST");
	console.log("通过：断线禁发保草稿，重连不自动发出请求");

	const sent = page.waitForResponse(r => r.url() === base + fixturePath + "send" && r.ok());
	await send.click();
	await sent;
	await page.waitForFunction(() => document.querySelector('textarea[aria-label="远端消息"]')?.value === "");
	assert.equal(posts.length, 1, "only the explicit click sends a POST");
	assert.equal(posts[0].path, fixturePath + "send");
	const payload = JSON.parse(posts[0].body);
	assert.deepEqual(payload.target, { peer, agent, conversation: "current" });
	assert.equal(payload.text, offlineDraft);
	assert.ok(payload.id?.length, "explicit send includes a client message ID");
	await button(dialog, "本机").click();
	await dialog.waitFor({ state: "hidden" });
	assert.equal(await localBox.inputValue(), localDraft);
	assert.deepEqual(unexpected, [], "only allowed fixture operations and same-origin traffic");
	assert.deepEqual(errors, [], "no uncaught browser exceptions");
	console.log("通过：明确点击后只向选中的远端会话发送一次，本机草稿不变");
} finally {
	slow.resolve();
	try { await browser?.close(); } finally {
		try { await vite?.close(); } finally {
			await srv.stop();
			cleanupTempRun(run);
		}
	}
}
