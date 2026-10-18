/** http 路由共用：请求环境类型、管理权限中间件、调用方、错误响应。各 routes/*.ts 与 http.ts 共用这一份。 */
import type { IncomingMessage } from "node:http";
import type { Context, Next } from "hono";
import type { Caller } from "../auth.ts";

export type Env = { Bindings: { incoming: IncomingMessage }; Variables: { caller: Caller } };

/** 管理类接口：本机，或主人设备（Linux 服务器版用设置码登录的第一台设备，DESIGN §15.3） */
export const isAdmin = (c: Context<Env>) => c.get("caller").local || !!c.get("caller").owner;
export const localOnly = async (c: Context<Env>, next: Next) => (isAdmin(c) ? next() : c.json({ error: "local_only" }, 403));
export const by = (c: Context<Env>) => c.get("caller").deviceId ?? "local";
export const errJson = (c: Context<Env>, e: unknown) => c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
