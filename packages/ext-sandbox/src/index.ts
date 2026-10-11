/**
 * @pi-assistant/ext-sandbox —— 让 Pi 的内置工具在“助理自己的电脑”里运行（Pi 扩展）。
 * L0 工作区：bash 在工作区目录中运行，清理敏感环境变量；文件工具禁止越出工作区。
 * L2 Docker：bash 通过注入的 operations 在容器内执行（工作区以 bind mount 共享）。
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SpawnCtx = { command: string; cwd: string; env: NodeJS.ProcessEnv };
export interface SandboxHost {
	workspace: string;
	mode: "workspace" | "docker";
	/** 由 pi-adapter 提供：创建 Pi 内置 bash 工具 */
	makeBashTool(cwd: string, opts: { operations?: BashOperations; spawnHook?: (c: SpawnCtx) => SpawnCtx }): unknown;
	dockerOperations?: BashOperations;
}

const SENSITIVE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH)/i;
export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (!SENSITIVE.test(k) && !k.startsWith("PIA_") && !k.startsWith("HUHAO_")) out[k] = v;
	return out;
}

export function sandboxExtension(host: SandboxHost) {
	return (pi: ExtensionAPI) => {
		const bash = host.makeBashTool(host.workspace, {
			operations: host.mode === "docker" ? host.dockerOperations : undefined,
			spawnHook: (c) => ({ ...c, env: { ...sanitizeEnv(c.env), HOME: host.workspace } }),
		}) as Parameters<ExtensionAPI["registerTool"]>[0];
		pi.registerTool({ ...bash });
		pi.on("tool_call", async (event) => {
			if (!["read", "write", "edit", "ls", "find", "grep"].includes(event.toolName)) return;
			const p = (event.input as { path?: string }).path;
			if (!p) return;
			const abs = isAbsolute(p) ? p : resolve(host.workspace, p);
			const rel = relative(host.workspace, abs);
			if (rel.startsWith("..") || isAbsolute(rel)) return { block: true, reason: `沙箱限制：只能访问工作区（${host.workspace}）内的文件` };
		});
	};
}
