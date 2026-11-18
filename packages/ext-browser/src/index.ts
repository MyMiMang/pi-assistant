/**
 * @pi-assistant/ext-browser —— 助理的浏览器（Pi 扩展）。
 *
 * 浏览器由宿主提供：助理电脑容器里有界面的 Chromium（CDP 连接，「电脑」实时画面里可见、登录态长期保留），
 * 或 Docker 不可用时本机无头 Chromium（每个助理独立的持久化用户目录）。只用 Playwright 公开 API。
 *
 * 审批规则（DESIGN §5.7）：读网页、点链接、填表都不需要审批；提交表单 / 付款 / 下单 / 发送 / 上传文件
 * 这类“对外产生后果”的动作先经宿主 request() 让用户批准（可选“本任务内都允许”）。
 */
import { mkdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Frame, Locator, Page } from "playwright-core";
import type { BrowserSessionPort } from "./session.ts";
export type { BrowserSessionPort } from "./session.ts";
import { IMAGE_INFO_FN, RISK_FN, SNAPSHOT_FN, type RiskInfo, type SnapshotResult } from "./snapshot.ts";

export const BROWSER_TOOLS = ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_select", "browser_scroll", "browser_press", "browser_tabs", "browser_download", "browser_save_image", "browser_upload", "browser_handoff", "browser_context"] as const;
/** 审批卡片里显示的地址（data: 等超长地址截短） */
const shortUrl = (u: string) => (u.length > 160 ? `${u.slice(0, 160)}…` : u);
export const isBrowserTool = (name: string) => (BROWSER_TOOLS as readonly string[]).includes(name);

export interface BrowserHost {
	/** 服务端与工作区共用的明确页身份和串行输入。 */
	session: BrowserSessionPort;
	/** "sandbox" = 助理电脑里有界面的浏览器；"host" = 本机无头浏览器 */
	mode(): "sandbox" | "host";
	workspace: string;
	isPaused(): boolean;
	/** 有后果的动作：等用户批准。返回 scope="task" 表示“本任务内同类动作都允许” */
	request(req: { toolName: string; input: Record<string, unknown>; summary: string; risk: "medium" | "high"; allowTask?: boolean }): Promise<{ approved: boolean; note?: string; scope?: "task" }>;
	/** 请用户接管（扫码 / 验证码 / 登录），推送截图到手机，返回用户的说明 */
	handoff(reason: string, screenshot: Buffer, url: string): Promise<string>;
	/**
	 * 共用浏览器（多个助理连同一个 Chromium、共用登录状态）：每个助理只看得到、只操作自己打开的标签页
	 * （自己新开的 + 从自己的页面弹出来的），不会去动别的助理正在用的页面。
	 */
	shared?: boolean;

}

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; details: undefined };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], details: undefined });

interface Operation {
	page(): Promise<Page>;
	input<T>(p: Page, action: (check: () => void) => Promise<T>): Promise<T>;
}

/** 编号 → 定位器。编号形如 e12（主页面）或 f2e5（第 2 个子框架） */
function locate(page: Page, ref: string): Locator {
	const m = /^(?:f(\d+))?e\d+$/.exec(ref.trim());
	if (!m) throw new Error(`编号格式不对：${ref}（应为 browser_snapshot 给出的 e12 / f1e3 这样的编号）`);
	const frames = page.frames();
	const frame: Frame = m[1] ? frames[Number(m[1])] : page.mainFrame();
	if (!frame) throw new Error(`找不到编号 ${ref} 所在的框架，请重新 browser_snapshot`);
	return frame.locator(`[data-pia-ref="${ref.trim()}"]`).first();
}

const referenceGeneration = new WeakMap<Page, number>();
export async function snapshot(page: Page, opts: { maxItems?: number; withScreenshot?: boolean } = {}): Promise<{ text: string; png?: Buffer }> {
	referenceGeneration.set(page, (referenceGeneration.get(page) ?? 0) + 1);
	const parts: string[] = [];
	const frames = page.frames();
	let budget = opts.maxItems ?? 400;
	for (let i = 0; i < frames.length && budget > 0; i++) {
		const f = frames[i];
		if (i > 0 && (f.isDetached() || !f.url() || f.url() === "about:blank")) continue;
		try {
			const r = await f.evaluate(SNAPSHOT_FN, { prefix: i === 0 ? "" : `f${i}`, maxItems: budget });
			budget -= r.count;
			if (!r.lines.length) continue;
			parts.push(i === 0 ? r.lines.join("\n") : `\n### 子框架 f${i}：${f.url().slice(0, 100)}\n${r.lines.join("\n")}`);
			if (r.truncated) parts.push("…（页面元素太多，只列出前一部分；可以先 browser_scroll 再 browser_snapshot）");
		} catch {
			/* 跨域或已销毁的框架 */
		}
	}
	let body = parts.join("\n");
	if (body.length > 16_000) body = `${body.slice(0, 16_000)}\n…（大纲过长已截断）`;
	const head = `页面：${await page.title().catch(() => "")}\n地址：${page.url()}\n`;
	const png = opts.withScreenshot === false ? undefined : await page.screenshot({ type: "png", timeout: 10_000 }).catch(() => undefined);
	return { text: `${head}\n${body || "（页面上没有可识别的内容）"}`, png };
}

/**
 * 点击：先正常点（Playwright 的可操作性检查）；超时/被遮挡时依次退到
 * 滚动到可见处再点 → 强制点击（跳过遮挡检查）→ 按坐标点击 → 直接触发元素的 click()。
 * 返回实际用的方式（正常点击返回空串）。
 */
export async function robustClick(p: Page, loc: Locator, double = false, check = () => {}): Promise<string> {
	const first = async (o: { timeout: number; force?: boolean }) => { check(); return double ? loc.dblclick(o) : loc.click(o); };
	let why = "";
	try {
		await first({ timeout: 5000 });
		return "";
	} catch (e) {
		why = e instanceof Error ? (e.message.match(/intercepts pointer events|not visible|not stable|outside of the viewport|detached|Timeout \d+ms exceeded/)?.[0] ?? e.message.split("\n")[0]) : String(e);
		if (/detached/.test(why) || !(await loc.count().catch(() => 0))) throw new Error(`元素已不在页面上（${why}），请重新 browser_snapshot`);
	}
	check();
	await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
	try {
		await first({ timeout: 3000, force: true });
		return `正常点击失败（${why}），已滚动到可见处并强制点击`;
	} catch {
		/* 下一种 */
	}
	const box = await loc.boundingBox({ timeout: 2000 }).catch(() => null);
	if (box && box.width > 0 && box.height > 0) {
		check();
		await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: double ? 2 : 1 });
		return `正常点击失败（${why}），已按坐标点击元素中心`;
	}
	check();
	await loc.evaluate((el) => (el as HTMLElement).click(), undefined, { timeout: 3000 });
	return `正常点击失败（${why}），已直接触发元素的点击事件`;
}

const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp", "image/avif": ".avif" };

function insideWorkspace(ws: string, p: string) {
	const abs = isAbsolute(p) ? p : resolve(ws, p);
	const rel = relative(ws, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`只能使用工作区里的文件：${p}`);
	return abs;
}

export function browserExtension(host: BrowserHost) {
	return (pi: ExtensionAPI) => {
		/** 本任务内已批准的同类动作（选了“本任务内都允许”） */
		const granted = new Set<string>();
		const session = host.session;
		const withSnap = async (p: Page, msg: string): Promise<ToolResult> => {
			await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
			const s = await snapshot(p, { withScreenshot: false });
			return text(`${msg}\n\n${s.text}`);
		};
		/** 有后果的动作：先问用户 */
		const gate = async (kind: string, summary: string, input: Record<string, unknown>, risk: "medium" | "high" = "high") => {
			if (granted.has(kind)) return;
			const res = await host.request({ toolName: `browser:${kind}`, input, summary, risk, allowTask: true });
			if (!res.approved) throw new Error(`用户拒绝了：${summary}${res.note ? `（${res.note}）` : ""}。不要换方式重试，告诉用户你停在了哪一步。`);
			if (res.scope === "task") granted.add(kind);
		};
		const riskOf = async (loc: Locator) => (await loc.evaluate(RISK_FN).catch(() => ({ risky: false, label: "", text: "" }))) as RiskInfo;

		const tool = (def: { name: string; label: string; description: string; parameters: ReturnType<typeof Type.Object>; readOnly?: boolean; run: (p: Record<string, unknown>, op: Operation) => Promise<ToolResult> }) =>
			pi.registerTool({
				name: def.name,
				label: def.label,
				description: def.description,
				promptSnippet: `${def.name}: ${def.label}`,
				parameters: def.parameters,
				annotations: { readOnlyHint: !!def.readOnly },
				async execute(_id: string, params: Record<string, unknown>) {
					if (host.isPaused()) return text("用户已暂停“操作电脑”。停止所有浏览器操作，告诉用户你停在了哪一步。");
					try {
						const leases = new Map<Page, { lease: unknown; refs: number }>();
						const op: Operation = {
							page: async () => { const p = await session.page(); if (!leases.has(p)) leases.set(p, { lease: session.capture(p), refs: referenceGeneration.get(p) ?? 0 }); return p; },
							input: (p, action) => {
								if (!leases.has(p)) leases.set(p, { lease: session.capture(p), refs: referenceGeneration.get(p) ?? 0 });
								const captured = leases.get(p)!;
								return session.run(p, captured.lease, async check => {
									const validate = () => { check(); if (captured.refs !== (referenceGeneration.get(p) ?? 0)) throw new Error("页面大纲已更新，旧元素编号失效，请重新读取；不要重放原操作"); };
									validate(); return action(validate);
								});
							},
						};
						return await def.run(params, op);
					} catch (e) {
						return text(`失败：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
					}
				},
			} as never);

		tool({
			name: "browser_navigate",
			label: "打开网页",
			description: "在助理自己的浏览器里打开网址（或 back / forward / reload）。返回页面大纲（带编号）。登录状态长期保留。注意：这是助理的浏览器，不是用户电脑上的浏览器——用户说“用我电脑的浏览器”时要用 mcp__hostpc__ 用户电脑工具。",
			parameters: Type.Object({ url: Type.String({ description: "完整网址，或 back / forward / reload" }) }),
			async run({ url }, op) {
				const p = await op.page();
				const u = String(url).trim();
				await op.input(p, async () => {
					if (u === "back") await p.goBack({ timeout: 30_000 });
					else if (u === "forward") await p.goForward({ timeout: 30_000 });
					else if (u === "reload") await p.reload({ timeout: 30_000 });
					else await p.goto(/^[a-z]+:/i.test(u) ? u : `https://${u}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
				});
				return withSnap(p, "已打开。");
			},
		});
		tool({
			name: "browser_snapshot",
			label: "查看网页",
			description: "查看当前网页：可访问性大纲（可交互元素带 [ref=e12] 编号，供点击/输入使用）+ 截图。页面变化后编号会更新，操作前请用最新的。",
			parameters: Type.Object({ screenshot: Type.Optional(Type.Boolean({ description: "是否附截图，默认是" })) }),
			readOnly: true,
			async run({ screenshot }, op) {
				const p = await op.page();
				const s = await snapshot(p, { withScreenshot: screenshot !== false });
				return { content: [{ type: "text", text: s.text }, ...(s.png ? [{ type: "image" as const, data: s.png.toString("base64"), mimeType: "image/png" }] : [])], details: undefined };
			},
		});
		tool({
			name: "browser_click",
			label: "点击",
			description: "点击页面元素（用 browser_snapshot 给出的编号）。提交表单、付款、下单、发送等按钮会先请用户批准。",
			parameters: Type.Object({ ref: Type.String(), double: Type.Optional(Type.Boolean()) }),
			async run({ ref, double }, op) {
				const p = await op.page();
				const loc = locate(p, String(ref));
				const r = await riskOf(loc);
				if (r.risky) await gate(r.label, `在网页「${(await p.title().catch(() => "")) || p.url()}」点击「${r.text || ref}」（${r.label}）`, { url: shortUrl(p.url()), 按钮: r.text, ...(r.form ? { 表单: r.form } : {}) });
				const how = await op.input(p, async (check) => {
					if (r.risky) { check(); await (double ? loc.dblclick({ timeout: 5000 }) : loc.click({ timeout: 5000 })); return ""; }
					return robustClick(p, loc, !!double, check);
				});
				await p.waitForTimeout(300);
				return withSnap(await session.page(), `已点击 ${ref}。${how ? `（${how}）` : ""}`);
			},
		});
		tool({
			name: "browser_type",
			label: "输入",
			description: "在输入框里输入文字（先清空）。submit=true 时输入后回车提交（会先请用户批准）。不要输入用户没提供的密码；需要登录时用 browser_handoff 请用户自己输入。",
			parameters: Type.Object({ ref: Type.String(), text: Type.String(), submit: Type.Optional(Type.Boolean()) }),
			async run({ ref, text: t, submit }, op) {
				const p = await op.page();
				const loc = locate(p, String(ref));
				if (submit) {
					const inForm = await loc.evaluate((el) => !!el.closest("form")).catch(() => false);
					if (inForm) await gate("提交表单", `在网页「${(await p.title().catch(() => "")) || p.url()}」输入后回车提交`, { url: shortUrl(p.url()), 内容: String(t).slice(0, 200) });
				}
				await op.input(p, async (check) => {
					await loc.fill(String(t), { timeout: 10_000 });
					if (submit) { check(); await loc.press("Enter"); }
				});
				await p.waitForTimeout(300);
				return withSnap(await session.page(), `已输入${submit ? "并提交" : ""}。`);
			},
		});
		tool({
			name: "browser_select",
			label: "选择",
			description: "在下拉框里选择选项（按选项文字或值）；对复选框/单选框传 values=['on'] 勾选、['off'] 取消。",
			parameters: Type.Object({ ref: Type.String(), values: Type.Array(Type.String()) }),
			async run({ ref, values }, op) {
				const p = await op.page();
				const loc = locate(p, String(ref));
				const vs = values as string[];
				const kind = await loc.evaluate((el) => (el.tagName === "INPUT" ? (el as HTMLInputElement).type : el.tagName.toLowerCase()));
				await op.input(p, async (check) => {
					if (kind === "checkbox" || kind === "radio") await loc.setChecked(vs[0] !== "off", { timeout: 10_000 });
					else await loc.selectOption(vs.map((v) => ({ label: v })), { timeout: 5000 }).catch(() => { check(); return loc.selectOption(vs, { timeout: 5000 }); });
				});
				return withSnap(p, "已选择。");
			},
		});
		tool({
			name: "browser_scroll",
			label: "滚动",
			description: "滚动页面（direction=down/up）或把某个元素滚到可见处（ref）。",
			parameters: Type.Object({ direction: Type.Optional(Type.Union([Type.Literal("down"), Type.Literal("up")])), ref: Type.Optional(Type.String()) }),
			async run({ direction, ref }, op) {
				const p = await op.page();
				await op.input(p, async () => {
					if (ref) await locate(p, String(ref)).scrollIntoViewIfNeeded({ timeout: 10_000 });
					else await p.mouse.wheel(0, direction === "up" ? -700 : 700);
				});
				await p.waitForTimeout(300);
				return withSnap(p, "已滚动。");
			},
		});
		tool({
			name: "browser_press",
			label: "按键",
			description: "在当前页面按键，例如 Escape、Tab、ArrowDown、Control+A。按 Enter 提交表单前请改用 browser_type 的 submit。",
			parameters: Type.Object({ key: Type.String() }),
			async run({ key }, op) {
				const p = await op.page();
				await op.input(p, () => p.keyboard.press(String(key)));
				await p.waitForTimeout(200);
				return withSnap(p, `已按 ${key}。`);
			},
		});
		tool({
			name: "browser_tabs",
			label: "标签页",
			description: "管理标签页：list 列出；new 新开（可带 url）；switch 切换到 index；close 关闭 index（默认当前）。",
			parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("new"), Type.Literal("switch"), Type.Literal("close")]), index: Type.Optional(Type.Number()), url: Type.Optional(Type.String()) }),
			async run({ action, index, url }, op) {
				const cur = await op.page();
				const pages = () => session.pages();
				if (action === "new") {
					const p = await op.input(cur, () => session.newPage());
					if (url) await op.input(p, () => p.goto(String(url), { waitUntil: "domcontentloaded", timeout: 45_000 }));
				} else if (action === "switch") {
					const p = (await pages())[Number(index)];
					if (!p) throw new Error(`没有第 ${index} 个标签页`);
					const targetLease = session.capture(p);
					await op.input(cur, async () => { session.check(p, targetLease); session.select(p); });
				} else if (action === "close") {
					const p = index === undefined ? cur : (await pages())[Number(index)];
					if (!p) throw new Error(`没有第 ${index} 个标签页`);
					await op.input(p, () => p.close());
				}
				const now = await session.page();
				const list = await Promise.all((await pages()).map(async (p, i) => `${p === now ? "→" : " "} [${i}] ${(await p.title().catch(() => "")) || "（无标题）"} — ${p.url()}`));
				return text(`标签页：\n${list.join("\n")}`);
			},
		});
		tool({
			name: "browser_download",
			label: "下载",
			description: "点击下载链接/按钮（ref）或直接给 url，把文件保存到工作区 downloads/ 目录，返回路径（可再用 deliver_file 发给用户）。",
			parameters: Type.Object({ ref: Type.Optional(Type.String()), url: Type.Optional(Type.String()) }),
			async run({ ref, url }, op) {
				const p = await op.page();
				const dir = join(host.workspace, "downloads");
				mkdirSync(dir, { recursive: true });
				const wait = p.waitForEvent("download", { timeout: 60_000 });
				void wait.catch(() => {}); // 输入被接管/暂停拒绝时，不让未触发的监听产生未处理拒绝。
				await op.input(p, async () => {
				if (ref) await locate(p, String(ref)).click({ timeout: 10_000 });
				else if (url) await p.evaluate((u) => {
					const a = document.createElement("a");
					a.href = u;
					a.download = "";
					document.body.appendChild(a);
					a.click();
					a.remove();
				}, String(url));
				else throw new Error("需要 ref 或 url");
				});
				const d = await wait;
				const name = basename(d.suggestedFilename() || "download").replace(/[\\/:*?"<>|]/g, "_");
				let target = join(dir, name);
				for (let i = 1; await import("node:fs").then((fs) => fs.existsSync(target)); i++) target = join(dir, name.replace(/(\.[^.]*)?$/, `-${i}$1`));
				await d.saveAs(target);
				const fail = await d.failure();
				if (fail) throw new Error(`下载失败：${fail}`);
				return text(`已下载到工作区：${relative(host.workspace, target)}`);
			},
		});
		tool({
			name: "browser_save_image",
			label: "保存图片",
			description:
				"把当前网页上的图片保存到工作区 images/ 目录（用浏览器自己的登录状态和来源页下载，不会被防盗链挡住）。ref 是 browser_snapshot 里的 img（或包着图片的链接）编号；也可以直接给图片 url。full=true（默认）时尽量取原图（如必应图片结果里的原图地址），取不到就存缩略图，再不行就截取该元素。保存后用 look_at_image 确认内容，再 deliver_file 发给用户。",
			parameters: Type.Object({ ref: Type.Optional(Type.String()), url: Type.Optional(Type.String()), full: Type.Optional(Type.Boolean()), name: Type.Optional(Type.String({ description: "文件名（不含扩展名）" })) }),
			async run({ ref, url, full, name }, op) {
				const p = await op.page();
				const dir = join(host.workspace, "images");
				mkdirSync(dir, { recursive: true });
				const loc = ref ? locate(p, String(ref)) : null;
				const info = loc ? await loc.evaluate(IMAGE_INFO_FN).catch(() => null) : null;
				const cands = [...new Set([url ? String(url) : "", full !== false ? (info?.full ?? "") : "", info?.src ?? ""].filter((u) => u && !u.startsWith("blob:")))];
				const fs = await import("node:fs");
				const base = (String(name ?? "") || `image-${Date.now().toString(36)}`).replace(/[\\/:*?"<>|.]/g, "_").slice(0, 80);
				const unique = (ext: string) => {
					let t = join(dir, `${base}${ext}`);
					for (let i = 1; fs.existsSync(t); i++) t = join(dir, `${base}-${i}${ext}`);
					return t;
				};
				const errs: string[] = [];
				for (const u of cands) {
					try {
						let buf: Buffer;
						let type: string;
						if (u.startsWith("data:")) {
							const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(u);
							if (!m) throw new Error("data 地址格式不对");
							type = m[1];
							buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
						} else {
							const r = await p.context().request.get(new URL(u, p.url()).href, { headers: { Referer: p.url() }, timeout: 30_000, maxRedirects: 5 });
							if (!r.ok()) throw new Error(`HTTP ${r.status()}`);
							type = (r.headers()["content-type"] ?? "").split(";")[0].trim();
							buf = await r.body();
						}
						if (!type.startsWith("image/")) throw new Error(`不是图片（${type || "未知类型"}）`);
						if (buf.length < 200) throw new Error("文件太小，可能是占位图");
						const target = unique(EXT[type] ?? ".img");
						fs.writeFileSync(target, buf);
						const kind = u === info?.full && u !== info?.src ? "原图" : u === info?.src ? "页面上的图片（可能是缩略图）" : "图片";
						return text(`已保存${kind}到工作区：${relative(host.workspace, target)}（${Math.round(buf.length / 1024)} KB${info?.alt ? `，alt="${info.alt.slice(0, 80)}"` : ""}）\n来源：${shortUrl(u)}\n发给用户前先用 look_at_image 确认内容。`);
					} catch (e) {
						errs.push(`${shortUrl(u)}：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
					}
				}
				if (loc) {
					const target = unique(".png");
					await op.input(p, async (check) => {
						await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
						check(); await loc.screenshot({ path: target, timeout: 10_000 });
					});
					return text(`下载图片失败${errs.length ? `（${errs.join("；")}）` : ""}，已截取该元素保存到工作区：${relative(host.workspace, target)}\n发给用户前先用 look_at_image 确认内容。`);
				}
				throw new Error(errs.length ? `保存失败：${errs.join("；")}` : "需要 ref 或 url");
			},
		});
		tool({
			name: "browser_upload",
			label: "上传文件",
			description: "把工作区里的文件填到网页的文件选择框（ref 指向 file 输入框或会弹出文件选择的按钮）。上传会先请用户批准。",
			parameters: Type.Object({ ref: Type.String(), paths: Type.Array(Type.String({ description: "工作区内的相对路径" })) }),
			async run({ ref, paths }, op) {
				const p = await op.page();
				const files = (paths as string[]).map((x) => insideWorkspace(host.workspace, x));
				await gate("上传文件", `把 ${files.map((f) => relative(host.workspace, f)).join("、")} 上传到「${(await p.title().catch(() => "")) || p.url()}」`, { url: shortUrl(p.url()), 文件: files.map((f) => relative(host.workspace, f)) }, "medium");
				const loc = locate(p, String(ref));
				const isFile = await loc.evaluate((el) => el.tagName === "INPUT" && (el as HTMLInputElement).type === "file").catch(() => false);
				await op.input(p, async (check) => {
					if (isFile) await loc.setInputFiles(files, { timeout: 10_000 });
					else {
						const chooser = p.waitForEvent("filechooser", { timeout: 10_000 });
						await loc.click({ timeout: 10_000 });
						const opened = await chooser; check(); await opened.setFiles(files);
					}
				});
				return withSnap(p, `已选择 ${files.length} 个文件。`);
			},
		});
		tool({
				name: "browser_context",
				label: "浏览器环境",
				description:
					"切换浏览器环境。shared（默认）：和其他助理共用的浏览器，带着已经登录的账号和 cookie。isolated：单独的浏览器环境，不带任何登录状态，关掉（切回 shared）就清空——" +
					"需要在同一个网站登录另一个账号、或者不想动到已登录账号（试用、测试、可疑网站）时用；切换时告诉用户。要长期分开保存另一套登录状态，请用户给你开“单独的电脑”。",
				parameters: Type.Object({ mode: Type.Union([Type.Literal("shared"), Type.Literal("isolated")]) }),
				readOnly: true,
				async run({ mode }) {
					await session.switchContext(mode as "shared" | "isolated");
					if (mode === "isolated") {
						return text("已切换到单独的浏览器环境（不带共用的登录状态）。后面的 browser_* 操作都在这里进行；用完用 browser_context shared 切回，这个环境会被清空。");
					}
					return text("已切回共用的浏览器（带着已登录的账号）。");
				},
			});
		tool({
			name: "browser_handoff",
			label: "请你接管",
			description: "遇到需要用户本人完成的步骤（登录输入密码、扫码、短信/图形验证码、人机验证、付款确认）时调用：把当前页面推送到用户手机，等用户完成后继续。",
			parameters: Type.Object({ reason: Type.String({ description: "需要用户做什么，例如“请扫码登录淘宝”" }) }),
			readOnly: true,
			async run({ reason }, op) {
				const p = await op.page();
				const takeoverGeneration = await session.takeover(p);
				const png = await p.screenshot({ type: "png" });
				const r = await host.handoff(String(reason), png, p.url());
				// 用户明确回答完成后，仍须重读同一页才能交还；失败保持锁定。
				if (r === "已完成") await session.giveBack(p, takeoverGeneration);
				return withSnap(p, `用户接管结果：${r}`);
			},
		});
	};
}
