/**
 * @pi-assistant/ext-sandbox —— 让 Pi 的内置工具在“助理自己的电脑”里运行（Pi 扩展）。
 * L0 工作区：bash 在工作区目录中运行，清理敏感环境变量；文件工具禁止越出工作区。
 *   L0 不是 OS 级隔离：命令仍以当前用户身份在本机跑，只是把工作区当默认目录、清掉模型相关环境变量。
 * L2 Docker：bash 通过注入的 operations 在容器内执行（工作区以 bind mount 共享）。
 * 完全权限（hostAccess）：用户选了“完全权限”时，文件工具可读写用户主机，bash 在主机上以真实 HOME 运行
 *   （仍清理 KEY/TOKEN 等秘密环境变量），即使沙箱偏好是 Docker 也不进容器。
 */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SpawnCtx = { command: string; cwd: string; env: NodeJS.ProcessEnv };
export interface SandboxHost {
	workspace: string;
	mode: "workspace" | "docker";
	/** 由 pi-adapter 提供：创建 Pi 内置 bash 工具 */
	makeBashTool(cwd: string, opts: { operations?: BashOperations; spawnHook?: (c: SpawnCtx) => SpawnCtx }): unknown;
	dockerOperations?: BashOperations;
	/** 由 pi-adapter 提供：Pi 内置的“本机 bash”执行后端（Docker 偏好下切回主机时用） */
	localOperations?: BashOperations;
	/** 工作区之外允许“只读”访问的目录（例如技能库，Pi 需要读取 SKILL.md） */
	readOnlyRoots?: string[];
	/** 完全权限：文件工具可访问用户主机、bash 在主机上以真实 HOME 运行。每次调用求值，降权 / 暂停立即生效 */
	hostAccess?: () => boolean;
}
const inside = (root: string, abs: string) => {
	const rel = relative(root, abs);
	return !(rel.startsWith("..") || isAbsolute(rel));
};

const SENSITIVE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH)/i;
export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (!SENSITIVE.test(k) && !k.startsWith("PIA_") && !k.startsWith("HUHAO_")) out[k] = v;
	return out;
}

export function sandboxExtension(host: SandboxHost) {
	const hostAccess = () => host.hostAccess?.() ?? false;
	return (pi: ExtensionAPI) => {
		// Docker 模式下“完全权限”要改在主机上跑：按每次调用判断，降权 / 暂停后立刻回到容器，不依赖会话重建
		const local = host.mode === "docker" ? host.localOperations : undefined;
		const docker = host.dockerOperations;
		const operations: BashOperations | undefined =
			host.mode === "docker" && docker && local ? { exec: (command, cwd, options) => (hostAccess() ? local : docker).exec(command, cwd, options) } : host.mode === "docker" ? docker : undefined;
		const bash = host.makeBashTool(host.workspace, {
			operations,
			// 完全权限：真实 HOME；其他档位仍把 HOME 指到工作区
			spawnHook: (c) => ({ ...c, env: { ...sanitizeEnv(c.env), HOME: hostAccess() ? homedir() : host.workspace } }),
		}) as Parameters<ExtensionAPI["registerTool"]>[0];
		pi.registerTool({ ...bash });
		pi.on("tool_call", async (event) => {
			if (!["read", "write", "edit", "ls", "find", "grep"].includes(event.toolName)) return;
			const p = (event.input as { path?: string }).path;
			if (!p) return;
			const abs = isAbsolute(p) ? p : resolve(host.workspace, p);
			if (inside(host.workspace, abs)) return;
			// 完全权限：主机文件统一可用（凭据路径拒绝与硬性保护仍由审批扩展把关）
			if (hostAccess()) return;
			const readOnly = ["read", "ls", "find", "grep"].includes(event.toolName);
			if (readOnly && (host.readOnlyRoots ?? []).some((r) => inside(r, abs))) return;
			return { block: true, reason: `沙箱限制：只能访问工作区（${host.workspace}）内的文件${host.readOnlyRoots?.length ? "（技能库只读）" : ""}` };
		});
	};
}
