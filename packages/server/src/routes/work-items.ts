/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono, type Context } from "hono";
import { WorkItemError, editWorkItem, getWorkItemDetail, postWorkFeedback, userAction } from "../work-items.ts";
import { type Env } from "./common.ts";

// ---------------------------------------------------------------- 长期任务（任务责任）与执行分离
export const workErr = (c: Context, e: unknown) => {
	if (e instanceof WorkItemError) {
		const status = e.code === "not_manager" || e.code === "not_owner" ? 403 : e.code === "not_found" || e.code === "room_not_found" ? 404 : e.code === "bad_status" || e.code === "already_running" ? 409 : 400;
		return c.json({ error: e.message, code: e.code }, status);
	}
	return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
};

export function mountWorkItemRoutes(app: Hono<Env>) {
	app.get("/api/work-items/:wid", (c) => {
		try {
			return c.json(getWorkItemDetail(c.req.param("wid")));
		} catch (e) {
			return workErr(c, e);
		}
	});
	app.patch("/api/work-items/:wid", async (c) => {
		const b = await c.req.json<{ title?: string; requirement?: string; doneCriteria?: string; ownerAgentId?: string | null }>();
		try {
			return c.json(editWorkItem({ workItemId: c.req.param("wid"), actor: { kind: "user" }, title: b.title, requirement: b.requirement, doneCriteria: b.doneCriteria, ...(b.ownerAgentId !== undefined ? { ownerAgentId: b.ownerAgentId } : {}) }));
		} catch (e) {
			return workErr(c, e);
		}
	});
	/** 看板「在群里继续」：服务端把任务关联写进这条用户消息（前端不能伪造），再走正常群路由。 */
	app.post("/api/work-items/:wid/feedback", async (c) => {
		const b = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
		try {
			return c.json(await postWorkFeedback(c.req.param("wid"), String(b.text ?? "")));
		} catch (e) {
			return workErr(c, e);
		}
	});
	app.post("/api/work-items/:wid/:action", async (c) => {
		const action = c.req.param("action");
		const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
		try {
			return c.json(await userAction(c.req.param("wid"), action, b));
		} catch (e) {
			return workErr(c, e);
		}
	});
}
