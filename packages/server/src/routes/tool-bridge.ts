/**
 * 工具桥的 HTTP 入口（claude 的 MCP 客户端来调，不是给界面用的，所以不在 /api 下、不走设备登录）。
 * 只收来自 127.0.0.1 的请求（隧道转发进来的也拒绝），并校验这次运行的随机令牌（`Authorization: Bearer`）。
 * 协议处理在 `cli-agents/tool-bridge.ts`。
 */
import type { Hono } from "hono";
import { isLoopbackRequest } from "../auth.ts";
import { toolBridge } from "../cli-agents/tool-bridge.ts";
import type { Env } from "./common.ts";

export const TOOL_BRIDGE_PATH = "/internal/tool-bridge";
const MAX_BODY = 8 * 1024 * 1024;

export function mountToolBridgeRoutes(app: Hono<Env>): void {
	app.post(`${TOOL_BRIDGE_PATH}/:runId`, async (c) => {
		if (!isLoopbackRequest(c.env.incoming.socket.remoteAddress, c.req.raw.headers)) return c.json({ error: "local_only" }, 403);
		const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
		const run = toolBridge.authorize(c.req.param("runId"), token);
		if (!run) return c.json({ error: "unauthorized" }, 401);
		if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return c.json({ error: "too_large" }, 413);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "不是有效的 JSON" } }, 400);
		}
		if (Array.isArray(body)) {
			const out = (await Promise.all(body.map((m) => run.handleMessage(m)))).filter((r) => r !== null);
			return out.length ? c.json(out) : c.body(null, 202);
		}
		const res = await run.handleMessage(body);
		return res ? c.json(res) : c.body(null, 202);
	});
	// 不提供服务端主动推送的流，也没有会话可删：按规范回 405
	app.on(["GET", "DELETE"], `${TOOL_BRIDGE_PATH}/:runId`, (c) => c.body(null, 405));
}
