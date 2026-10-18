/**
 * 助理详情 8 个分类的前后对比截图（只截图，不做断言矩阵）。
 * 真实临时服务（makeTempRun / startTempServer，内存凭据 + Mock 模型），种一个助理 + 记忆 / 文件 / 定时任务。
 * 用法：npm run build -w @pi-assistant/web && SHOT_DIR=artifacts/agent-details/after node e2e/agent-details-shots.mjs
 */
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { waitStable } from "./fixtures/stable-shot.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { infoTab, INFO_TABS } from "./fixtures/info-pane.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = artifactDir("agent-details");
const run = makeTempRun("pia-agent-details-shots-");
const port = await new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
const json = async (path, method = "GET", body) => {
	const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
	return r.json();
};
const upload = async (agentId, name, bytes, type) => {
	const fd = new FormData();
	fd.append("file", new Blob([bytes], { type }), name);
	const r = await fetch(`${base}/api/agents/${agentId}/upload`, { method: "POST", body: fd });
	if (!r.ok) throw new Error(`上传 ${name} → ${r.status}`);
};
let browser;
try {
	for (let i = 0; ; i++) {
		if (server.child.exitCode !== null) throw new Error("临时服务退出：" + server.logs());
		try { if ((await fetch(base + "/api/system")).ok) break; } catch {}
		if (i > 400) throw new Error("临时服务就绪超时");
		await new Promise((r) => setTimeout(r, 80));
	}
	await json("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
	const agent = await json("/api/agents", "POST", { name: "小派", description: "写代码、查资料、整理文件的全能助理", persona: "回答要简洁，结论先行；称呼我 deng。", model: { provider: "mock", id: "echo-think" }, thinking: "medium" });
	await json(`/api/agents/${agent.id}/memory`, "POST", { text: "我叫邓邓，喜欢简洁的回答", kind: "fact", scope: "user" });
	await json(`/api/agents/${agent.id}/memory`, "POST", { text: "提交信息用单行中文", kind: "experience", scope: "agent" });
	await upload(agent.id, "需求说明.md", Buffer.from("# 需求\n"), "text/markdown");
	await json(`/api/agents/${agent.id}/routines`, "POST", { name: "每日简报", prompt: "整理今天的待办。", trigger: "cron", cron: "0 8 * * *" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, env: browserEnv(run) });
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN", colorScheme: "dark" });
	const page = await ctx.newPage();
	await page.addInitScript(() => { localStorage.setItem("pia.theme", "dark"); localStorage.setItem("pia.layout", JSON.stringify({ sideW: 264, sideCollapsed: true, info: true, paneW: 420 })); });
	await page.goto(`${base}/?agent=${agent.id}`);
	const pane = page.locator(".pa-pane-wrap");
	await page.getByTestId("info-tabs").waitFor();
	for (const key of Object.keys(INFO_TABS)) {
		await infoTab(page, key);
		await page.waitForTimeout(500);
		await waitStable(page, pane);
		await pane.screenshot({ path: join(out, `${process.env.SHOT_PREFIX ?? ""}${key}.png`) });
	}
	await page.locator(".pa-composer").screenshot({ path: join(out, `${process.env.SHOT_PREFIX ?? ""}composer.png`) });
	console.log("截图写入", out);
} finally {
	await browser?.close();
	await server.stop();
	cleanupTempRun(run);
}
