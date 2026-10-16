/**
 * 本地 ASR **真实链路 smoke**（显式手动运行；不进默认 npm test，不默认拉大权重）。
 *
 * 跑的是生产实现本身：`createAsrDeps()` → `LocalAsrService.install()` →
 * 「uv → venv → sherpa-onnx 引擎 → 按所选模型 repo/revision 直连 HF 下载权重 → SHA256 校验 → activate」
 * → `start()` 起真实 sidecar → `transcribeWav()` 走真实 HTTP + token + 租约 → 真实推理结果。
 *
 * 安全边界：
 *  - 只在**本脚本创建的、带 owner 标记的 scratch 根**里读写；`PIA_SMOKE_DIR` 给未标记目录一律拒绝，
 *    绝不删除未经标记的路径（不碰他人 /tmp 目录）；`PIA_SMOKE_FRESH=1` 只重建 root 下的受控子目录。
 *  - 进程内显式覆盖 PIA_DATA_DIR / PIA_WORKSPACE / HOME / UV_CACHE_DIR / UV_PYTHON_INSTALL_DIR / PIP_CONFIG_FILE，
 *    不碰用户真实数据目录、系统 Python、全局 pip。
 *  - 下载前先按 catalog 元数据估总量，超过 PIA_SMOKE_BUDGET_MB（默认 900MB）立即报阻塞退出。
 *  - 每个模型起的 worker 都在 finally 里 stop，中途失败也不泄漏进程。
 *
 * 用法：node --import tsx scripts/local-asr-real-smoke.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const OWNER = "amv7oy7ejb00";
const BUDGET_BYTES = Number(process.env.PIA_SMOKE_BUDGET_MB ?? 900) * 1024 * 1024;
/** 运行时（uv + Python + sherpa wheels）估算上限，计入预算。 */
const RUNTIME_ALLOWANCE_BYTES = 120 * 1024 * 1024;
/** 单个模型超过它就拒绝下载（覆盖 turbo / large-v3 这类 GB 级；本批不实测）。 */
const PER_MODEL_LIMIT_BYTES = 500 * 1024 * 1024;

// ---------------------------------------------------------------- scratch 根

function ownedRoot() {
	const marker = ".pia-asr-smoke-owner";
	const explicit = process.env.PIA_SMOKE_DIR;
	const root = explicit ? resolve(explicit) : join(tmpdir(), `pia-asr-smoke-${OWNER}`);
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
	// 只重建 root 下的受控子目录；不动 root 本身（root 带我们的 owner 标记）。
	for (const sub of ["data", "home", "wav", "uv-cache", "python"]) rmSync(join(root, sub), { recursive: true, force: true });
}
const dirs = {
	data: join(root, "data"),
	workspace: join(root, "workspace"),
	home: join(root, "home"),
	uvCache: join(root, "uv-cache"),
	python: join(root, "python"),
	wav: join(root, "wav"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
// 必须用 `=` 覆盖：环境里可能已 export 过真实数据目录。
process.env.PIA_DATA_DIR = dirs.data;
process.env.PIA_WORKSPACE = dirs.workspace;
process.env.HOME = dirs.home;
process.env.UV_CACHE_DIR = dirs.uvCache;
process.env.UV_PYTHON_INSTALL_DIR = dirs.python;
process.env.PIP_CONFIG_FILE = "/dev/null";

const { createAsrDeps } = await import("../packages/server/src/local-asr/deps.ts");
const { LocalAsrManager } = await import("../packages/server/src/local-asr/manager.ts");
const { LocalAsrService } = await import("../packages/server/src/local-asr/service.ts");
const { asrModelSpec } = await import("../packages/server/src/local-asr/catalog.ts");
const { asrEndpoint } = await import("../packages/server/src/local-asr/adapter-registry.ts");
const { transcribeWav } = await import("../packages/server/src/local-asr/transcribe.ts");

const logged = [];
const log = (...a) => {
	const line = `${new Date().toISOString().slice(11, 19)} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
	logged.push(line);
	console.log(line);
};

/** 官方示例 WAV（各自模型仓 test_wavs，均 <2MB）。 */
const CHINESE = {
	repo: "csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14",
	revision: "def027084691107096b5ebba69785756d63de6c5",
	file: "test_wavs/0.wav",
	expect: "对我做了介绍啊那么我想说的是呢大家如果对我的研究感兴趣呢你",
	keys: ["对我做了介绍", "研究感兴趣"],
	source: "官方 sherpa-onnx 文档该模型一节的期望输出",
};
const SAMPLE = {
	"whisper-base-int8": {
		repo: "csukuangfj/sherpa-onnx-whisper-base",
		revision: "bb53ee204431c90d314c1cc08d28d23e5b7927cc",
		file: "test_wavs/0.wav",
		expect: "AFTER EARLY NIGHTFALL THE YELLOW LAMPS WOULD LIGHT UP HERE AND THERE THE SQUALID QUARTER OF THE BROTHELS",
		keys: ["EARLY NIGHTFALL", "YELLOW LAMPS", "BROTHELS"],
		source: "官方仓 test_wavs/trans.txt",
	},
	"paraformer-zh-2023-09-14-int8": { ...CHINESE },
	"sensevoice-small-int8": {
		repo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
		revision: "2365baeacb507f821a0c8120fcee3d484dba7a07",
		file: "test_wavs/zh.wav",
		expect: "开放时间早上9点至下午5点。（官方 zh.wav 示例；未做 ITN 时为「开饭时间早上九点至下午五点」）",
		keys: ["早上", "下午", "点"],
		source: "官方 sherpa-onnx SenseVoice 文档 test_wavs/zh.wav 期望输出",
	},
};

const targets = (process.env.PIA_SMOKE_MODELS ?? "whisper-base-int8,paraformer-zh-2023-09-14-int8").split(",").filter(Boolean);
const specs = targets.map((id) => {
	const spec = asrModelSpec(id);
	if (!spec) throw new Error(`未知模型 ${id}`);
	if (spec.manifest.bytes > PER_MODEL_LIMIT_BYTES) throw new Error(`模型 ${id} 权重 ${spec.manifest.bytes} 超过单模型上限，本次预算内不下载（高档模型请单独立项实测）`);
	return spec;
});

// ------------------------------------------------------------- 预算（下载前）

const planBytes = specs.reduce((n, s) => n + s.manifest.bytes, 0) + RUNTIME_ALLOWANCE_BYTES;
log(`计划：${specs.map((s) => `${s.id}(${(s.manifest.bytes / 1e6).toFixed(1)}MB)`).join(" + ")} + 运行时估算 ${(RUNTIME_ALLOWANCE_BYTES / 1e6).toFixed(0)}MB = ${(planBytes / 1e6).toFixed(1)}MB（预算 ${(BUDGET_BYTES / 1e6).toFixed(0)}MB）`);
if (planBytes > BUDGET_BYTES) {
	throw new Error(`预算不足：估算 ${(planBytes / 1e6).toFixed(1)}MB > ${(BUDGET_BYTES / 1e6).toFixed(0)}MB，已停止，不继续下载`);
}

const deps = createAsrDeps();
const phases = new Map();
let selection = null;
const svc = new LocalAsrService({
	createManager: (spec) => {
		let mgr = null;
		mgr = new LocalAsrManager(
			deps,
			{ source: spec.source, license: spec.license, model: spec.manifest, ids: { provider: spec.provider, modelId: spec.id, protocol: "local-asr-http" } },
			() => {
				// manager 每次 set() 都会回调；install 阶段用它记录真实 phase 轨迹（引擎复用证据靠这里）。
				const st = mgr?.status();
				if (st?.install.state === "installing") {
					const set = phases.get(spec.id) ?? new Set();
					set.add(st.install.phase);
					phases.set(spec.id, set);
					if (st.install.phase !== "weights") log(`  [${spec.id}] phase=${st.install.phase}`);
				}
			},
		);
		return mgr;
	},
	selection: {
		read: () => selection,
		version: () => 0,
		write: (s) => {
			selection = s;
		},
	},
	onChange: () => {},
	hardware: () => ({ os: process.platform, arch: process.arch, cpuCores: 8, memoryBytes: 16 * 1024 ** 3 }),
});

const wavCache = new Map();
async function fetchSample(s) {
	const key = `${s.repo}@${s.revision}/${s.file}`;
	if (wavCache.has(key)) return wavCache.get(key);
	const dest = join(dirs.wav, `${s.repo.replace(/\//g, "_")}-${s.file.replace(/\//g, "_")}`);
	if (!existsSync(dest)) {
		const res = await fetch(`https://huggingface.co/${s.repo}/resolve/${s.revision}/${s.file}`, { redirect: "follow" });
		if (!res.ok) throw new Error(`示例 wav 下载失败 HTTP ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length === 0 || buf.length > 2 * 1024 * 1024) throw new Error(`示例 wav 大小异常：${buf.length}`);
		writeFileSync(dest, buf);
	}
	const buf = readFileSync(dest);
	const info = { buf, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
	wavCache.set(key, info);
	log(`  示例 wav ${s.file}：${info.size}B sha256=${info.sha256}`);
	return info;
}

function isAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitDead(pid, timeoutMs = 4000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (!isAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return !isAlive(pid);
}

function cjkRatio(text) {
	const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
	const letters = (text.match(/[A-Za-z\u4e00-\u9fff]/g) ?? []).length;
	return letters ? cjk / letters : 0;
}

const report = { startedAt: new Date().toISOString(), scratchRoot: root, budgetBytes: BUDGET_BYTES, planBytes, models: {}, checks: {} };

// ------------------------------------------------------------------ 主流程

for (const spec of specs) {
	const modelId = spec.id;
	const sample = SAMPLE[modelId];
	log(`\n=== ${spec.name}（${modelId}）许可=${spec.license.decision} 权重 ${(spec.manifest.bytes / 1e6).toFixed(1)}MB repo=${spec.manifest.repo}@${spec.manifest.revision.slice(0, 8)}`);
	const entry = { repo: spec.manifest.repo, revision: spec.manifest.revision, weightsBytes: spec.manifest.bytes, files: {}, phases: [] };
	report.models[modelId] = entry;
	const t0 = Date.now();
	let started = null;
	try {
		if (svc.managerFor(modelId).status().install.state !== "installed") await svc.install(modelId, { intent: "install" });
		const st = svc.managerFor(modelId).status();
		entry.installSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
		entry.phases = [...(phases.get(modelId) ?? [])];
		if (st.install.state !== "installed") throw new Error(`安装未成功：${st.install.error}`);
		log(`  安装完成 ${entry.installSeconds}s phases=${entry.phases.join(">")}`);

		// 权重落在该模型目录，且每个文件的大小 / SHA256 与 catalog pin 一致。
		const paths = deps.paths(modelId);
		for (const f of spec.manifest.files) {
			const full = join(paths.weights, f.path);
			const size = statSync(full).size;
			const sha = createHash("sha256").update(readFileSync(full)).digest("hex");
			entry.files[f.path] = { size, sha256: sha };
			if (size !== f.size || sha !== f.sha256) throw new Error(`${modelId}/${f.path} 与 catalog pin 不一致`);
		}
		log(`  权重目录 ${paths.weights}：${spec.manifest.files.length} 个文件大小/SHA256 与 catalog pin 全部一致`);
		entry.weightsDir = paths.weights;
		const onDisk = spec.manifest.files.reduce((n, f) => n + statSync(join(paths.weights, f.path)).size, 0);
		entry.weightsOnDisk = onDisk;
		if (onDisk > BUDGET_BYTES) throw new Error(`${modelId} 实际权重 ${onDisk} 超预算`);

		// 切到该模型并起真实 worker。
		await svc.select(modelId);
		started = svc.managerFor(modelId);
		const rt = started.status();
		if (rt.runtime.state !== "running") throw new Error(`worker 未运行：${rt.runtime.state} ${rt.runtime.lastError}`);
		const h = rt.health;
		entry.pid = rt.runtime.pid;
		entry.port = rt.runtime.port;
		entry.health = { ok: h?.ok ?? false, device: h?.device ?? null, loaded: h?.loaded ?? null, modelId: h?.modelId ?? null };
		log(`  worker pid=${entry.pid} port=${entry.port} health=${JSON.stringify(entry.health)}`);
		if (!h?.ok) throw new Error("health 未通过");
		if (h.modelId !== modelId) throw new Error(`health.modelId=${h.modelId} 不等于所选模型 ${modelId}（选错模型）`);
		for (const role of Object.keys(spec.manifest.fileRoles ?? {})) {
			if (role === "tokens") continue;
			const base = String(spec.manifest.fileRoles?.[role]).split("/").pop();
			if (!(h.loaded ?? []).includes(base)) throw new Error(`health.loaded 缺 ${base}：${JSON.stringify(h.loaded)}`);
		}

		// 真实推理 1：该模型的官方示例（结果必须命中关键片段，不能是固定字幕）。
		const w = await fetchSample(sample);
		const ep = asrEndpoint(spec.provider, modelId);
		if (!ep) throw new Error("端点未注册");
		const t1 = Date.now();
		const out = await transcribeWav(started, ep, w.buf, { timeoutMs: 180_000 });
		const text = (out.text ?? "").trim();
		entry.inference = { seconds: Number(((Date.now() - t1) / 1000).toFixed(2)), secondsOfAudio: Number((w.size / 32000).toFixed(2)), text, expect: sample.expect, source: sample.source };
		log(`  推理（样本 ${sample.source}）：${text}`);
		if (!text) throw new Error("推理结果为空");
		const missing = sample.keys.filter((k) => !text.toUpperCase().includes(k.toUpperCase()));
		if (missing.length) throw new Error(`关键片段未命中：${missing.join(" / ")}；期望：${sample.expect}；实际：${text}`);

		// 真实推理 2（只对 Whisper）：同一段**中文**示例，验证 auto/zh 而不是默认回落英文（不另下权重）。
		if (modelId.startsWith("whisper")) {
			const zw = await fetchSample(CHINESE);
			const t2 = Date.now();
			const zout = await transcribeWav(started, ep, zw.buf, { timeoutMs: 180_000 });
			const ztext = (zout.text ?? "").trim();
			entry.chineseAuto = { seconds: Number(((Date.now() - t2) / 1000).toFixed(2)), text: ztext, cjkRatio: Number(cjkRatio(ztext).toFixed(2)), expect: CHINESE.expect };
			log(`  中文 auto 推理（期望文本：${CHINESE.expect}）：${ztext}`);
			if (!/[一-龥]/.test(ztext)) throw new Error(`Whisper 中文样本输出里没有中文字符（疑似回落英文）：${ztext}`);
		}
	} finally {
		// 任何中途失败都必须回收自己起的 worker。
		if (started) {
			const pid = started.status().runtime.pid;
			await started.stop("smoke").catch(() => {});
			const after = started.status();
			entry.stopState = after.runtime.state;
			if (pid) {
				const dead = await waitDead(pid);
				entry.pidReleased = dead;
				log(`  stop：state=${after.runtime.state} 旧 pid ${pid} 已退出=${dead}`);
				if (!dead) throw new Error(`stop 后 pid ${pid} 仍存活（泄漏）`);
			}
		}
	}
}

// -------------------------------------------------- 切换证据 + 卸载一个不碰另一个

const withPid = specs.filter((s) => report.models[s.id]?.pid);
if (withPid.length >= 2) {
	const [a, b] = withPid;
	report.checks.switchDistinctPids = report.models[a.id].pid !== report.models[b.id].pid;
	log(`\n切换证据：${a.id} pid=${report.models[a.id].pid}，${b.id} pid=${report.models[b.id].pid}，不同=${report.checks.switchDistinctPids}`);
	if (!report.checks.switchDistinctPids) throw new Error("两个模型 worker pid 相同，切换没有真的换模型");
}
report.checks.engineReused = specs.length >= 2 && [...(phases.get(specs[1].id) ?? [])].length > 0 && [...(phases.get(specs[1].id) ?? [])].every((p) => p !== "venv" && p !== "engine");
log(`共享引擎复用（第二个模型未重建 venv / 未重装 wheel）=${report.checks.engineReused}（第二个模型 phase 轨迹=${specs[1] ? [...(phases.get(specs[1].id) ?? [])].join(">") || "空" : "不适用（单模型）"}）`);
if (specs.length >= 2 && !report.checks.engineReused) throw new Error("第二个模型没有复用共享引擎（或没有拿到 phase 证据）");

if (process.env.PIA_SMOKE_UNINSTALL !== "0" && specs.length >= 2) {
	const [a, b] = specs;
	const pa = deps.paths(a.id);
	const keep = readFileSync(join(pa.weights, a.manifest.files[0].path));
	await deps.uninstall(deps.paths(b.id), b.id);
	report.checks.uninstallKeptOther = existsSync(join(pa.weights, a.manifest.files[0].path)) && readFileSync(join(pa.weights, a.manifest.files[0].path)).equals(keep);
	report.checks.uninstalledRemovedSelf = !existsSync(join(deps.paths(b.id).weights, b.manifest.files[0].path));
	log(`\n卸载 ${b.id}：${a.id} 权重仍在=${report.checks.uninstallKeptOther}，${b.id} 权重已删=${report.checks.uninstalledRemovedSelf}`);
	if (!report.checks.uninstallKeptOther || !report.checks.uninstalledRemovedSelf) throw new Error("卸载语义不符：应只删自己、不动另一个");
}

// -------------------------------------------------------------------- 证据

report.finishedAt = new Date().toISOString();
const evidenceDir = resolve(import.meta.dirname, "..", "evidence", "local-asr-real-smoke");
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
writeFileSync(join(evidenceDir, `smoke-${stamp}.log`), `${logged.join("\n")}\n`);
writeFileSync(join(evidenceDir, `report-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
log(`\n证据已写入 ${join("evidence", "local-asr-real-smoke")}（smoke-${stamp}.log / report-${stamp}.json）`);

console.log("\n=== SMOKE OK ===");
console.log(JSON.stringify({ checks: report.checks, models: Object.fromEntries(Object.entries(report.models).map(([k, v]) => [k, { pid: v.pid, inference: v.inference?.text, chineseAuto: v.chineseAuto?.text, files: v.files }])) }, null, 2));
