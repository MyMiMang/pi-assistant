/**
 * 完全权限（hostAccess）：文件工具可读写用户主机、bash 用真实 HOME；非完全权限维持工作区行为；
 * Docker 模式下完全权限改在主机上跑（按每次调用判断，降权立即回到容器）。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir, tmpdir } from "node:os";
const { sandboxExtension } = await import("@pi-assistant/ext-sandbox");

type SpawnCtx = { command: string; cwd: string; env: NodeJS.ProcessEnv };
type Handler = (e: { toolName: string; input: Record<string, unknown> }) => Promise<{ block?: boolean; reason?: string } | undefined>;
function harness(hostAccess: boolean, mode: "workspace" | "docker" = "workspace") {
	const tools: { name?: string; operations?: { exec: (...a: never[]) => Promise<unknown> } }[] = [];
	const handlers: Handler[] = [];
	let hook: ((c: SpawnCtx) => SpawnCtx) | null = null;
	const dockerCalls: string[] = [];
	const localCalls: string[] = [];
	const host = {
		workspace: "/ws/a1",
		mode,
		makeBashTool: (_cwd: string, opts: { spawnHook?: (c: SpawnCtx) => SpawnCtx; operations?: { exec: (...a: never[]) => Promise<unknown> } }) => {
			hook = opts.spawnHook ?? null;
			return { name: "bash", operations: opts.operations };
		},
		dockerOperations: mode === "docker" ? { exec: async () => (dockerCalls.push("docker"), { exitCode: 0 }) } : undefined,
		// pi-adapter 注入的本机执行后端（扩展不再自己 import Pi）
		localOperations: mode === "docker" ? { exec: async () => (localCalls.push("local"), { exitCode: 0 }) } : undefined,
		hostAccess: () => hostAccess,
	};
	sandboxExtension(host as never)({ registerTool: (t: unknown) => tools.push(t as never), on: (_n: string, h: never) => handlers.push(h) } as never);
	return { tools, handlers, hook: () => hook!, dockerCalls, localCalls };
}
const call = (h: ReturnType<typeof harness>, toolName: string, path: string) => h.handlers[0]({ toolName, input: { path } });

test("扩展只依赖 Pi 的类型：运行时代码必须经 pi-adapter / host 注入，不直接 import Pi", async () => {
	const { readdirSync, readFileSync } = await import("node:fs");
	const packages = new URL("../../", import.meta.url);
	const bad: string[] = [];
	for (const pkg of readdirSync(packages).filter((n) => n.startsWith("ext-"))) {
		const src = new URL(`./${pkg}/src/`, packages);
		for (const f of readdirSync(src, { recursive: true }).map(String).filter((n) => n.endsWith(".ts"))) {
			const text = readFileSync(new URL(f, src), "utf8");
			for (const m of text.matchAll(/^[ \t]*(import|export)[ \t]+([^;]*?)[ \t]*from[ \t]+"(@earendil-works\/[^"]+)"/gm)) if (!/^type\b/.test(m[2].trim())) bad.push(`${pkg}/${f}: ${m[0].split("\n")[0].trim()}`);
			for (const m of text.matchAll(/\bimport\(\s*"(@earendil-works\/[^"]+)"/g)) bad.push(`${pkg}/${f}: ${m[0]}`);
		}
	}
	assert.deepEqual(bad, [], `扩展不应直接 import Pi 运行时代码，应由 pi-adapter 注入：\n${bad.join("\n")}`);
});

test("完全权限：文件工具可访问主机；非完全权限只能工作区内", async () => {
	const off = harness(false);
	assert.equal((await call(off, "read", "/etc/hosts"))?.block, true, "非完全权限下 /etc/hosts 应被拦下");
	assert.match((await call(off, "read", "/etc/hosts"))?.reason ?? "", /工作区/);
	assert.equal(await call(off, "read", "notes/a.md"), undefined, "工作区内正常");
	const full = harness(true);
	assert.equal(await call(full, "read", "/etc/hosts"), undefined, "完全权限可读主机文件");
	assert.equal(await call(full, "write", "/tmp/report.md"), undefined, "完全权限可写主机文件");
});

test("完全权限：bash 用真实 HOME；其他档位指向工作区；都清理秘密环境变量", () => {
	const full = harness(true);
	const e1 = full.hook()({ command: "echo hi", cwd: "/ws/a1", env: { HOME: "/Users/x", OPENAI_API_KEY: "sk-x", PATH: "/usr/bin" } });
	assert.equal(e1.env.HOME, homedir());
	assert.equal(e1.env.OPENAI_API_KEY, undefined, "模型密钥不传给命令");
	assert.equal(e1.env.PATH, "/usr/bin");
	const ws = harness(false);
	const e2 = ws.hook()({ command: "echo hi", cwd: "/ws/a1", env: { HOME: "/Users/x", SECRET: "s" } });
	assert.equal(e2.env.HOME, "/ws/a1");
	assert.equal(e2.env.SECRET, undefined);
});

test("Docker 模式下完全权限 bash 走主机，非完全权限走容器", async () => {
	const full = harness(true, "docker");
	assert.ok(full.tools[0].operations, "docker 模式下有 operations 包装");
	await full.tools[0].operations!.exec("true" as never, tmpdir() as never, { onData: () => {} } as never);
	assert.deepEqual(full.localCalls, ["local"], "完全权限在主机上执行");
	assert.deepEqual(full.dockerCalls, [], "完全权限不进容器");
	const bounded = harness(false, "docker");
	await bounded.tools[0].operations!.exec("true" as never, tmpdir() as never, { onData: () => {} } as never);
	assert.deepEqual(bounded.dockerCalls, ["docker"], "非完全权限进容器");
	assert.deepEqual(bounded.localCalls, [], "非完全权限不在主机执行");
});
