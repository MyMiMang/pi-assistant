// 从 assets/brand/*.svg（唯一母版）生成所有图标：PWA / favicon / apple-touch / Tauri（tauri icon）/ 托盘。
// 用法：node scripts/gen-icons.mjs   （需要 Chrome：CHROME=/path/to/chrome，默认 /usr/bin/google-chrome）
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = new URL("..", import.meta.url).pathname;
const BRAND = join(ROOT, "assets/brand");
const WEB = join(ROOT, "apps/web/public");
const TAURI = join(ROOT, "apps/tray/src-tauri/icons");
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(svg, size, out) {
	const src = readFileSync(join(BRAND, svg), "utf8");
	await page.setViewportSize({ width: size, height: size });
	await page.setContent(`<html><body style="margin:0;background:transparent"><img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(src).toString("base64")}"></body></html>`);
	await page.locator("img").evaluate((i) => i.decode());
	await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
const tmp = mkdtempSync(join(tmpdir(), "pia-icons-"));
try {
	// Web / PWA
	copyFileSync(join(BRAND, "icon.svg"), join(WEB, "icon.svg"));
	await png("icon.svg", 192, join(WEB, "icon-192.png"));
	await png("icon.svg", 512, join(WEB, "icon-512.png"));
	await png("icon-maskable.svg", 512, join(WEB, "icon-maskable.png"));
	await png("icon-maskable.svg", 180, join(WEB, "apple-touch-icon.png")); // iOS 自己加圆角，用满版背景
	await png("tray-template.svg", 96, join(WEB, "badge-96.png")); // 安卓通知小图标：只用透明度（单色）
	// Tauri：全部尺寸（Windows ico / Linux png / Store logo）用满版母版，macOS icns 用带留白和阴影的版本
	await png("icon.svg", 1024, join(tmp, "icon.png"));
	await png("icon-macos.svg", 1024, join(tmp, "icon-macos.png"));
	const tauri = (input, out) => execFileSync("npx", ["--no-install", "tauri", "icon", input, "-o", out], { cwd: join(ROOT, "apps/tray"), stdio: "inherit" });
	tauri(join(tmp, "icon.png"), join(tmp, "all"));
	tauri(join(tmp, "icon-macos.png"), join(tmp, "mac"));
	for (const f of ["32x32.png", "64x64.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico", "StoreLogo.png", ...[30, 44, 71, 89, 107, 142, 150, 284, 310].map((n) => `Square${n}x${n}Logo.png`)]) copyFileSync(join(tmp, "all", f), join(TAURI, f));
	copyFileSync(join(tmp, "mac", "icon.icns"), join(TAURI, "icon.icns"));
	copyFileSync(join(tmp, "all", "icon.ico"), join(WEB, "favicon.ico"));
	// 托盘：彩色（Windows/Linux）+ macOS 菜单栏模板图（纯黑 + 透明，系统自动适配深浅色）
	await png("tray.svg", 64, join(TAURI, "tray.png"));
	await png("tray-template.svg", 44, join(TAURI, "tray-template.png"));
	await png("tray-template.svg", 88, join(TAURI, "tray-template@2x.png"));
} finally {
	await browser.close();
	rmSync(tmp, { recursive: true, force: true });
}
console.log("图标已生成");
