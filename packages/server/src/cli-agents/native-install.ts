/** 原生 ACP npm 私有安装；仅用户操作触发网络，旧版只在下次启动清理。 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { appNodeNpmPaths, npmBinPath } from "../app-node-npm.ts";
import { registerDownload, trackDownload, watchDir } from "../downloads.ts";
import type { ManagedCliId as NativeAcpId } from "./native-env.ts";

export interface NativeRelease { packageName: string; version: string; integrity: string; bin: string; executable?: "node" | "binary" }
export interface NativeInstallation { version: string; command: string; args: string[]; integrity: string; verified: boolean }
export interface NpmRequest { args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }
export type NpmRun = (request: NpmRequest) => Promise<string>;
const versionOk = (v: string) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v);
const supportedIds: NativeAcpId[] = ["gemini", "codebuddy", "claude-code", "codex", "opencode", "antigravity"];

export async function runPrivateNpm(request: NpmRequest): Promise<string> {
	const runtime = appNodeNpmPaths();
	return new Promise((resolve, reject) => {
		let output = "";
		const child = spawn(runtime.node, [runtime.npm, ...request.args], { cwd: request.cwd, env: request.env, signal: request.signal, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let errors = "";
		child.stdout.on("data", (b) => { output = (output + b).slice(-1_000_000); });
		child.stderr.on("data", (b) => { errors = (errors + b).slice(-2000); });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(errors.trim() || `npm 退出码 ${code}`)));
	});
}

export class NativeInstaller {
	private jobs = new Map<NativeAcpId, { controller: AbortController; promise: Promise<NativeInstallation> }>();
	private run: NpmRun;
	constructor(private options: { dataDir: string; releases: Partial<Record<NativeAcpId, NativeRelease>>; run?: NpmRun }) { this.run = options.run ?? runPrivateNpm; }
	private get ids(): NativeAcpId[] { return supportedIds.filter((id) => this.options.releases[id]); }
	private release(id: NativeAcpId): NativeRelease {
		const release = this.options.releases[id];
		if (!release) throw new Error("缺少工具安装清单");
		return release;
	}
	private root(id: NativeAcpId) {
		if (!this.ids.includes(id)) throw new Error("未知原生工具");
		const parent = join(this.options.dataDir, "cli-agents");
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		if (lstatSync(parent).isSymbolicLink()) throw new Error("工具安装父目录不能是符号链接");
		const root = join(parent, id);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if (lstatSync(root).isSymbolicLink()) throw new Error("工具安装目录不能是符号链接");
		return root;
	}
	private environment(id: NativeAcpId): NodeJS.ProcessEnv {
		const root = this.root(id);
		const home = join(root, "npm-home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const runtimeBin = join(root, "npm-runtime");
		mkdirSync(runtimeBin, { recursive: true, mode: 0o700 });
		const nodeAlias = join(runtimeBin, process.platform === "win32" ? "node.exe" : "node");
		if (!existsSync(nodeAlias)) {
			if (process.platform === "win32") copyFileSync(process.execPath, nodeAlias);
			else symlinkSync(process.execPath, nodeAlias);
		}
		const rc = join(root, "npmrc");
		writeFileSync(rc, "registry=https://registry.npmjs.org/\n", { mode: 0o600 });
		const env: NodeJS.ProcessEnv = {};
		for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) if (process.env[key]) env[key] = process.env[key];
		return { ...env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: runtimeBin + delimiter + dirname(process.execPath) + delimiter + (process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin"), npm_config_userconfig: rc, npm_config_globalconfig: rc, npm_config_cache: join(root, "npm-cache"), npm_config_update_notifier: "false", npm_config_registry: "https://registry.npmjs.org/" };
	}
	installed(id: NativeAcpId): NativeInstallation | null {
		try {
			const root = this.root(id);
			const current = JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
			if (!versionOk(current.version) || lstatSync(join(root, current.version)).isSymbolicLink()) return null;
			const release = JSON.parse(readFileSync(join(root, current.version, ".pia-installed.json"), "utf8")) as NativeRelease & { verified: boolean };
			if (release.version !== current.version || release.packageName !== this.release(id).packageName) return null;
			const entry = npmBinPath(join(root, current.version), release.packageName, release.bin);
			return { version: release.version, command: release.executable === "binary" ? entry : process.execPath, args: release.executable === "binary" ? [] : [entry], integrity: release.integrity, verified: release.verified };
		} catch { return null; }
	}
	cancel(id: NativeAcpId): void { this.jobs.get(id)?.controller.abort(); }
	async checkUpdate(id: NativeAcpId): Promise<NativeRelease> {
		const known = this.release(id);
		const raw = await this.run({ args: ["view", `${known.packageName}@latest`, "--json"], cwd: this.root(id), env: this.environment(id), signal: AbortSignal.timeout(60_000) });
		const meta = JSON.parse(raw);
		if (meta.name !== known.packageName || !versionOk(meta.version) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(meta.dist?.integrity ?? "")) throw new Error("官方 npm 版本信息无效");
		return { packageName: meta.name, version: meta.version, integrity: meta.dist.integrity, bin: known.bin, executable: known.executable };
	}
	install(id: NativeAcpId, release = this.release(id)): Promise<NativeInstallation> {
		const existing = this.jobs.get(id);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const promise = trackDownload(`native:${id}`, async (progress) => {
			const root = this.root(id);
			if (!versionOk(release.version) || release.packageName !== this.release(id).packageName || !/^sha512-[A-Za-z0-9+/]+=*$/.test(release.integrity)) throw new Error("无效安装版本");
			const staging = join(root, `.staging-${randomUUID()}`);
			const target = join(root, release.version);
			mkdirSync(staging, { mode: 0o700 });
			const env = this.environment(id);
			try {
				return await watchDir([staging, join(root, "npm-cache")], progress, null, async () => {
					progress.detail(`下载并校验 ${release.packageName}@${release.version}`);
					const request = (args: string[]) => this.run({ args, cwd: staging, env, signal: controller.signal });
					const pack = JSON.parse(await request(["pack", `${release.packageName}@${release.version}`, "--ignore-scripts", "--json", "--pack-destination", staging]));
					const filename = pack[0]?.filename;
					if (typeof filename !== "string" || /[/\\]/.test(filename)) throw new Error("npm 包文件名无效");
					const archive = join(staging, filename);
					const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
					if (integrity !== release.integrity) throw new Error("npm 包完整性校验失败");
					writeFileSync(join(staging, "package.json"), '{"private":true}');
					progress.detail("安装私有依赖");
					await request(["install", "--no-audit", "--no-fund", "--omit=dev", "--prefix", staging, archive]);
					controller.signal.throwIfAborted();
					npmBinPath(staging, release.packageName, release.bin);
					const pkg = JSON.parse(readFileSync(join(staging, "node_modules", release.packageName, "package.json"), "utf8"));
					if (pkg.version !== release.version) throw new Error("安装版本与请求版本不符");
					writeFileSync(join(staging, ".pia-installed.json"), JSON.stringify({ ...release, verified: false }));
					if (!existsSync(target)) renameSync(staging, target);
					else {
						if (lstatSync(target).isSymbolicLink()) throw new Error("版本目录不能是符号链接");
						const marker = JSON.parse(readFileSync(join(target, ".pia-installed.json"), "utf8"));
						if (marker.integrity !== release.integrity) throw new Error("同版本目录已有不同内容");
						npmBinPath(target, release.packageName, release.bin);
					}
					controller.signal.throwIfAborted();
					const pointer = join(root, `.current-${randomUUID()}.json`);
					writeFileSync(pointer, JSON.stringify({ version: release.version }), { mode: 0o600 });
					renameSync(pointer, join(root, "current.json"));
					return this.installed(id)!;
				});
			} finally { rmSync(staging, { recursive: true, force: true }); }
		}).finally(() => this.jobs.delete(id));
		this.jobs.set(id, { controller, promise });
		return promise;
	}
	cleanupOnStartup(): void {
		for (const id of this.ids) {
			const root = this.root(id);
			const current = this.installed(id);
			if (!current) continue;
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory() || entry.isSymbolicLink() || !versionOk(entry.name) || entry.name === current.version) continue;
				const dir = join(root, entry.name);
				// 仅清理由本安装器产生、包身份一致的版本；home/cache/未知目录永不删除。
				try {
					const marker = JSON.parse(readFileSync(join(dir, ".pia-installed.json"), "utf8"));
					if (marker.version === entry.name && marker.packageName === this.release(id).packageName) rmSync(dir, { recursive: true, force: true });
				} catch { /* 不认识的内容保留 */ }
			}
		}
	}
	registerDownloads(): void {
		for (const id of this.ids) registerDownload({ id: `native:${id}`, name: id === "gemini" ? "Gemini CLI" : "CodeBuddy Code", group: "编程工具", installed: () => !this.jobs.has(id) && !!this.installed(id), start: () => this.install(id), cancel: () => this.cancel(id) });
	}
}
