/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono } from "hono";
import { describeRoutine } from "../runtime.ts";
import { deleteRoutine, getRoutine, listRuns, type RoutineInput, type RoutineRow, runRoutine, setRoutineStatus, updateRoutine, webhookPath } from "../routines.ts";
import { type Env } from "./common.ts";

// ---------------------------------------------------------------- 定时与触发
export const routineJson = (r: RoutineRow) => {
	const last = listRuns(r.id, 1)[0] ?? null;
	return { ...r, webhook_secret: undefined, quiet: r.quiet ? JSON.parse(r.quiet) : null, webhookPath: webhookPath(r), lastRun: last };
};

export function mountRoutineRoutes(app: Hono<Env>) {
	app.post("/api/routines/preview", async (c) => {
		const b = await c.req.json<{ trigger: string; cron?: string; quietHours?: boolean; agentId?: string }>();
		try {
			return c.json({ ok: true, text: describeRoutine(b, b.agentId) });
		} catch (e) {
			return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
		}
	});
	app.patch("/api/routines/:rid", async (c) => {
		try {
			return c.json(routineJson(updateRoutine(c.req.param("rid"), await c.req.json<Partial<RoutineInput>>())));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.post("/api/routines/:rid/:action{pause|resume|run}", (c) => {
		const rid = c.req.param("rid");
		if (!getRoutine(rid)) return c.json({ error: "not_found" }, 404);
		const action = c.req.param("action");
		if (action === "run") return c.json(runRoutine(rid, "manual"));
		return c.json(routineJson(setRoutineStatus(rid, action === "pause" ? "paused" : "active")!));
	});
	app.delete("/api/routines/:rid", (c) => c.json({ ok: deleteRoutine(c.req.param("rid")) }));
	app.get("/api/routines/:rid/runs", (c) => c.json(listRuns(c.req.param("rid"), 50)));
}
