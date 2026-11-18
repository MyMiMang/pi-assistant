import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import { sameBrowserIdentity, type BrowserIdentity, type BrowserPageInfo } from "@pi-assistant/shared";
import type { BrowserSessionPort } from "@pi-assistant/ext-browser";
import { snapshot } from "@pi-assistant/ext-browser";
import { BrowserInputControl } from "./browser-control.ts";

export interface RegisteredBrowserPage {
	page: Page; agentId: string; identity: BrowserIdentity; isolated: boolean; control: BrowserInputControl;
}
interface ContextRecord { ctx: BrowserContext; id: string; runtimeId: string; isolated: boolean }
interface Lease { identity: BrowserIdentity; controlGeneration: number; pauseGeneration: number; selectionGeneration: number }
/** 一份服务端注册表同时供工具、查看路由使用；永远不以 URL 或标签顺序认页。 */
export class BrowserPages implements BrowserSessionPort {
	private contexts = new Map<BrowserContext, ContextRecord>();
	private owned = new Map<string, RegisteredBrowserPage>();
	private current: string | null = null;
	private selectedByContext = new Map<BrowserContext, string>();
	private isolated: ContextRecord | null = null;
	private activeIsolated = false;
	private defaultContext: ContextRecord | null = null;
	private switching: Promise<void> | null = null;
	private selectionGeneration = 0;
	constructor(readonly agentId: string, private deps: {
		context(): Promise<{ ctx: BrowserContext; runtimeId: string }>;
		isolated(): Promise<BrowserContext>;
		paused(): boolean;
		pauseVersion?(): number;
	}) {}
	private registerContext(ctx: BrowserContext, runtimeId: string, isolated: boolean) {
		let record = this.contexts.get(ctx);
		if (record) return record;
		record = { ctx, runtimeId, isolated, id: randomUUID() };
		this.contexts.set(ctx, record);
		const r = record;
		ctx.on("page", (p) => {
			void p.opener().then((opener) => {
				if (opener && this.find(opener)) this.register(p, r, true);
			}).catch(() => {});
		});
		ctx.on("close", () => {
			this.contexts.delete(ctx);
			for (const [id, page] of this.owned) if (page.page.context() === ctx) this.owned.delete(id);
			if (this.defaultContext === r) this.defaultContext = null;
			if (this.isolated === r) this.isolated = null;
		});
		return record;
	}
	private async activeContext() {
		if (this.activeIsolated && this.isolated) return this.isolated;
		const { ctx, runtimeId } = await this.deps.context();
		return this.defaultContext = this.registerContext(ctx, runtimeId, false);
	}
	async context() { return (await this.activeContext()).ctx; }
	private register(page: Page, ctx: ContextRecord, select: boolean) {
		let r = this.find(page);
		if (!r) {
			r = { page, agentId: this.agentId, isolated: ctx.isolated, identity: { runtimeId: ctx.runtimeId, contextId: ctx.id, pageId: randomUUID(), generation: 1 }, control: new BrowserInputControl(this.deps.paused) };
			this.owned.set(r.identity.pageId, r);
			const ref = r;
			page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) ref.identity.generation++; });
			page.on("close", () => { this.owned.delete(ref.identity.pageId); if (this.current === ref.identity.pageId) this.current = null; });
		}
		if (select) { this.selectionGeneration++; this.current = r.identity.pageId; this.selectedByContext.set(ctx.ctx, r.identity.pageId); }
		return r;
	}
	find(page: Page) { return [...this.owned.values()].find((r) => r.page === page); }
	get(pageId: string) {
		const r = this.owned.get(pageId);
		if (!r || r.page.isClosed()) throw new Error("网页已关闭或不属于这个助理");
		return r;
	}
	selected() { return this.current ? this.owned.get(this.current) : undefined; }
	async page(create = true): Promise<Page> {
		const ctx = await this.activeContext();
		const selectedId = this.selectedByContext.get(ctx.ctx);
		const selected = selectedId ? this.owned.get(selectedId) : undefined;
		if (selected) this.current = selected.identity.pageId;
		if (selected && selected.page.context() === ctx.ctx && !selected.page.isClosed()) return selected.page;
		if (!create) throw new Error("还没有打开网页");
		return this.newPage();
	}
	async pages() {
		const ctx = await this.activeContext();
		return [...this.owned.values()].filter((r) => r.page.context() === ctx.ctx && !r.page.isClosed()).map((r) => r.page);
	}
	async newPage() {
		if (this.switching || this.deps.paused()) throw new Error("浏览器已暂停或环境正在切换");
		const ctx = await this.activeContext();
		const p = await ctx.ctx.newPage(); this.register(p, ctx, true); return p;
	}
	select(page: Page) {
		const r = this.find(page);
		if (!r) throw new Error("网页不属于这个助理");
		if (this.current !== r.identity.pageId) this.selectionGeneration++;
		this.current = r.identity.pageId;
		this.selectedByContext.set(page.context(), r.identity.pageId);
		this.activeIsolated = r.isolated;
	}
	async switchContext(mode: "shared" | "isolated") {
		if (this.switching) throw new Error("浏览器环境正在切换");
		// 环境切换是破坏性操作，不允许绕过任何页的接管屏障。
		for (const r of this.owned.values()) r.control.check("agent", r.control.generation);
		const controls = [...this.owned.values()].map(r => r.control);
		this.switching = (async () => {
			await Promise.all(controls.map(control => control.freeze()));
			if (mode === "isolated") {
				if (!this.isolated) {
					const base = await this.activeContext();
					this.isolated = this.registerContext(await this.deps.isolated(), base.runtimeId, true);
				}
				this.activeIsolated = true;
			} else if (this.isolated) {
				const old = this.isolated; this.isolated = null; this.activeIsolated = false;
				await old.ctx.close();
			}
			this.current = this.selectedByContext.get((await this.activeContext()).ctx) ?? null;
			for (const control of controls) control.thaw();
		})();
		try { await this.switching; } finally { this.switching = null; }
	}
	capture(page: Page): Lease {
		const r = this.find(page);
		if (!r || this.switching) throw new Error("网页归属已变化");
		return { identity: { ...r.identity }, controlGeneration: r.control.generation, pauseGeneration: this.deps.pauseVersion?.() ?? 0, selectionGeneration: this.selectionGeneration };
	}
	check(page: Page, lease: unknown) {
		const r = this.find(page), l = lease as Lease;
		if (this.deps.paused()) throw new Error("浏览器操作已暂停");
		if (!r || this.switching || l.selectionGeneration !== this.selectionGeneration || l.pauseGeneration !== (this.deps.pauseVersion?.() ?? 0) || !sameBrowserIdentity(r.identity, l.identity)) throw new Error("网页已变化，请重新读取；旧操作已取消");
		r.control.check("agent", l.controlGeneration);
	}
	run<T>(page: Page, lease: unknown, action: (check: () => void) => Promise<T>) {
		const l = lease as Lease, r = this.find(page);
		if (!r) throw new Error("网页不属于这个助理");
		return r.control.run("agent", l.controlGeneration, () => this.check(page, l), action);
	}
	async takeover(page: Page, recover = false) {
		if (this.switching) throw new Error("浏览器环境正在切换");
		const r = this.find(page); if (!r) throw new Error("网页不属于这个助理");
		await r.control.takeover(recover, () => snapshot(page, { withScreenshot: false }));
		return r.control.generation;
	}
	async giveBack(page: Page, expectedGeneration?: number) {
		if (this.switching) throw new Error("浏览器环境正在切换");
		const r = this.find(page); if (!r) throw new Error("网页不属于这个助理");
		if (expectedGeneration !== undefined && r.control.generation !== expectedGeneration) throw new Error("这张接管卡片已过期，当前控制权保持不变");
		if (r.control.state !== "agent") await r.control.giveBack(() => snapshot(page, { withScreenshot: false }));
	}
	async info(): Promise<BrowserPageInfo[]> {
		return Promise.all([...this.owned.values()].filter(r => !r.page.isClosed()).map(async (r) => ({ ...r.identity, title: await r.page.title().catch(() => ""), url: r.page.url(), isolated: r.isolated, control: r.control.state, controlGeneration: r.control.generation, error: r.control.error })));
	}
	async dispose() {
		const isolated = this.isolated;
		this.invalidate();
		await isolated?.ctx.close().catch(() => {});
	}
	invalidate() { for (const r of this.owned.values()) r.identity.generation++; this.owned.clear(); this.contexts.clear(); this.selectedByContext.clear(); this.current = null; this.defaultContext = this.isolated = null; this.activeIsolated = false; }
}
