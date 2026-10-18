/**
 * 定向验证：发送快捷键偏好（默认 Enter 发送，可切 Shift+Enter 发送）+ 输入法（IME）防误发。
 * 覆盖：单聊 / 群聊 / 子代理三个输入栏同一偏好、两种偏好、持久化、按设备（不影响别的设备 / 服务端设置）、
 *       Chrome 与 WebKit 两种 composition 次序、keyCode 229、按住重复、@ 候选只选人不发送、引用保留、390 布局。
 * 只跑这一个脚本，不跑全量 e2e。
 * 运行：node e2e/send-shortcut-ui.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createSecurityProbe, spawnMemoryServer, startupEvidence } from "./fixtures/safe-memory-server.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";

const ROOT = new URL("..", import.meta.url);
const { fileURLToPath } = await import("node:url");
const REPO = fileURLToPath(ROOT);
const OUT = artifactDir("send-shortcut");
const DATA = "/tmp/pia-verify-send-shortcut";
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const PREF = "pia.chat.sendShortcut";
rmSync(DATA, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const probe = createSecurityProbe(DATA);
let server, startupFile, browser;
const waitFor = async (fn, ms = 25_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(`${path} ${JSON.stringify(data)}`); return data; };
const start = async () => { const r = spawnMemoryServer({ repoRoot: REPO, dataDir: DATA, port: PORT, probe }); server = r.child; startupFile = r.startupFile; server.stdout.on("data", (d) => process.stdout.write(d)); server.stderr.on("data", (d) => process.stderr.write(d));
	server.on("exit", (code, sig) => console.error(`[server exited] code=${code} signal=${sig}`));
	await waitFor(async () => (await fetch(BASE + "/api/system")).ok); };
const stop = async () => { if (!server || server.exitCode !== null) return; const done = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await done; };

let failed = 0;
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };

const SINGLE_TA = "[data-testid=main-conversation] textarea:visible:not(.pa-card textarea)";
const userMsgs = async (agentId) => (await j(`/api/agents/${agentId}/messages`)).filter((x) => x.role === "user");
/** 合成 composition / Enter（React 在根节点上代理事件，冒泡到的合成事件同样会进 handler） */
const synth = (page, sel, kind, opts = {}) => page.locator(sel).evaluate((el, [kind, o]) => {
	if (kind === "compositionstart" || kind === "compositionend") {
		el.dispatchEvent(new CompositionEvent(kind, { bubbles: true, cancelable: true, data: o.data ?? "" }));
		return;
	}
	const ev = new KeyboardEvent("keydown", { key: o.key ?? "Enter", bubbles: true, cancelable: true, shiftKey: !!o.shiftKey, repeat: !!o.repeat });
	Object.defineProperty(ev, "keyCode", { value: o.keyCode ?? 13 });
	Object.defineProperty(ev, "isComposing", { value: !!o.isComposing });
	el.dispatchEvent(ev);
}, [kind, opts]);

try {
	await start();
	const ev = await startupEvidence(startupFile, probe);
	check("启动走测试入口：内存凭据被调用（>0）", ev.storeCalls > 0, `storeCalls=${ev.storeCalls}`);
	check("0 次系统 security（不碰钥匙串）", ev.securityCalls === 0, `security=${ev.securityCalls}`);
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "快捷键验证" });
	const room = await j("/api/rooms", "POST", { name: "快捷键群", purpose: "验证群聊输入栏", memberIds: [a.id], managerId: a.id });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	const page = await ctx.newPage();
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (e) => { console.error("pageerror:", e); failed++; });
	// 只说「发送键」：助理运行时发送键会换成停止键（aria-label 不同），所以按 aria-label 取
	const sendBtn = page.locator('[data-testid=main-conversation] .pa-composer .pa-send[aria-label="发送"]');
	const gotoAgent = async () => { await page.goto(`${BASE}/?agent=${a.id}`); await page.locator(SINGLE_TA).waitFor(); await page.waitForTimeout(700); };

	// ---------------- 1) 默认（没设过）= Enter 发送 / Shift+Enter 换行
	console.log("\n[1] 默认偏好：Enter 发送 / Shift+Enter 换行");
	await gotoAgent();
	check("默认没有本地偏好值", (await page.evaluate((k) => localStorage.getItem(k), PREF)) === null);
	check("发送按钮 title = Enter 发送", (await sendBtn.getAttribute("title")) === "Enter 发送，Shift+Enter 换行", String(await sendBtn.getAttribute("title")));
	check("aria-keyshortcuts = Enter", (await sendBtn.getAttribute("aria-keyshortcuts")) === "Enter", String(await sendBtn.getAttribute("aria-keyshortcuts")));
	const before1 = (await userMsgs(a.id)).length;
	await page.keyboard.press("Enter"); // 空草稿：不发、也不插换行
	await page.waitForTimeout(250);
	check("空草稿 Enter 不发送", (await userMsgs(a.id)).length === before1);
	check("空草稿 Enter 不插入换行", (await page.locator(SINGLE_TA).inputValue()) === "");
	await page.locator(SINGLE_TA).fill("默认Enter发送");
	await page.keyboard.press("Enter");
	await waitFor(async () => (await userMsgs(a.id)).some((x) => x.content === "默认Enter发送"));
	check("Enter 发送", (await page.locator(SINGLE_TA).inputValue()) === "");
	await page.locator(SINGLE_TA).fill("第一行");
	await page.locator(SINGLE_TA).evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
	await page.keyboard.press("Shift+Enter");
	await page.waitForTimeout(200);
	check("Shift+Enter 换行", (await page.locator(SINGLE_TA).inputValue()) === "第一行\n", await page.locator(SINGLE_TA).inputValue());
	check("Shift+Enter 没有发送", !(await userMsgs(a.id)).some((x) => x.content.includes("第一行")));
	await page.screenshot({ path: join(OUT, "01-default-enter.png") });

	// ---------------- 2) 偏好持久化 + 只在本设备（服务端设置里没有它）
	console.log("\n[2] 切到 Shift+Enter 发送：刷新保持 / 只在这台设备");
	const st = await j("/api/settings");
	check("服务端设置里没有发送快捷键（不污染其他设备）", JSON.stringify(st).indexOf("sendShortcut") === -1 && JSON.stringify(st).indexOf("send_shortcut") === -1);
	await page.evaluate((k) => localStorage.setItem(k, "shift-enter"), PREF);
	await page.reload();
	await page.locator(SINGLE_TA).waitFor();
	await page.waitForTimeout(700);
	check("刷新后偏好保持", (await page.evaluate((k) => localStorage.getItem(k), PREF)) === "shift-enter");
	check("按钮 title 跟着变", (await sendBtn.getAttribute("title")) === "Shift+Enter 发送，Enter 换行", String(await sendBtn.getAttribute("title")));
	check("aria-keyshortcuts 跟着变", (await sendBtn.getAttribute("aria-keyshortcuts")) === "Shift+Enter");
	await page.locator(SINGLE_TA).fill("旧习惯第一行");
	await page.locator(SINGLE_TA).evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
	await page.keyboard.press("Enter");
	await page.waitForTimeout(200);
	check("该偏好下 Enter 换行", (await page.locator(SINGLE_TA).inputValue()) === "旧习惯第一行\n", await page.locator(SINGLE_TA).inputValue());
	await page.locator(SINGLE_TA).fill("旧习惯发送");
	await page.keyboard.press("Shift+Enter");
	await waitFor(async () => (await userMsgs(a.id)).some((x) => x.content === "旧习惯发送"));
	check("该偏好下 Shift+Enter 发送", (await page.locator(SINGLE_TA).inputValue()) === "");
	// 换一台设备（新的浏览器上下文 = 另一份 localStorage）：默认仍是 Enter 发送
	const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	const p2 = await ctx2.newPage();
	p2.setDefaultTimeout(20_000);
	await p2.goto(`${BASE}/?agent=${a.id}`);
	await p2.locator(SINGLE_TA).waitFor();
	await p2.waitForTimeout(700);
	check("另一台设备默认还是 Enter 发送", (await p2.evaluate((k) => localStorage.getItem(k), PREF)) === null && (await p2.locator('[data-testid=main-conversation] .pa-composer .pa-send[aria-label="发送"]').getAttribute("title")) === "Enter 发送，Shift+Enter 换行");
	await ctx2.close();
	await page.evaluate((k) => localStorage.removeItem(k), PREF);
	await page.reload();
	await page.locator(SINGLE_TA).waitFor();
	await page.waitForTimeout(700);

	// ---------------- 3) 合成 composition：WebKit 次序 / 229 / 按住重复
	console.log("\n[3] 合成 composition 事件（Chrome 次序 / WebKit 次序 / keyCode 229 / repeat）");
	const posts = [];
	// 只拦发送（POST）；GET 消息列表放行走真实接口
	const recorder = async (route) => {
		const r = route.request();
		if (r.method() !== "POST") return route.fallback();
		posts.push(r.postDataJSON());
		await route.fulfill({ json: { id: `m-${posts.length}`, role: "user", content: "x", created_at: Date.now() } });
	};
	await page.route("**/api/agents/*/messages", recorder);
	const nSend = () => posts.length;
	// ① 组合中（Chrome / Firefox：回车 keydown 带 isComposing + keyCode 229）
	await page.locator(SINGLE_TA).fill("组合中不发");
	await synth(page, SINGLE_TA, "compositionstart");
	await synth(page, SINGLE_TA, "keydown", { isComposing: true, keyCode: 229 });
	await page.waitForTimeout(150);
	check("① 组合中回车不发（isComposing + 229）", nSend() === 0, `sent=${nSend()}`);
	await synth(page, SINGLE_TA, "compositionend", { data: "组合中不发" });
	// Chrome 次序：组合中的那个回车已经是确认键 → 组合结束后回车直接发送（不能被长吞）
	await synth(page, SINGLE_TA, "keydown", { keyCode: 13 });
	await waitFor(() => nSend() === 1);
	check("③c Chrome 次序：组合中的确认回车只算一次，之后回车正常发送", nSend() === 1, `sent=${nSend()}`);
	// ② WebKit 次序：新一轮组合，没有「组合中的 keydown」，compositionend 先到
	await page.locator(SINGLE_TA).fill("确认中不发");
	await synth(page, SINGLE_TA, "compositionstart");
	await synth(page, SINGLE_TA, "keydown", { key: "ArrowDown", keyCode: 229, isComposing: true }); // 选字方向键：不能解除兜底
	await synth(page, SINGLE_TA, "compositionend", { data: "确认中不发" });
	await synth(page, SINGLE_TA, "keydown", { keyCode: 13 });
	await page.waitForTimeout(200);
	check("③ WebKit 次序：compositionend 之后那次确认回车不发", nSend() === 1, `sent=${nSend()}`);
	await synth(page, SINGLE_TA, "keydown", { keyCode: 13 });
	await waitFor(() => nSend() === 2);
	check("③ 紧接着的下一次回车正常发送（只吞一次，不是长 timeout）", nSend() === 2, `sent=${nSend()}`);
	// ② keyCode 229（没有组合状态）
	await page.locator(SINGLE_TA).fill("229 不发");
	await synth(page, SINGLE_TA, "keydown", { keyCode: 229 });
	await page.waitForTimeout(150);
	check("② keyCode 229 不发", nSend() === 2, `sent=${nSend()}`);
	// ⑥ 按住不放：1 次正常 + 3 次 repeat → 只发 1 次
	await page.locator(SINGLE_TA).fill("按住不放");
	await synth(page, SINGLE_TA, "keydown", { keyCode: 13 });
	for (let i = 0; i < 3; i++) await synth(page, SINGLE_TA, "keydown", { keyCode: 13, repeat: true });
	await waitFor(() => nSend() === 3);
	await page.waitForTimeout(200);
	check("⑥ 按住不放只发一次", nSend() === 3, `sent=${nSend()}`);
	// ⑧ 已经被别人 preventDefault 的回车不抢（弹窗 / @ 候选用同一条路径）
	await page.locator(SINGLE_TA).evaluate((el) => { const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }); Object.defineProperty(ev, "keyCode", { value: 13 }); el.addEventListener("keydown", (e) => e.preventDefault(), { once: true }); el.dispatchEvent(ev); });
	await page.waitForTimeout(200);
	check("⑧ 已被别人 preventDefault 的回车不抢", nSend() === 3, `sent=${nSend()}`);
	await page.unroute("**/api/agents/*/messages", recorder);

	// ---------------- 4) 真实 CDP 组合：组合中不发、组合结束后回车一定发（不长吞）
	console.log("\n[4] 真实 IME 组合（CDP）：组合中不发 / 结束后 Enter 一定发");
	await gotoAgent();
	const ta4 = page.locator(SINGLE_TA);
	const before4 = (await userMsgs(a.id)).length;
	const cdp = await page.context().newCDPSession(page);
	await ta4.click();
	await cdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
	await page.keyboard.press("Enter"); // 组合中的回车 = 确认选字
	await page.waitForTimeout(300);
	const after4 = (await userMsgs(a.id)).length;
	check("组合中真实回车不发送", after4 === before4, `msgs=${after4} before=${before4}`);
	const composed = await ta4.inputValue();
	await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 }); // 结束组合
	// React 只在 compositionend（commit）之后才收下候选文本；按钮 disabled 直接反映 React 侧草稿是否为空
	const draftReady = !(await page.locator('[data-testid=main-conversation] .pa-composer .pa-send[aria-label="发送"]').isDisabled());
	if (composed.includes("zhong") && draftReady) {
		// 确认之后的第二次回车：必须发送（不是被 guard 长吞）
		await page.keyboard.press("Enter");
		await waitFor(async () => (await userMsgs(a.id)).length === after4 + 1).catch(() => {});
		check("确认选字后马上再按一次 Enter 能发送", (await userMsgs(a.id)).length === after4 + 1, `msgs=${(await userMsgs(a.id)).length}`);
	} else {
		console.log(`  ℹ️ 这次 CDP 组合没把候选交到 React 侧草稿（DOM=${JSON.stringify(composed)}，发送键 disabled=${!draftReady}）：「确认后立刻再按一次」这一步不适用，改由合成事件 ③c 与下面的硬断言覆盖`);
	}
	// 兜底（硬）：组合结束之后 Enter 一定能发送 —— 防「guard 把之后所有回车都吞掉」
	const n4 = (await userMsgs(a.id)).length;
	await ta4.fill("组合结束后发送");
	await page.keyboard.press("Enter");
	await waitFor(async () => (await userMsgs(a.id)).length === n4 + 1);
	check("组合结束后 Enter 一定发送", (await userMsgs(a.id)).length === n4 + 1, `msgs=${(await userMsgs(a.id)).length}`);
	await page.screenshot({ path: join(OUT, "02-ime-confirm-then-send.png") });

	// ---------------- 5) 群聊：Enter 发送 / @ 候选 Enter 只选人不发送 / Shift+Enter 换行
	console.log("\n[5] 群聊：Enter 发送 / @ 候选 / Shift+Enter 换行");
	await page.goto(`${BASE}/?room=${room.id}`);
	const roomTa = page.locator("[data-testid=room-input]");
	await roomTa.waitFor();
	await page.waitForTimeout(700);
	check("群聊发送按钮 title 同一偏好", (await page.getByTestId("room-send").getAttribute("title")) === "Enter 发送，Shift+Enter 换行", String(await page.getByTestId("room-send").getAttribute("title")));
	const roomBefore = (await j(`/api/rooms/${room.id}/messages`)).length;
	await roomTa.fill("@");
	await page.getByTestId("mention-list").waitFor();
	await page.keyboard.press("Enter");
	await page.waitForTimeout(250);
	const afterMention = await roomTa.inputValue();
	check("⑧ @ 候选回车只选人不发送", afterMention.includes("@") && !afterMention.includes("\n") && (await j(`/api/rooms/${room.id}/messages`)).length === roomBefore, JSON.stringify(afterMention));
	await page.keyboard.press("Escape");
	await roomTa.fill("群聊第一行");
	await roomTa.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
	await page.keyboard.press("Shift+Enter");
	await page.waitForTimeout(200);
	check("群聊 Shift+Enter 换行", (await roomTa.inputValue()) === "群聊第一行\n", await roomTa.inputValue());
	await roomTa.fill("群聊Enter发送");
	await page.keyboard.press("Enter");
	await waitFor(async () => (await j(`/api/rooms/${room.id}/messages`)).some((x) => x.role === "user" && x.content === "群聊Enter发送"));
	check("群聊 Enter 发送", (await roomTa.inputValue()) === "");
	await page.screenshot({ path: join(OUT, "03-room-enter.png") });

	// ---------------- 6) 子代理输入栏：同一偏好（Enter 发送）
	console.log("\n[6] 子代理输入栏：同一偏好");
	const subPosts = [];
	await page.route("**/api/subagents/*/messages", async (route) => { subPosts.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
	await page.goto(`${BASE}/?agent=${a.id}`);
	const box6 = page.locator(SINGLE_TA);
	await box6.waitFor();
	await box6.fill("派个子代理 检查输入栏按 Enter 发送，工作区仓库 /Users/dengdeng/Documents/AI/pi-assistant");
	await page.keyboard.press("Enter");
	await page.getByTestId("subagent-tasks").waitFor({ timeout: 30_000 });
	await page.getByTestId("subagent-tasks").click();
	const row = page.getByTestId("subagent-row").first();
	await row.waitFor();
	await row.click();
	const detail = page.locator('[data-testid="subagent-detail"]:visible');
	await detail.waitFor();
	const subTa = detail.locator(".pa-composer textarea");
	// 先填字：空草稿时可停止的子代理显示的是停止键，不是发送键
	await subTa.fill("补充要求");
	const subSend = detail.locator('.pa-composer .pa-send[aria-label="发送给子代理"]');
	check("子代理发送按钮 title 同一偏好", (await subSend.getAttribute("title")) === "Enter 发送，Shift+Enter 换行", String(await subSend.getAttribute("title")));
	check("子代理 aria-keyshortcuts 同一偏好", (await subSend.getAttribute("aria-keyshortcuts")) === "Enter");
	await page.keyboard.press("Enter");
	await waitFor(() => subPosts.length === 1);
	check("子代理 Enter 发送", subPosts.length === 1 && subPosts[0]?.text === "补充要求", JSON.stringify(subPosts));
	await waitFor(async () => (await subTa.inputValue()) === "").catch(() => {});
	check("子代理发送后清空输入框", (await subTa.inputValue()) === "", JSON.stringify(await subTa.inputValue()));
	await page.unroute("**/api/subagents/*/messages");

	// ---------------- 7) 引用照旧：带引用按 Enter 发送，成功才清引用
	console.log("\n[7] 引用 + Enter 发送");
	await page.goto(`${BASE}/?agent=${a.id}`);
	const ta7 = page.locator(SINGLE_TA);
	await ta7.waitFor();
	await page.waitForTimeout(700);
	await page.locator('[data-testid="quote-btn"]').last().click();
	await page.getByTestId("quote-bar").waitFor();
	await ta7.fill("带引用的Enter发送");
	await page.keyboard.press("Enter");
	await waitFor(async () => (await userMsgs(a.id)).some((x) => x.content === "带引用的Enter发送"));
	check("带引用 Enter 发送成功", (await ta7.inputValue()) === "");
	await waitFor(async () => (await page.getByTestId("quote-bar").count()) === 0);
	check("发送成功后引用条清空", (await page.getByTestId("quote-bar").count()) === 0);
	await page.waitForTimeout(400);
	check("引用块渲染出来（replyToId 生效）", (await page.locator('[data-testid="quoted-block"]').count()) >= 1);
	await page.screenshot({ path: join(OUT, "04-quote-enter.png") });

	// ---------------- 8) 390：三处输入栏不被挤（偏好切换不改输入栏 DOM）
	console.log("\n[8] 390 布局：输入栏不被挤");
	const measure = (sel) => page.locator(sel).evaluate((el) => ({ w: Math.round(el.getBoundingClientRect().width), overflowX: el.scrollWidth - el.clientWidth, children: el.children.length, nodes: el.querySelectorAll("*").length, doc: document.documentElement.scrollWidth - innerWidth }));
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(500);
	let m1 = await measure("[data-testid=main-conversation] .pa-composer");
	check("单聊 390：无横向溢出 / 整页不撑宽", m1.overflowX <= 1 && m1.doc <= 1, JSON.stringify(m1));
	await page.evaluate((k) => localStorage.setItem(k, "shift-enter"), PREF);
	await page.reload();
	await page.locator(SINGLE_TA).waitFor();
	await page.waitForTimeout(700);
	const m2 = await measure("[data-testid=main-conversation] .pa-composer");
	check("切换偏好不改变输入栏结构（不挤）", m2.children === m1.children && m2.nodes === m1.nodes && m2.overflowX <= 1, `${JSON.stringify(m1)} vs ${JSON.stringify(m2)}`);
	check("390 偏好切换后按钮 title 仍是新偏好", (await sendBtn.getAttribute("title")) === "Shift+Enter 发送，Enter 换行");
	await page.evaluate((k) => localStorage.removeItem(k), PREF);
	await page.screenshot({ path: join(OUT, "05-390.png") });

	// ---------------- 9）设置 › 聊天与输入：导航第 17 项 + 页面渲染 + 偏好持久化 + 390 不溢出
	console.log("\n[9] 设置「聊天与输入」页（主整合接入）");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${BASE}/?settings=chat`);
	await page.getByTestId("settings-dialog").waitFor();
	const chatTab = page.locator('[data-testid=settings-nav] [data-tab=chat]');
	await chatTab.waitFor();
	check("导航有「聊天与输入」", ((await chatTab.textContent()) ?? "").includes("聊天与输入"));
	check("导航项总数为 17（旧 16 + 新增 chat）", (await page.locator('[data-testid=settings-nav] [data-tab]').count()) === 17, String(await page.locator('[data-testid=settings-nav] [data-tab]').count()));
	check("「聊天与输入」属「偏好与系统」组", await chatTab.evaluate((el) => { let n = el.previousElementSibling; while (n && !n.hasAttribute("data-settings-group")) n = n.previousElementSibling; return n?.getAttribute("data-settings-group") === "偏好与系统"; }));
	await page.getByTestId("chat-settings").waitFor();
	check("页面渲染出发送快捷键", await page.getByTestId("send-shortcut").isVisible());
	check("缺省选中 Enter 发送", (await page.getByTestId("send-shortcut-enter").getAttribute("aria-checked")) === "true");
	await page.getByTestId("send-shortcut-shift-enter").click();
	check("点选 Shift+Enter 即写入本机偏好", (await page.evaluate((k) => localStorage.getItem(k), PREF)) === "shift-enter");
	await page.reload();
	await page.getByTestId("chat-settings").waitFor();
	check("刷新后设置页仍是 Shift+Enter", (await page.getByTestId("send-shortcut-shift-enter").getAttribute("aria-checked")) === "true");
	await page.evaluate((k) => localStorage.removeItem(k), PREF);
	// 390：设置导航横排不撑宽，聊天页内容不溢出
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(400);
	const navDoc = await page.locator("[data-testid=settings-nav]").evaluate(() => document.documentElement.scrollWidth - innerWidth);
	check("390 设置导航横排不撑宽", navDoc <= 1, String(navDoc));
	check("390 聊天与输入页不横向溢出", (await page.getByTestId("chat-settings").evaluate((el) => el.scrollWidth - el.clientWidth)) <= 1);
	await page.screenshot({ path: join(OUT, "06-chat-settings-390.png") });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${BASE}/?settings=chat`);
	await page.getByTestId("chat-settings").waitFor();
	await page.screenshot({ path: join(OUT, "07-chat-settings.png") });

	console.log(`\n${failed === 0 ? "全部通过" : `失败 ${failed} 项`}（截图在 ${OUT}）`);
	await ctx.close();
} finally {
	await browser?.close();
	await stop();
}
process.exit(failed === 0 ? 0 : 1);
