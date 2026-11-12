/** 原生 ACP：临时数据、Mock、本地 npm / binary 假包；不联网、不运行真实工具。 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";
import { makeNativeInstallPreload } from "./fixtures/native-acp-package.mjs";
import { openModelMenu } from "./model-menu-flow.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";

export async function runNativeAcpUi({ samples = [
 { kind: "gemini-cli", name: "Gemini", update: true },
 { kind: "codebuddy-cli", name: "CodeBuddy", update: true },
], artifactName = "native-acp-ui", boundaries = true } = {}) {
const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-native-ui-");
const OUT = artifactDir(artifactName);
const preload = makeNativeInstallPreload(root, join(run.runDir, "fake-packages"));
const port = await new Promise(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
assert.notEqual(port, 8787);
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run, extra: { NODE_OPTIONS: `--import tsx --import ${JSON.stringify(preload)}` } });
const wait = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`等待超时\n${server.logs().slice(-6000)}`); };
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path}: ${r.status}`); return r.json(); };
let browser;
try {
 await wait(async () => { if (server.child.exitCode !== null) throw new Error(server.logs()); try { return (await fetch(base + "/api/system", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } });
 await j("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
 browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
 const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, locale: "zh-CN" });
 page.setDefaultTimeout(20000);
 const errors = [];
 page.on("pageerror", e => errors.push(e.message));
 await page.goto(`${base}/?settings=models`);
 const toggle = page.getByTestId("cli-agents-toggle");
 assert.equal(await toggle.getAttribute("aria-expanded"), "false", "编程工具默认折叠");
 await toggle.click();
 assert.equal(await page.getByTestId("cli-agents-list").locator("[data-installed]").count(), 21, "四家 brain + 17 家 native 共用列表");
 for (const { kind, update } of samples) {
  const card = page.getByTestId(`${kind}-card`);
  await card.getByText("没装", { exact: true }).waitFor();
  assert.match(await card.innerText(), /Pi 单独装一份，和你电脑上的设置、登录完全分开。/);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(OUT, `${kind}-01-not-installed.png`) });
  await card.getByRole("button", { name: "安装", exact: true }).click();
  await wait(async () => await card.getAttribute("data-installed") === "true");
  if (kind === "goose") {
   const installRoot = join(run.data, "cli-agents", "goose");
   const current = JSON.parse(readFileSync(join(installRoot, "current.json"), "utf8"));
   const release = JSON.parse(readFileSync(join(installRoot, current.version, ".pia-installed.json"), "utf8"));
   assert.equal(release.source, "binary", "Goose 使用 binary 安装路径");
   assert.equal(release.assets[`${process.platform}-${process.arch}`].executable, "node", "假 binary 仅执行本地 JS");
   assert.match(readFileSync(join(installRoot, current.version, "goose"), "utf8"), /fake ACP requires isolated home/);
  }
  await card.getByRole("button", { name: "登录", exact: true }).waitFor();
  await card.screenshot({ path: join(OUT, `${kind}-02-installed.png`) });
  // 先取消一次，验证登录异步且取消后可重试。
  await card.getByRole("button", { name: "登录", exact: true }).click();
  await card.getByText("正在登录，请在浏览器里完成", { exact: true }).waitFor();
  await card.screenshot({ path: join(OUT, `${kind}-03-login.png`) });
  await card.getByRole("button", { name: "取消", exact: true }).click();
  await card.getByRole("button", { name: "登录", exact: true }).waitFor();
  await card.getByRole("button", { name: "登录", exact: true }).click();
  await wait(async () => await card.getAttribute("data-logged-in") === "true");
  await card.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  await card.getByRole("button", { name: "重新检测", exact: true }).click();
  await wait(async () => await card.getAttribute("data-registered") === "true");
  await card.screenshot({ path: join(OUT, `${kind}-04-ready.png`) });
  if (update) {
   await card.getByRole("button", { name: "检查更新", exact: true }).click();
   await card.getByRole("button", { name: /更新到 v2\.0\.0/ }).waitFor();
   await card.getByRole("button", { name: /更新到 v2\.0\.0/ }).click();
   await wait(async () => /已安装 v2\.0\.0/.test(await card.innerText()));
   await card.getByText("这个版本还没测过", { exact: true }).waitFor();
   assert.equal(await card.getAttribute("data-logged-in"), "true", "更新保留独立 home 的登录");
   await card.screenshot({ path: join(OUT, `${kind}-05-updated.png`) });
  }
 }
 await wait(async () => {
  const first = await page.getByTestId("cli-agents-list").locator("[data-registered]").first().getAttribute("data-registered");
  return first === "true";
 });
 // 两个独立入口共用流程，各自选模型 → 原生步骤 → 审批 → 文件落地 → 历史重载。
 for (const { kind, name } of samples.filter(s => s.kind !== "codebuddy-cli")) {
  const agent = await j("/api/agents", "POST", { name: `${name} 原生 ACP 测试助理` });
  const list = (await j("/api/models")).filter(m => m.provider === kind);
  assert.ok(list.length, `${kind} 登录后注册原生模型`);
  await page.goto(`${base}/?agent=${agent.id}`);
  const menu = await openModelMenu(page);
  await page.getByTestId("model-search").fill(name);
  const option = menu.locator(`[data-testid=model-option][data-model="${kind}/${list[0].id}"]`).first();
  await option.waitFor();
  await page.screenshot({ path: join(OUT, `${kind}-06-model-picker.png`) });
  await option.click();
  await wait(async () => (await j("/api/agents")).find(a => a.id === agent.id)?.model?.provider === kind);
  await page.keyboard.press("Escape");
  const actualAgent = (await j("/api/agents")).find(a => a.id === agent.id);
  assert.ok(actualAgent.workspace.startsWith(run.data), "测试工作区位于内存凭据服务的临时数据目录");
  const note = join(actualAgent.workspace, "test-note.txt");
  assert.equal(existsSync(note), false, "审批前测试笔记不存在");
  const box = page.locator("main textarea:not(.pa-card textarea)");
  await box.fill("请写入测试笔记"); await box.press("Enter");
  await page.locator("main").getByText("需要你的批准", { exact: false }).last().waitFor({ timeout: 30000 });
  assert.match(await page.locator("main").innerText(), /准备写入测试笔记/);
  assert.match(await page.locator("main").innerText(), /写入测试笔记/);
  assert.equal(existsSync(note), false, "假 ACP 等待批准时不能提前写文件");
  await stableShot(page, page.getByRole("button", { name: "批准", exact: true }), join(OUT, `${kind}-07-native-step-approval.png`));
  await page.getByRole("button", { name: "批准", exact: true }).click();
  const done = page.locator("main").getByText("本地假 ACP 已获批准，测试笔记已写入。", { exact: false }).last();
  await done.waitFor({ timeout: 30000 });
  assert.ok(existsSync(note), "批准后假 ACP 在助理工作文件夹写文件");
  assert.equal(readFileSync(note, "utf8"), "本地假 ACP 已获批准");
  await stableShot(page, done, join(OUT, `${kind}-08-native-approved.png`));
  await page.reload();
  await page.locator("main").getByText("本地假 ACP 已获批准，测试笔记已写入。", { exact: false }).last().waitFor();
  assert.match(await page.locator("main").innerText(), /写入测试笔记/);
 }
 // 界面边界用假响应覆盖，不安装、不调用这三家的真实工具。
 if (boundaries) {
 let terminalLogin = false;
 await page.route(/\/api\/models\/(cursor|grok-build|devin)(?:\/[^?]*)?$/, async route => {
  const url = new URL(route.request().url());
  const kind = url.pathname.split("/")[3];
  const action = url.pathname.split("/")[4];
  if (route.request().method() === "POST" && action !== "recheck") {
   assert.equal(kind, "devin");
   assert.ok(action === "login" || action === "cancel");
   terminalLogin = action === "login";
   return route.fulfill({ json: { started: true } });
  }
  await route.fulfill({ json: { installed: kind !== "cursor", loggedIn: false, registered: false, platformSupported: kind !== "cursor", authType: kind === "grok-build" ? "api-key" : "terminal", ...(kind === "devin" && terminalLogin ? { operation: "login" } : {}) } });
 });
 }
 await page.setViewportSize({ width: 390, height: 844 });
 await page.goto(`${base}/?settings=models`);
 await page.getByTestId("cli-agents-toggle").click();
 if (boundaries) {
 const unsupported = page.getByTestId("cursor-card");
 await unsupported.getByText("这个平台暂不支持", { exact: true }).waitFor();
 assert.equal(await unsupported.getByRole("button", { name: "安装", exact: true }).isDisabled(), true);
 const apiKey = page.getByTestId("grok-build-card");
 await apiKey.getByText("需要在工具里配置", { exact: true }).waitFor();
 assert.equal(await apiKey.getByRole("button", { name: "登录", exact: true }).count(), 0);
 assert.equal(await apiKey.locator("input").count(), 0, "不提供密钥输入框");
 const terminal = page.getByTestId("devin-card");
 await terminal.getByRole("button", { name: "登录", exact: true }).click();
 await terminal.getByText("正在登录，请在打开的终端里完成", { exact: true }).waitFor();
 await terminal.getByRole("button", { name: "取消", exact: true }).click();
 await terminal.getByRole("button", { name: "登录", exact: true }).waitFor();
 }
 for (const kind of [...samples.map(s => s.kind), ...(boundaries ? ["cursor", "grok-build"] : [])]) {
  const card = page.getByTestId(`${kind}-card`);
  await card.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "手机卡片不横向溢出");
  await card.screenshot({ path: join(OUT, `${kind}-09-mobile-card.png`) });
 }
 if (boundaries) assert.equal(await page.getByTestId("cli-agents-list").locator("[data-platform-supported]").last().getAttribute("data-platform-supported"), "false", "不支持平台的卡片排在最后");
 assert.deepEqual(errors, []);
 console.log(`✅ ${artifactName} 通过（${samples.map(s => s.kind).join("、")}），截图：${OUT}`);
} finally {
 await browser?.close().catch(() => {});
 await server.stop();
 cleanupTempRun(run);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runNativeAcpUi();
