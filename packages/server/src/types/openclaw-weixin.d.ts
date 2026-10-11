// 腾讯官方微信插件 dist 没有带 .d.ts：这里只声明我们用到的函数（签名对照 node_modules/@tencent-weixin/openclaw-weixin/src）
declare module "@tencent-weixin/openclaw-weixin/dist/src/api/api.js" {
	type O = { baseUrl: string; token?: string; timeoutMs?: number };
	export function apiGetFetch(p: { baseUrl: string; endpoint: string; timeoutMs?: number; label: string }): Promise<string>;
	export function apiPostFetch(p: { baseUrl: string; endpoint: string; body: string; token?: string; timeoutMs?: number; label: string; abortSignal?: AbortSignal }): Promise<string>;
	export function getUpdates(p: O & { get_updates_buf?: string; abortSignal?: AbortSignal }): Promise<unknown>;
	export function getConfig(p: O & { ilinkUserId: string; contextToken?: string }): Promise<unknown>;
	export function sendTyping(p: O & { body: unknown }): Promise<void>;
	export function sendMessage(p: O & { body: unknown }): Promise<unknown>;
	export function notifyStart(p: O): Promise<unknown>;
	export function notifyStop(p: O): Promise<unknown>;
}
declare module "@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js" {
	export class StreamingMarkdownFilter {
		feed(s: string): string;
		flush(): string;
	}
	export function sendMessageWeixin(p: { to: string; text: string; opts: unknown }): Promise<{ messageId: string; serverMessageId?: string }>;
}
declare module "@tencent-weixin/openclaw-weixin/dist/src/messaging/send-media.js" {
	export function sendWeixinMediaFile(p: { filePath: string; to: string; text: string; opts: unknown; cdnBaseUrl: string }): Promise<{ messageId: string }>;
}
declare module "@tencent-weixin/openclaw-weixin/dist/src/media/media-download.js" {
	export function downloadMediaFromItem(item: unknown, deps: unknown): Promise<unknown>;
}
