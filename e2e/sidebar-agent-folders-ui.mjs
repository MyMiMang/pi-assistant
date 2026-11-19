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
			await exercise(page, base, json, mobile, seeded, groupOnly, tag);
		} catch (error) {
			await page.screenshot({ path: join(artifactDir("sidebar-agent-folders"), `${tag}-failure.png`), timeout: 3000 }).catch(() => {});
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
