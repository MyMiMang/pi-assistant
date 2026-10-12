/**
 * Hindsight 附属进程：我们自己的 uv + 我们自己的 Python 环境 + 我们自己的数据目录 + 每次随机端口。
 *
 * 隔离（DESIGN.md §5.19）：
 *  - hindsight-embed / pg0 的所有“默认路径”都基于 HOME（~/.hindsight、~/.pg0），所以给附属进程单独的 HOME =
 *    数据目录/hindsight/home；uv 缓存、Python、HuggingFace 缓存、flashrank 模型也都在 数据目录/hindsight 下
 *  - 只用 数据目录/bin 里（或安装包内置）的固定版本 uv；清掉外部 PYTHONPATH / VIRTUAL_ENV / UV_* / CONDA 等变量
 *  - 端口每次启动动态挑选，只监听 127.0.0.1；开启 Hindsight 的 API Key 租户扩展，用我们生成的密钥握手，
 *    确认连上的是我们自己拉起的进程；从不连接默认端口 8888 上已有的实例
 *  - 模型调用走本机网关（llm-proxy），令牌每次启动随机；密钥不写进 Hindsight 配置
 * 生命周期：按需安装 → 启动 → 每 20 秒健康检查 → 崩溃按退避重启；服务退出时停止。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fetchWithProgress, registerDownload, trackDownload, watchDir } from "../../downloads.ts";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { HindsightServer } from "@vectorize-io/hindsight-all";
import { bus } from "../../bus.ts";
import { config } from "../../config.ts";
import { db } from "../../db.ts";
import { llmProxy } from "../../llm-proxy.ts";
import { ensureUv } from "./uv-bin.ts";
import { readZip } from "./zip.ts";
import { hindsightSecrets, hindsightSettings, LOCAL_EMBEDDINGS, LOCAL_RERANKERS, pickMemoryModel, type HindsightSecrets, type HindsightSettings, type Mirror } from "./settings.ts";

export const PROFILE = "pia";
export const MEMORY_MODEL_ALIAS = "memory";
const PROJECT_SRC = join(import.meta.dirname, "..", "..", "..", "hindsight");

export const paths = () => {
	const root = join(config.dataDir, "hindsight");
	return {
		root,
		project: join(root, "project"),
		home: join(root, "home"),
		uvCache: join(root, "uv-cache"),
		python: join(root, "python"),
		uvTools: join(root, "uv-tools"),
		hf: join(root, "models", "hf"),
		flashrank: join(root, "models", "flashrank"),
		xdg: join(root, "xdg"),
		log: join(root, "home", ".hindsight", "profiles", `${PROFILE}.log`),
	};
};

export const MIRRORS = {
	official: { pypi: "https://pypi.org/simple", hf: "https://huggingface.co", python: undefined as string | undefined },
	china: { pypi: "https://pypi.tuna.tsinghua.edu.cn/simple", hf: "https://hf-mirror.com", python: "https://registry.npmmirror.com/-/binary/python-build-standalone" },
};
const CHINA_PYPI_FALLBACK = "https://mirrors.aliyun.com/pypi/simple";

async function reachable(url: string, ms = 4000) {
	try {
		const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(ms) });
		return r.status < 500;
	} catch {
		return false;
	}
}
/** auto：官方源 4 秒内连得上就用官方，否则用国内镜像 */
export async function resolveMirror(m: Mirror): Promise<"official" | "china"> {
	if (m !== "auto") return m;
	const [pypi, hf] = await Promise.all([reachable("https://pypi.org/simple/uv/"), reachable("https://huggingface.co/api/models/intfloat/multilingual-e5-small")]);
	return pypi && hf ? "official" : "china";
}

/** 外部环境里会干扰我们 Python/uv 的变量：一律清空 */
const SCRUB = /^(PYTHON[A-Z_]*|VIRTUAL_ENV|CONDA_[A-Z_]*|PIP_[A-Z_]*|UV_[A-Z_]*|HF_[A-Z_]*|HUGGINGFACE_[A-Z_]*|TRANSFORMERS_[A-Z_]*|HINDSIGHT_[A-Z_]*|OPENAI_[A-Z_]*|XDG_[A-Z_]*)$/;

/** 附属进程的完整环境（导出给隔离测试用） */
export function sidecarEnv(o: { s: HindsightSettings; sec: HindsightSecrets; mirror: "official" | "china"; proxyUrl: string; proxyToken: string; uvDir: string }): Record<string, string | undefined> {
	const p = paths();
	const mir = MIRRORS[o.mirror];
	const scrub: Record<string, string> = {};
	for (const k of Object.keys(process.env)) if (SCRUB.test(k)) scrub[k] = "";
	const e: Record<string, string | undefined> = {
		...scrub,
		HOME: p.home,
		USERPROFILE: p.home,
		XDG_CONFIG_HOME: join(p.xdg, "config"),
		XDG_CACHE_HOME: join(p.xdg, "cache"),
		XDG_DATA_HOME: join(p.xdg, "data"),
		PATH: [o.uvDir, ...(process.env.PATH ?? "").split(delimiter).filter((d) => d && d !== o.uvDir)].join(delimiter),
		UV_CACHE_DIR: p.uvCache,
		UV_PYTHON_INSTALL_DIR: p.python,
		UV_TOOL_DIR: p.uvTools,
		UV_PYTHON_PREFERENCE: "only-managed",
		UV_NO_CONFIG: "1",
		UV_DEFAULT_INDEX: mir.pypi,
		UV_PYTHON_INSTALL_MIRROR: mir.python,
		UV_FROZEN: "1",
		UV_PYTHON: "3.12",
		HF_HOME: p.hf,
		HF_ENDPOINT: mir.hf,
		HF_HUB_DISABLE_TELEMETRY: "1",
		// —— Hindsight 配置 ——
		HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT: "0",
		HINDSIGHT_API_HOST: "127.0.0.1",
		HINDSIGHT_API_TENANT_EXTENSION: "hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension",
		HINDSIGHT_API_TENANT_API_KEY: o.sec.tenantKey,
		HINDSIGHT_API_MCP_ENABLED: "false",
		HINDSIGHT_API_LLM_PROVIDER: "openai",
		HINDSIGHT_API_LLM_BASE_URL: o.proxyUrl,
		HINDSIGHT_API_LLM_API_KEY: o.proxyToken,
		HINDSIGHT_API_LLM_MODEL: MEMORY_MODEL_ALIAS,
		HINDSIGHT_API_LLM_OPENAI_COMPATIBLE_JSON_MODE: "true",
		HINDSIGHT_API_LLM_STRICT_SCHEMA: "false",
		HINDSIGHT_API_SKIP_LLM_VERIFICATION: "true",
		HINDSIGHT_API_LLM_OUTPUT_LANGUAGE: undefined,
	};
	const emb = o.s.embedding;
	if (emb.kind === "local") {
		e.HINDSIGHT_API_EMBEDDINGS_PROVIDER = "onnx";
		e.HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID = emb.model;
		if (emb.model === "BAAI/bge-m3") Object.assign(e, { HINDSIGHT_API_EMBEDDINGS_ONNX_POOLING: "cls", HINDSIGHT_API_EMBEDDINGS_ONNX_QUERY_PREFIX: "", HINDSIGHT_API_EMBEDDINGS_ONNX_PASSAGE_PREFIX: "", HINDSIGHT_API_EMBEDDINGS_ONNX_MAX_TOKENS: "1024" });
	} else {
		Object.assign(e, { HINDSIGHT_API_EMBEDDINGS_PROVIDER: "openai", HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: emb.baseUrl, HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: emb.model, HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: o.sec.embeddingKey ?? "none" });
		if (emb.dimensions) e.HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS = String(emb.dimensions);
	}
	const rr = o.s.reranker;
	if (rr.kind === "off") e.HINDSIGHT_API_RERANKER_PROVIDER = "rrf";
	else if (rr.kind === "local") Object.assign(e, { HINDSIGHT_API_RERANKER_PROVIDER: "flashrank", HINDSIGHT_API_RERANKER_FLASHRANK_MODEL: rr.model, HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR: p.flashrank });
	else if (rr.kind === "siliconflow") Object.assign(e, { HINDSIGHT_API_RERANKER_PROVIDER: "siliconflow", HINDSIGHT_API_RERANKER_SILICONFLOW_MODEL: rr.model, HINDSIGHT_API_RERANKER_SILICONFLOW_API_KEY: o.sec.rerankerKey, HINDSIGHT_API_RERANKER_SILICONFLOW_BASE_URL: rr.baseUrl });
	else if (rr.kind === "alibaba") Object.assign(e, { HINDSIGHT_API_RERANKER_PROVIDER: "alibaba", HINDSIGHT_API_RERANKER_ALIBABA_MODEL: rr.model, HINDSIGHT_API_RERANKER_ALIBABA_API_KEY: o.sec.rerankerKey });
	return e;
}

/** 记忆用模型：设置里选的；没选就自动挑（同渠道便宜快速的）。每次请求时解析，换模型不用重启 Hindsight */
export async function configuredModels() {
	const { models } = await import("../../models.ts");
	return models.listProviders().filter((p) => p.configured).flatMap((p) => models.listModels(p.id));
}
let cachedModels: { provider: string; id: string; reasoning?: boolean }[] = [];
let cachedAt = 0;
export function resolveMemoryModel(): { provider: string; id: string } | null {
	const s = hindsightSettings();
	if (s.llm) return s.llm;
	if (Date.now() - cachedAt > 30_000) {
		cachedAt = Date.now();
		void configuredModels().then((l) => (cachedModels = l));
	}
	return pickMemoryModel(cachedModels, chatDefault());
}
let chatDefault: () => { provider: string; id: string } | null = () => null;
export const setChatDefault = (f: typeof chatDefault) => (chatDefault = f);

export type SidecarState = "off" | "installing" | "starting" | "ready" | "down" | "error";
export interface SidecarStatus {
	state: SidecarState;
	detail: string;
	baseUrl?: string;
	port?: number;
	since: number;
	restarts: number;
	mirror?: "official" | "china";
	log?: string;
}

const freePort = () =>
	new Promise<number>((ok, bad) => {
		const s = createServer();
		s.once("error", bad);
		s.listen(0, "127.0.0.1", () => {
			const port = (s.address() as { port: number }).port;
			s.close(() => ok(port));
		});
	});

function run(cmd: string, args: string[], env: Record<string, string | undefined>, onLine: (l: string) => void, timeoutMs = 30 * 60_000) {
	return new Promise<void>((ok, bad) => {
		const clean = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>;
		const child = spawn(cmd, args, { env: clean, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let tail = "";
		const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		const feed = (b: Buffer) => {
			const s = b.toString();
			tail = (tail + s).slice(-4000);
			for (const l of s.split(/\r?\n/)) if (l.trim()) onLine(l.trim());
		};
		child.stdout.on("data", feed);
		child.stderr.on("data", feed);
		child.on("error", (e) => (clearTimeout(t), bad(e)));
		child.on("exit", (code) => (clearTimeout(t), code === 0 ? ok() : bad(new Error(`${cmd} ${args[0]} 失败（${code}）：${tail.split("\n").slice(-6).join(" ")}`))));
	});
}

const fileHash = (...files: string[]) => createHash("sha256").update(files.map((f) => (existsSync(f) ? readFileSync(f, "utf8") : "")).join("\0")).digest("hex").slice(0, 16);

class Sidecar {
	status: SidecarStatus = { state: "off", detail: "未启用", since: Date.now(), restarts: 0 };
	private server: HindsightServer | null = null;
	private starting: Promise<void> | null = null;
	private timer: NodeJS.Timeout | null = null;
	private fails = 0;
	private wanted = false;
	private backoff = 0;
	/** 测试可替换：拿到 env 后真正启动守护进程 */
	launcher: (o: { port: number; env: Record<string, string | undefined>; project: string; onLog: (l: string) => void }) => Promise<{ stop: () => Promise<void> }> = async (o) => {
		const s = new HindsightServer({
			profile: PROFILE,
			port: o.port,
			embedPackagePath: o.project,
			env: o.env,
			readyTimeoutMs: 15 * 60_000,
			readyPollIntervalMs: 2000,
			platformCpuWorkaround: true,
			logger: { debug: () => {}, info: o.onLog, warn: o.onLog, error: o.onLog },
		});
		await s.start();
		return { stop: () => s.stop() };
	};
	private handle: { stop: () => Promise<void> } | null = null;

	private lastEmit = 0;
	private emitTimer: NodeJS.Timeout | null = null;
	private set(state: SidecarState, detail: string, extra: Partial<SidecarStatus> = {}) {
		const changed = state !== this.status.state;
		this.status = { ...this.status, ...extra, state, detail, since: changed ? Date.now() : this.status.since };
		// 状态变化立即推送；同一状态下的进度文字最多每秒推一次
		const emit = () => {
			this.lastEmit = Date.now();
			this.emitTimer = null;
			bus.emit({ type: "memory.hindsight", status: this.status });
		};
		if (changed || Date.now() - this.lastEmit > 1000) {
			if (this.emitTimer) clearTimeout(this.emitTimer);
			emit();
		} else this.emitTimer ??= setTimeout(emit, 1000);
	}
	get ready() {
		return this.status.state === "ready";
	}
	get baseUrl() {
		return this.status.baseUrl;
	}

	/** 确保在运行（并发调用共用一次启动）；不抛错，失败反映在 status 里 */
	ensure(): Promise<void> {
		this.wanted = true;
		if (this.ready) return Promise.resolve();
		this.starting ??= this.boot().finally(() => (this.starting = null));
		return this.starting;
	}

	private async boot() {
		const s = hindsightSettings();
		const sec = hindsightSecrets();
		cachedModels = await configuredModels().catch(() => []);
		cachedAt = Date.now();
		try {
			if (s.mode === "remote") {
				this.set("starting", "正在连接远程 Hindsight…", { baseUrl: s.remoteUrl!.replace(/\/+$/, ""), port: undefined });
				if (!(await this.check(this.status.baseUrl!, sec.remoteKey))) throw new Error("连不上远程 Hindsight（检查地址和 API Key）");
				this.set("ready", "已连接远程 Hindsight");
				this.monitor();
				return;
			}
			const p = paths();
			for (const d of [p.root, p.project, p.home, p.hf, p.flashrank, p.xdg]) mkdirSync(d, { recursive: true });
			const mirror = await resolveMirror(s.mirror);
			this.set("installing", "正在准备运行环境…", { mirror, log: p.log });
			const uv = await ensureUv({ pypiIndex: MIRRORS[mirror].pypi, onProgress: (m) => this.set("installing", m) });
			const proxy = await llmProxy();
			proxy.alias(MEMORY_MODEL_ALIAS, () => resolveMemoryModel());
			const env = sidecarEnv({ s, sec, mirror, proxyUrl: proxy.baseUrl, proxyToken: proxy.token, uvDir: dirname(uv) });
			await this.install(uv, env, mirror);
			if (s.reranker.kind === "local") await this.ensureFlashrank(s.reranker.model, MIRRORS[mirror].hf);
			// 停掉上次留下的（旧令牌/旧端口）守护进程，再按新端口启动
			await run(uv, ["run", "--directory", p.project, "hindsight-embed", "daemon", "--profile", PROFILE, "stop"], env, () => {}, 60_000).catch(() => {});
			const port = await freePort();
			const firstRun = !existsSync(join(p.hf, "hub"));
			this.set("starting", firstRun ? "正在启动 Hindsight（首次要下载向量模型，可能需要几分钟）…" : "正在启动 Hindsight…", { port, baseUrl: `http://127.0.0.1:${port}` });
			const launch = () => this.launcher({ port, env, project: p.project, onLog: (l) => this.status.state === "starting" && this.set("starting", l.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 160)) });
			// 本地向量模型由 Hindsight 进程自己从 HuggingFace（或镜像）拉：量模型缓存目录的大小当进度
			const emb = s.embedding.kind === "local" ? LOCAL_EMBEDDINGS.find((e) => e.id === (s.embedding as { model: string }).model) : undefined;
			this.handle = emb && !embeddingInstalled(emb.id) ? await trackDownload(`embedding:${emb.id}`, (prog) => watchDir([join(p.hf, "hub", hfDir(emb.id))], prog, emb.bytes, launch)) : await launch();
			// 握手：必须用我们的密钥才能访问，否则不是我们拉起的进程
			if (!(await this.check(this.status.baseUrl!, sec.tenantKey, true))) throw new Error("Hindsight 握手失败（端口上的不是我们启动的进程）");
			this.fails = 0;
			this.backoff = 0;
			this.set("ready", "运行中");
			this.monitor();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.set("error", msg);
			this.scheduleRestart();
		}
	}

	/** 用 uv 同步依赖（pyproject 没变就跳过）；失败时换另一套源重试一次 */
	private async install(uv: string, env: Record<string, string | undefined>, mirror: "official" | "china") {
		const p = paths();
		const srcPy = join(PROJECT_SRC, "pyproject.toml");
		const srcVer = join(PROJECT_SRC, ".python-version");
		const want = fileHash(srcPy, srcVer);
		const marker = join(p.project, ".pia-installed");
		if (existsSync(marker) && readFileSync(marker, "utf8") === want && existsSync(join(p.project, ".venv"))) return;
		copyFileSync(srcPy, join(p.project, "pyproject.toml"));
		copyFileSync(srcVer, join(p.project, ".python-version"));
		const attempt = (m: "official" | "china", index?: string) =>
			run(uv, ["sync", "--directory", p.project, "--no-progress"], { ...env, UV_FROZEN: undefined, UV_DEFAULT_INDEX: index ?? MIRRORS[m].pypi, UV_PYTHON_INSTALL_MIRROR: MIRRORS[m].python, HF_ENDPOINT: MIRRORS[m].hf }, (l) => this.set("installing", `安装 Hindsight：${l.slice(0, 140)}`));
		this.set("installing", `正在安装 Hindsight（${mirror === "china" ? "国内镜像" : "官方源"}，约 300–600 MB，只需一次）…`);
		await trackDownload("hindsight-env", (prog) => watchDir([p.uvCache, p.python, join(p.project, ".venv")], prog, 500e6, () => this.installAttempts(attempt, mirror)));
		writeFileSync(marker, want);
	}

	private async installAttempts(attempt: (m: "official" | "china", index?: string) => Promise<void>, mirror: "official" | "china") {
		try {
			await attempt(mirror);
		} catch (e1) {
			const other = mirror === "china" ? "official" : "china";
			this.set("installing", `安装失败，改用${other === "china" ? "国内镜像" : "官方源"}重试…`);
			try {
				await attempt(other);
			} catch {
				if (mirror === "china" || other === "china") await attempt("china", CHINA_PYPI_FALLBACK).catch(() => Promise.reject(e1));
				else throw e1;
			}
		}
	}

	/** flashrank 只会从 huggingface.co 下载：我们按镜像先把模型包下好放进它的缓存目录 */
	private async ensureFlashrank(model: string, hf: string) {
		const dir = join(paths().flashrank, model);
		if (existsSync(dir)) return;
		this.set("installing", `正在下载重排序模型 ${model}…`);
		const buf = await trackDownload(`reranker:${model}`, (prog) => fetchWithProgress(`${hf}/prithivida/flashrank/resolve/main/${model}.zip`, prog, { timeoutMs: 10 * 60_000 })).catch((e) =>
			Promise.reject(new Error(`下载重排序模型失败：${e instanceof Error ? e.message : e}`)),
		);
		const tmp = `${dir}.part`;
		rmSync(tmp, { recursive: true, force: true });
		for (const e of readZip(buf)) {
			if (e.name.endsWith("/") || e.name.includes("..")) continue;
			const rel = e.name.startsWith(`${model}/`) ? e.name.slice(model.length + 1) : e.name;
			const out = join(tmp, rel);
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, e.data());
		}
		const { renameSync } = await import("node:fs");
		renameSync(tmp, dir);
	}

	/** 健康 + 鉴权检查。requireAuth：无密钥访问必须被拒（证明开启了我们的租户密钥） */
	async check(base: string, key?: string, requireAuth = false) {
		try {
			const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
			if (!h.ok) return false;
			const ok = await fetch(`${base}/v1/default/banks`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) });
			if (!ok.ok) return false;
			if (requireAuth) {
				const anon = await fetch(`${base}/v1/default/banks`, { signal: AbortSignal.timeout(5000) });
				if (anon.ok) return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	private monitor() {
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => void this.tick(), 20_000);
		this.timer.unref();
	}
	/** 一次健康检查（连续 2 次失败 → down，读记忆改走基础检索、写入排队，并按退避重启） */
	async tick() {
		if (!this.status.baseUrl) return;
		const ok = await this.check(this.status.baseUrl, this.apiKey());
		if (ok) {
			if (this.status.state !== "ready") this.set("ready", "运行中");
			this.fails = 0;
			return;
		}
		if (++this.fails >= 2 && this.status.state === "ready") {
			if (this.timer) clearInterval(this.timer);
			this.timer = null;
			this.set("down", "Hindsight 没有响应，已临时改用基础记忆（新记忆会排队，恢复后补写）");
			this.scheduleRestart();
		}
	}

	private scheduleRestart() {
		if (!this.wanted) return;
		const steps = [10_000, 30_000, 60_000, 120_000, 300_000];
		const ms = steps[Math.min(this.backoff++, steps.length - 1)];
		this.status.restarts++;
		setTimeout(() => {
			if (this.wanted && !this.ready && !this.starting) void this.ensure();
		}, ms).unref();
	}

	/**
	 * 配置变了：重启。resetStore：换了向量模型——Hindsight 的向量列维度是整库共享的（e5-small 384 维 / bge-m3 1024 维），
	 * 库里有数据时它启动会直接报错“Cannot change embedding dimension”，同维度换模型则旧向量和新向量不在同一空间。
	 * 所以本机模式下先停进程、清掉内嵌数据库，再按账本原文重建（resyncAll）。
	 */
	async restart(o: { resetStore?: boolean } = {}) {
		await this.stop(true);
		if (o.resetStore) resetEmbeddingStore();
		return this.ensure();
	}

	async stop(keepWanted = false) {
		this.wanted = keepWanted;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.starting?.catch(() => {});
		const h = this.handle;
		this.handle = null;
		if (h) await h.stop().catch(() => {});
		this.set("off", keepWanted ? "正在重启…" : "未启用", { baseUrl: undefined, port: undefined });
	}

	/** 当前可用的鉴权密钥 */
	apiKey() {
		const s = hindsightSettings();
		const sec = hindsightSecrets();
		return s.mode === "remote" ? sec.remoteKey : sec.tenantKey;
	}
}

export const sidecar = new Sidecar();

/** HuggingFace 缓存里的目录名 */
const hfDir = (id: string) => `models--${id.replace(/\//g, "--")}`;
/** 向量模型是否已下载完（缓存里有 .onnx 权重文件） */
export function embeddingInstalled(id: string) {
	const snap = join(paths().hf, "hub", hfDir(id), "snapshots");
	if (!existsSync(snap)) return false;
	const has = (d: string): boolean => readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? has(join(d, e.name)) : e.name.endsWith(".onnx") && !e.name.endsWith(".incomplete")));
	try {
		return has(snap);
	} catch {
		return false;
	}
}
// 统一下载状态：高级记忆用到的运行环境与模型（选中的或已下载的才显示）
registerDownload({ id: "hindsight-env", name: "Hindsight 运行环境（Python + 依赖）", group: "高级记忆", size: 500e6, installed: () => existsSync(join(paths().project, ".pia-installed")) && existsSync(join(paths().project, ".venv")), start: () => sidecar.restart() });
for (const e of LOCAL_EMBEDDINGS)
	registerDownload({
		id: `embedding:${e.id}`,
		name: `向量模型 ${e.id.split("/")[1]}`,
		group: "高级记忆",
		size: e.bytes,
		installed: () => embeddingInstalled(e.id),
		hidden: () => { const s = hindsightSettings(); return !(s.mode === "local" && s.embedding.kind === "local" && s.embedding.model === e.id) && !embeddingInstalled(e.id); },
		start: () => sidecar.restart(),
	});
for (const r of LOCAL_RERANKERS)
	registerDownload({
		id: `reranker:${r.id}`,
		name: `重排序模型 ${r.id}`,
		group: "高级记忆",
		size: r.bytes,
		installed: () => existsSync(join(paths().flashrank, r.id)),
		hidden: () => { const s = hindsightSettings(); return !(s.mode === "local" && s.reranker.kind === "local" && s.reranker.model === r.id) && !existsSync(join(paths().flashrank, r.id)); },
		start: () => sidecar.restart(),
	});

/** 清掉本机 Hindsight 的内嵌数据库（pg0 数据在附属进程的 HOME 下），并把所有库标记为“需要重建”。原文都在账本里，不丢数据 */
export function resetEmbeddingStore() {
	if (hindsightSettings().mode === "local") rmSync(join(paths().home, ".pg0"), { recursive: true, force: true });
	db.prepare("UPDATE hindsight_banks SET signature = ''").run();
}
