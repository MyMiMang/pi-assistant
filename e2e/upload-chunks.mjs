/**
 * 真实前端 + 临时服务 + Mock：单聊/群聊的文件及图片分块上传。
 * 先由调用方构建网页，再运行 node e2e/upload-chunks.mjs（本脚本不构建）。
 * SHOT_PREFIX=before：只拍单聊/群聊的初始空托盘，适用于旧构建，不发上传请求。
 * 默认截图为 after-*-empty / uploading / complete，证据在 artifacts/upload-chunks/。
 * 使用真实 33MiB 文件，不注入前端分块参数；只在网络层扣住第二块，由测试明确放行。
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = artifactDir("upload-chunks");
const PREFIX = process.env.SHOT_PREFIX ?? "after";
assert.match(PREFIX, /^[a-zA-Z0-9_-]+$/, "SHOT_PREFIX 只能含字母、数字、下划线或短横线");
const BEFORE_ONLY = PREFIX === "before";
const CHUNK = 32 * 1024 * 1024;
const SIZE = 33 * 1024 * 1024;
const FAILURE = "测试分块失败，请重新上传";
const run = makeTempRun("pia-upload-chunks-");
let server, browser;
const pageErrors = [];

async function freePort() {
	const socket = createServer();
	await new Promise((resolve, reject) => {
		socket.once("error", reject);
		socket.listen(0, "127.0.0.1", resolve);
	});
	const port = socket.address().port;
	await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
	return port;
}

async function waitFor(label, fn, timeout = 30_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await fn()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`等待超时：${label}`);
}

let BASE;
async function json(path, method = "GET", body) {
	const response = await fetch(BASE + path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
	return response.json();
}

const shot = async (page, scope, state, anchor) => {
	await (anchor ?? scope.root(page).locator(".pa-composer")).waitFor({ state: "visible" });
	return stableShot(page, page.locator("body"), join(OUT, `${PREFIX}-${scope.key}-${state}.png`));
};
const chipFor = (root, name) => root.getByTestId("attach-chip").filter({ has: root.page().getByRole("button", { name: `移除 ${name}`, exact: true }) });

async function openScope(page, scope) {
	await page.goto(BASE + scope.url);
	await page.waitForLoadState("networkidle");
	await scope.root(page).locator(".pa-composer textarea").waitFor();
	assert.equal(await scope.root(page).getByTestId("attach-tray").count(), 0, `${scope.key} 初始附件托盘为空`);
}

/** 真实转发第一块，只扣第二块；POST 创建和 DELETE 清理仍由真实服务执行。 */
async function interceptChunks(page, scope, bytes, mode) {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const trace = { puts: [], deleted: [], errors: [], held: false, file: null, firstConfirmed: false, uploadId: null };
	const pattern = `${BASE}${scope.upload}/**`;
	const handler = async (route) => {
		try {
			const request = route.request();
			const url = new URL(request.url());
			const uploadId = decodeURIComponent(url.pathname.slice(scope.upload.length + 1));
			assert.ok(uploadId && !uploadId.includes("/"), "分块 URL 使用单个上传会话编号");
			if (request.method() === "DELETE") {
				const response = await route.fetch();
				assert.ok(response.ok(), `DELETE 清理失败：${response.status()}`);
				trace.deleted.push(uploadId);
				await route.fulfill({ response });
				return;
			}
			assert.equal(request.method(), "PUT", "会话只接收 PUT 分块或 DELETE 中止");
			assert.match(request.headers()["content-type"] ?? "", /^application\/octet-stream/);
			const offset = Number(url.searchParams.get("offset"));
			const index = Number(url.searchParams.get("index"));
			const data = request.postDataBuffer();
			assert.ok(data && data.length > 0 && data.length <= CHUNK, "每块是非空原始字节，最多 32MiB");
			assert.equal(offset, index * CHUNK, "每块 offset/index 连续且无重复");
			assert.equal(index, trace.puts.length, "分块串行发送");
			assert.equal(data.length, Math.min(CHUNK, bytes.length - offset));
			assert.ok(data.equals(bytes.subarray(offset, offset + data.length)), "上传原始字节与本地文件完全相同");
			trace.puts.push({ offset, index, size: data.length });
			trace.uploadId = uploadId;
			if (index === 1) {
				assert.equal(trace.firstConfirmed, true, "第二块只能在第一块确认后发出");
				trace.held = true;
				await gate;
				if (mode === "cancel") {
					await route.abort("aborted");
					return;
				}
				if (mode === "failure") {
					await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: FAILURE }) });
					return;
				}
			}
			const response = await route.fetch();
			assert.ok(response.ok(), `PUT 分块失败：${response.status()} ${await response.text()}`);
			const result = await response.json();
			assert.equal(result.offset, offset + data.length, "服务端返回已确认字节数");
			if (index === 0) {
				assert.equal(result.file, undefined, "第一块未完成时不得登记文件");
				trace.firstConfirmed = true;
			} else {
				assert.ok(result.file?.fileId, "最后一块返回正式附件");
				trace.file = result.file;
			}
			await route.fulfill({ response });
		} catch (error) {
			trace.errors.push(error);
			await route.abort("failed").catch(() => {});
		}
	};
	await page.route(pattern, handler);
	return {
		trace,
		release,
		check: () => { if (trace.errors.length) throw trace.errors[0]; },
		close: async () => {
			release();
			// 失败收尾时先等处理器退完，避免仍扣着请求导致浏览器关闭挂住。
			await page.unrouteAll({ behavior: "wait" });
		},
	};
}

async function beginUpload(page, scope, input, mode = "success") {
	const root = scope.root(page);
	const control = await interceptChunks(page, scope, input.bytes, mode);
	try {
		const created = page.waitForResponse((response) => response.url() === BASE + scope.upload && response.request().method() === "POST");
		// 先监听响应，再操作真实文件选择框；不改 React 状态，也不替换上传实现。
		await root.getByTestId("attach-input").setInputFiles(input.path);
		const response = await created;
		assert.ok(response.ok(), `创建上传会话失败：${response.status()}`);
		assert.deepEqual(response.request().postDataJSON(), { name: input.name, size: input.bytes.length });
		assert.match(response.request().headers()["content-type"] ?? "", /^application\/json/);
		const { uploadId } = await response.json();
		assert.ok(uploadId, "POST 返回上传会话编号");
		await waitFor(`${scope.key} 第二块被测试扣住`, () => { control.check(); return control.trace.held; });
		assert.equal(control.trace.uploadId, uploadId);
		const chip = chipFor(root, input.name);
		await chip.waitFor();
		const progress = chip.getByTestId("attach-progress");
		await waitFor("托盘显示已确认的 96%", async () => {
			control.check();
			return await progress.getAttribute("aria-valuenow") === "96";
		});
		assert.equal(await progress.getAttribute("role"), "progressbar");
		assert.equal(await progress.isVisible(), true, "文件和图片都显示字节进度");
		assert.match(await progress.textContent(), /96\s*%/, "用户能看到百分比文字");
		assert.equal(await chip.getAttribute("data-kind"), input.kind);
		// 第一块已经落到真实服务，但最终附件尚未登记。
		const files = await json(`/api/agents/${scope.agentId}/files`);
		assert.equal(files.some((file) => file.name === input.name), false, "未完成上传不出现在助理 files API");
		return control;
	} catch (error) {
		await control.close();
		throw error;
	}
}

async function assertDownload(file, input) {
	assert.equal(file.name, input.name);
	assert.equal(file.size, input.bytes.length);
	const response = await fetch(`${BASE}/api/files/${encodeURIComponent(file.fileId)}`, { signal: AbortSignal.timeout(30_000) });
	assert.ok(response.ok, `正式附件下载失败：${response.status}`);
	const downloaded = Buffer.from(await response.arrayBuffer());
	assert.equal(downloaded.length, input.bytes.length);
	assert.ok(downloaded.equals(input.bytes), "整份下载与原始 33MiB 文件逐字节一致（含跨块边界）");
}

async function assertRegistration(scope, file) {
	const files = await json(`/api/agents/${scope.agentId}/files`);
	if (scope.kind === "agent") {
		const matches = files.filter((row) => row.fileId === file.fileId);
		assert.equal(matches.length, 1, "助理 files API 恰好登记一次");
		assert.equal(matches[0].size, file.size);
		assert.equal(matches[0].name, file.name);
	} else {
		// 当前没有 GET /api/rooms/:rid/files；核对返回归属及随消息落库，不虚构群文件接口。
		assert.equal(file.roomId, scope.id, "正式附件登记到当前群");
		assert.equal(files.some((row) => row.fileId === file.fileId), false, "群文件不混入成员的私有文件列表");
	}
}

async function sendAttachment(page, scope, file, input) {
	const root = scope.root(page);
	const text = `${scope.key} ${input.kind} 分块附件验收`;
	await root.locator(".pa-composer textarea").fill(text);
	await root.getByRole("button", { name: "发送", exact: true }).click();
	await waitFor("上传附件随真实消息登记", async () => {
		const result = await json(scope.messages);
		const rows = Array.isArray(result) ? result : result.messages;
		const row = rows.find((message) => message.role === "user" && message.content === text);
		if (!row) return false;
		const meta = typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta;
		assert.deepEqual(meta.attachments.map((attachment) => attachment.fileId), [file.fileId]);
		assert.equal(meta.attachments[0].size, input.bytes.length);
		return true;
	});
	await waitFor("发送后托盘清空", async () => await root.getByTestId("attach-tray").count() === 0);
	if (input.kind === "image") await root.getByTestId("image-attachment").filter({ has: page.getByAltText(input.name, { exact: true }) }).first().waitFor();
	else await root.getByTestId("file-attachment").filter({ hasText: input.name }).first().waitFor();
}

async function successCase(page, scope, input) {
	const control = await beginUpload(page, scope, input);
	try {
		await shot(page, scope, `${input.kind}-uploading`, chipFor(scope.root(page), input.name));
		control.release();
		await waitFor("上传完成且进度退出", async () => {
			control.check();
			return !!control.trace.file && await scope.root(page).getByTestId("attach-progress").count() === 0;
		});
		const file = control.trace.file;
		assert.deepEqual(control.trace.puts.map((put) => put.size), [CHUNK, SIZE - CHUNK]);
		assert.equal(control.trace.deleted.length, 0, "成功上传不用 DELETE");
		await assertDownload(file, input);
		await assertRegistration(scope, file);
		if (input.kind === "image") {
			await waitFor("正式图片缩略图可解码", () => chipFor(scope.root(page), input.name).locator("img").evaluate((image) => image.complete && image.naturalWidth > 0));
		}
		await shot(page, scope, `${input.kind}-complete`, chipFor(scope.root(page), input.name));
		await sendAttachment(page, scope, file, input);
		console.log(`✅ ${scope.key}/${input.kind}：32MiB + 1MiB，96% 可见，完整字节下载、登记与发送`);
	} finally {
		await control.close();
	}
}

async function cleanupCase(page, scope, input, mode) {
	const beforeFiles = await json(`/api/agents/${scope.agentId}/files`);
	const control = await beginUpload(page, scope, input, mode);
	try {
		const chip = chipFor(scope.root(page), input.name);
		if (mode === "cancel") {
			await chip.getByRole("button", { name: `移除 ${input.name}`, exact: true }).click();
		} else {
			control.release();
		}
		await waitFor("失败/取消后真实 DELETE 清理会话", () => {
			control.check();
			return control.trace.deleted.includes(control.trace.uploadId);
		});
		control.release();
		await waitFor("失败/取消退出上传进度", async () => await scope.root(page).getByTestId("attach-progress").count() === 0);
		if (mode === "failure") {
			assert.match(await chip.getAttribute("title"), new RegExp(FAILURE), "上传失败在附件上可见");
			await shot(page, scope, "failure", chip);
			await chip.getByRole("button", { name: `移除 ${input.name}`, exact: true }).click();
		}
		await waitFor("移除后托盘为空", async () => await scope.root(page).getByTestId("attach-tray").count() === 0);
		// 不附大请求体查询失效会话，避免服务提前返回 404 时关闭尚未收完的请求连接。
		const retry = await fetch(`${BASE}${scope.upload}/${encodeURIComponent(control.trace.uploadId)}?offset=${CHUNK}&index=1`, {
			method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(), signal: AbortSignal.timeout(30_000),
		});
		assert.equal(retry.status, 404, "清理后的会话已经失效");
		await retry.arrayBuffer();
		assert.deepEqual(await json(`/api/agents/${scope.agentId}/files`), beforeFiles, "失败/取消没有额外文件登记");
		assert.equal(control.trace.file, null);
		assert.equal(control.trace.deleted.length, 1, "每个失败/取消会话清理一次");
		await shot(page, scope, `${mode}-empty`);
		console.log(`✅ ${scope.key}/${mode}：真实 DELETE 清理、无正式附件、旧会话不能续写`);
	} finally {
		await control.close();
	}
}

try {
	const port = await freePort();
	BASE = `http://127.0.0.1:${port}`;
	server = startTempServer({ root: ROOT, port, run, extra: { PIA_HOST_CONTROL_DRY_RUN: "1" } });
	await waitFor("临时 Mock 服务启动", async () => {
		if (server.child.exitCode !== null) throw new Error(`临时服务退出：${server.logs()}`);
		try { return (await fetch(BASE + "/api/system", { signal: AbortSignal.timeout(1000) })).ok; }
		catch { return false; }
	}, 60_000);
	await json("/api/settings", "PUT", { onboarded: true });
	const system = await json("/api/system");
	assert.equal(system.mock, true, "只允许 Mock 服务");
	const agent = await json("/api/agents", "POST", { name: "分块上传验收" });
	const room = await json("/api/rooms", "POST", { name: "分块上传验收群", memberIds: [agent.id], managerId: agent.id });
	const scopes = [
		{ kind: "agent", key: "single", id: agent.id, agentId: agent.id, url: `/?agent=${agent.id}`, upload: `/api/agents/${agent.id}/upload`, messages: `/api/agents/${agent.id}/messages`, root: (page) => page.getByTestId("main-conversation") },
		{ kind: "room", key: "room", id: room.id, agentId: agent.id, url: `/?room=${room.id}`, upload: `/api/rooms/${room.id}/upload`, messages: `/api/rooms/${room.id}/messages`, root: (page) => page.getByTestId("room-chat") },
	];
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	// before 模式不创建大文件、不依赖新分块协议，只记录旧构建下的两个初始界面。
	for (const scope of scopes) {
		await openScope(page, scope);
		await shot(page, scope, "empty");
	}
	if (!BEFORE_ONLY) {
		const binary = Buffer.alloc(SIZE, 0x5a);
		binary.write("upload-chunks: first block");
		binary.write("upload-chunks: boundary", CHUNK - 10);
		binary.write("upload-chunks: final bytes", SIZE - 32);
		// 已有真实 PNG 后加尾部填充，浏览器仍可解码，文件体积确实跨过 32MiB。
		const png = readFileSync(join(ROOT, "e2e/fixtures/chat-generated-image.png"));
		assert.ok(png.length < SIZE);
		const image = Buffer.alloc(SIZE, 0x37);
		png.copy(image);
		for (const scope of scopes) {
			await openScope(page, scope);
			const input = (kind, suffix = "") => {
				const name = `${scope.key}-${kind}${suffix}-33MiB.${kind === "image" ? "png" : "bin"}`;
				const path = join(run.runDir, name);
				const bytes = kind === "image" ? image : binary;
				writeFileSync(path, bytes);
				return { kind, name, path, bytes };
			};
			await successCase(page, scope, input("file"));
			await successCase(page, scope, input("image"));
			await cleanupCase(page, scope, input("file", "-failure"), "failure");
			await cleanupCase(page, scope, input("image", "-cancel"), "cancel");
		}
	}
	assert.deepEqual(pageErrors, [], "真实前端没有未处理异常");
	console.log(BEFORE_ONLY ? `✅ 仅记录初始截图：${OUT}` : `✅ 分块上传 e2e 通过；截图：${OUT}`);
} catch (error) {
	writeFileSync(join(OUT, `${PREFIX}-server.log`), server?.logs() ?? "服务未启动");
	throw error;
} finally {
	await browser?.close().catch(() => {});
	await server?.stop().catch(() => {});
	cleanupTempRun(run);
}
