/**
 * 本地 Laya **真实安装 / 启动 / 分类** smoke（显式手动运行；不进默认 npm test，默认不跑）。
 *
 * 跑的是生产实现本身：
 *   `createLayaDeps()` → `LocalLayaManager.install()`
 *   →「uv → staging venv → torch + laya[serve] → 按固定清单从 HF 下 multilingual 权重 → SHA256 校验 / 物化 → 原子 activate」
 *   → `start()` 起真实 `laya-serve`（loopback + 每次新 token）→ `/health` loaded=multilingual
 *   → 经 Pi 公开的 classifier 链路（`models.classify`，官方 typesafe-system-one 协议）发一次**无害**选择题（两个普通标签）。
 *
 * 安全边界（与 local-asr-real-smoke.mjs 同一套）：
 *  - 只在**本脚本创建的、带 owner 标记的 scratch 根**里读写；`PIA_SMOKE_DIR` 给未标记目录一律拒绝，
 *    绝不删除未经标记的路径；`PIA_SMOKE_FRESH=1` 只重建 root 下的受控子目录。
 *  - 进程内显式覆盖 PIA_DATA_DIR / PIA_WORKSPACE / HOME / UV_CACHE_DIR / UV_PYTHON_INSTALL_DIR / PIP_CONFIG_FILE，
 *    不碰用户真实数据目录、真实 HF 缓存、系统 Python、全局 pip、钥匙串（注入内存 CredentialStore）。
 *  - 下载前先按 HF 元数据 + PyPI 元数据估总量，超过 PIA_SMOKE_BUDGET_MB（默认 3072=3GB）立即报阻塞退出，不继续拉。
 *  - 安装 / 下载过程中每 2s 采样 scratch 目录真实字节，超过预算立即 cancel 并有界退出。
 *  - 只装 `LAYA_MODELS=multilingual` 这一个 checkpoint（生产 manager 已设，不加载另两个）。
 *  - runtime token 只经 Pi 公开 classifier 链路使用，不打印、不写盘。
 *  - 自起的 worker 在 finally 里 stop，中途失败也不泄漏进程。
 *
 * 用法：node --import tsx scripts/laya-real-smoke.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const OWNER = "amv7oy7ejb00";
const BUDGET_BYTES = Number(process.env.PIA_SMOKE_BUDGET_MB ?? 3072) * 1024 * 1024;

// ---------------------------------------------------------------- scratch 根（owner guard）

function ownedRoot() {
	const marker = ".pia-laya-smoke-owner";
	const explicit = process.env.PIA_SMOKE_DIR;
	const root = explicit ? resolve(explicit) : join(tmpdir(), `pia-laya-smoke-${OWNER}`);
	if (explicit) {
		if (!existsSync(root) || !existsSync(join(root, marker)) || readFileSync(join(root, marker), "utf8").trim() !== OWNER) {
			throw new Error(`拒绝使用未标记的 PIA_SMOKE_DIR（只接受本脚本建的目录）：${root}`);
		}
		return root;
	}
	mkdirSync(root, { recursive: true });
	const m = join(root, marker);
	if (existsSync(m)) {
		if (readFileSync(m, "utf8").trim() !== OWNER) throw new Error(`scratch 根的 owner 标记不是本脚本，拒绝使用：${root}`);
	} else {
		writeFileSync(m, `${OWNER}\n`);
	}
	return root;
}

const root = ownedRoot();
if (process.env.PIA_SMOKE_FRESH === "1") {
	for (const sub of ["data", "workspace", "home", "uv-cache", "python"]) rmSync(join(root, sub), { recursive: true, force: true });
}
const dirs = {
	data: join(root, "data"),
	workspace: join(root, "workspace"),
	home: join(root, "home"),
	uvCache: join(root, "uv-cache"),
	python: join(root, "python"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
// 必须用 `=` 覆盖：环境里可能已 export 过真实数据目录 / HOME。
process.env.PIA_DATA_DIR = dirs.data;
process.env.PIA_WORKSPACE = dirs.workspace;
process.env.HOME = dirs.home;
process.env.UV_CACHE_DIR = dirs.uvCache;
process.env.UV_PYTHON_INSTALL_DIR = dirs.python;
process.env.PIP_CONFIG_FILE = "/dev/null";
// 不用真实模型库网络刷新；安装本身仍可联网（uv / pip / HF）。
process.env.PIA_OFFLINE = "1";

const logged = [];
const log = (...a) => {
	const line = `${new Date().toISOString().slice(11, 19)} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
	logged.push(line);
	console.log(line);
};

/**
 * scratch 的唯一真实字节（用于预算硬卡）：
 *  - 不跟随 symlink（HF 缓存 snapshot / repo-blobs / hub-blobs 是同一份真实文件的多层链接，
 *    跟随会把同一 blob 重复计数，把「已下载字节」虚增成数倍 → 误判超预算）；
 *  - 按 (dev, ino) 去重（uv 从 cache 硬链接到 venv，物化 staging 也常是硬链接，应只算一份）。
 * 预算关心的是**网络下载量**，不是磁盘占用。
 */
function dirBytes(dir, seen = new Set()) {
	let n = 0;
	let names;
	try {
		names = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of names) {
		const p = join(dir, e.name);
		try {
			if (e.isSymbolicLink()) continue;
			if (e.isDirectory()) {
				n += dirBytes(p, seen);
				continue;
			}
			const st = lstatSync(p);
			const key = `${st.dev}:${st.ino}`;
			if (seen.has(key)) continue;
			seen.add(key);
			n += st.size;
		} catch {
			/* 正在写入 / 已删除：忽略 */
		}
	}
	return n;
}

async function fetchRetry(url, opts = {}, tries = 3) {
	let last;
	for (let i = 0; i < tries; i++) {
		try {
			const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000), ...opts });
			if (!res.ok && !opts.allowNonOk) throw new Error(`HTTP ${res.status}`);
			return res;
		} catch (e) {
			last = e;
			await new Promise((r) => setTimeout(r, 800 * (i + 1)));
		}
	}
	throw last;
}
async function fetchJson(url) {
	const res = await fetchRetry(url, { headers: { accept: "application/json" } });
	return res.json();
}
async function contentLength(url) {
	const res = await fetchRetry(url, { method: "HEAD", allowNonOk: true });
	if (!res.ok) return 0;
	const n = Number(res.headers.get("content-length") ?? 0);
	return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------- 预算估算（下载前，只读元数据）

// 需要动态 import 生产模块拿到 pin（config 已在上面初始化）。
const { LAYA_CHECKPOINTS, LAYA_SOURCE, DEFAULT_CHECKPOINT } = await import("../packages/server/src/local-laya/manifest.ts");
const { checkpointFiles } = await import("../packages/server/src/local-laya/checkpoint-files.ts");

const cp = LAYA_CHECKPOINTS[DEFAULT_CHECKPOINT];
const files = checkpointFiles(cp.id);
const pinnedBytes = files.reduce((n, f) => n + f.size, 0);

/** 运行时时估算（无法在拉之前精确知道 uv 解析出的全部 wheel；用元数据 + 已知 pin 给小上界）。 */
const RUNTIME_ESTIMATE_BYTES = 400 * 1024 * 1024; // uv + CPython3.12 + torch + laya[serve] 依赖的保守上界

const report = {
	startedAt: new Date().toISOString(),
	scratchRoot: root,
	budgetBytes: BUDGET_BYTES,
	checkpoint: { id: cp.id, repo: cp.repo, revision: cp.revision, files: files.length, pinnedBytes },
	estimate: {},
	install: {},
	files: {},
	health: null,
	classify: null,
	runtimeBytes: {},
	checks: {},
};

log(`scratch=${root}`);
log(`checkpoint=${cp.id} repo=${cp.repo}@${cp.revision.slice(0, 8)} 固定清单 ${files.length} 文件 / ${(pinnedBytes / 1e6).toFixed(1)}MB`);

// (1) HF 元数据核对（几 KB，不下载权重）：确认 sibling 大小 / LFS sha 与固定清单逐条一致。
try {
	const meta = await fetchJson(`https://huggingface.co/api/models/${cp.repo}/revision/${encodeURIComponent(cp.revision)}?blobs=true`);
	const sib = new Map((meta.siblings ?? []).map((s) => [s.rfilename, s]));
	for (const f of files) {
		const s = sib.get(f.path);
		if (!s) throw new Error(`HF 元数据缺少 ${f.path}`);
		if (Number(s.size) !== f.size) throw new Error(`${f.path} 元数据大小 ${s.size} != pin ${f.size}`);
		if (s.lfs?.sha256 && s.lfs.sha256 !== f.sha256) throw new Error(`${f.path} LFS sha 与 pin 不一致`);
	}
	report.estimate.hfMetadata = { ok: true, siblingsChecked: files.length };
	log(`HF 元数据核对：${files.length} 个文件大小 / LFS sha 与固定清单一致`);
} catch (e) {
	report.estimate.hfMetadata = { ok: false, error: String(e?.message ?? e) };
	log(`⚠ HF 元数据核对失败（继续，但下载后会做 SHA256 硬校验）：${e?.message ?? e}`);
}

// (2) PyPI 元数据估算若干大 wheel（HEAD/JSON，不下载）：torch macos arm64 + laya wheel。
let torchBytes = 0;
let layaWheelBytes = 0;
try {
	const tj = await fetchJson("https://pypi.org/pypi/torch/json");
	const stable = Object.keys(tj.releases).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
	stable.sort((a, b) => {
		const pa = a.split(".").map(Number);
		const pb = b.split(".").map(Number);
		for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
		return 0;
	});
	for (let i = stable.length - 1; i >= 0; i--) {
		const f = (tj.releases[stable[i]] ?? []).find((x) => /macosx_11_0_arm64/.test(x.filename) && /cp312/.test(x.filename));
		if (f) {
			torchBytes = Number(f.size) || (await contentLength(f.url));
			break;
		}
	}
} catch (e) {
	log(`⚠ torch PyPI 估算失败：${e?.message ?? e}`);
}
try {
	const lj = await fetchJson(`https://pypi.org/pypi/laya/${LAYA_SOURCE.version}/json`);
	const w = (lj.urls ?? []).find((u) => u.filename?.endsWith(".whl"));
	layaWheelBytes = w ? Number(w.size) || (await contentLength(w.url)) : 0;
} catch (e) {
	log(`⚠ laya PyPI 估算失败：${e?.message ?? e}`);
}

const nonCheckpoint = Math.max(RUNTIME_ESTIMATE_BYTES, (torchBytes ? torchBytes + 220 * 1024 * 1024 : RUNTIME_ESTIMATE_BYTES) + layaWheelBytes);
const estimateBytes = pinnedBytes + nonCheckpoint;
report.estimate.bytes = { pinned: pinnedBytes, torchMacosArm64: torchBytes, layaWheel: layaWheelBytes, nonCheckpointAllowance: nonCheckpoint, total: estimateBytes };
log(`预算估算：权重 ${(pinnedBytes / 1e6).toFixed(1)}MB + 运行时 ${(nonCheckpoint / 1e6).toFixed(1)}MB（含 torch ${(torchBytes / 1e6).toFixed(1)}MB）= ${(estimateBytes / 1e6).toFixed(1)}MB（预算 ${(BUDGET_BYTES / 1e6).toFixed(0)}MB）`);
if (estimateBytes > BUDGET_BYTES) {
	throw new Error(`预算不足：估算 ${(estimateBytes / 1e6).toFixed(1)}MB > 预算 ${(BUDGET_BYTES / 1e6).toFixed(0)}MB，已停止，不继续下载`);
}

// ---------------------------------------------------------------- 初始化生产模块

const modelsMod = await import("../packages/server/src/models.ts");
const { memoryCredentialStore } = await import("../packages/server/test/in-memory-credentials.ts");
await modelsMod.initModels(memoryCredentialStore());
const models = modelsMod.models; // 命名空间读取 live binding（解构会在 initModels 前拿到 undefined）
log("已初始化 Pi 模型运行时（内存 CredentialStore，不碰钥匙串）");

const { createLayaDeps, layaPaths, checkpointSourcePath } = await import("../packages/server/src/local-laya/deps.ts");
const { LocalLayaManager, LAYA_PROVIDER_ID, LAYA_MODEL_ID } = await import("../packages/server/src/local-laya/manager.ts");

const deps = createLayaDeps();
const phases = new Set();
let mgr = null;
mgr = new LocalLayaManager(deps, LAYA_SOURCE, () => {
	const st = mgr?.status();
	if (st?.install.state === "installing") {
		if (!phases.has(st.install.phase)) log(`  phase=${st.install.phase}`);
		phases.add(st.install.phase);
	}
});

// 预算硬卡：安装 / 下载期间采样 scratch 真实字节，越界立刻 cancel（有界退出）。
let overBudget = false;
const guard = setInterval(() => {
	const n = dirBytes(root);
	report.runtimeBytes.peak = Math.max(report.runtimeBytes.peak ?? 0, n);
	if (n > BUDGET_BYTES) {
		overBudget = true;
		try {
			mgr.cancel();
		} catch {
			/* ignore */
		}
	}
}, 2000);
guard.unref();

function isAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function waitDead(pid, timeoutMs = 8000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (!isAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 150));
	}
	return !isAlive(pid);
}

let started = null;
try {
	// ---------------------------------------------------- 安装（真实链路）
	const t0 = Date.now();
	log("\n=== 开始安装 Laya（真实 uv/pip/HF）===");
	await mgr.install({ checkpoint: cp });
	report.install.seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
	report.install.phases = [...phases];
	const st = mgr.status();
	report.install.state = st.install.state;
	if (overBudget) throw new Error(`安装期间 scratch 字节超过预算 ${(BUDGET_BYTES / 1e6).toFixed(0)}MB（峰值 ${((report.runtimeBytes.peak ?? 0) / 1e6).toFixed(1)}MB），已取消`);
	if (st.install.state !== "installed") throw new Error(`安装未成功：${st.install.error}`);
	log(`安装完成 ${report.install.seconds}s phases=${report.install.phases.join(">")}`);

	// ---------------------------------------------------- 权重：物化目录逐文件 SHA256 与 pin 核对
	const paths = layaPaths();
	for (const f of files) {
		if (f.optional) continue;
		const full = join(paths.weights, f.path);
		const size = statSync(full).size;
		const sha = createHash("sha256").update(readFileSync(full)).digest("hex");
		report.files[f.path] = { size, sha256: sha };
		if (size !== f.size || sha !== f.sha256) throw new Error(`${f.path} 与固定清单不一致（size=${size} sha=${sha.slice(0, 12)}）`);
	}
	const onDisk = files.filter((f) => !f.optional).reduce((n, f) => n + statSync(join(paths.weights, f.path)).size, 0);
	report.runtimeBytes.weights = onDisk;
	log(`权重目录 ${paths.weights}：${Object.keys(report.files).length} 个必需文件大小 / SHA256 与固定清单全部一致（${(onDisk / 1e6).toFixed(1)}MB）`);
	if (!checkpointSourcePath(paths.weights)) throw new Error("activate 后 checkpointSourcePath 为空（运行时权重来源没接上）");

	// ---------------------------------------------------- 启动真实 sidecar + /health
	await mgr.start();
	started = mgr;
	const rt = mgr.status();
	if (rt.runtime.state !== "running") throw new Error(`sidecar 未运行：${rt.runtime.state}`);
	const h = rt.health;
	report.health = { ok: h?.ok ?? false, device: h?.device ?? null, loaded: h?.loaded ?? null, revisions: h?.revisions ?? null, checkpointDevices: h?.checkpointDevices ?? null };
	log(`sidecar pid=${rt.runtime.pid} port=${rt.runtime.port} host=${rt.runtime.host}`);
	log(`/health loaded=${JSON.stringify(h?.loaded)} device=${h?.device}`);
	if (!h?.ok) throw new Error("health 未通过");
	if (!(h.loaded ?? []).includes(LAYA_MODEL_ID)) throw new Error(`health.loaded 不含 ${LAYA_MODEL_ID}：${JSON.stringify(h.loaded)}`);

	// ---------------------------------------------------- 官方协议分类请求（无害，两个普通标签）
	// 经 Pi 公开 classifier 链路（models.classify → typesafe-system-one → /v1/systemone），token 不在此打印。
	const context = {
		state: { kind: "smoke", note: "本地无害分类自检" },
		questions: {
			pick: { type: "choice", instructions: "从两个普通标签里选出最符合这个自检请求的一个。", criteria: { alpha: "普通标签 alpha", beta: "普通标签 beta" } },
		},
	};
	const t1 = Date.now();
	const out = await models.classify(LAYA_PROVIDER_ID, LAYA_MODEL_ID, context, { timeoutMs: 180_000 });
	const ans = out.answers?.pick;
	report.classify = {
		seconds: Number(((Date.now() - t1) / 1000).toFixed(2)),
		stopReason: out.stopReason,
		errorMessage: out.errorMessage ?? null,
		answerType: ans?.type ?? null,
		choice: ans?.type === "choice" ? ans.choice : null,
		confidence: ans?.type === "choice" ? ans.confidence : null,
		probabilities: ans?.type === "choice" ? ans.probabilities : null,
		usage: out.usage ?? null,
	};
	log(`分类请求（官方 typesafe-system-one）：stopReason=${out.stopReason} choice=${report.classify.choice} confidence=${report.classify.confidence} usage=${JSON.stringify(out.usage ?? null)}`);
	if (out.stopReason !== "stop") throw new Error(`分类请求未成功：${out.errorMessage ?? out.stopReason}`);
	if (ans?.type !== "choice") throw new Error(`分类答案不是 choice：${JSON.stringify(ans)}`);
	if (!["alpha", "beta"].includes(ans.choice)) throw new Error(`分类答案不在候选集合：${ans.choice}`);
	if (!(typeof ans.confidence === "number" && Number.isFinite(ans.confidence) && ans.confidence >= 0 && ans.confidence <= 1)) throw new Error(`confidence 非法：${ans.confidence}`);

	report.checks.installOk = true;
	report.checks.weightsMatchPin = true;
	report.checks.healthLoaded = true;
	report.checks.classifyOk = true;
} finally {
	clearInterval(guard);
	if (overBudget) report.checks.overBudget = true;
	// 任何中途失败都必须回收自己起的 worker。
	if (started) {
		const pid = started.status().runtime.pid;
		await started.stop().catch(() => {});
		const after = started.status();
		report.checks.stopState = after.runtime.state;
		if (pid) {
			const dead = await waitDead(pid);
			report.checks.pidReleased = dead;
			log(`stop：state=${after.runtime.state} 旧 pid 已退出=${dead}`);
			if (!dead) throw new Error(`stop 后 pid ${pid} 仍存活（泄漏）`);
		}
	}
	report.runtimeBytes.final = dirBytes(root);
	report.finishedAt = new Date().toISOString();
}

// ---------------------------------------------------------------- 证据

const evidenceDir = resolve(import.meta.dirname, "..", "evidence", "local-laya-real-smoke");
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
writeFileSync(join(evidenceDir, `smoke-${stamp}.log`), `${logged.join("\n")}\n`);
writeFileSync(join(evidenceDir, `report-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
log(`\n证据已写入 ${join("evidence", "local-laya-real-smoke")}（smoke-${stamp}.log / report-${stamp}.json）`);

console.log("\n=== LAYA SMOKE OK ===");
console.log(JSON.stringify({ install: report.install, health: report.health, classify: report.classify, runtimeBytes: report.runtimeBytes, checks: report.checks }, null, 2));
