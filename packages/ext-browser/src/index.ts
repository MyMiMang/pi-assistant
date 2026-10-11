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
import type { BrowserContext, Frame, Locator, Page } from "playwright-core";
import { RISK_FN, SNAPSHOT_FN, type RiskInfo, type SnapshotResult } from "./snapshot.ts";

export const BROWSER_TOOLS = ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_select", "browser_scroll", "browser_press", "browser_tabs", "browser_download", "browser_upload", "browser_handoff"] as const;
/** 审批卡片里显示的地址（data: 等超长地址截短） */
const shortUrl = (u: string) => (u.length > 160 ? `${u.slice(0, 160)}…` : u);
export const isBrowserTool = (name: string) => (BROWSER_TOOLS as readonly string[]).includes(name);

export interface BrowserHost {
	/** 拿到（必要时启动）这个助理的浏览器 */
	context(): Promise<BrowserContext>;
	/** "sandbox" = 助理电脑里有界面的浏览器；"host" = 本机无头浏览器 */
	mode(): "sandbox" | "host";
	workspace: string;
	isPaused(): boolean;
	/** 有后果的动作：等用户批准。返回 scope="task" 表示“本任务内同类动作都允许” */
	request(req: { toolName: string; input: Record<string, unknown>; summary: string; risk: "medium" | "high"; allowTask?: boolean }): Promise<{ approved: boolean; note?: string; scope?: "task" }>;
	/** 请用户接管（扫码 / 验证码 / 登录），推送截图到手机，返回用户的说明 */
	handoff(reason: string, screenshot: Buffer, url: string): Promise<string>;
}

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; details: undefined };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], details: undefined });

/** 当前页：宿主每个上下文里记一个“当前标签页” */
const current = new WeakMap<BrowserContext, Page>();
async function activePage(ctx: BrowserContext): Promise<Page> {
	let p = current.get(ctx);
	if (!p || p.isClosed()) p = ctx.pages().filter((x) => !x.isClosed()).at(-1) ?? (await ctx.newPage());
	current.set(ctx, p);
	return p;
}
function watchPages(ctx: BrowserContext) {
	if ((ctx as unknown as { __piaWatch?: boolean }).__piaWatch) return;
	(ctx as unknown as { __piaWatch?: boolean }).__piaWatch = true;
	// 点链接弹出的新标签页自动成为当前页
	ctx.on("page", (p) => current.set(ctx, p));
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

export async function snapshot(page: Page, opts: { maxItems?: number; withScreenshot?: boolean } = {}): Promise<{ text: string; png?: Buffer }> {
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
		const page = async () => {
			const ctx = await host.context();
			watchPages(ctx);
			return activePage(ctx);
		};
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

		const tool = (def: { name: string; label: string; description: string; parameters: ReturnType<typeof Type.Object>; readOnly?: boolean; run: (p: Record<string, unknown>) => Promise<ToolResult> }) =>
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
						return await def.run(params);
					} catch (e) {
						return text(`失败：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
					}
				},
			} as never);

		tool({
			name: "browser_navigate",
			label: "打开网页",
			description: "在助理的浏览器里打开网址（或 back / forward / reload）。返回页面大纲（带编号）。登录状态长期保留。",
			parameters: Type.Object({ url: Type.String({ description: "完整网址，或 back / forward / reload" }) }),
			async run({ url }) {
				const p = await page();
				const u = String(url).trim();
				if (u === "back") await p.goBack({ timeout: 30_000 });
				else if (u === "forward") await p.goForward({ timeout: 30_000 });
				else if (u === "reload") await p.reload({ timeout: 30_000 });
				else await p.goto(/^[a-z]+:/i.test(u) ? u : `https://${u}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
				return withSnap(p, "已打开。");
			},
		});
		tool({
			name: "browser_snapshot",
			label: "查看网页",
			description: "查看当前网页：可访问性大纲（可交互元素带 [ref=e12] 编号，供点击/输入使用）+ 截图。页面变化后编号会更新，操作前请用最新的。",
			parameters: Type.Object({ screenshot: Type.Optional(Type.Boolean({ description: "是否附截图，默认是" })) }),
			readOnly: true,
			async run({ screenshot }) {
				const p = await page();
				const s = await snapshot(p, { withScreenshot: screenshot !== false });
				return { content: [{ type: "text", text: s.text }, ...(s.png ? [{ type: "image" as const, data: s.png.toString("base64"), mimeType: "image/png" }] : [])], details: undefined };
			},
		});
		tool({
			name: "browser_click",
			label: "点击",
			description: "点击页面元素（用 browser_snapshot 给出的编号）。提交表单、付款、下单、发送等按钮会先请用户批准。",
			parameters: Type.Object({ ref: Type.String(), double: Type.Optional(Type.Boolean()) }),
			async run({ ref, double }) {
				const p = await page();
				const loc = locate(p, String(ref));
				const r = await riskOf(loc);
				if (r.risky) await gate(r.label, `在网页「${(await p.title().catch(() => "")) || p.url()}」点击「${r.text || ref}」（${r.label}）`, { url: shortUrl(p.url()), 按钮: r.text, ...(r.form ? { 表单: r.form } : {}) });
				if (double) await loc.dblclick({ timeout: 10_000 });
				else await loc.click({ timeout: 10_000 });
				await p.waitForTimeout(300);
				return withSnap(await page(), `已点击 ${ref}。`);
			},
		});
		tool({
			name: "browser_type",
			label: "输入",
			description: "在输入框里输入文字（先清空）。submit=true 时输入后回车提交（会先请用户批准）。不要输入用户没提供的密码；需要登录时用 browser_handoff 请用户自己输入。",
			parameters: Type.Object({ ref: Type.String(), text: Type.String(), submit: Type.Optional(Type.Boolean()) }),
			async run({ ref, text: t, submit }) {
				const p = await page();
				const loc = locate(p, String(ref));
				if (submit) {
					const inForm = await loc.evaluate((el) => !!el.closest("form")).catch(() => false);
					if (inForm) await gate("提交表单", `在网页「${(await p.title().catch(() => "")) || p.url()}」输入后回车提交`, { url: shortUrl(p.url()), 内容: String(t).slice(0, 200) });
				}
				await loc.fill(String(t), { timeout: 10_000 });
				if (submit) await loc.press("Enter");
				await p.waitForTimeout(300);
				return withSnap(await page(), `已输入${submit ? "并提交" : ""}。`);
			},
		});
		tool({
			name: "browser_select",
			label: "选择",
			description: "在下拉框里选择选项（按选项文字或值）；对复选框/单选框传 values=['on'] 勾选、['off'] 取消。",
			parameters: Type.Object({ ref: Type.String(), values: Type.Array(Type.String()) }),
			async run({ ref, values }) {
				const p = await page();
				const loc = locate(p, String(ref));
				const vs = values as string[];
				const kind = await loc.evaluate((el) => (el.tagName === "INPUT" ? (el as HTMLInputElement).type : el.tagName.toLowerCase()));
				if (kind === "checkbox" || kind === "radio") await loc.setChecked(vs[0] !== "off", { timeout: 10_000 });
				else await loc.selectOption(vs.map((v) => ({ label: v })), { timeout: 5000 }).catch(() => loc.selectOption(vs, { timeout: 5000 }));
				return withSnap(p, "已选择。");
			},
		});
		tool({
			name: "browser_scroll",
			label: "滚动",
			description: "滚动页面（direction=down/up）或把某个元素滚到可见处（ref）。",
			parameters: Type.Object({ direction: Type.Optional(Type.Union([Type.Literal("down"), Type.Literal("up")])), ref: Type.Optional(Type.String()) }),
			async run({ direction, ref }) {
				const p = await page();
				if (ref) await locate(p, String(ref)).scrollIntoViewIfNeeded({ timeout: 10_000 });
				else await p.mouse.wheel(0, direction === "up" ? -700 : 700);
				await p.waitForTimeout(300);
				return withSnap(p, "已滚动。");
			},
		});
		tool({
			name: "browser_press",
			label: "按键",
			description: "在当前页面按键，例如 Escape、Tab、ArrowDown、Control+A。按 Enter 提交表单前请改用 browser_type 的 submit。",
			parameters: Type.Object({ key: Type.String() }),
			async run({ key }) {
				const p = await page();
				await p.keyboard.press(String(key));
				await p.waitForTimeout(200);
				return withSnap(p, `已按 ${key}。`);
			},
		});
		tool({
			name: "browser_tabs",
			label: "标签页",
			description: "管理标签页：list 列出；new 新开（可带 url）；switch 切换到 index；close 关闭 index（默认当前）。",
			parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("new"), Type.Literal("switch"), Type.Literal("close")]), index: Type.Optional(Type.Number()), url: Type.Optional(Type.String()) }),
			async run({ action, index, url }) {
				const ctx = await host.context();
				watchPages(ctx);
				const cur = await activePage(ctx);
				const pages = () => ctx.pages().filter((x) => !x.isClosed());
				if (action === "new") {
					const p = await ctx.newPage();
					current.set(ctx, p);
					if (url) await p.goto(String(url), { waitUntil: "domcontentloaded", timeout: 45_000 });
				} else if (action === "switch") {
					const p = pages()[Number(index)];
					if (!p) throw new Error(`没有第 ${index} 个标签页`);
					current.set(ctx, p);
					await p.bringToFront().catch(() => {});
				} else if (action === "close") {
					const p = index === undefined ? cur : pages()[Number(index)];
					if (!p) throw new Error(`没有第 ${index} 个标签页`);
					await p.close();
					current.delete(ctx);
				}
				const now = await activePage(ctx);
				const list = await Promise.all(pages().map(async (p, i) => `${p === now ? "→" : " "} [${i}] ${(await p.title().catch(() => "")) || "（无标题）"} — ${p.url()}`));
				return text(`标签页：\n${list.join("\n")}`);
			},
		});
		tool({
			name: "browser_download",
			label: "下载",
			description: "点击下载链接/按钮（ref）或直接给 url，把文件保存到工作区 downloads/ 目录，返回路径（可再用 deliver_file 发给用户）。",
			parameters: Type.Object({ ref: Type.Optional(Type.String()), url: Type.Optional(Type.String()) }),
			async run({ ref, url }) {
				const p = await page();
				const dir = join(host.workspace, "downloads");
				mkdirSync(dir, { recursive: true });
				const wait = p.waitForEvent("download", { timeout: 60_000 });
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
			name: "browser_upload",
			label: "上传文件",
			description: "把工作区里的文件填到网页的文件选择框（ref 指向 file 输入框或会弹出文件选择的按钮）。上传会先请用户批准。",
			parameters: Type.Object({ ref: Type.String(), paths: Type.Array(Type.String({ description: "工作区内的相对路径" })) }),
			async run({ ref, paths }) {
				const p = await page();
				const files = (paths as string[]).map((x) => insideWorkspace(host.workspace, x));
				await gate("上传文件", `把 ${files.map((f) => relative(host.workspace, f)).join("、")} 上传到「${(await p.title().catch(() => "")) || p.url()}」`, { url: shortUrl(p.url()), 文件: files.map((f) => relative(host.workspace, f)) }, "medium");
				const loc = locate(p, String(ref));
				const isFile = await loc.evaluate((el) => el.tagName === "INPUT" && (el as HTMLInputElement).type === "file").catch(() => false);
				if (isFile) await loc.setInputFiles(files, { timeout: 10_000 });
				else {
					const chooser = p.waitForEvent("filechooser", { timeout: 10_000 });
					await loc.click({ timeout: 10_000 });
					await (await chooser).setFiles(files);
				}
				return withSnap(p, `已选择 ${files.length} 个文件。`);
			},
		});
		tool({
			name: "browser_handoff",
			label: "请你接管",
			description: "遇到需要用户本人完成的步骤（登录输入密码、扫码、短信/图形验证码、人机验证、付款确认）时调用：把当前页面推送到用户手机，等用户完成后继续。",
			parameters: Type.Object({ reason: Type.String({ description: "需要用户做什么，例如“请扫码登录淘宝”" }) }),
			readOnly: true,
			async run({ reason }) {
				const p = await page();
				const png = await p.screenshot({ type: "png" });
				const r = await host.handoff(String(reason), png, p.url());
				return withSnap(await page(), `用户接管结果：${r}`);
			},
		});
	};
}
