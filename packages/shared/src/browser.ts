/** 同一业务页面的身份与查看协议；不含浏览器调试地址或凭据。 */
export interface BrowserIdentity { runtimeId: string; contextId: string; pageId: string; generation: number }
export type BrowserControl = "agent" | "draining" | "user" | "reading";
export interface BrowserPageInfo extends BrowserIdentity { title: string; url: string; isolated: boolean; control: BrowserControl; controlGeneration: number; error?: string }
export interface BrowserState { pages: BrowserPageInfo[]; current: string | null; mode: "host" | "sandbox" | null; paused: boolean }
export interface BrowserFrame extends BrowserIdentity { type: "frame"; seq: number; width: number; height: number; data: string }
export interface BrowserInput extends BrowserIdentity {
	controlGeneration: number;
	seq: number;
	kind: "click" | "wheel" | "key" | "text" | "navigate";
	x?: number; y?: number; deltaY?: number; text?: string; key?: string; url?: string;
}
export const sameBrowserIdentity = (a: BrowserIdentity, b: BrowserIdentity) => a.runtimeId === b.runtimeId && a.contextId === b.contextId && a.pageId === b.pageId && a.generation === b.generation;
