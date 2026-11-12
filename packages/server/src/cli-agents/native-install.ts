/** 原生 ACP npm / 官方 binary 私有安装；仅用户操作触发网络，旧版只在下次启动清理。 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { appNodeNpmPaths, npmBinPath } from "../app-node-npm.ts";
import { fetchWithProgress, registerDownload, trackDownload, watchDir } from "../downloads.ts";
import { NATIVE_ACP_AGENTS, type NativeAcpDefinition } from "@pi-assistant/shared";
import { nativeAcpHome, prepareNativeAcpHome, type ManagedCliId as NativeAcpId } from "./native-env.ts";

import { binaryAsset, binaryAssetIdentity, binaryLaunch, extractBinary, npmLaunch, validateAntigravityAsset, versionOk } from "./native-binary.ts";

export interface NativeBinaryAsset {
	url: string; sha256: string; archive?: "tar.gz" | "tar.xz" | "tar.bz2" | "zip" | "raw" | "binary"; entry: string; unsupported?: string;
	/** 文件参数相对版本根展开；{entry} 可显式引用入口。协议参数由 catalog 提供。 */
	args?: string[]; executable?: "node" | "binary";
}
export interface NativeRelease {
	packageName: string; version: string; integrity: string; bin: string; executable?: "node" | "binary" | "auto";
	source?: "binary"; assets?: Record<string, NativeBinaryAsset>; updateManifest?: string; updateBlocked?: string;
}
const manifestBase = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/";
const binaryBase = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
export interface NativeInstallation { version: string; command: string; args: string[]; integrity: string; verified: boolean }
export interface NpmRequest { args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }
export type NpmRun = (request: NpmRequest) => Promise<string>;
const npmVersionOk = (v: string) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v);
const idOk = (id: string) => /^[a-z][a-z0-9-]{0,63}$/.test(id) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id);

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
	constructor(private options: { dataDir: string; releases: Partial<Record<NativeAcpId, NativeRelease>>; run?: NpmRun; downloadPrefix?: string; dependencies?: Partial<Record<NativeAcpId, NativeInstaller>> }) {
		this.run = options.run ?? runPrivateNpm;
		this.options = { ...options, releases: structuredClone(options.releases) };
	}
	private get ids(): NativeAcpId[] { return (Object.keys(this.options.releases) as NativeAcpId[]).filter((id) => idOk(id) && !!this.options.releases[id]); }
	private release(id: NativeAcpId): NativeRelease {
		if (!idOk(id) || !Object.hasOwn(this.options.releases, id)) throw new Error("未知原生工具");
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
	/** 跑私有 npm 用的环境（单测会用真 npm 验证它能加载配置） */
	npmEnvironment(id: NativeAcpId): NodeJS.ProcessEnv {
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
		const runtimeHome = nativeAcpHome(this.options.dataDir, id);
		if (existsSync(runtimeHome) && lstatSync(runtimeHome).isSymbolicLink()) throw new Error("工具私有 home 不能是符号链接");
		if (id === "grok-build") prepareNativeAcpHome(this.options.dataDir, id);
		const definition: NativeAcpDefinition | undefined = NATIVE_ACP_AGENTS.find((agent) => agent.id === id);
		const toolEnv = Object.fromEntries(Object.entries(definition?.environment ?? {}).map(([key, value]) => [key, value.replaceAll("{home}", runtimeHome)]));
		if (id === "grok-build" && !toolEnv.GROK_HOME) toolEnv.GROK_HOME = runtimeHome;
		// 全局配置必须是另一个文件：两项指向同一文件时 npm 直接拒绝运行（double-loading config），装不上
		const globalRc = join(root, "npmrc-global");
		writeFileSync(globalRc, "", { mode: 0o600 });
		const env: NodeJS.ProcessEnv = {};
		for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) if (process.env[key]) env[key] = process.env[key];
		return { ...env, ...toolEnv, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: runtimeBin + delimiter + dirname(process.execPath) + delimiter + (process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin"), npm_config_userconfig: rc, npm_config_globalconfig: globalRc, npm_config_cache: join(root, "npm-cache"), npm_config_update_notifier: "false", npm_config_registry: "https://registry.npmjs.org/" };
	}
	installed(id: NativeAcpId): NativeInstallation | null {
		try {
			if (this.options.dependencies?.[id] && !this.options.dependencies[id]!.installed(id)) return null;
			const root = this.root(id);
			const current = JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
			if (!versionOk(current.version) || lstatSync(join(root, current.version)).isSymbolicLink()) return null;
			const release = JSON.parse(readFileSync(join(root, current.version, ".pia-installed.json"), "utf8")) as NativeRelease & { verified: boolean };
			if (release.version !== current.version || release.packageName !== this.release(id).packageName) return null;
			if (release.source !== this.release(id).source) return null;
			const dir = join(root, current.version);
			const entry = release.source === "binary" ? undefined : npmBinPath(dir, release.packageName, release.bin);
			const launch = release.source === "binary" ? binaryLaunch(dir, release) : npmLaunch(entry!, release.executable);
			return { version: release.version, ...launch, integrity: release.integrity, verified: release.verified };
		} catch { return null; }
	}
	/** 两种来源共用版本身份校验、原子 current 切换和失败保旧。 */
	private activate(id: NativeAcpId, release: NativeRelease, staging: string, target: string, signal: AbortSignal): NativeInstallation {
		signal.throwIfAborted();
		if (!existsSync(target)) renameSync(staging, target);
		else {
			if (lstatSync(target).isSymbolicLink()) throw new Error("版本目录不能是符号链接");
			const marker = JSON.parse(readFileSync(join(target, ".pia-installed.json"), "utf8"));
			if (marker.packageName !== release.packageName || marker.source !== release.source || marker.integrity !== release.integrity) throw new Error("同版本目录已有不同内容");
			if (release.source === "binary") {
				if (binaryAssetIdentity(binaryAsset(marker)) !== binaryAssetIdentity(binaryAsset(release)) || marker.executable !== release.executable) throw new Error("同版本目录已有不同启动清单");
				binaryLaunch(target, marker);
			}
			else npmLaunch(npmBinPath(target, release.packageName, release.bin), release.executable);
		}
		signal.throwIfAborted();
		const pointer = join(this.root(id), `.current-${randomUUID()}.json`);
		writeFileSync(pointer, JSON.stringify({ version: release.version }), { mode: 0o600 });
		renameSync(pointer, join(this.root(id), "current.json"));
		return this.installed(id)!;
	}
	cancel(id: NativeAcpId): void { this.jobs.get(id)?.controller.abort(); this.options.dependencies?.[id]?.cancel(id); }
	async checkUpdate(id: NativeAcpId): Promise<NativeRelease> {
		const known = this.release(id);
		if (known.source === "binary") {
			if (id !== "antigravity") return structuredClone(known);
			const os = process.platform === "win32" ? "windows" : process.platform;
			const arch = process.arch === "x64" ? "amd64" : process.arch;
			const expected = `${manifestBase}${os}_${arch}.json`;
			const url = known.updateManifest?.replaceAll("{platform}", os).replaceAll("{arch}", arch);
			if (url !== expected) throw new Error("非官方更新清单地址");
			const raw = await fetchWithProgress(url, undefined, { redirect: "error", signal: AbortSignal.timeout(60_000) });
			const meta = JSON.parse(raw.toString());
			if (typeof meta.url !== "string") throw new Error("官方 binary 版本信息无效");
			const urlVersion = meta.url.startsWith(binaryBase) ? meta.url.slice(binaryBase.length).split("/")[0] : "";
			if (!versionOk(urlVersion) || (meta.version !== undefined && meta.version !== urlVersion)) throw new Error("官方 binary 版本信息无效");
			meta.version = urlVersion;
			const asset: NativeBinaryAsset = { url: meta.url, sha256: meta.sha256 ?? "", entry: "antigravity", archive: os === "windows" ? "binary" : "tar.gz" };
			const next: NativeRelease = { ...known, version: meta.version, integrity: asset.sha256, assets: { [`${process.platform}-${process.arch}`]: asset } };
			// 即使官方尚未发布摘要，也先验证 URL；无摘要只向界面报告版本。
			validateAntigravityAsset({ ...next, assets: { [`${process.platform}-${process.arch}`]: { ...asset, sha256: "0".repeat(64) } } });
			if (!asset.sha256) next.updateBlocked = "官方尚未提供 SHA256，暂不能更新，请等待 App 更新固定清单";
			else validateAntigravityAsset(next);
			return next;
		}
		const raw = await this.run({ args: ["view", `${known.packageName}@latest`, "--json"], cwd: this.root(id), env: this.npmEnvironment(id), signal: AbortSignal.timeout(60_000) });
		const meta = JSON.parse(raw);
		if (meta.name !== known.packageName || !npmVersionOk(meta.version) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(meta.dist?.integrity ?? "")) throw new Error("官方 npm 版本信息无效");
		return { packageName: meta.name, version: meta.version, integrity: meta.dist.integrity, bin: known.bin, executable: known.executable };
	}
	install(id: NativeAcpId, release = this.release(id)): Promise<NativeInstallation> {
		release = structuredClone(release);
		const existing = this.jobs.get(id);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const promise = trackDownload(`${this.options.downloadPrefix ?? "native"}:${id}`, async (progress) => {
			const root = this.root(id);
			const known = this.release(id);
			if (!versionOk(release.version) || (release.source !== "binary" && !npmVersionOk(release.version)) || release.packageName !== known.packageName || release.source !== known.source || release.updateBlocked || (release.source !== "binary" && !/^sha512-[A-Za-z0-9+/]+=*$/.test(release.integrity))) throw new Error(release.updateBlocked || "无效安装版本");
			if (release.source === "binary") {
				const asset = id === "antigravity" ? validateAntigravityAsset(release) : binaryAsset(release);
				if (id !== "antigravity") {
					const fixed = binaryAsset(known);
					if (release.version !== known.version || binaryAssetIdentity(asset) !== binaryAssetIdentity(fixed) || release.executable !== known.executable) throw new Error("binary 安装清单与固定版本或当前平台不符");
				}
			}
			const dependency = this.options.dependencies?.[id];
			if (dependency && dependency.installed(id)?.version !== dependency.release(id).version) {
				progress.detail("准备官方私有运行程序");
				await dependency.install(id);
			}
			controller.signal.throwIfAborted();
			const staging = join(root, `.staging-${randomUUID()}`);
			const target = join(root, release.version);
			mkdirSync(staging, { mode: 0o700 });
			try {
				if (release.source === "binary") {
					const asset = binaryAsset(release);
					progress.detail(`下载并校验 ${id}@${release.version}`);
					const bytes = await fetchWithProgress(asset.url, progress, { signal: controller.signal, redirect: id === "antigravity" ? "error" : "follow" });
					if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256.toLowerCase()) throw new Error("binary SHA256 校验失败");
					controller.signal.throwIfAborted();
					extractBinary(bytes, staging, release, id === "antigravity");
					const installedRelease = { ...release, integrity: asset.sha256.toLowerCase() };
					writeFileSync(join(staging, ".pia-installed.json"), JSON.stringify({ ...installedRelease, verified: false }));
					return this.activate(id, installedRelease, staging, target, controller.signal);
				}
				const env = this.npmEnvironment(id);
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
					npmLaunch(npmBinPath(staging, release.packageName, release.bin), release.executable);
					const pkg = JSON.parse(readFileSync(join(staging, "node_modules", release.packageName, "package.json"), "utf8"));
					if (pkg.version !== release.version) throw new Error("安装版本与请求版本不符");
					writeFileSync(join(staging, ".pia-installed.json"), JSON.stringify({ ...release, verified: false }));
					return this.activate(id, release, staging, target, controller.signal);
				});
			} finally { rmSync(staging, { recursive: true, force: true }); }
		}).finally(() => this.jobs.delete(id));
		this.jobs.set(id, { controller, promise });
		return promise;
	}
	cleanupOnStartup(): void {
		for (const id of this.ids) {
			this.options.dependencies?.[id]?.cleanupOnStartup();
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
		for (const id of this.ids) registerDownload({ id: `native:${id}`, name: NATIVE_ACP_AGENTS.find((agent) => agent.id === id)?.name ?? ({ "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity CLI" } as Record<string, string>)[id] ?? id, group: "编程工具", installed: () => !this.jobs.has(id) && !!this.installed(id), start: () => this.install(id), cancel: () => this.cancel(id) });
	}
}
