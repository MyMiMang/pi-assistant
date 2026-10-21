/** http 路由共用：请求环境类型、管理权限中间件、调用方、错误响应。各 routes/*.ts 与 http.ts 共用这一份。 */
import type { IncomingMessage } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { Context, Next } from "hono";
import { ReplyError } from "../replies.ts";
import type { Caller } from "../auth.ts";
import { mimeOf } from "../files.ts";

export type Env = { Bindings: { incoming: IncomingMessage }; Variables: { caller: Caller } };

/** 管理类接口：本机，或主人设备（Linux 服务器版用设置码登录的第一台设备，DESIGN §15.3） */
export const isAdmin = (c: Context<Env>) => c.get("caller").local || !!c.get("caller").owner;
export const localOnly = async (c: Context<Env>, next: Next) => (isAdmin(c) ? next() : c.json({ error: "local_only" }, 403));
export const by = (c: Context<Env>) => c.get("caller").deviceId ?? "local";
export const errJson = (c: Context<Env>, e: unknown) => c.json({ error: e instanceof Error ? e.message : String(e) }, 400);

export const roomErr = (c: Context, e: unknown) => {
	if (e instanceof ReplyError) return c.json({ error: e.message, code: e.code }, e.status as 400 | 403 | 404);
	return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
};

/** 能在页面里直接播放的视频 / 音频类型：inline=1 时不再强制下载。 */
const INLINE_OK = /^(image\/(png|jpeg|gif|webp)|text\/plain|(video|audio)\/[a-z0-9.+-]+)$/i;

/**
 * 解析单区间 Range 头。返回 null = 没有 / 不认识（按完整文件 200 发，含多区间）；"invalid" = 区间落在文件外（416）。
 * 支持 bytes=a-b、bytes=a-、bytes=-n（末尾 n 字节）；end 超出文件尾时截到文件尾。
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
	const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
	if (!m || (m[1] === "" && m[2] === "")) return null;
	let start: number;
	let end: number;
	if (m[1] === "") {
		const n = Number(m[2]);
		if (n === 0) return "invalid";
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		start = Number(m[1]);
		end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
		if (m[2] !== "" && Number(m[2]) < start) return null; // a > b：语法无效，忽略 Range
	}
	return start >= size ? "invalid" : { start, end };
}

export function sendFile(c: Context<Env>, path: string, name: string, mime: string) {
	if (mime === "application/octet-stream") mime = mimeOf(name); // 旧记录（早于视频 / 音频类型表）存的是 octet-stream
	const inline = c.req.query("inline") === "1" && INLINE_OK.test(mime);
	const size = statSync(path).size;
	c.header("Content-Type", inline ? mime : mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime);
	c.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
	c.header("Cache-Control", "private, max-age=3600");
	c.header("Accept-Ranges", "bytes");
	const range = parseRange(c.req.header("range"), size);
	if (range === "invalid") {
		c.header("Content-Range", `bytes */${size}`);
		return c.body(null, 416);
	}
	if (!range) {
		c.header("Content-Length", String(size));
		return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
	}
	c.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
	c.header("Content-Length", String(range.end - range.start + 1));
	return c.body(Readable.toWeb(createReadStream(path, { start: range.start, end: range.end })) as ReadableStream, 206);
}
