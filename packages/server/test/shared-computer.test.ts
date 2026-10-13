/**
 * 共用助理电脑（DESIGN §15.4）：
 * - 纯逻辑：分配到哪台电脑、自己的屏幕名、旧版数据保留、主屏幕争用、合并脚本（真跑一遍）、硬性保护
 * - 扩展：共用浏览器里每个助理只看自己的标签页；computer_screen 工具与“动作前”钩子
 * - 真 Docker（需要本地镜像 pi-assistant/desktop:dev，没有就跳过）：两个助理同时用一台电脑、各自的屏幕互不抢鼠标、
 *   一个助理的登录 cookie 另一个看得到、单独电脑的助理完全隔离、合并进共用电脑
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PIA_SHARED_COMPUTER = `sharedit${process.pid}`;
process.env.PIA_DESKTOP_IMAGE ??= "pi-assistant/desktop:dev";
await import("./setup.ts");
import assert from "node:assert/strict";
const { test } = await import("node:test");
const C = await import("../src/desktop/computers.ts");
const D = await import("../src/desktop.ts");
const { updateDesktopSettings, setSeparate, desktopSettings } = await import("../src/desktop/settings.ts");
const { assertOwnTarget } = await import("../src/desktop/names.ts");
const { db } = await import("../src/db.ts");
const { browserExtension } = await import("@pi-assistant/ext-browser");
const { computerExtension, SHARED_COMPUTER_PROMPT } = await import("@pi-assistant/ext-computer");
const { chromium } = await import("playwright-core");

let haveDocker = false;
try {
	execFileSync("docker", ["image", "inspect", process.env.PIA_DESKTOP_IMAGE!], { stdio: "ignore" });
	haveDocker = true;
} catch {}

const P = process.pid;
const A = `sca${P}`, B = `scb${P}`, S = `scs${P}`;
for (const [id, name] of [[A, "小甲"], [B, "小乙"], [S, "小丙"]])
	db.prepare("INSERT INTO agents(id, name, avatar, color, persona, sort, created_at) VALUES(?,?,?,?,?,?,?)").run(id, name, "x", "#000", "", 0, Date.now());

// ---------------------------------------------------------------- 纯逻辑
test("分配：默认共用一台，选了单独的电脑用自己的（名字与旧版一致）", () => {
	assert.equal(C.computerFor("a1", { separate: [] }), C.SHARED);
	assert.equal(C.computerFor("a1", { separate: ["a1"] }), "a1");
	assert.equal(C.isSharedComputer(C.SHARED), true);
	assert.equal(C.ownScreenKey("a/1"), "s-a1");
	assert.equal(C.ownScreenKey("x".repeat(40)), `s-${"x".repeat(40)}`);
});
test("旧版数据：已有自己电脑家目录卷的现有助理保留为单独的电脑；不认识的卷 / 共用卷忽略", () => {
	assert.deepEqual(C.legacySeparate(["pia-home-a1", "pia-home-zz", `pia-home-${C.SHARED}`, "other", ""], ["a1", "a2"]), ["a1"]);
	assert.deepEqual(C.legacySeparate([], ["a1"]), []);
});
test("主屏幕争用：别的助理在 90 秒内用过且还在工作 → 开自己的屏幕；否则可以用", () => {
	const busy = (id: string) => id === "b";
	assert.equal(C.mainScreenDecision("a", undefined, 1000, busy), "ok");
	assert.equal(C.mainScreenDecision("a", { agentId: "a", at: 0 }, 1000, busy), "ok");
	assert.equal(C.mainScreenDecision("a", { agentId: "b", at: 0 }, 1000, busy), "contention");
	assert.equal(C.mainScreenDecision("a", { agentId: "b", at: 0 }, C.MAIN_LEASE_MS, busy), "ok", "过期了");
	assert.equal(C.mainScreenDecision("a", { agentId: "c", at: 0 }, 1000, busy), "ok", "那个助理已经不工作了");
	const t = C.describeScreens([{ key: C.MAIN }, { key: "s-a", agentId: "a" }], "a", "s-a", (x) => x.toUpperCase());
	assert.match(t, /主屏幕/);
	assert.match(t, /→ A 的屏幕（你的）/);
});
test("设置：separate 列表增删", () => {
	setSeparate("zz", true);
	assert.ok(desktopSettings().separate.includes("zz"));
	setSeparate("zz", false);
	assert.ok(!desktopSettings().separate.includes("zz"));
});
test("合并脚本：语法正确；浏览器目录 共用里没有就搬、有了放进 旧电脑-名字；其他文件不覆盖", () => {
	execFileSync("bash", ["-n", "-c", D.MERGE_SCRIPT]);
	const t = mkdtempSync(join(tmpdir(), "pia-merge-"));
	const from = join(t, "from"), to = join(t, "to");
	for (const [p, v] of [["from/.config/pia-browser/Cookies", "old"], ["from/.xwechat/x", "wx"], ["from/a.txt", "from"], ["from/new.txt", "new"], ["to/.config/pia-browser/Cookies", "shared"], ["to/a.txt", "to"]]) {
		mkdirSync(join(t, p, ".."), { recursive: true });
		writeFileSync(join(t, p), v);
	}
	const script = D.MERGE_SCRIPT.replaceAll("/from", from).replaceAll("/to", to);
	const out = execFileSync("bash", ["-c", script, "merge", "小丙"], { encoding: "utf8" });
	assert.match(out, /merged moved=1 kept=1/);
	const r = (p: string) => readFileSync(join(to, p), "utf8");
	assert.equal(r(".config/pia-browser/Cookies"), "shared", "共用电脑的登录状态不被覆盖");
	assert.equal(r("旧电脑-小丙/.config/pia-browser/Cookies"), "old");
	assert.equal(r(".xwechat/x"), "wx");
	assert.equal(r("a.txt"), "to");
	assert.equal(r("new.txt"), "new");
});
test("硬性保护：合并辅助容器 / 共用电脑都是我们自己的；别的容器不行", () => {
	const img = ["pi-assistant/desktop"];
	assert.doesNotThrow(() => assertOwnTarget(["run", "--rm", "--name", "pia-desk-merge-a1", "--label", "pia.agent=merge", "-u", "0", "--entrypoint", "bash", "-v", "pia-home-a1:/from:ro", "-v", "pia-home-shared:/to", "pi-assistant/desktop:dev", "-c", "x"], img));
	assert.doesNotThrow(() => assertOwnTarget(["exec", "pia-desk-shared", "pia-screen", "ls"], img));
	assert.throws(() => assertOwnTarget(["exec", "postgres", "pia-screen", "ls"], img));
	assert.throws(() => assertOwnTarget(["run", "--rm", "-v", "/:/to", "pi-assistant/desktop:dev"], img));
});

// ---------------------------------------------------------------- 扩展
function fakePi() {
	const tools = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[] }> }>();
	const handlers = new Map<string, ((e: never) => unknown)[]>();
	return {
		tools,
		handlers,
		registerTool: (t: never) => tools.set((t as { name: string }).name, t),
		registerMcpServer: () => {},
		on: (ev: string, h: (e: never) => unknown) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
		call: async (n: string, p: Record<string, unknown> = {}) => (await tools.get(n)!.execute("id", p)).content.map((c) => c.text ?? "").join("\n"),
	};
}
test("computer_screen 工具 + 系统提示 + 动作前钩子（主屏幕忙时拦下并说明）", async () => {
	const pi = fakePi();
	const calls: string[] = [];
	let first = true;
	computerExtension({
		target: "sandbox", mcp: { command: "true", args: [] }, isPaused: () => false, request: async () => ({ approved: true }), screenshot: async () => Buffer.alloc(0), handoff: async () => "",
		before: async () => (first ? ((first = false), "主屏幕现在正被「小乙」操作，已经给你开了一块自己的屏幕") : null),
		screens: { list: async () => (calls.push("list"), "屏幕列表"), own: async () => (calls.push("own"), "自己的"), main: async () => (calls.push("main"), "主"), separate: async (on: boolean, r: string) => (calls.push(`sep:${on}:${r}`), "ok") },
	} as never)(pi as never);
	assert.equal(await pi.call("computer_screen", { action: "own" }), "自己的");
	await pi.call("computer_screen", { action: "list" });
	await assert.rejects(pi.tools.get("computer_screen")!.execute("i", { action: "separate_on" }), /reason/);
	await pi.call("computer_screen", { action: "separate_on", reason: "要登录另一个淘宝号" });
	assert.deepEqual(calls, ["own", "list", "sep:true:要登录另一个淘宝号"]);
	const sp = (await (pi.handlers.get("before_agent_start")![0] as (e: { systemPrompt: string }) => Promise<{ systemPrompt: string }>)({ systemPrompt: "基础" })).systemPrompt;
	assert.ok(sp.startsWith("基础") && sp.includes(SHARED_COMPUTER_PROMPT));
	assert.match(SHARED_COMPUTER_PROMPT, /shell[\s\S]*browser_context isolated[\s\S]*separate_on/);
	const hook = pi.handlers.get("tool_call")![0] as (e: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;
	const r1 = await hook({ toolName: "mcp__computer__click", input: { x: 1, y: 2 }, toolCallId: "c1" });
	assert.equal(r1?.block, true);
	assert.match(r1!.reason!, /自己的屏幕/);
	const r2 = await hook({ toolName: "mcp__computer__get_screen_size", input: {}, toolCallId: "c2" });
	assert.ok(!r2?.block, "只看不动的工具不经过钩子");
});

const CHROME = process.env.CHROME ?? ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
test("共用浏览器：两个助理连同一个浏览器，各自只看到自己打开的标签页；cookie 共用；isolated 不带 cookie", { skip: !CHROME && "没有 Chrome", timeout: 60_000 }, async () => {
	// 和助理电脑一样：一个 Chromium 进程，每个助理一条自己的 CDP 连接
	const port = 9400 + (P % 500);
	const ud = mkdtempSync(join(tmpdir(), "pia-cdp-"));
	const proc = spawn(CHROME!, ["--headless=new", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${ud}`, "about:blank"], { stdio: "ignore" });
	let browser!: Awaited<ReturnType<typeof chromium.connectOverCDP>>, browser2!: typeof browser;
	for (let i = 0; i < 50 && !browser; i++) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(async () => (await new Promise((r) => setTimeout(r, 200)), undefined as never));
	browser2 = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	try {
		const base = browser.contexts()[0];
		const base2 = browser2.contexts()[0];
		await base.addCookies([{ name: "sid", value: "login-ok", url: "https://example.test/" }]);
		const mk = (ctx: typeof base) => {
			const pi = fakePi();
			browserExtension({ context: async () => ctx, mode: () => "sandbox", workspace: tmpdir(), isPaused: () => false, request: async () => ({ approved: true }), handoff: async () => "", shared: true, isolated: () => browser.newContext() })(pi as never);
			return pi;
		};
		const a = mk(base), b = mk(base2);
		await a.call("browser_navigate", { url: "data:text/html;charset=utf-8,<title>甲的页面</title>A" });
		await b.call("browser_navigate", { url: "data:text/html;charset=utf-8,<title>乙的页面</title>B" });
		const ta = await a.call("browser_tabs", {});
		const tb = await b.call("browser_tabs", {});
		assert.match(ta, /甲的页面/);
		assert.doesNotMatch(ta, /乙的页面/);
		assert.match(tb, /乙的页面/);
		assert.doesNotMatch(tb, /甲的页面/);
		assert.equal(base.pages().length >= 2, true);
		assert.equal((await base2.cookies("https://example.test/"))[0]?.value, "login-ok", "另一个助理的连接看得到同一个 cookie");
		assert.match(await a.call("browser_context", { mode: "isolated" }), /单独的浏览器环境/);
		assert.match(await a.call("browser_tabs", {}), /about:blank|没有|0/);
		assert.match(await a.call("browser_context", { mode: "shared" }), /切回/);
		assert.match(await a.call("browser_tabs", {}), /甲的页面/);
	} finally {
		await browser.close().catch(() => {});
		await browser2.close().catch(() => {});
		proc.kill();
	}
});

// ---------------------------------------------------------------- 真 Docker
type Rpc = { send(m: unknown): void; next(id: number): Promise<{ result?: { content?: { text?: string }[] }; error?: unknown }>; close(): void };
function mcp(agentId: string): Rpc {
	const c = D.cuaMcpCommand(agentId);
	const p = spawn(c.command, c.args, { stdio: ["pipe", "pipe", "ignore"] });
	let buf = "";
	const waiters = new Map<number, (m: never) => void>();
	p.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			try {
				const m = JSON.parse(line);
				waiters.get(m.id)?.(m as never);
			} catch {}
		}
	});
	return {
		send: (m) => p.stdin.write(`${JSON.stringify(m)}\n`),
		next: (id) => new Promise((r, j) => (waiters.set(id, r), setTimeout(() => j(new Error(`mcp ${agentId} #${id} 超时`)), 30_000))),
		close: () => p.kill(),
	};
}
async function mcpCall(r: Rpc, id: number, name: string, args: Record<string, unknown>) {
	r.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
	return r.next(id);
}
async function mcpInit(r: Rpc) {
	r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
	await r.next(1);
	r.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}
const ex = (cid: string, ...cmd: string[]) => execFileSync("docker", ["exec", `pia-desk-${cid}`, ...cmd], { encoding: "utf8" }).trim();
const mouse = (cid: string, display: number) => execFileSync("docker", ["exec", "-e", `DISPLAY=:${display}`, `pia-desk-${cid}`, "xdotool", "getmouselocation"], { encoding: "utf8" }).trim();

test("真 Docker：两个助理同时用共用电脑、各自的屏幕、共用登录状态；单独的电脑隔离；合并", { skip: !haveDocker && "没有 Docker 或 pi-assistant/desktop:dev 镜像", timeout: 900_000 }, async () => {
	const SH = C.SHARED;
	updateDesktopSettings({ enabled: true, idleMinutes: 5 });
	const busy = () => true;
	try {
		// 两个助理 → 同一台电脑（一个容器、一个家目录）
		const [sa, sb] = await Promise.all([D.startDesktop(A), D.startDesktop(B)]);
		assert.equal(sa.state, "running");
		assert.equal(sa.port, sb.port, "同一台电脑");
		assert.equal(D.containerOf(A), `pia-desk-${SH}`);
		assert.deepEqual(D.agentsOn(SH).sort(), [A, B, S].sort(), "默认所有助理都在共用电脑上");
		const runningBefore = await D.runningDesktops();
		assert.ok(runningBefore.includes(SH));

		// 甲先在主屏幕上操作；乙这时也要操作 → 自动给乙开自己的屏幕，这次动作被拦下并说明
		assert.equal(await D.beforeComputerAction(A, busy), null);
		const why = await D.beforeComputerAction(B, busy);
		assert.match(why ?? "", /小甲[\s\S]*自己的屏幕/);
		const dA = await D.displayOf(A), dB = await D.displayOf(B);
		assert.notEqual(dA, dB);
		assert.equal(await D.beforeComputerAction(B, busy), null, "在自己的屏幕上就不再拦");
		assert.match(ex(SH, "pia-screen", "ls"), new RegExp(C.ownScreenKey(B)));

		// 两个助理同时用 cua-driver 操作（经中继连到各自屏幕的守护进程）：鼠标互不影响
		const ma = mcp(A), mb = mcp(B);
		try {
			await Promise.all([mcpInit(ma), mcpInit(mb)]);
			const [ra, rb] = await Promise.all([mcpCall(ma, 2, "click", { x: 111, y: 222, scope: "desktop" }), mcpCall(mb, 2, "click", { x: 333, y: 144, scope: "desktop" })]);
			assert.ok(!ra.error && !rb.error, JSON.stringify([ra, rb]));
			assert.match(mouse(SH, dA), /x:111 y:222/);
			assert.match(mouse(SH, dB), /x:333 y:144/);
			const [sza, szb] = await Promise.all([mcpCall(ma, 3, "get_screen_size", {}), mcpCall(mb, 3, "get_screen_size", {})]);
			assert.ok(sza.result && szb.result);
		} finally {
			ma.close();
			mb.close();
		}
		// 截图各是各的屏幕
		const [pa, pb] = await Promise.all([D.screenshotDesktop(A), D.screenshotDesktop(B)]);
		assert.equal(pa.subarray(1, 4).toString(), "PNG");
		assert.equal(pb.subarray(1, 4).toString(), "PNG");
		// 实时画面：默认看自己的屏幕，可以看同一台电脑上的其他屏幕，不存在的屏幕回落到主屏幕
		assert.equal(await D.viewToken(B), C.ownScreenKey(B));
		assert.equal(await D.viewToken(B, C.MAIN), C.MAIN);
		assert.equal(await D.viewToken(A, C.ownScreenKey(B)), C.ownScreenKey(B));
		assert.equal(await D.viewToken(A, "s-nope"), C.MAIN);
		const tk = D.issueTicket(A, C.ownScreenKey(B));
		assert.deepEqual(D.useTicket(tk), { agentId: A, screen: C.ownScreenKey(B) });
		assert.equal(D.useTicket(tk), null, "一次性");
		const vnc = await fetch(`http://127.0.0.1:${sa.port}/vnc.html`);
		assert.equal(vnc.status, 200);

		// 共用浏览器：一个 Chromium，甲登录（写 cookie），乙看得到
		const [cdpA, cdpB] = await Promise.all([D.ensureDesktopBrowser(A), D.ensureDesktopBrowser(B)]);
		assert.equal(cdpA, cdpB);
		const ba = await chromium.connectOverCDP(cdpA), bb = await chromium.connectOverCDP(cdpB);
		await ba.contexts()[0].addCookies([{ name: "sid", value: "logged-in-by-A", url: "https://login.example/" , expires: Math.floor(Date.now() / 1000) + 3600 }]);
		assert.equal((await bb.contexts()[0].cookies("https://login.example/"))[0]?.value, "logged-in-by-A");
		await ba.close();
		await bb.close();
		// 文件也共用
		ex(SH, "sh", "-c", "echo from-A > /home/agent/shared.txt");

		// 乙回主屏幕：自己的屏幕收掉
		await D.releaseScreen(B);
		assert.equal(await D.displayOf(B), dA);
		assert.doesNotMatch(ex(SH, "pia-screen", "ls"), new RegExp(C.ownScreenKey(B)));

		// 丙选了单独的电脑：自己的容器和家目录，看不到共用的文件和登录状态
		await D.setSeparateComputer(S, true);
		assert.equal(D.containerOf(S), `pia-desk-${S}`);
		const ss = await D.startDesktop(S);
		assert.equal(ss.state, "running");
		assert.notEqual(ss.port, sa.port);
		assert.equal(ex(S, "sh", "-c", "cat /home/agent/shared.txt 2>/dev/null || echo none"), "none");
		const cdpS = await D.ensureDesktopBrowser(S);
		assert.notEqual(cdpS, cdpA);
		const bs = await chromium.connectOverCDP(cdpS);
		assert.equal((await bs.contexts()[0].cookies("https://login.example/")).length, 0, "单独的电脑没有共用的登录状态");
		await bs.close();
		assert.equal(await D.beforeComputerAction(S, busy), null, "单独的电脑主屏幕只有自己");
		ex(S, "sh", "-c", "echo mine > /home/agent/s-only.txt");
		assert.equal(await D.hasSeparateData(S), true);
		// 切回共用：数据保留；再合并进共用电脑
		await D.setSeparateComputer(S, false);
		assert.equal(D.containerOf(S), `pia-desk-${SH}`);
		assert.equal(await D.hasSeparateData(S), true, "关掉单独的电脑数据还在");
		// 已改回共用电脑时也能合并（设置页「合并进共用电脑」就是这种情形；卷还在）
		await assert.rejects(D.mergeIntoShared(S, (id) => id === A), /共用电脑正在被使用/);
		const res = await D.mergeIntoShared(S, () => false);
		assert.match(res, /merged/);
		assert.equal(D.containerOf(S), `pia-desk-${SH}`);
		assert.equal(await D.hasSeparateData(S), false);
		await D.startDesktop(S);
		assert.equal(ex(SH, "cat", "/home/agent/s-only.txt"), "mine");
		assert.equal(ex(SH, "cat", "/home/agent/shared.txt"), "from-A", "合并不覆盖共用电脑已有的文件");
		const cdp2 = await D.ensureDesktopBrowser(A);
		const b2 = await chromium.connectOverCDP(cdp2);
		assert.equal((await b2.contexts()[0].cookies("https://login.example/"))[0]?.value, "logged-in-by-A", "共用电脑的登录状态没被合并弄丢");
		await b2.close();
	} finally {
		await D.stopDesktop(A).catch(() => {});
		for (const n of [`pia-desk-${SH}`, `pia-desk-${S}`]) execFileSync("docker", ["rm", "-f", n], { stdio: "ignore" });
		for (const v of [`pia-home-${SH}`, `pia-home-${S}`]) try { execFileSync("docker", ["volume", "rm", v], { stdio: "ignore" }); } catch {}
		updateDesktopSettings({ enabled: false });
	}
});
