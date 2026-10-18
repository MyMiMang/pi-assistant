/** http 路由共用：请求环境类型、管理权限中间件、调用方、错误响应。各 routes/*.ts 与 http.ts 共用这一份。 */
import type { IncomingMessage } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { Context, Next } from "hono";
import { ReplyError } from "../replies.ts";
import type { Caller } from "../auth.ts";

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

export function sendFile(c: Context<Env>, path: string, name: string, mime: string) {
	const inline = c.req.query("inline") === "1" && /^(image\/(png|jpeg|gif|webp)|text\/plain)$/.test(mime);
	c.header("Content-Type", inline ? mime : mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime);
	c.header("Content-Length", String(statSync(path).size));
	c.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
	c.header("Cache-Control", "private, max-age=3600");
	return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
}
