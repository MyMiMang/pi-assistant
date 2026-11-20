// 先构建 Web，再运行本脚本。两套临时数据库，全部技能内容均为合成。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, unzipSync, zipSync } from "fflate";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = artifactDir("skill-zip-export");
const name = "e2e-zip-roundtrip";
const description = "合成技能：验证压缩包往返";
const body = "# 已保存的合成技能\n\n读取 references/sample.txt。";
const attachment = strToU8("合成附件\n第一行\n");
const fixture = { "SKILL.md": strToU8(`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`), "references/sample.txt": attachment };
const exportPath = "/api/skills/export.zip";
const servers = [];
let browser;

async function start() {
	const run = makeTempRun("pia-skill-zip-export-");
	const port = await new Promise((resolve, reject) => {
		const socket = createServer().listen(0, "127.0.0.1", () => { const port = socket.address().port; socket.close(() => resolve(port)); });
		socket.on("error", reject);
	});
	const server = startTempServer({ root, port, run });
	servers.push({ server, run });
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 30_000;
	while (!(await fetch(`${base}/api/system`).then((r) => r.ok, () => false))) {
		if (Date.now() > deadline || server.child.exitCode !== null) throw new Error(server.logs());
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const onboard = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ onboarded: true }) });
	assert.ok(onboard.ok);
	return { base, run };
}

async function pageAt(base, width) {
	const page = await browser.newPage({ viewport: { width, height: 900 }, acceptDownloads: true, serviceWorkers: "block" });
	page.setDefaultTimeout(10_000);
	await page.route("**/*", (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
	await page.goto(`${base}/?settings=skills`);
	await page.getByTestId("skills-tab").waitFor();
	return page;
}

async function importZip(page, bytes) {
	await page.getByTestId("skill-import-open").click();
	await page.getByTestId("skill-import-file").setInputFiles({ name: `${name}.zip`, mimeType: "application/zip", buffer: Buffer.from(bytes) });
	const [response] = await Promise.all([
		page.waitForResponse((r) => new URL(r.url()).pathname === "/api/skills/import" && r.request().method() === "POST"),
		page.getByTestId("skill-import-submit").click(),
	]);
	assert.ok(response.ok(), await response.text());
	assert.equal((await response.json()).id, `external/${name}`);
	await page.getByTestId("skill-import-modal").waitFor({ state: "hidden" });
}

async function downloadSkill(page, button) {
	const [download, response] = await Promise.all([
		page.waitForEvent("download"),
		page.waitForResponse((r) => new URL(r.url()).pathname === exportPath),
		button.click(),
	]);
	assert.equal(response.request().method(), "GET");
	assert.equal(new URL(response.url()).searchParams.get("id"), `external/${name}`);
	assert.equal(response.status(), 200);
	assert.match(response.headers()["content-disposition"], /attachment/i);
	assert.match(response.headers()["content-type"], /^application\/zip\b/i);
	assert.equal(download.suggestedFilename(), `${name}.zip`);
	const bytes = readFileSync(await download.path());
	const entries = unzipSync(bytes);
	const files = Object.keys(entries).filter((key) => !key.endsWith("/"));
	assert.deepEqual(files.sort(), Object.keys(fixture).sort());
	assert.deepEqual(entries["SKILL.md"], fixture["SKILL.md"], "原始中文 SKILL.md 逐字节一致");
	assert.deepEqual(entries["references/sample.txt"], attachment);
	console.log(`${page.viewportSize().width}px ${response.request().method()} ${new URL(response.url()).pathname}${new URL(response.url()).search} → ${response.status()} ${response.headers()["content-type"]}; ${response.headers()["content-disposition"]}; 下载 ${download.suggestedFilename()}; 内容 ${files.join(", ")}`);
	return bytes;
}

try {
	const source = await start();
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(source.run) });
	let exported;
	for (const width of [1440, 390]) {
		const page = await pageAt(source.base, width);
		const button = page.getByRole("button", { name: "导出 ZIP" });
		assert.equal(await button.count(), 0, "列表不展示导出");
		if (width === 1440) {
			await page.getByRole("button", { name: "新建技能" }).click();
			await page.getByTestId("skill-form").waitFor();
			assert.equal(await button.count(), 0, "新建草稿不展示导出");
			await page.getByRole("button", { name: "取消", exact: true }).click();
			await importZip(page, zipSync(fixture));
		}
		await page.getByTestId(`skill-item-${name}`).click();
		await button.waitFor();
		await page.screenshot({ path: join(out, `detail-${width}.png`), animations: "disabled" });
		const box = await button.boundingBox();
		assert.ok(box && box.x >= 0 && box.x + box.width <= width, "按钮在视口内");
		await page.getByRole("button", { name: "编辑", exact: true }).click();
		await page.getByTestId("skill-form").locator("textarea").fill("不应写入下载包的合成草稿");
		assert.equal(await button.count(), 0, "编辑草稿不展示导出");
		await page.getByRole("button", { name: "取消", exact: true }).click();
		if (width === 1440) {
			const match = (u) => u.pathname === exportPath;
			let release;
			let requests = 0;
			const hold = new Promise((resolve) => { release = resolve; });
			await page.route(match, async (route) => {
				requests++;
				await hold;
				await route.fulfill({ status: 413, json: { error: "too_large", message: "合成测试：技能文件过大" } });
			});
			let downloads = 0;
			page.on("download", () => downloads++);
			try {
				await button.click();
				await page.getByRole("button", { name: "正在导出…" }).waitFor();
				assert.ok(await page.getByRole("button", { name: "正在导出…" }).isDisabled());
			} finally {
				release();
			}
			await page.getByText("导出失败：合成测试：技能文件过大").waitFor();
			assert.equal(requests, 1);
			assert.equal(downloads, 0);
			assert.ok(await button.isEnabled());
			await page.unroute(match);
		}
		exported = await downloadSkill(page, button);
		assert.equal(await page.getByText(/^导出失败：/).count(), 0);
		await page.close();
		console.log(`通过 ${width}px：仅详情可导出；canonical id、文件名与 ZIP 内容正确`);
	}
	const bad = join(source.run.data, "skills-external", name);
	writeFileSync(join(bad, "references", "unsupported.bin"), Buffer.from([255, 254]));
	const rejected = await pageAt(source.base, 390);
	await rejected.getByTestId(`skill-item-${name}`).click();
	let invalidDownloads = 0;
	rejected.on("download", () => invalidDownloads++);
	const refused = async () => {
		const [response] = await Promise.all([
			rejected.waitForResponse((r) => new URL(r.url()).pathname === exportPath),
			rejected.getByRole("button", { name: "导出 ZIP" }).click(),
		]);
		assert.equal(response.status(), 400);
		const { error } = await response.json();
		await rejected.getByText(`导出失败：${error}`, { exact: true }).waitFor();
		assert.equal(invalidDownloads, 0);
		console.log(`390px 拒绝：${response.status()} ${error}，无下载`);
		return error;
	};
	assert.match(await refused(), /unsupported\.bin/);
	// 单独一个技能，避免二进制拒绝影响空目录用例。
	const empty = join(source.run.data, "skills", "e2e-empty-dir");
	mkdirSync(join(empty, "references"), { recursive: true });
	writeFileSync(join(empty, "SKILL.md"), "---\nname: e2e-empty-dir\ndescription: 合成空目录\n---\n\n正文\n");
	await rejected.reload();
	await rejected.getByTestId("skill-item-e2e-empty-dir").click();
	assert.match(await refused(), /空目录/);
	await rejected.close();
	const target = await start();
	const page = await pageAt(target.base, 390);
	assert.deepEqual((await (await fetch(`${target.base}/api/skills`)).json()).filter((s) => !s.builtin), []);
	await importZip(page, exported);
	await page.getByTestId(`skill-item-${name}`).click();
	await page.getByRole("heading", { name: "已保存的合成技能" }).waitFor();
	await downloadSkill(page, page.getByRole("button", { name: "导出 ZIP" }));
	console.log("通过独立清库：现有导入界面可导入，正文与附带文件可再次导出");
} finally {
	try { await browser?.close(); }
	finally {
		for (const { server, run } of servers) {
			await server.stop();
			cleanupTempRun(run);
		}
	}
}
