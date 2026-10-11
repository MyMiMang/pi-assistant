/** 沙箱驱动：L0 工作区目录（默认兜底）/ L2 Docker（检测到可用时）。 */
import { execFile, spawn } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { BashOperations } from "./pi-adapter/index.ts";
import { config } from "./config.ts";
import { getSetting } from "./db.ts";

const run = promisify(execFile);
const IMAGE = process.env.HUHAO_SANDBOX_IMAGE ?? "huhao-sandbox:latest";
const FALLBACK_IMAGE = "debian:bookworm-slim";
let dockerOk: boolean | null = null;

export async function dockerAvailable(): Promise<boolean> {
	if (dockerOk !== null) return dockerOk;
	try {
		await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
		dockerOk = true;
	} catch {
		dockerOk = false;
	}
	return dockerOk;
}

export async function sandboxMode(): Promise<"workspace" | "docker"> {
	const pref = getSetting<"auto" | "workspace" | "docker">("sandbox", config.sandbox);
	if (pref === "workspace") return "workspace";
	if (pref === "docker" || pref === "auto") {
		// auto 只在用户明确开启或环境变量要求时使用 Docker；默认工作区模式最稳
		if (pref === "docker" && (await dockerAvailable())) return "docker";
	}
	return "workspace";
}

async function ensureContainer(agentId: string, workspace: string): Promise<string> {
	const name = `huhao-sbx-${agentId.replace(/[^a-zA-Z0-9_.-]/g, "")}`;
	try {
		const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Running}}", name]);
		if (stdout.trim() === "true") return name;
		await run("docker", ["start", name]);
		return name;
	} catch {
		/* create */
	}
	let image = IMAGE;
	try {
		await run("docker", ["image", "inspect", IMAGE]);
	} catch {
		image = FALLBACK_IMAGE;
	}
	await run("docker", ["run", "-d", "--name", name, "--restart", "unless-stopped", "-v", `${workspace}:/workspace`, "-w", "/workspace", image, "sleep", "infinity"], {
		timeout: 300_000,
	});
	return name;
}

export function dockerOperations(agentId: string, workspace: string): BashOperations {
	return {
		async exec(command, cwd, options) {
			const container = await ensureContainer(agentId, workspace);
			const rel = relative(workspace, cwd);
			const inner = rel && !rel.startsWith("..") ? `/workspace/${rel}` : "/workspace";
			return new Promise((resolve, reject) => {
				const child = spawn("docker", ["exec", "-i", "-w", inner, container, "bash", "-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
				child.stdout.on("data", options.onData);
				child.stderr.on("data", options.onData);
				const timer = options.timeout ? setTimeout(() => child.kill("SIGKILL"), options.timeout * 1000) : undefined;
				options.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
				child.on("error", reject);
				child.on("close", (code, signal) => {
					if (timer) clearTimeout(timer);
					resolve({ exitCode: code ?? (signal ? 137 : null) });
				});
			});
		},
	};
}
