/**
 * macOS 自带运行时（DESIGN §15.2 第 2 步）：Lima 2.2.1 + vmType vz（Apple Virtualization.framework，macOS 13+，Apple 芯片 / Intel）。
 * - 一台共用虚拟机 `pia-desktop`（Debian 12 genericcloud），里面是 rootful containerd + nerdctl（nerdctl-full 2.4.1），
 *   每个助理一个桌面容器；容器端口发布在虚拟机里，Lima 自动转发到 Mac 的 127.0.0.1。
 * - limactl / 系统盘 / nerdctl-full 都由我们下载（断点续传 + 固定摘要校验 + 可选 GitHub 加速前缀），以本地路径交给 Lima；
 *   LIMA_HOME 是我们自己的目录，`mounts: []` 不挂载任何 Mac 文件夹。
 * - 硬性保护：只执行我们下载的 limactl（绝对路径，从不查 PATH），只对实例 `pia-desktop` 下命令（assertLimaArgs）。
 */
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { cpus, homedir, release, totalmem } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { downloadFile, registerDownload, trackDownload, type FileSpec, type Progress } from "../downloads.ts";
import { LIMA_INSTANCE } from "./names.ts";
import { desktopSettings } from "./settings.ts";
import { hostFacts, mergeInstanceResources, resolveResources, suggestResources, type VmResources } from "./resources.ts";

const run = promisify(execFile);
const GiB = 1024 ** 3;

// ---------------------------------------------------------------- 清单（third-party.json）
interface Asset { file: string; sha256?: string; sha512?: string; size: number }
interface Comp { name: string; version: string; repo?: string; base?: string; assets: Record<string, Asset> }
let manifestCache: Record<string, Comp> | null = null;
export function vmManifest() {
	if (manifestCache) return manifestCache;
	const j = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "third-party.json"), "utf8")) as { components: Comp[] };
	const get = (n: string) => {
		const c = j.components.find((x) => x.name === n);
		if (!c) throw new Error(`third-party.json 缺少 ${n}`);
		return c;
	};
	return (manifestCache = { lima: get("lima"), nerdctl: get("nerdctl-full"), debian: get("debian-12-genericcloud") });
}

/** Mac 的 CPU 架构 → 清单键 / Lima 架构名 */
export function archKeys(arch = process.arch) {
	if (arch === "arm64") return { host: "darwin-arm64", guest: "linux-arm64", lima: "aarch64" as const };
	if (arch === "x64") return { host: "darwin-x64", guest: "linux-x64", lima: "x86_64" as const };
	throw new Error(`不支持的 CPU 架构：${arch}`);
}

// ---------------------------------------------------------------- 目录
export const vmDir = () => join(config.dataDir, "vm");
/**
 * LIMA_HOME：默认在数据目录里；但 Lima 的 ssh 控制套接字路径受 macOS 104 字节限制，且数据目录在 “Application Support”（含空格），
 * 这时改用家目录下的短路径 ~/.pia-vm（仍然是我们独占的目录，从不使用用户自己的 ~/.lima）。
 */
export function limaHome(dataVm = vmDir(), home = homedir()) {
	if (process.env.PIA_LIMA_HOME) return resolve(process.env.PIA_LIMA_HOME);
	const inData = join(dataVm, "lima");
	return /\s/.test(inData) || inData.length > 60 ? join(home, ".pia-vm") : inData;
}
export const limaDistDir = () => join(vmDir(), "dist", `lima-${vmManifest().lima.version}`);
/** 我们自己下载的 limactl（绝对路径）。测试可用 PIA_LIMACTL 指向假 limactl */
export const limactlPath = () => process.env.PIA_LIMACTL ?? join(limaDistDir(), "bin", "limactl");
const filesDir = () => join(vmDir(), "files");
export const configPath = () => join(vmDir(), `${LIMA_INSTANCE}.yaml`);
const markerPath = () => join(vmDir(), "image.ok");

// ---------------------------------------------------------------- 要下载的文件
export function githubUrls(repo: string, version: string, file: string, mirror: string) {
	const url = `https://github.com/${repo}/releases/download/v${version}/${file}`;
	return mirror ? [`${mirror}${url}`, url] : [url];
}
export function vmFiles(arch = process.arch, mirror = desktopSettings().fileMirror): (FileSpec & { id: string; label: string })[] {
	const m = vmManifest();
	const k = archKeys(arch);
	const v = (s: string, ver: string) => s.replaceAll("{v}", ver);
	const la = m.lima.assets[k.host];
	const na = m.nerdctl.assets[k.guest];
	const da = m.debian.assets[k.guest];
	const debFile = v(da.file, m.debian.version);
	const debUrls = [v(m.debian.base!, m.debian.version) + debFile];
	if (process.env.PIA_DEBIAN_MIRROR) debUrls.unshift(`${process.env.PIA_DEBIAN_MIRROR.replace(/\/+$/, "")}/${m.debian.version}/${debFile}`);
	return [
		{ id: "lima", label: `Lima ${m.lima.version}`, urls: githubUrls(m.lima.repo!, m.lima.version, v(la.file, m.lima.version), mirror), dest: join(filesDir(), v(la.file, m.lima.version)), algo: "sha256", digest: la.sha256!, size: la.size },
		{ id: "nerdctl", label: `containerd / nerdctl ${m.nerdctl.version}`, urls: githubUrls(m.nerdctl.repo!, m.nerdctl.version, v(na.file, m.nerdctl.version), mirror), dest: join(filesDir(), v(na.file, m.nerdctl.version)), algo: "sha256", digest: na.sha256!, size: na.size },
		{ id: "debian", label: `Debian 12（${m.debian.version}）`, urls: debUrls, dest: join(filesDir(), debFile), algo: "sha512", digest: da.sha512!, size: da.size },
	];
}
const filesReady = () => {
	try {
		return vmFiles().every((f) => existsSync(f.dest) && existsSync(`${f.dest}.ok`) && readFileSync(`${f.dest}.ok`, "utf8").trim() === f.digest) && existsSync(limactlPath());
	} catch {
		return false;
	}
};

// ---------------------------------------------------------------- Lima 配置（纯函数，单测 + macOS CI 上 limactl validate）
export interface LimaConfigInput {
	/** 只有 vz（macOS）；qemu 仅用于在 Linux 上做真实虚拟机冒烟测试（PIA_LIMA_VMTYPE=qemu） */
	vmType?: "vz" | "qemu";
	arch: "aarch64" | "x86_64";
	imagePath: string;
	imageDigest: string; // sha512 hex
	nerdctlPath: string;
	nerdctlDigest: string; // sha256 hex
	cpus: number;
	memoryGiB: number;
	diskGiB: number;
}
const q = (s: string) => JSON.stringify(s); // YAML 兼容的双引号字符串（路径可能有空格）
export function limaConfig(i: LimaConfigInput) {
	return [
		"# 由 Pi Assistant 生成，请勿手改（每次开机前按固定版本重写）",
		`vmType: ${i.vmType ?? "vz"}`,
		`arch: ${i.arch}`,
		`cpus: ${i.cpus}`,
		`memory: ${q(`${i.memoryGiB}GiB`)}`,
		`disk: ${q(`${i.diskGiB}GiB`)}`,
		"images:",
		`- location: ${q(i.imagePath)}`,
		`  arch: ${i.arch}`,
		`  digest: ${q(`sha512:${i.imageDigest}`)}`,
		"# 不挂载任何 Mac 文件夹",
		"mounts: []",
		"containerd:",
		"  system: true",
		"  user: false",
		"  archives:",
		`  - location: ${q(i.nerdctlPath)}`,
		`    arch: ${i.arch}`,
		`    digest: ${q(`sha256:${i.nerdctlDigest}`)}`,
		"ssh:",
		"  loadDotSSHPubKeys: false",
		"  forwardAgent: false",
		"  forwardX11: false",
		"# 容器端口只转发到 Mac 的 127.0.0.1（Lima 默认 hostIP 就是 127.0.0.1，这里写死）",
		"portForwards:",
		"- guestIP: 0.0.0.0",
		"  guestPortRange: [1024, 65535]",
		"  hostIP: 127.0.0.1",
		"- guestIP: 127.0.0.1",
		"  guestPortRange: [1024, 65535]",
		"  hostIP: 127.0.0.1",
		"",
	].join("\n");
}
/** 按这台 Mac 的配置算虚拟机大小：内存 = 总内存一半，4–8 GiB；CPU = 核数 − 2，2–4 个；磁盘 40 GiB（稀疏文件，用多少占多少） */
export function vmSize(total = totalmem(), ncpu = cpus().length) {
	return suggestResources(hostFacts(ncpu, total));
}
/** 现有实例 lima.yaml 里的资源（用户没自定义时尊重它，不强行升降配）；只返回读到的正整数字段，读不到返回 null */
export function instanceResources(instYaml = join(limaHome(), LIMA_INSTANCE, "lima.yaml")): Partial<VmResources> | null {
	if (!existsSync(instYaml)) return null;
	try {
		const text = readFileSync(instYaml, "utf8");
		const num = (re: RegExp) => {
			const m = re.exec(text);
			const n = m ? Number(m[1]) : Number.NaN;
			return Number.isFinite(n) && n > 0 ? n : undefined;
		};
		const out: Partial<VmResources> = {};
		const cpus = num(/^cpus:\s*(\d+)\s*$/m);
		const memoryGiB = num(/^memory:\s*"?(\d+)GiB"?\s*$/m);
		const diskGiB = num(/^disk:\s*"?(\d+)GiB"?\s*$/m);
		if (cpus !== undefined) out.cpus = cpus;
		if (memoryGiB !== undefined) out.memoryGiB = memoryGiB;
		if (diskGiB !== undefined) out.diskGiB = diskGiB;
		return Object.keys(out).length ? out : null;
	} catch {
		return null;
	}
}
export function currentConfig(arch = process.arch) {
	const size = resolveResources(desktopSettings().resources);
	if (process.env.PIA_LIMA_MEMORY_GIB) size.memoryGiB = Number(process.env.PIA_LIMA_MEMORY_GIB);
	return buildConfig(arch, size);
}
/** 写配置时把“用户选择 / 现有值 / 建议值”合并；existing 只含读到的正整数字段，可为 null */
export function configForInstance(arch = process.arch, existing: Partial<VmResources> | null = null) {
	const merged = mergeInstanceResources(desktopSettings().resources, existing);
	if (process.env.PIA_LIMA_MEMORY_GIB) merged.memoryGiB = Number(process.env.PIA_LIMA_MEMORY_GIB);
	return buildConfig(arch, merged);
}
function buildConfig(arch: NodeJS.Architecture, size: VmResources) {
	const k = archKeys(arch);
	const f = vmFiles(arch);
	const nd = f.find((x) => x.id === "nerdctl")!;
	const db = f.find((x) => x.id === "debian")!;
	return limaConfig({ vmType: process.env.PIA_LIMA_VMTYPE === "qemu" ? "qemu" : "vz", arch: k.lima, imagePath: db.dest, imageDigest: db.digest, nerdctlPath: nd.dest, nerdctlDigest: nd.digest, cpus: size.cpus, memoryGiB: size.memoryGiB, diskGiB: size.diskGiB });
}

// ---------------------------------------------------------------- 环境检测（纯函数）
export interface MacFacts { platform: string; release: string; arch: string; hvSupport: boolean | null }
export function checkMac(f: MacFacts): { ok: boolean; reason?: string } {
	if (f.platform !== "darwin") return { ok: false, reason: "Lima 虚拟机只用于 macOS" };
	const major = Number(f.release.split(".")[0]);
	if (!(major >= 22)) return { ok: false, reason: "助理电脑需要 macOS 13（Ventura）或更新版本，请先升级系统，或在 设置 › 助理电脑 里改用已安装的 Docker" };
	if (f.arch !== "arm64" && f.arch !== "x64") return { ok: false, reason: `不支持这台 Mac 的 CPU 架构（${f.arch}）` };
	if (f.hvSupport === false) return { ok: false, reason: "这台 Mac 没有开启硬件虚拟化（常见于 Mac 本身运行在虚拟机里），无法运行助理电脑；可以改用已安装的 Docker" };
	return { ok: true };
}
async function hvSupport(): Promise<boolean | null> {
	try {
		const { stdout } = await run("/usr/sbin/sysctl", ["-n", "kern.hv_support"], { timeout: 5000 });
		return String(stdout).trim() === "1";
	} catch {
		return null; // 读不到就不拦，交给 Lima 报错
	}
}
/** 磁盘空间：要下载的剩余字节 + 虚拟机运行余量（镜像解压、容器层、家目录）。不够时给出中文说明 */
export function diskShortfall(freeBytes: number, missingDownloadBytes: number, vmExists: boolean) {
	const need = missingDownloadBytes + (vmExists ? 2 : 8) * GiB;
	return freeBytes >= need ? null : `磁盘空间不足：助理电脑还需要约 ${(need / GiB).toFixed(1)} GB，当前只剩 ${(freeBytes / GiB).toFixed(1)} GB。请清理磁盘后再试`;
}
function freeBytes(dir: string) {
	let d = dir;
	while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
	const s = statfsSync(d);
	return Number(s.bavail) * Number(s.bsize);
}

// ---------------------------------------------------------------- 硬性保护：limactl 只对 pia-desktop
const LIMA_SUBS = new Set(["list", "create", "start", "stop", "delete", "shell", "validate", "info", "--version"]);
export function assertLimaArgs(args: string[]) {
	const sub = args[0];
	if (!LIMA_SUBS.has(sub)) throw new Error(`拒绝执行 limactl ${sub}`);
	if (sub === "info" || sub === "--version") return;
	if (sub === "validate") {
		if (args.length !== 2 || resolve(args[1]) !== resolve(configPath())) throw new Error("拒绝校验不属于 Pi Assistant 的 Lima 配置");
		return;
	}
	if (sub === "create") {
		// limactl create --name=pia-desktop --tty=false <我们的配置文件>
		const name = args.find((a) => a.startsWith("--name="))?.slice(7);
		const files = args.slice(1).filter((a) => !a.startsWith("-"));
		if (name !== LIMA_INSTANCE || files.length !== 1 || resolve(files[0]) !== resolve(configPath())) throw new Error(`拒绝操作不属于 Pi Assistant 的 Lima 实例：${name ?? "(未命名)"}`);
		return;
	}
	// 其他子命令：第一个非选项参数必须是我们的实例（shell 之后的是虚拟机里的命令）
	const rest = args.slice(1);
	const i = rest.findIndex((a, j) => !a.startsWith("-") && !(sub === "shell" && rest[j - 1] === "--workdir"));
	if (i < 0 || rest[i] !== LIMA_INSTANCE) throw new Error(`拒绝操作不属于 Pi Assistant 的 Lima 实例：${i < 0 ? "(未指定)" : rest[i]}`);
	if (sub !== "shell" && rest.slice(i + 1).some((a) => !a.startsWith("-"))) throw new Error("拒绝：一次只能操作 Pi Assistant 自己的实例");
}
/** 运行我们自己的 limactl（绝对路径 + 我们的 LIMA_HOME；清掉用户环境里会改变行为的 LIMA_* 变量） */
export function limaEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("LIMA_")) env[k] = v;
	env.LIMA_HOME = limaHome();
	return env;
}
export function limactl(args: string[], timeout = 60_000) {
	assertLimaArgs(args);
	return run(limactlPath(), args, { env: limaEnv(), timeout, maxBuffer: 16 * 1024 * 1024 });
}
/** docker 兼容命令前缀：limactl shell pia-desktop sudo nerdctl …（通过 env 带上 LIMA_HOME，调用方无需关心） */
export function nerdctlCli() {
	return ["/usr/bin/env", `LIMA_HOME=${limaHome()}`, limactlPath(), "shell", "--workdir", "/", LIMA_INSTANCE, "sudo", "nerdctl"];
}

// ---------------------------------------------------------------- 实例状态
export type VmState = "missing" | "stopped" | "running" | "broken";
export function parseLimaList(stdout: string): VmState {
	for (const line of stdout.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("{")) continue;
		try {
			const j = JSON.parse(t) as { name?: string; status?: string };
			if (j.name !== LIMA_INSTANCE) continue;
			return j.status === "Running" ? "running" : j.status === "Stopped" ? "stopped" : "broken";
		} catch {}
	}
	return "missing";
}
export async function vmState(): Promise<VmState> {
	if (!existsSync(limactlPath())) return "missing";
	try {
		const { stdout } = await limactl(["list", "--json", LIMA_INSTANCE], 20_000);
		return parseLimaList(String(stdout));
	} catch (e) {
		if (/No instance|not found|does not exist/i.test(String((e as { stderr?: string }).stderr ?? e))) return "missing";
		return "broken";
	}
}

// ---------------------------------------------------------------- 阶段（给界面显示“正在启动虚拟机”等）
export type VmPhase = "idle" | "downloading" | "creating" | "booting" | "running" | "stopping" | "error";
let phase: { phase: VmPhase; detail?: string } = { phase: "idle" };
export const vmPhase = () => phase;
const setPhase = (p: VmPhase, detail?: string) => (phase = { phase: p, detail });

// ---------------------------------------------------------------- 下载
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
registerDownload({
	id: "desktop-vm",
	name: "助理电脑虚拟机（Lima + Debian 12 + containerd）",
	group: "助理电脑",
	size: (() => {
		try {
			return sum(vmFiles(process.arch === "x64" ? "x64" : "arm64", "").map((f) => f.size ?? 0));
		} catch {
			return 0.65e9;
		}
	})(),
	installed: filesReady,
	start: () => ensureVmFiles(),
	hidden: () => process.platform !== "darwin" || desktopSettings().backend === "docker",
});
let filesInflight: Promise<void> | null = null;
let abort: AbortController | null = null;
export function ensureVmFiles(): Promise<void> {
	if (filesReady()) return Promise.resolve();
	filesInflight ??= trackDownload("desktop-vm", (p) => downloadAll(p)).finally(() => ((filesInflight = null), (abort = null)));
	return filesInflight;
}
export function cancelVmDownload() {
	abort?.abort();
}
async function downloadAll(p: Progress) {
	const files = vmFiles();
	const missing = files.filter((f) => !(existsSync(f.dest) && existsSync(`${f.dest}.ok`)));
	const miss = sum(missing.map((f) => f.size ?? 0));
	const short = diskShortfall(freeBytes(vmDir()), miss, (await vmState().catch(() => "missing")) !== "missing");
	if (short) throw new Error(short);
	abort = new AbortController();
	setPhase("downloading");
	const total = sum(files.map((f) => f.size ?? 0));
	let doneBefore = sum(files.filter((f) => !missing.includes(f)).map((f) => f.size ?? 0));
	for (const f of missing) {
		const base = doneBefore;
		p.detail(`正在下载 ${f.label}`);
		await downloadFile(f, { bytes: (r) => p.bytes(base + r, total), detail: (t) => p.detail(`${f.label}：${t}`) }, { signal: abort.signal }).catch((e) => {
			throw new Error(`${f.label} 下载失败：${e instanceof Error ? e.message : e}`);
		});
		doneBefore += f.size ?? 0;
	}
	p.bytes(total, total);
	if (!existsSync(limactlPath())) {
		p.detail("正在解压 Lima…");
		const tgz = files.find((f) => f.id === "lima")!.dest;
		const dist = limaDistDir();
		const tmp = `${dist}.tmp`;
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		await run("/usr/bin/tar", ["xzf", tgz, "-C", tmp], { timeout: 120_000 });
		if (!existsSync(join(tmp, "bin", "limactl"))) throw new Error("Lima 安装包内容不完整");
		chmodSync(join(tmp, "bin", "limactl"), 0o755);
		// 去掉隔离属性（不是从浏览器下载的，一般没有；有的话 Gatekeeper 会拦）
		await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", tmp]).catch(() => {});
		rmSync(dist, { recursive: true, force: true });
		renameSync(tmp, dist);
	}
	cleanupOldVersions(files);
	setPhase("idle");
}
/** 升级固定版本后：删掉旧版本的 limactl 目录和旧下载文件（不动虚拟机本身） */
function cleanupOldVersions(files: FileSpec[]) {
	const keep = new Set(files.flatMap((f) => [f.dest, `${f.dest}.ok`, `${f.dest}.part`]));
	try {
		for (const n of readdirSync(filesDir())) if (!keep.has(join(filesDir(), n))) rmSync(join(filesDir(), n), { force: true });
		const distRoot = join(vmDir(), "dist");
		for (const n of readdirSync(distRoot)) if (join(distRoot, n) !== limaDistDir()) rmSync(join(distRoot, n), { recursive: true, force: true });
	} catch {}
}

// ---------------------------------------------------------------- 开机 / 关机 / 删除
async function engineHealthy(timeout = 30_000) {
	const cli = nerdctlCli();
	try {
		// nerdctl 没有 .Server.Version（只有 .Server.Components），用 {{json .Server}} 判断 containerd 是否在响应
		const { stdout } = await run(cli[0], [...cli.slice(1), "version", "--format", "{{json .Server}}"], { timeout });
		return /containerd/i.test(String(stdout));
	} catch {
		return false;
	}
}
/** 关机状态下把配置同步成当前固定版本 + 用户选择的资源（升级 / 内存变化）；运行中不改 */
function syncInstanceConfig() {
	const inst = join(limaHome(), LIMA_INSTANCE, "lima.yaml");
	const want = configForInstance(process.arch, instanceResources(inst));
	writeFileSync(configPath(), want);
	if (existsSync(inst) && readFileSync(inst, "utf8") !== want) writeFileSync(inst, want);
}
let bootInflight: Promise<void> | null = null;
/** 确保虚拟机在跑、里面的容器引擎可用（并发调用合并） */
export function ensureVm(): Promise<void> {
	bootInflight ??= bootVm()
		.then(() => void setPhase("running"))
		.catch((e) => {
			setPhase("error", e instanceof Error ? e.message : String(e));
			throw e;
		})
		.finally(() => (bootInflight = null));
	return bootInflight;
}
async function bootVm() {
	await ensureVmFiles();
	mkdirSync(limaHome(), { recursive: true });
	let st = await vmState();
	if (st === "running") {
		if (await engineHealthy()) return;
		// 睡眠唤醒 / 虚拟机里 containerd 卡住：强制关机再开
		console.warn("[lima] 虚拟机在运行但容器引擎没响应，重启虚拟机");
		setPhase("booting", "虚拟机没响应，正在重启");
		await limactl(["stop", "--force", LIMA_INSTANCE], 120_000).catch(() => {});
		st = "stopped";
	}
	if (st === "broken") {
		// 异常退出（Mac 崩溃、强制退出）留下的残留进程 / pid 文件
		await limactl(["stop", "--force", LIMA_INSTANCE], 120_000).catch(() => {});
		st = await vmState();
		if (st === "broken") throw new Error("助理电脑虚拟机状态异常，可以在 设置 › 助理电脑 关闭后选“删除虚拟机和镜像”再重新开启");
	}
	const short = diskShortfall(freeBytes(limaHome()), 0, st !== "missing");
	if (short) throw new Error(short);
	syncInstanceConfig();
	if (st === "missing") {
		setPhase("creating", "正在创建虚拟机");
		await limactl(["create", `--name=${LIMA_INSTANCE}`, "--tty=false", configPath()], 10 * 60_000).catch((e) => {
			throw new Error(`创建虚拟机失败：${limaErr(e)}`);
		});
	}
	setPhase("booting", st === "missing" ? "第一次开机，正在安装容器引擎（约 1–3 分钟）" : "正在启动虚拟机");
	await limactl(["start", "--tty=false", "--timeout=10m", LIMA_INSTANCE], 11 * 60_000).catch((e) => {
		throw new Error(`虚拟机启动失败：${limaErr(e)}`);
	});
	for (let i = 0; i < 60; i++) {
		if (await engineHealthy(15_000)) return;
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error("虚拟机已开机，但里面的容器引擎没有就绪");
}
export function limaErr(e: unknown) {
	const s = String((e as { stderr?: string }).stderr || (e as Error)?.message || e);
	if (/Virtualization\.framework|VZErrorDomain|vz.*not supported/i.test(s)) return "macOS 虚拟化不可用（需要 macOS 13+，且不能在虚拟机里的 macOS 上运行）";
	if (/no space left|ENOSPC/i.test(s)) return "磁盘空间不足";
	if (/timed? ?out|deadline/i.test(s)) return "等待超时，请稍后重试";
	const last = s.trim().split("\n").filter(Boolean).slice(-2).join(" ").replace(/time="[^"]*" level=\w+ msg=/g, "");
	return last.slice(0, 300) || "未知错误";
}
export async function stopVm() {
	if ((await vmState()) !== "running") return;
	setPhase("stopping");
	await limactl(["stop", LIMA_INSTANCE], 120_000).catch(() => limactl(["stop", "--force", LIMA_INSTANCE], 60_000).catch(() => {}));
	setPhase("idle");
}
/** App 退出时：不等，交给独立进程去关虚拟机（关机要几十秒） */
export function stopVmDetached() {
	if (!existsSync(limactlPath())) return;
	try {
		assertLimaArgs(["stop", LIMA_INSTANCE]);
		spawn(limactlPath(), ["stop", LIMA_INSTANCE], { env: limaEnv(), detached: true, stdio: "ignore" }).unref();
	} catch {}
}
/** 删除虚拟机 + 我们下载的所有文件（LIMA_HOME 只在确认是我们自己的目录时整个删除） */
export async function destroyVm() {
	cancelVmDownload();
	if (existsSync(limactlPath())) await limactl(["delete", "--force", LIMA_INSTANCE], 120_000).catch(() => {});
	const home = limaHome();
	if (isOwnLimaHome(home)) rmSync(home, { recursive: true, force: true });
	rmSync(vmDir(), { recursive: true, force: true });
	setPhase("idle");
}
export function isOwnLimaHome(home: string, dataVm = vmDir(), userHome = homedir()) {
	const h = resolve(home);
	return h === join(userHome, ".pia-vm") || h.startsWith(resolve(dataVm) + sep) || (!!process.env.PIA_LIMA_HOME && h === resolve(process.env.PIA_LIMA_HOME));
}

// ---------------------------------------------------------------- 镜像已下载标记（虚拟机关机时也能知道“已安装”）
export const imageMarked = (ref: string) => existsSync(markerPath()) && readFileSync(markerPath(), "utf8").trim() === ref;
export function markImage(ref: string | null) {
	if (ref === null) return rmSync(markerPath(), { force: true });
	mkdirSync(vmDir(), { recursive: true });
	writeFileSync(markerPath(), ref);
}

// ---------------------------------------------------------------- 检测
export async function detectLima() {
	if (process.env.PIA_TEST_LIMA === "1") return { ok: true };
	const r = checkMac({ platform: process.platform, release: release(), arch: process.arch, hvSupport: process.platform === "darwin" ? await hvSupport() : null });
	return r;
}
