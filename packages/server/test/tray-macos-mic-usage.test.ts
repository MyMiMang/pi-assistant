/**
 * 发布前的 macOS 平台静态核查（纯 fixture：只读源码 / 配置文件，不起服务、不打包、不碰系统权限）。
 *
 * 为什么需要它：
 *  1) 语音输入在**应用内**（Tauri 的 WKWebView，页面来自本机 8787）走 `getUserMedia`。macOS 要求
 *     bundle 的 `Info.plist` 里有 `NSMicrophoneUsageDescription`，否则系统会在请求麦克风时**直接终止进程**。
 *     Tauri 会自动合并与 `tauri.conf.json` **同目录**的 `Info.plist`，所以这里断言这个文件真的在位、内容合法。
 *  2) 采集用 `audioWorklet.addModule(blob:)`、PDF 预览用 `<object data="blob:">`，而服务端给的 CSP 只放行
 *     同源脚本。CSP 少写 `blob:` 时功能会静默失效（真实浏览器实测：worklet 报 AbortError、PDF 被 frame-src 拦），
 *     所以这里把必需的指令固定下来（真浏览器行为另见 `e2e/voice-csp-audioworklet.mjs`）。
 *
 * 边界：不做代码签名 / 不改系统权限；`tauri build` 与安装包真机不在本测试范围（无 Rust 工具链，未跑）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(p, "utf8");
const TAURI_DIR = join(ROOT, "apps/tray/src-tauri");
/** Tauri 默认在这个位置找要合并的 Info.plist（与 tauri.conf.json 同目录）。 */
const AUTO_PLIST = join(TAURI_DIR, "Info.plist");

/** 极简 plist 解析：只认 `<key>` + `<string>/<true/>/<false/>`（够用且不引依赖）。 */
function parsePlistKeys(xml: string): Map<string, string> {
	const out = new Map<string, string>();
	const re = /<key>([^<]+)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|<(true|false)\s*\/>)/g;
	for (const m of xml.matchAll(re)) out.set(m[1].trim(), (m[2] ?? m[3] ?? "").trim());
	return out;
}

test("macOS：Tauri 会合并的 Info.plist 存在、合法，且带麦克风用途说明", () => {
	assert.ok(existsSync(join(TAURI_DIR, "tauri.conf.json")), "tauri.conf.json 必须在 apps/tray/src-tauri");
	assert.ok(existsSync(AUTO_PLIST), "apps/tray/src-tauri/Info.plist 必须存在（Tauri 与 tauri.conf.json 同目录自动合并）");
	const xml = read(AUTO_PLIST);
	assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, "Info.plist 必须是 XML plist");
	assert.match(xml, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"/, "Info.plist 必须声明 Apple plist DTD");
	assert.match(xml, /<plist version="1\.0">/, "Info.plist 必须有 plist 版本");
	const keys = parsePlistKeys(xml);
	assert.ok(keys.has("NSMicrophoneUsageDescription"), "缺 NSMicrophoneUsageDescription：请求麦克风时 macOS 会终止进程");
	const usage = keys.get("NSMicrophoneUsageDescription") ?? "";
	assert.ok(usage.length >= 10, "用途说明不能为空");
	assert.match(usage, /麦克风/, "用途说明要讲清是麦克风");
	assert.match(usage, /语音|录音/, "用途说明要讲清是语音输入 / 录音");
	assert.match(usage, /不.*(录音|录制)|主动/, "用途说明要说明只有用户主动点按才录音（不给系统权限承诺）");
	assert.equal(keys.has("NSCameraUsageDescription"), false, "没用摄像头就不声明摄像头用途（保持最小）");
});

test("macOS：Info.plist 路径与 tauri.conf.json 的配置一致（不会被静默忽略）", () => {
	const conf = JSON.parse(read(join(TAURI_DIR, "tauri.conf.json"))) as {
		bundle?: { active?: boolean; macOS?: { minimumSystemVersion?: string; infoPlist?: string; entitlements?: string } };
	};
	assert.equal(conf.bundle?.active, true, "bundle.active 必须是 true，否则不出安装包");
	assert.ok(conf.bundle?.macOS?.minimumSystemVersion, "macOS 最低系统版本要显式声明（不能靠默认 10.13）");
	const declared = conf.bundle?.macOS?.infoPlist;
	if (declared) {
		assert.ok(existsSync(resolve(TAURI_DIR, declared)), `tauri.conf.json 指定的 infoPlist 不存在：${declared}`);
		assert.equal(resolve(TAURI_DIR, declared), AUTO_PLIST, "声明了 infoPlist 就必须指向同一个文件，避免两份用途说明分叉");
	}
	// 现状：没有 entitlements（未开 App Sandbox、没有走 codesign --options runtime 的签名步骤），
	// 因此不需要 `com.apple.security.device.audio-input`；哪天加上签名步骤（见 docs/beta18-macos-signing-tcc-report.md §4）
	// 就必须同时把这条 entitlement 加到同一个文件里，否则 hardened runtime 会挡麦克风。
	const ent = conf.bundle?.macOS?.entitlements;
	if (ent) {
		const p = resolve(TAURI_DIR, ent);
		assert.ok(existsSync(p), `声明了 entitlements 但文件不存在：${ent}`);
		assert.match(read(p), /com\.apple\.security\.device\.audio-input/, "开了签名 / hardened runtime 就必须声明 audio-input entitlement");
	}
});

test("CSP：语音 worklet 与 PDF 预览需要的 blob: 在位，且没放开 inline / 远程脚本", () => {
	const http = read(join(ROOT, "packages/server/src/http.ts"));
	const cspMatch = /"(default-src 'self'[^"]*)"/.exec(http);
	assert.ok(cspMatch, "http.ts 里必须能找到 CSP 字符串");
	const csp = cspMatch[1];
	const dir = (name: string) => new RegExp(`${name}[^;]*`).exec(csp)?.[0] ?? "";
	assert.ok(dir("script-src").includes("blob:"), "script-src 必须放行 blob:（AudioWorklet 的 blob 模块按 script-src 判定）");
	assert.equal(dir("script-src").includes("'unsafe-inline'"), false, "script-src 不能放开 inline 脚本（首屏主题走同源外部 theme-boot.js）");
	assert.ok(dir("object-src").includes("blob:"), "object-src 必须放行 blob:（PDF 预览用 <object data=blob:>）");
	assert.ok(dir("frame-src").includes("blob:"), "frame-src 必须放行 blob:（Chromium 内置 PDF 查看器要套一层 frame）");
	assert.ok(dir("img-src").includes("blob:"), "img-src 必须放行 blob:（文件预览 / 主题素材预览）");
	assert.ok(dir("style-src").includes("'unsafe-inline'"), "style-src 必须放行 inline（DIY 主题 token 注入）");
	assert.equal(/script-src[^;]*https?:/.test(csp), false, "script-src 不能放行远程脚本");
	assert.ok(csp.includes("frame-ancestors 'none'"), "frame-ancestors 'none' 不能被去掉");
	// 页面里不能有 inline 脚本（CSP 只有 'self' + blob:）
	const html = read(join(ROOT, "apps/web/index.html"));
	const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((s) => s[0]);
	assert.ok(scripts.length > 0, "index.html 要有脚本");
	for (const s of scripts) assert.match(s, /\bsrc=/, `inline 脚本会被 CSP 拦掉：${s}`);
	assert.ok(html.includes("/theme-boot.js"), "首屏主题预置必须走同源外部文件 /theme-boot.js");
	assert.ok(existsSync(join(ROOT, "apps/web/public/theme-boot.js")), "theme-boot.js 必须存在（否则首屏会闪白）");
});
