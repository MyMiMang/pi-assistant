import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { wait } from "./fixtures/chat-history-search.mjs";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const foldersApi = "/api/agent-folders";
const agentsApi = "/api/agents";
const roomName = "验收讨论群";
const firstName = "开发归档";
const renamed = "开发精选";
const secondName = "日常归档";
const targetName = "联合归档";
const createdName = "文件夹内新建助理";
const seedName = (n) => `合成个人助理 ${String(n).padStart(2, "0")}`;

function sidebar(page, mobile) {
	const aside = page.locator(".pa-sidebar");
	const by = (id) => aside.getByTestId(id);
	const button = (scope, name) => scope.getByRole("button", { name, exact: true });
	const rows = (scope = aside) => scope.getByTestId("sidebar-agent");
	const agent = (name, scope) => rows(scope).filter({ has: page.getByText(name, { exact: true }) });
	const folders = by("sidebar-agent-folder");
	const unclassified = by("sidebar-uncategorized");
	const folder = (name) => name === "未分类" ? unclassified : folders.filter({ has: page.getByText(name, { exact: true }) });
	const expand = async (name) => {
		const toggle = folder(name).locator("button[aria-expanded]");
		await toggle.waitFor();
		if (await toggle.getAttribute("aria-expanded") === "false") await hit(toggle);
	};
	const room = (name) => by("sidebar-room").filter({ has: page.getByText(name, { exact: true }) });
	const hit = (locator) => mobile ? locator.tap() : locator.click();
	const open = async () => {
		const drawer = button(page, "打开助理列表");
		if (mobile) {
			const openDrawer = page.locator(".pa-drawer.translate-x-0");
			if (!await openDrawer.count()) await hit(drawer);
			await openDrawer.waitFor();
		}
		await by("sidebar-rooms-toggle").waitFor();
	};
	return { aside, button, rows, agent, folders, folder, room, hit, open, expand };
}

function trackWrites(page, base) {
	const writes = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		const method = request.method();
		if (url.origin !== base || !["POST", "PATCH", "PUT", "DELETE"].includes(method)) return;
		if (url.pathname === foldersApi || url.pathname.startsWith(`${foldersApi}/`) || /^\/api\/agents(?:\/[^/]+)?$/.test(url.pathname)) {
			writes.push({ method, path: url.pathname, data: request.postDataJSON() });
		}
	});
	return writes;
}

async function exercise(page, base, json, mobile, seeded, groupOnly, tag) {
	const { aside, button, rows, agent, folder, folders, room, hit, open, expand } = sidebar(page, mobile);
	const shot = (checkpoint) => page.screenshot({ path: join(artifactDir("sidebar-agent-folders"), `${tag}-${checkpoint}.png`), animations: "disabled", timeout: 3000 });
	const writes = trackWrites(page, base);
	const a = seeded[0];
	const b = seeded[1];
	const untouched = seeded[2];
	const enter = () => hit(button(aside, "整理助理"));
	const checks = () => rows().and(aside.getByRole("checkbox"));
	const selected = () => checks().and(aside.getByRole("checkbox", { checked: true }));
	const getFolders = () => json(foldersApi);
	const getAgents = () => json(agentsApi);
	const location = async (id) => {
		const found = (await getAgents()).find((row) => row.id === id);
		assert.ok(found, `助理 ${id} 不应丢失`);
		return found.folderId;
	};
	const snapshot = async () => ({ folders: await getFolders(), agents: (await getAgents()).map(({ id, folderId }) => [id, folderId]) });
	const groupSeparate = async () => {
		await room(roomName).waitFor();
		assert.equal(await folders.or(folder("未分类")).getByTestId("sidebar-room").count(), 0, "群聊不属于个人文件夹或未分类");
		assert.equal(await agent(groupOnly.name).count(), 0, "群专属助理不能成为个人条目");
	};
	const mutate = async (method, path, action, expectedBody) => {
		const from = writes.length;
		const [response] = await Promise.all([
			page.waitForResponse((r) => r.url() === base + path && r.request().method() === method),
			action(),
		]);
		assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${response.ok() ? "" : await response.text()}`);
		if (expectedBody) assert.deepEqual(response.request().postDataJSON(), expectedBody);
		return { result: await response.json(), from };
	};
	const assertWrite = (from, method, path) => assert.deepEqual(writes.slice(from).map(({ method: m, path: p }) => [m, p]), [[method, path]]);

	await page.goto(base);
	await open();
	await wait(async () => await rows().count() === seeded.length, "all personal agents initially rendered");
	assert.deepEqual((await rows().evaluateAll((els) => els.map((el) => el.dataset.name))).sort(), seeded.map((row) => row.name).sort());
	assert.equal(await folders.count(), 0, "无文件夹时应平铺");
	assert.equal(await aside.getByText("未分类", { exact: true }).count(), 0, "无文件夹时不加未分类分组");
	assert.deepEqual(await getFolders(), []);
	await groupSeparate();
	await shot("01-flat");

	const folderEdit = async (trigger, name, method, path) => {
		await hit(trigger);
		const dialog = page.getByRole("dialog");
		await dialog.getByRole("textbox").fill(name);
		const { result, from } = await mutate(method, path, () => hit(button(dialog, "保存")), { name });
		await dialog.waitFor({ state: "hidden" });
		assertWrite(from, method, path);
		await folder(name).waitFor();
		assert.equal(result.name, name);
		return result.id;
	};
	const dialog = (name) => page.getByRole("dialog", { name, exact: true });
	const folderMenuItem = async (name, action) => {
		await hit(button(folder(name), `${name}更多操作`));
		return page.getByTestId("agent-folder-menu").getByRole("menuitem", { name: action, exact: true });
	};
	const first = await folderEdit(button(aside, "新建文件夹"), firstName, "POST", foldersApi);
	const second = await folderEdit(button(aside, "新建文件夹"), secondName, "POST", foldersApi);
	const target = await folderEdit(button(aside, "新建文件夹"), targetName, "POST", foldersApi);
	assert.equal(new Set([first, second, target]).size, 3);

	await hit(await folderMenuItem(firstName, "新建助理"));
	const create = dialog("新建助理");
	await create.getByPlaceholder("给助理起个名字").fill(createdName);
	const { result: created, from: createFrom } = await mutate("POST", agentsApi, () => hit(button(create, "创建")));
	assert.equal(created.name, createdName);
	assert.equal(created.folderId, first);
	assert.equal(writes[createFrom].data.folderId, first, "创建时直接携带文件夹，不是先建再移动");
	await create.waitFor({ state: "hidden" });
	await open();
	await agent(createdName, folder(firstName)).waitFor();
	assertWrite(createFrom, "POST", agentsApi);

	assert.equal(await folderEdit(await folderMenuItem(firstName, "重命名"), renamed, "PATCH", `${foldersApi}/${first}`), first);
	await folder(firstName).waitFor({ state: "detached" });
	await agent(createdName, folder(renamed)).waitFor();

	const picker = dialog("选择目标文件夹");
	const destination = (name) => button(picker, name);
	const move = async (name, ids, folderId) => {
		const path = `${foldersApi}/move`;
		const { result, from } = await mutate("POST", path, () => hit(destination(name)));
		assert.equal(result.ok, true);
		await picker.waitFor({ state: "hidden" });
		assertWrite(from, "POST", path);
		const data = writes[from].data;
		assert.deepEqual({ ...data, agentIds: [...data.agentIds].sort() }, { agentIds: [...ids].sort(), folderId });
	};
	const moveOne = async (person, name, id) => {
		await hit(button(aside, `${person.name}更多操作`));
		await hit(page.getByTestId("agent-menu").getByRole("menuitem", { name: "移动到文件夹", exact: true }));
		await move(name, [person.id], id);
		await agent(person.name, folder(name)).waitFor();
		assert.equal(await location(person.id), id);
	};
	await moveOne(a, renamed, first);
	assert.equal(await location(b.id), null);
	await moveOne(b, secondName, second);

	const chat = page.getByTestId("main-conversation");
	const draft = chat.locator(".pa-composer textarea");
	const draftText = "整理时保留的单聊草稿";
	const staysInChat = async () => {
		await chat.getByTestId("agent-detail-open").getByText(a.name, { exact: true }).waitFor();
		assert.equal(await draft.inputValue(), draftText, "整理不切换当前单聊或丢弃草稿");
	};
	await hit(agent(a.name, folder(renamed)));
	await draft.fill(draftText);
	await open();
	const beforeCancel = await snapshot();
	const cancelFrom = writes.length;
	await enter();
	assert.equal(await checks().count(), seeded.length + 1, "所有个人助理参与整理，群和群专属助理不参与");
	assert.equal(await room(roomName).getAttribute("role"), null);
	await hit(agent(a.name, folder(renamed)));
	await hit(agent(b.name, folder(secondName)));
	assert.equal(await selected().count(), 2);
	await hit(button(aside, "移动 2 个"));
	await hit(button(picker, "取消"));
	await picker.waitFor({ state: "hidden" });
	assert.equal(await selected().count(), 2, "取消目标选择仍保留本次勾选");
	await hit(button(aside, "取消"));
	await checks().first().waitFor({ state: "detached" });
	await enter();
	assert.equal(await selected().count(), 0, "再次整理不能残留上轮勾选");
	assert.deepEqual(await snapshot(), beforeCancel, "取消不能改变任何归类");
	assert.deepEqual(writes.slice(cancelFrom), [], "进入、勾选、取消及再次进入均零写请求");

	await hit(agent(a.name, folder(renamed)));
	await hit(agent(b.name, folder(secondName)));
	await hit(button(aside, "移动 2 个"));
	assert.deepEqual(writes.slice(cancelFrom), [], "在选定目标前不保存");
	await move(targetName, [a.id, b.id], target);
	await checks().first().waitFor({ state: "detached" });
	await agent(a.name, folder(targetName)).waitFor();
	await agent(b.name, folder(targetName)).waitFor();
	await agent(createdName, folder(renamed)).waitFor();
	assert.deepEqual(await Promise.all([a, b, created, untouched, groupOnly].map(({ id }) => location(id))), [target, target, first, null, null]);
	await groupSeparate();
	await staysInChat();
	await shot("02-moved");
	const renamedToggle = folder(renamed).locator("button[aria-expanded]");
	await hit(renamedToggle);
	assert.equal(await renamedToggle.getAttribute("aria-expanded"), "false");

	await page.reload();
	await open();
	await renamedToggle.waitFor();
	assert.equal(await renamedToggle.getAttribute("aria-expanded"), "false", "刷新后文件夹仍收起");
	await expand(renamed);
	await expand(targetName);
	await agent(createdName, folder(renamed)).waitFor();
	await agent(a.name, folder(targetName)).waitFor();
	await agent(b.name, folder(targetName)).waitFor();
	await groupSeparate();
	await hit(agent(a.name, folder(targetName)));
	await draft.fill(draftText);
	await open();
	const beforeDissolve = await snapshot();
	const history = () => Promise.all([a, b].map(({ id }) => json(`${agentsApi}/${id}/messages`)));
	const histories = await history();
	assert.ok(histories.every((messages) => messages.length > 0), "两位助理先有聊天记录，才能验证解散不丢聊天");
	await hit(await folderMenuItem(targetName, "解散文件夹"));
	const confirm = dialog("解散文件夹");
	const path = `${foldersApi}/${target}`;
	const { from: dissolveFrom } = await mutate("DELETE", path, () => hit(button(confirm, "解散")));
	await confirm.waitFor({ state: "hidden" });
	await folder(targetName).waitFor({ state: "detached" });
	await agent(a.name, folder("未分类")).waitFor();
	await agent(b.name, folder("未分类")).waitFor();
	assertWrite(dissolveFrom, "DELETE", path);
	assert.deepEqual(await snapshot(), {
		folders: beforeDissolve.folders.filter(({ id }) => id !== target),
		agents: beforeDissolve.agents.map(([id, folderId]) => [id, folderId === target ? null : folderId]),
	}, "解散只移除归类，不删除或替换助理");
	assert.deepEqual(await history(), histories, "解散不改聊天记录");
	await staysInChat();
	await page.reload();
	await open();
	await expand(renamed);
	await agent(createdName, folder(renamed)).waitFor();
	await agent(a.name, folder("未分类")).waitFor();
	await agent(b.name, folder("未分类")).waitFor();
	assert.equal(await folders.count(), 2);
	await groupSeparate();
	await shot("03-dissolved");
	console.log(`PASS ${tag}: ${seeded.length} 个人助理平铺、建文件夹/助理、改名、单移/跨分组批移、取消零写入、解散保留助理、刷新保持折叠、批移与解散保留当前单聊和草稿、群聊独立`);
}

async function exerciseDrag(page, base, json, mobile, seeded, _groupOnly, tag) {
	const { aside, rows, agent, folder, folders, hit, open, expand } = sidebar(page, mobile);
	const writes = trackWrites(page, base);
	const movePath = `${foldersApi}/move`;
	const target = (id) => aside.locator(`[data-folder-drop=${JSON.stringify(id ?? "")}]`);
	const active = aside.locator("[data-drop-active]");
	const namePoint = (person) => agent(person.name).getByText(person.name, { exact: true });
	const grip = (person) => agent(person.name).locator("..").getByTestId("sidebar-agent-drag-handle");
	const shot = () => page.screenshot({ path: join(artifactDir("sidebar-agent-folder-drag"), `${tag}-target.png`), timeout: 3000 });
	const [a, b] = seeded;
	const chat = page.getByTestId("main-conversation");
	const title = chat.getByTestId("agent-detail-open").getByText(a.name, { exact: true });
	const draft = chat.locator(".pa-composer textarea");
	const text = "拖动助理时保留的草稿";
	const point = async (locator) => {
		// Trial checks hit-testing and waits for drawer transition/row layout without clicking.
		await locator.click({ trial: true });
		const box = await locator.boundingBox();
		assert.ok(box, "拖动起点和终点须有实际布局");
		const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		assert.ok(await locator.evaluate((el, { x, y }) => el.contains(document.elementFromPoint(x, y)), p), "手势坐标须实际命中目标");
		return p;
	};
	const clean = () => active.waitFor({ state: "detached" });
	const snap = async () => (await json(agentsApi)).map(({ id, folderId }) => [id, folderId]);
	const staysInChat = async () => {
		await title.waitFor();
		assert.equal(await draft.inputValue(), text, "拖动不丢草稿");
		assert.ok(await draft.evaluate((el) => el === document.activeElement), "拖动不抢输入框焦点");
	};

	await page.goto(base);
	await open();
	await wait(async () => await rows().count() === seeded.length, "flat assistant list");
	assert.deepEqual(await json(foldersApi), []);
	assert.equal(await folders.or(folder("未分类")).count(), 0, "没有文件夹时仍平铺");
	assert.equal(await aside.locator("[data-folder-drop]").count(), 0);
	assert.equal(await aside.getByTestId("sidebar-agent-drag-handle").count(), 0);

	const createFolder = (name) => json(foldersApi, "POST", { name });
	const work = await createFolder("展开工作");
	const closed = await createFolder("收起学习");
	const empty = await createFolder("空文件夹");
	await json(movePath, "POST", { agentIds: [a.id, b.id], folderId: work.id });
	await page.reload();
	await open();
	// 用户显式设定展开状态，避免默认规则跟随当前聊天改变本次预置。
	const workToggle = folder(work.name).locator("button[aria-expanded]");
	await workToggle.waitFor();
	if (await workToggle.getAttribute("aria-expanded") === "true") await hit(workToggle);
	await expand(work.name);
	const closedToggle = folder(closed.name).locator("button[aria-expanded]");
	await expand(closed.name);
	await hit(closedToggle);
	assert.equal(await closedToggle.getAttribute("aria-expanded"), "false");
	assert.equal(await rows(folder(empty.name)).count(), 0);
	for (const id of [work.id, closed.id, empty.id, null]) await target(id).waitFor();

	const cdp = mobile ? await page.context().newCDPSession(page) : null;
	const touch = (type, p) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [p] : [] });
	const travel = async (start, end) => {
		if (!mobile) return page.mouse.move(end.x, end.y, { steps: 12 });
		for (let i = 1; i <= 12; i++) await touch("touchMove", {
			x: start.x + (end.x - start.x) * i / 12, y: start.y + (end.y - start.y) * i / 12,
		});
	};
	const held = async (person, id) => {
		const from = await point(mobile ? grip(person) : namePoint(person));
		const to = await point(target(id));
		if (mobile) await touch("touchStart", from);
		else { await page.mouse.move(from.x, from.y); await page.mouse.down(); }
		await travel(from, to);
		await target(id).and(active).waitFor();
		assert.equal(await active.count(), 1, "只高亮命中的文件夹标题");
	};
	const release = () => mobile ? touch("touchEnd") : page.mouse.up();
	const drop = async (person, id, { status = 200, capture = false } = {}) => {
		const from = writes.length;
		await held(person, id);
		if (!mobile) await staysInChat();
		if (capture) await shot();
		assert.deepEqual(writes.slice(from), [], "悬停时不能写入");
		const [response] = await Promise.all([
			page.waitForResponse((r) => r.url() === base + movePath && r.request().method() === "POST"), release(),
		]);
		assert.equal(response.status(), status);
		assert.deepEqual(writes.slice(from), [{ method: "POST", path: movePath, data: { agentIds: [person.id], folderId: id } }]);
		await clean();
		return response;
	};
	const noWrite = async (label, action) => {
		const from = writes.length;
		const before = await snap();
		await action();
		await clean();
		assert.deepEqual(await snap(), before, `${label}：归类不变`);
		assert.deepEqual(writes.slice(from), [], `${label}：零写请求`);
	};

	if (mobile) {
		assert.equal(await page.evaluate(() => innerWidth), 390);
		await drop(a, closed.id, { capture: true });
		await agent(a.name, folder(work.name)).waitFor({ state: "detached" });
		assert.equal(await closedToggle.getAttribute("aria-expanded"), "false", "放入收起文件夹后不自动展开");
		assert.equal(new Map(await snap()).get(a.id), closed.id);
		await noWrite("系统取消触摸", async () => {
			await held(b, empty.id);
			await touch("touchCancel");
		});
		await agent(b.name, folder(work.name)).waitFor();
		const scroller = aside.locator(".pa-agents");
		const before = await scroller.evaluate((el) => el.scrollTop);
		await noWrite("姓名区原生纵向滚动", async () => {
			const from = await point(namePoint(b));
			await touch("touchStart", from);
			await travel(from, { x: from.x, y: from.y - 130 });
			await touch("touchEnd");
			await wait(async () => await scroller.evaluate((el) => el.scrollTop) > before + 45, "native touch scrolled the sidebar");
		});
		console.log(`PASS ${tag}: 名字区触摸滚动、六点把手归类、touchCancel 零写入`);
		return;
	}

	await hit(agent(a.name, folder(work.name)));
	await title.waitFor();
	await draft.fill(text);
	await staysInChat();
	await drop(a, closed.id);
	await agent(a.name, folder(work.name)).waitFor({ state: "detached" });
	assert.equal(await closedToggle.getAttribute("aria-expanded"), "false", "放入收起文件夹后不自动展开");
	assert.equal(new Map(await snap()).get(a.id), closed.id);
	await staysInChat();
	await expand(closed.name);
	await draft.focus(); // 打开文件夹的正常点击会改变焦点，重新设置下一次拖动的起点。
	await drop(a, empty.id);
	assert.equal(new Map(await snap()).get(a.id), empty.id);
	await staysInChat();
	await expand(empty.name);
	await draft.focus();
	await drop(a, work.id, { capture: true });
	await agent(a.name, folder(work.name)).waitFor();
	await staysInChat();
	await drop(a, null);
	await agent(a.name, folder("未分类")).waitFor();
	await staysInChat();
	await noWrite("放回原分类", async () => { await held(a, null); await release(); });
	await noWrite("Esc 取消", async () => {
		await held(a, work.id);
		await page.keyboard.press("Escape");
		await clean();
		await release();
	});
	await noWrite("无效区域松手", async () => {
		await held(a, work.id);
		const { x, y } = await point(draft);
		await page.mouse.move(x, y, { steps: 12 });
		await clean();
		await release();
	});
	await staysInChat();

	// 页面仍发真实目标；仅转发到临时服务时替换为不存在的目标，取回真实事务拒绝的响应。
	const beforeFailure = await snap();
	await page.route(base + movePath, async (route) => {
		const request = route.request().postDataJSON();
		const response = await route.fetch({ postData: { ...request, folderId: "missing-e2e-folder" } });
		await route.fulfill({ response });
	}, { times: 1 });
	assert.deepEqual(await (await drop(a, work.id, { status: 404 })).json(), { error: "folder_not_found" });
	await aside.getByRole("status").filter({ hasText: "移动失败" }).waitFor();
	await agent(a.name, folder("未分类")).waitFor();
	assert.deepEqual(await snap(), beforeFailure, "服务端拒绝后任何助理的归类均不变");
	await staysInChat();

	await page.reload();
	await open();
	await title.waitFor();
	await agent(a.name, folder("未分类")).waitFor();
	await agent(b.name, folder(work.name)).waitFor();
	assert.equal(new Map(await snap()).get(a.id), null);
	console.log(`PASS ${tag}: 四种放置目标与高亮、原处/Esc/无效区零写、真实 404、当前聊天草稿焦点与刷新归类`);
}

const dragOnly = process.argv.includes("--drag");
async function scenario(mobile) {
	const port = await new Promise((resolve, reject) => {
		const socket = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
			const { port } = socket.address();
			socket.close((error) => error ? reject(error) : resolve(port));
		});
	});
	const run = makeTempRun("pia-agent-folders-");
	const base = `http://127.0.0.1:${port}`;
	const server = startTempServer({ root, port, run, extra: { PIA_HOST: "127.0.0.1", PIA_HEADLESS: "0", PIA_WEB_DIST: join(root, "apps/web/dist") } });
	const json = async (path, method = "GET", data) => {
		const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
		assert.ok(response.ok, `${method} ${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
		return response.json();
	};
	let browser;
	const tag = mobile ? "mobile-390" : "desktop";
	try {
		await wait(async () => {
			assert.equal(server.child.exitCode, null, server.logs());
			return (await fetch(`${base}/api/system`).catch(() => null))?.ok;
		}, "temporary Mock server");
		assert.equal((await json("/api/system")).mock, true);
		await json("/api/settings", "PUT", { onboarded: true });
		const seeded = [];
		for (let n = 1; n <= 34; n++) seeded.push(await json(agentsApi, "POST", { name: seedName(n) }));
		const memberIds = seeded.slice(0, 2).map(({ id }) => id);
		const room = await json("/api/rooms", "POST", { name: roomName, memberIds, managerId: memberIds[0] });
		const groupOnly = await json("/api/rooms/builtin-manager", "POST", { roomId: room.id });
		assert.equal(groupOnly.scope, "room");
		browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
		const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile, isMobile: mobile, serviceWorkers: "block" });
		page.setDefaultTimeout(8000);
		try {
			await (dragOnly ? exerciseDrag : exercise)(page, base, json, mobile, seeded, groupOnly, tag);
		} catch (error) {
			await page.screenshot({ path: join(artifactDir(dragOnly ? "sidebar-agent-folder-drag" : "sidebar-agent-folders"), `${tag}-failure.png`), timeout: 3000 }).catch(() => {});
			throw error;
		}
	} finally {
		try { await browser?.close(); } finally {
			try { await server.stop(); } finally { cleanupTempRun(run); }
		}
	}
}

assert.ok(existsSync(join(root, "apps/web/dist/index.html")), "Build the web workspace first");
for (const mobile of [false, true]) await scenario(mobile);
