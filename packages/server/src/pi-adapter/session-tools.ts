/**
 * Pi 会话的工具清单与已加载资源（pi-adapter 内部用，经 index.ts 对外导出）。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** 会话实际加载的技能与扩展（用于隔离测试与诊断） */
export function loadedResources(session: AgentSession) {
	const rl = session.resourceLoader;
	return {
		skills: rl.getSkills().skills.map((s) => ({ name: s.name, path: (s as { filePath: string }).filePath })),
		extensions: rl.getExtensions().extensions.map((e) => (e as { path?: string }).path ?? ""),
	};
}

/**
 * 续接旧对话时，Pi 按会话记录恢复当时的工具清单（官方行为：记录里的 loadout 优先）。
 * 我们只在配置变了（例如刚加了邮箱、开了个人微信）才重建会话：这时新挂上的扩展工具要补进清单，
 * 否则模型看不到、调用会报 “Tool … not found”。只补扩展注册的、默认就该启用的直接工具；
 * 内置工具、默认不启用的（tool_search）和非直接暴露的（codemode / deferred）照旧。
 */
export function activateNewExtensionTools(session: AgentSession) {
	const active = new Set(session.getActiveToolNames());
	const add = session
		.getAllTools()
		.filter((t) => !active.has(t.name) && t.exposure === "direct" && t.sourceInfo?.source !== "builtin" && session.getToolDefinition(t.name)?.defaultActive !== false)
		.map((t) => t.name);
	if (add.length) session.setActiveToolsByName([...active, ...add]);
	return add;
}

/** 续接旧对话时补新扩展工具；纯工具名列表（受限会话）只保留显式选择，默认的 +/- 修饰符清单才补 */
export function refreshResumedTools(session: AgentSession, tools?: string[]) {
	if ((tools ?? ["+grep"]).every((t) => /^[+-]/.test(t))) activateNewExtensionTools(session);
}
