/**
 * 单聊项目的接口（docs/design/group-team.md §13，写法照 routes/rooms.ts 的项目路由）：列项目、用户按钮确认 / 先不做 / 停下。
 * 立项本身由助理在单聊里用 chat_plan 出方案卡。
 */
import type { Hono } from "hono";
import { chatProjectJson, chatProjectsOf, confirmChatProject, dismissChatProject, stopChatProject } from "../chat-projects/store.ts";
import { confirmWakeText } from "../chat-projects/rules.ts";
import { getConversation } from "../conversations.ts";
import { ProjectError } from "../rooms/plan.ts";
import { runtime } from "../runtime.ts";
import { roomErr, type Env } from "./common.ts";

const projectErr = (c: Parameters<typeof roomErr>[0], e: unknown) => (e instanceof ProjectError ? c.json({ error: e.message }, e.status) : roomErr(c, e));

export function mountChatProjectRoutes(app: Hono<Env>) {
	app.get("/api/conversations/:cid/projects", (c) => {
		const cid = c.req.param("cid");
		if (!getConversation(cid)) return c.json({ error: "not_found" }, 404);
		return c.json({ projects: chatProjectsOf(cid, c.req.query("all") === "1").map(chatProjectJson) });
	});
	/** 点「就这么干」：项目开始（或改过的方案生效），叫醒助理按方案推进。 */
	app.post("/api/conversations/:cid/projects/:pid/confirm", (c) => {
		const cid = c.req.param("cid");
		try {
			const { project, revised } = confirmChatProject(cid, c.req.param("pid"));
			void runtime(project.agent_id, cid).nudge(confirmWakeText(project.title, project.id, revised)).catch(() => {});
			return c.json({ ok: true, project: chatProjectJson(project) });
		} catch (e) {
			return projectErr(c, e);
		}
	});
	app.post("/api/conversations/:cid/projects/:pid/dismiss", (c) => {
		try {
			return c.json({ ok: true, project: chatProjectJson(dismissChatProject(c.req.param("cid"), c.req.param("pid"))) });
		} catch (e) {
			return projectErr(c, e);
		}
	});
	/** 停下项目：进度保留，助理手上的活（含帮手）一并停下。 */
	app.post("/api/conversations/:cid/projects/:pid/stop", async (c) => {
		const cid = c.req.param("cid");
		try {
			const project = stopChatProject(cid, c.req.param("pid"));
			await runtime(project.agent_id, cid).abort({ scope: "conversation" }).catch(() => {});
			return c.json({ ok: true, project: chatProjectJson(project) });
		} catch (e) {
			return projectErr(c, e);
		}
	});
}
