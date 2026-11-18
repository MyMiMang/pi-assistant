/** 共用 Help 链接/焦点回归：真实 ui.tsx + 临时 React fixture，无 build、后端、模型或个人 profile。 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { makeTempRun, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = makeTempRun("pia-help-links-");
const entry = join(run.runDir, "help-fixture.tsx");
writeFileSync(entry, `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Help, useEscLayer } from ${JSON.stringify(join(root, "apps/web/src/components/ui.tsx"))};
import ${JSON.stringify(join(root, "apps/web/src/themes/app.css"))};
function Fixture() {
 const [open, setOpen] = useState(true);
 const [clicks, setClicks] = useState(0);
 useEscLayer(open, () => setOpen(false));
 return <main style={{ padding: 80 }}>
  <button data-testid="before">前一个控件</button>
  {open && <section data-testid="underlying">
   <Help><span>许可说明</span><a href="#license" onClick={e => { e.preventDefault(); setClicks(n => n + 1); }}>许可正文</a><a href="#weights">权重页</a></Help>
   <button data-testid="after">后一个控件</button>
  </section>}
  <output data-testid="clicks">{clicks}</output>
 </main>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`);
let server;
let browser;
try {
 server = await createServer({
  root, configFile: false, esbuild: { jsx: "automatic" },
  cacheDir: join(run.runDir, "vite-cache"), resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root, run.runDir] } },
  plugins: [{ name: "help-fixture", configureServer(vite) {
   vite.middlewares.use((req, res, next) => {
    if (req.url !== "/help-fixture") return next();
    res.setHeader("Content-Type", "text/html");
    res.end('<div id="root"></div><script type="module" src="/@fs/' + entry + '"></script>');
   });
  } }],
 });
 await server.listen();
 browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
 const page = await browser.newPage();
 const errors = [];
 page.on("pageerror", e => errors.push(e.message));
 const base = `http://127.0.0.1:${server.httpServer.address().port}`;
 await page.route("**/*", route => route.request().url().startsWith(base + "/") ? route.continue() : route.abort());
 await page.goto(base + "/help-fixture");
 await page.getByTestId("before").waitFor({ timeout: 15000 }).catch(e => { throw new Error(`Fixture 未加载：${errors.join("; ")}`, { cause: e }); });
 const help = page.getByTestId("help");
 const pop = page.getByTestId("help-pop");
 const license = page.getByRole("link", { name: "许可正文" });
 const weights = page.getByRole("link", { name: "权重页" });
 const focusIs = async locator => assert.equal(await locator.evaluate(el => el === document.activeElement), true);
 const opened = () => pop.waitFor({ state: "visible" });
 const closed = () => pop.waitFor({ state: "detached" });
 const enterHelp = async () => {
  await page.getByTestId("before").focus();
  await page.keyboard.press("Tab");
  await focusIs(help);
  await opened();
 };
 await enterHelp();
 await license.click();
 await page.waitForFunction(() => document.querySelector('[data-testid="clicks"]').textContent === "1");
 await opened();
 await focusIs(license);
 console.log("PASS 鼠标点击气泡链接：点击送达、焦点进入、Help 保持打开");
 await page.getByTestId("after").focus();
 await closed();
 console.log("PASS 链接失焦到外部：Help 关闭");
 await enterHelp();
 await page.keyboard.press("Tab");
 await focusIs(license);
 await opened();
 await page.keyboard.press("Enter");
 await page.waitForFunction(() => document.querySelector('[data-testid="clicks"]').textContent === "2");
 await page.keyboard.press("Tab");
 await focusIs(weights);
 await opened();
 await page.keyboard.press("Tab");
 await closed();
 console.log("PASS Tab 从按钮进入链接、链接间移动、Enter 激活、Tab 离开关闭");
 await enterHelp();
 await page.keyboard.press("Shift+Tab");
 await focusIs(page.getByTestId("before"));
 await closed();
 await enterHelp();
 await page.keyboard.press("Tab");
 await page.keyboard.press("Escape");
 await closed();
 assert.equal(await page.getByTestId("underlying").count(), 1);
 await page.keyboard.press("Escape");
 await page.getByTestId("underlying").waitFor({ state: "detached" });
 console.log("PASS Shift+Tab 离开关闭；链接内 Esc 只关 Help，第二次才关底层");
 await page.reload();
 await enterHelp();
 await page.keyboard.press("Escape");
 await closed();
 await focusIs(help);
 await page.keyboard.press("a");
 assert.equal(await pop.count(), 0);
 await page.getByTestId("after").click();
 await enterHelp();
 await page.getByTestId("after").click();
 await closed();
 assert.equal(await page.getByTestId("underlying").count(), 1);
 assert.deepEqual(errors, []);
 console.log("PASS 按钮内 Esc 不立即重开、重新聚焦可打开、外部点击关闭；无页面异常");
} finally {
 await browser?.close();
 await server?.close();
 cleanupTempRun(run);
}
