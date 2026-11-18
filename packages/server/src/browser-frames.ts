import { randomUUID } from "node:crypto";
import type { CDPSession } from "playwright-core";
import { sameBrowserIdentity, type BrowserFrame, type BrowserIdentity } from "@pi-assistant/shared";
import type { RegisteredBrowserPage } from "./browser-pages.ts";

interface Viewer { send(frame: BrowserFrame): void; waiting?: BrowserFrame; drawn?: BrowserFrame; pending?: BrowserFrame }
/** 每个 Page 一个 CDP 流；浏览器 ACK 立即释放，慢查看者仅保留最新帧。 */
export class BrowserFrameStream {
	private viewers = new Map<string, Viewer>();
	private cdp?: CDPSession;
	private seq = 0;
	private serial = 0;
	private starting: Promise<void> | null = null;
	private retryStart = false;
	private latest?: BrowserFrame;
	private width = 1280;
	private height = 860;
	constructor(readonly record: RegisteredBrowserPage) {
		record.page.on("framenavigated", this.navigated);
		record.page.once("close", () => { void this.dispose(); });
	}
	private navigated = (frame: import("playwright-core").Frame) => { if (frame === this.record.page.mainFrame()) void this.restart().catch(() => {}); };
	private async restart() {
		this.serial++;
		if (this.starting) this.retryStart = true;
		this.latest = undefined;
		for (const v of this.viewers.values()) { v.waiting = v.drawn = v.pending = undefined; }
		const old = this.cdp; this.cdp = undefined;
		await old?.detach().catch(() => {});
		if (this.viewers.size) await this.start();
	}
	private start(): Promise<void> {
		if (this.starting) return this.starting;
		const serial = this.serial;
		this.starting = (async () => {
			const { page } = this.record;
			const cdp = await page.context().newCDPSession(page);
			if (serial !== this.serial || !this.viewers.size) { await cdp.detach(); return; }
			this.cdp = cdp;
			await cdp.send("Page.enable");
			cdp.on("Page.frameResized", () => { void this.validateLayout().catch(() => {}); });
			// 独占尺寸来源，避免同 Chromium 多 CDP 连接可见高度与 layout 不一致。
			await cdp.send("Emulation.setDeviceMetricsOverride", { width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false });
			await cdp.send("Emulation.setVisibleSize", { width: this.width, height: this.height });
			const identity = { ...this.record.identity };
			cdp.on("Page.screencastFrame", (event) => {
				void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
				if (this.cdp !== cdp || serial !== this.serial || !sameBrowserIdentity(identity, this.record.identity)) return;
				const m = event.metadata;
				if (m.deviceWidth !== this.width || m.deviceHeight !== this.height || m.offsetTop !== 0 || m.pageScaleFactor !== 1) {
					for (const v of this.viewers.values()) v.drawn = undefined;
					return;
				}
				const frame: BrowserFrame = { ...identity, type: "frame", seq: ++this.seq, width: this.width, height: this.height, data: event.data };
				this.latest = frame;
				for (const v of this.viewers.values()) this.offer(v, frame);
			});
			await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: this.width, maxHeight: this.height, everyNthFrame: 1 });
		})();
		return this.starting.finally(() => { this.starting = null; if (this.retryStart && this.viewers.size) { this.retryStart = false; void this.start().catch(() => {}); } });
	}
	private offer(v: Viewer, frame: BrowserFrame) {
		if (v.waiting) { v.pending = frame; return; }
		v.waiting = frame;
		v.send(frame);
	}
	async subscribe(send: Viewer["send"]) {
		const id = randomUUID(), viewer: Viewer = { send };
		this.viewers.set(id, viewer);
		try { await this.startIfNeeded(); if (this.latest && !viewer.waiting) this.offer(viewer, this.latest); }
		catch (e) { this.viewers.delete(id); throw e; }
		return id;
	}
	private async startIfNeeded() { if (!this.cdp) await this.start(); }
	ack(id: string, identity: BrowserIdentity, seq: number, width: number, height: number) {
		const v = this.viewers.get(id), f = v?.waiting;
		if (!v || !f || f.seq !== seq || f.width !== width || f.height !== height || !sameBrowserIdentity(f, identity) || !sameBrowserIdentity(f, this.record.identity)) throw new Error("旧画面已失效，请等待新画面绘制");
		v.drawn = f; v.waiting = undefined;
		// 先让路由回送绘制确认，再发下一帧，避免动画页面永远追不上确认。
		if (v.pending) setImmediate(() => {
			if (!this.viewers.has(id) || v.waiting || !v.pending) return;
			const next = v.pending; v.pending = undefined;
			if (sameBrowserIdentity(next, this.record.identity)) this.offer(v, next);
		});
	}
	check(id: string, identity: BrowserIdentity, seq: number) {
		const f = this.viewers.get(id)?.drawn;
		if (!f || f.seq !== seq || !sameBrowserIdentity(f, identity) || !sameBrowserIdentity(f, this.record.identity)) throw new Error("画面尚未确认或已经变化，请等待当前画面");
		return f;
	}
	async validateLayout() {
		const cdp = this.cdp;
		if (!cdp) throw new Error("查看连接已断开");
		const metrics = await cdp.send("Page.getLayoutMetrics");
		if (this.cdp !== cdp) throw new Error("网页画面正在更新");
		const layout = metrics.cssLayoutViewport;
		if (layout.clientWidth !== this.width || layout.clientHeight !== this.height) {
			this.record.identity.generation++;
			await this.restart();
			throw new Error("网页尺寸已变化，请等待新画面绘制后再操作");
		}
	}
	async resize(width: number, height: number) {
		if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 1920 || height < 240 || height > 1440) throw new Error("网页尺寸不受支持");
		this.width = width; this.height = height;
		this.record.identity.generation++;
		await this.restart();
	}
	unsubscribe(id: string) {
		this.viewers.delete(id);
		if (!this.viewers.size) { this.serial++; this.latest = undefined; const cdp = this.cdp; this.cdp = undefined; void cdp?.detach().catch(() => {}); }
	}
	async dispose() {
		this.record.page.off("framenavigated", this.navigated);
		this.viewers.clear(); this.serial++;
		const cdp = this.cdp; this.cdp = undefined;
		await cdp?.detach().catch(() => {});
	}
	get viewerCount() { return this.viewers.size; }
}
const streams = new WeakMap<RegisteredBrowserPage, BrowserFrameStream>();
export function browserFrames(record: RegisteredBrowserPage) {
	let stream = streams.get(record);
	if (!stream) { stream = new BrowserFrameStream(record); streams.set(record, stream); }
	return stream;
}
