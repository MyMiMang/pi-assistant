/**
 * 建一个助理的 Pi 会话（主会话 / 后台任务 / 子代理共用，决策 0014 第 1 步）：
 * 工作区、助理目录、系统规则、扩展（权限 / 审批 / 记忆身份）、技能清单和 MCP 只在这里拼一次，
 * 各调用方只给出差别：会话目录、续用的会话文件、模型、附加规则和扩展身份。
 */
import { join } from "node:path";
import { config } from "../config.ts";
import { workspaceOf } from "../files.ts";
import { hostFileAccess } from "../host-control.ts";
import { models } from "../models.ts";
import { createPiSession } from "../pi-adapter/index.ts";
import { skillFilterFor } from "../skill-scope.ts";
import { skillPaths } from "../skills.ts";
import { extensionsFor, integrationsFor } from "./extensions.ts";
import type { AgentRow } from "./rows.ts";
import { SYSTEM_RULES } from "./system-rules.ts";

type CreateOpts = Parameters<typeof createPiSession>[0];

export async function createAgentSession(a: AgentRow, o: {
	/** 相对助理目录的会话目录，例如 "sessions" / "tasks" / "subagents/<id>" */
	sessionDir: string;
	sessionFile?: string | null;
	parentSession?: CreateOpts["parentSession"];
	model: CreateOpts["model"];
	thinking?: CreateOpts["thinking"];
	/** 追加在通用系统规则之后的规则 */
	rules?: string[];
	conversationId: string | null;
	taskId: string | null;
	ext: Parameters<typeof extensionsFor>[3];
}) {
	const workspace = workspaceOf(a.id);
	return await createPiSession({
		models,
		cwd: workspace,
		agentDir: join(config.agentsDir, a.id),
		sessionDir: join(config.agentsDir, a.id, o.sessionDir),
		sessionFile: o.sessionFile ?? undefined,
		parentSession: o.parentSession,
		model: o.model,
		thinking: o.thinking,
		systemPromptAppend: [...SYSTEM_RULES(a.name, workspace, a.persona, hostFileAccess(a.id)), ...(o.rules ?? [])],
		extensions: await extensionsFor(a.id, o.conversationId, o.taskId, o.ext),
		skillPaths: skillPaths(),
		skillFilter: skillFilterFor(a.id),
		...integrationsFor(a.id, o.conversationId),
	});
}
