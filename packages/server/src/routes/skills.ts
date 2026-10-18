/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono } from "hono";
import { getAgent, listAgents } from "../runtime.ts";
import { deleteSkill, getSkill, listSkills } from "../skills.ts";
import { agentsUsingSkill, assignedSkillIds, enableSkillForAgents, setAssignedSkillIds, unassignSkillEverywhere } from "../skill-assignments.ts";
import { ImportConflict, importSkillFromPath, importSkillFromZip } from "../skill-import.ts";
import { listVersions, rollbackSkill, saveSkillVersioned, searchSkills, setSuggestSettings, skillDiff, suggestSettings } from "../skill-intel.ts";
import { type Env } from "./common.ts";

// ---------------------------------------------------------------- 技能库（Pi 原生 Agent Skills）
// 库存带 canonical id / 来源 / 启用了它的助理列表，供界面显示「启用数」与按 agent 配置。
const skillJson = (s: ReturnType<typeof listSkills>[number]) => ({ id: s.id, name: s.name, description: s.description, source: s.source, builtin: s.builtin, size: s.body.length, enabledAgents: agentsUsingSkill(s.id) });

export function mountSkillRoutes(app: Hono<Env>) {
	app.get("/api/skills", (c) => c.json(listSkills().map(skillJson)));
	app.get("/api/skills/:name", (c) => {
		const s = getSkill(c.req.param("name"));
		return s ? c.json({ ...skillJson(s), body: s.body }) : c.json({ error: "not_found" }, 404);
	});
	// 批量给当前所有助理启用某技能（UI 的「给所有助理启用」）；不建立对未来新助理的继承。
	app.post("/api/skills/:name/enable-all", (c) => {
		const s = getSkill(c.req.param("name"));
		if (!s) return c.json({ error: "not_found" }, 404);
		enableSkillForAgents(listAgents().map((a) => a.id), s.id);
		return c.json({ ok: true, id: s.id, agents: agentsUsingSkill(s.id) });
	});
	// 外部导入：zip 文件或本机路径（目录 / 单个 SKILL.md）。先入库，可选只 enable 目标助理。
	// 同名内容不同返回 409 conflict，由界面让用户选 update / newName，绝不静默覆盖。
	app.post("/api/skills/import", async (c) => {
		const body = await c.req.parseBody();
		const mode = (typeof body.mode === "string" && ["conflict", "update", "rename"].includes(body.mode) ? body.mode : "conflict") as "conflict" | "update" | "rename";
		const newName = typeof body.newName === "string" && body.newName.trim() ? body.newName.trim() : undefined;
		const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;
		try {
			const file = body.file as { arrayBuffer?: () => Promise<ArrayBuffer> } | undefined;
			const r = file?.arrayBuffer
				? await importSkillFromZip(new Uint8Array(await file.arrayBuffer()), { mode, newName })
				: typeof body.path === "string" && body.path.trim()
					? importSkillFromPath(body.path.trim(), { mode, newName })
					: null;
			if (!r) return c.json({ error: "请上传 zip，或填写本机目录 / SKILL.md 路径" }, 400);
			if (agentId && getAgent(agentId)) setAssignedSkillIds(agentId, [...new Set([...assignedSkillIds(agentId), r.id])]);
			return c.json(r);
		} catch (e) {
			if (e instanceof ImportConflict) return c.json({ error: "conflict", existing: e.existing, incoming: e.incoming }, 409);
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.post("/api/skills", async (c) => {
		const b = await c.req.json<{ name: string; description: string; body: string; previousName?: string; agentId?: string }>();
		if (getSkill(b.name)?.builtin) return c.json({ error: "内置技能不能覆盖，请换一个名字" }, 400);
		try {
			const s = saveSkillVersioned(b, "user");
			// 模型给某个助理新建的技能：默认只启用给那个助理（没有 target 就是不给任何人启用）
			if (b.agentId && getAgent(b.agentId)) setAssignedSkillIds(b.agentId, [...new Set([...assignedSkillIds(b.agentId), s.id])]);
			return c.json({ ...s, path: undefined });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	// 删除物理库存：先提示影响哪些已启用它的助理；未确认（?force 缺失）且有助理在用则返回 409。
	app.delete("/api/skills/:name", (c) => {
		const s = getSkill(c.req.param("name"));
		if (!s) return c.json({ error: "not_found" }, 404);
		const affected = agentsUsingSkill(s.id);
		if (affected.length && c.req.query("force") !== "1") return c.json({ error: "in_use", agents: affected }, 409);
		unassignSkillEverywhere(s.id);
		return c.json({ ok: deleteSkill(s.name), agents: affected });
	});
	app.get("/api/skills-search", (c) => c.json(searchSkills(c.req.query("q") ?? "")));
	app.get("/api/skills/:name/versions", (c) => {
		const vs = listVersions(c.req.param("name"));
		// 每个版本附上相对上一版本的 diff
		return c.json(vs.map((v, i) => ({ ...v, diff: skillDiff(v.name, vs[i + 1] ?? null, v) })));
	});
	app.post("/api/skills/:name/rollback", async (c) => {
		const { version } = await c.req.json<{ version: number }>();
		try {
			return c.json({ ...rollbackSkill(c.req.param("name"), version), path: undefined });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.get("/api/skill-suggest", (c) => c.json(suggestSettings()));
	app.put("/api/skill-suggest", async (c) => (setSuggestSettings(await c.req.json()), c.json(suggestSettings())));
}
