/**
 * MCP 服务的包预先装进我们自己的目录（统一下载管理里能看到“未下载 / 下载中 xx MB / 已下载 / 出错重试”）。
 *
 * - `npx [-y] pkg args…` / `npx -p pkg cmd args…` → `npm install --prefix <数据目录>/mcp-packages/<spec>`，
 *   会话里改成直接运行装好的可执行文件（不再每次联网解析，离线也能用）。
 * - `uvx pkg args…` / `uvx --from spec cmd args…` → `uv tool install`（UV_TOOL_DIR 指向我们的目录；uv 用 App 自带下载的）。
 * - 其他命令（node 脚本、docker、http 服务）不需要下载，不登记。
 * 没装好之前照常用原命令（npx/uvx 自己会下载），所以预装失败不会让服务不可用。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { downloadInfo, registerDownload, trackDownload, unregisterDownload, watchDir } from "./downloads.ts";
import { configOf, listMcp, type McpConfig } from "./mcp.ts";
import { ensureUv, findUv } from "./memory/hindsight/uv-bin.ts";

const WIN = process.platform === "win32";
export interface Runner {
	kind: "npm" | "uv";
	/** 安装用的包说明（可带版本，例如 @scope/pkg@1.2.3） */
	spec: string;
	/** 明确指定的可执行文件名（npx -p / uvx --from 时） */
	bin?: string;
	/** 传给可执行文件的参数 */
	rest: string[];
}

const base = (cmd: string) => cmd.trim().replace(/\\/g, "/").split("/").pop()!.replace(/\.(cmd|exe|bat)$/i, "").toLowerCase();

/** 识别 npx / uvx 命令（纯函数，单测覆盖） */
export function parseRunner(c: Pick<McpConfig, "type" | "command" | "args">): Runner | null {
	if (c.type !== "stdio" || !c.command) return null;
	const cmd = base(c.command);
	const args = [...(c.args ?? [])];
	if (cmd === "npx") {
		let pkg: string | undefined;
		let i = 0;
		for (; i < args.length; i++) {
			const a = args[i];
			if (a === "-y" || a === "--yes" || a === "-q" || a === "--quiet") continue;
			if (a === "-p" || a === "--package") (pkg = args[++i]);
			else if (a.startsWith("--package=")) pkg = a.slice(10);
			else if (a === "--") continue;
			else if (a.startsWith("-")) return null; // 不认识的 npx 选项：不碰
			else break;
		}
		if (i >= args.length) return null;
		return pkg ? { kind: "npm", spec: pkg, bin: args[i], rest: args.slice(i + 1) } : { kind: "npm", spec: args[i], rest: args.slice(i + 1) };
	}
	if (cmd === "uvx" || (cmd === "uv" && args[0] === "tool" && args[1] === "run" && args.splice(0, 2))) {
		let from: string | undefined;
		let i = 0;
		for (; i < args.length; i++) {
			const a = args[i];
			if (a === "--from") from = args[++i];
			else if (a.startsWith("--from=")) from = a.slice(7);
			else if (a === "-q" || a === "--quiet") continue;
			else if (a.startsWith("-")) return null;
			else break;
		}
		if (i >= args.length) return null;
		const head = args[i];
		if (from) return { kind: "uv", spec: from, bin: head, rest: args.slice(i + 1) };
		return { kind: "uv", spec: head, bin: head.replace(/\[.*\]/, "").split(/[@=<>~!]/)[0], rest: args.slice(i + 1) };
	}
	return null;
}

/** npm 包名（去掉版本） */
export const npmName = (spec: string) => (spec.startsWith("@") ? `@${spec.slice(1).split("@")[0]}` : spec.split("@")[0]);
const slug = (r: Runner) => `${r.kind}-${r.spec.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60)}-${createHash("sha1").update(r.spec).digest("hex").slice(0, 8)}`;
export const mcpPkgRoot = () => join(config.dataDir, "mcp-packages");
const dirOf = (r: Runner) => join(mcpPkgRoot(), slug(r));
const marker = (r: Runner) => join(dirOf(r), ".pia-installed.json");

/** 装好了就返回可执行文件的绝对路径 */
export function installedBin(r: Runner): string | null {
	try {
		const m = JSON.parse(readFileSync(marker(r), "utf8")) as { bin: string };
		return existsSync(m.bin) ? m.bin : null;
	} catch {
		return null;
	}
}

function run(cmd: string, args: string[], env: Record<string, string>, cwd?: string) {
	return new Promise<void>((res, rej) => {
		let tail = "";
		const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], shell: WIN });
		const on = (b: Buffer) => (tail = (tail + String(b)).slice(-1500));
		p.stdout.on("data", on);
		p.stderr.on("data", on);
		p.on("error", (e) => rej(/ENOENT/.test(String(e)) ? new Error(`找不到 ${cmd}（npx 类的 MCP 需要先装 Node.js）`) : e));
		p.on("exit", (code) => (code === 0 ? res() : rej(new Error(tail.trim().split("\n").slice(-3).join("\n") || `${cmd} 退出码 ${code}`))));
	});
}

/** npm 包的可执行文件：bin 是字符串 → 包名；对象只有一个 → 它；否则找和包名（去 scope）同名的 */
export function pickNpmBin(pkg: { name: string; bin?: string | Record<string, string> }, want?: string) {
	if (want) return want;
	if (!pkg.bin) return null;
	if (typeof pkg.bin === "string") return pkg.name.split("/").pop()!;
	const keys = Object.keys(pkg.bin);
	if (keys.length === 1) return keys[0];
	return keys.find((k) => k === pkg.name.split("/").pop()) ?? keys[0] ?? null;
}

const inflight = new Map<string, Promise<string>>();
export function installRunner(r: Runner, id: string): Promise<string> {
	const key = slug(r);
	const cur = inflight.get(key);
	if (cur) return cur;
	const job = trackDownload(id, (p) => {
		const dir = dirOf(r);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		return watchDir([dir], p, null, async () => {
			let bin: string;
			if (r.kind === "npm") {
				p.detail(`npm 安装 ${r.spec}`);
				writeFileSync(join(dir, "package.json"), '{"private":true}');
				await run(WIN ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "--omit=dev", "--prefix", dir, r.spec], {}, dir);
				const name = npmName(r.spec);
				const pkgJson = JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8"));
				const b = pickNpmBin(pkgJson, r.bin);
				if (!b) throw new Error(`${name} 没有可执行文件`);
				bin = join(dir, "node_modules", ".bin", WIN ? `${b}.cmd` : b);
			} else {
				p.detail(`uv 安装 ${r.spec}`);
				const uv = findUv() ?? (await ensureUv());
				const env = { UV_TOOL_DIR: join(dir, "tools"), UV_TOOL_BIN_DIR: join(dir, "bin"), UV_CACHE_DIR: join(dir, "cache") };
				await run(uv, ["tool", "install", "--force", r.spec], env);
				rmSync(join(dir, "cache"), { recursive: true, force: true });
				bin = join(dir, "bin", WIN ? `${r.bin}.exe` : r.bin!);
			}
			if (!existsSync(bin)) throw new Error(`安装完成但找不到可执行文件 ${bin}`);
			writeFileSync(marker(r), JSON.stringify({ spec: r.spec, bin, at: Date.now() }));
			return bin;
		});
	}).finally(() => inflight.delete(key));
	inflight.set(key, job);
	return job;
}

/** 会话 / 测试连接实际运行的命令：装好了用装好的可执行文件，否则原样 */
export function resolveMcpCommand(c: McpConfig): { command: string; args: string[] } {
	const r = parseRunner(c);
	const bin = r && installedBin(r);
	return bin ? { command: bin, args: r!.rest } : { command: c.command!, args: c.args ?? [] };
}

export const mcpDownloadId = (serverId: string) => `mcp:${serverId}`;
let registered = new Set<string>();
/** 按当前 MCP 配置登记下载条目（新增 / 修改 / 删除后调用） */
export function syncMcpDownloads() {
	const now = new Set<string>();
	for (const row of listMcp()) {
		const r = parseRunner(configOf(row));
		if (!r) continue;
		const id = mcpDownloadId(row.id);
		now.add(id);
		registerDownload({ id, name: `MCP「${row.name}」· ${r.spec}`, group: "MCP 服务", installed: () => !!installedBin(r), start: () => installRunner(r, id) });
	}
	for (const id of registered) if (!now.has(id)) unregisterDownload(id);
	registered = now;
}

/** 保存后：没装过就装（失败不影响用原命令连接） */
export async function ensureMcpPackage(serverId: string) {
	syncMcpDownloads();
	const row = listMcp().find((r) => r.id === serverId);
	const r = row && parseRunner(configOf(row));
	if (!r || installedBin(r)) return;
	if (downloadInfo(mcpDownloadId(serverId))?.state === "downloading") return;
	await installRunner(r, mcpDownloadId(serverId)).catch(() => {});
}
