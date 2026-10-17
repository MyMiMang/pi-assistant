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

/**
 * 原生流式模型的官方示例 wav（同一权重仓 test_wavs，<2MB）。
 * **两个都不是纯英语 / 纯中文样本**：0.wav 是中英混说，1.wav 是中文夹 ALWAYS。
 * 所以它们不能当「中文专项 / 英文专项」语料，下面的结果也不能说成 zh / en 分别测过。
 */
const STREAM_SAMPLES = {
	zh: { file: "test_wavs/0.wav" },
	en: { file: "test_wavs/1.wav" },
};
/**
 * 上游示例输出对照（**只用来核对「本机是否复现上游模型示例输出」，不是质量基准、不是人工真值**）。
 *
 * 来源核对（2026-10-24 公开 GET 原文读取，几 KB，不运行外部代码）：
 * https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html
 * #csukuangfj-sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20-bilingual-chinese-english
 * 该页 int8 段对 `test_wavs/1.wav`（5.100s）给出的识别结果 = 下面 1.wav 的字符串（逐字一致）。
 *
 * 0.wav：**该模型的公开文档页面没有 0.wav 的示例输出**（全页只出现该模型的 1.wav 路径）。
 * 同页那句「昨天是 MONDAY TODAY IS THEY AFTER TOMORROW是星期三」属于**另一个模型**
 * `streaming-zipformer-small-bilingual-zh-en-2023-02-16`，而且是 "THEY" 不是 "LIBR"。
 * → 历史 smoke 里 0.wav 用的对照串没有可公开核对的来源，这里标 `unverified-legacy-string`，
 *   不参与任何「一致 / 准确」结论（旧 json / log 不重写，见 evidence/local-asr-real-smoke/REPORT-CAVEATS.md）。
 *
 * 归一化（去空白 / 标点、小写）只为了比字符串，不是评分口径。
 */
const STREAM_EXPECT_SOURCE = {
	url: "https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html#csukuangfj-sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20-bilingual-chinese-english",
	retrievedAt: "2026-10-24",
	kind: "upstream-model-example",
	note: "上游文档里该模型的**模型自动识别示例输出**；不是人工转写真值（groundtruth），也不是质量 / 准确率基准",
};
const STREAM_EXPECT = {
	"1.wav": {
		text: "这是第一种第二种叫呃与 ALWAYS ALWAYS什么意思啊",
		referenceKind: "upstream-model-example",
		referenceSource: STREAM_EXPECT_SOURCE.url,
		verified: true,
	},
	"0.wav": {
		text: "昨天是 MONDAY TODAY IS LIBR THE DAY AFTER TOMORROW是星期三",
		referenceKind: "unverified-legacy-string",
		referenceSource: null,
		verified: false,
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
// 本轮资源口径：sidecar 线程数 = capThreads(物理核) ≤ 4。这里只在本 smoke 进程内把物理核报成 4，
// 不修改生产代码；真实安装 / 运行路径不变。
deps.physicalCores = () => 4;
log(`threads 上限：${deps.physicalCores()}（sidecar ASR_THREADS 由 capThreads 得出，本轮要求 ≤4）`);
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


// ------------------------------------------------------- 原生流式验收（真实 sidecar）

function parseWav(buf) {
	if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("不是合法 WAV");
	let off = 12;
	let fmt = null;
	let data = null;
	while (off + 8 <= buf.length) {
		const id = buf.toString("ascii", off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		const body = off + 8;
		if (id === "fmt ") fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
		else if (id === "data") data = buf.subarray(body, body + size);
		off = body + size + (size % 2);
	}
	if (!fmt || !data) throw new Error("WAV 缺 fmt/data");
	if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) throw new Error(`示例 WAV 不是 16k mono 16bit：${JSON.stringify(fmt)}`);
	const ab = new ArrayBuffer(data.length);
	new Uint8Array(ab).set(data);
	return { samples: new Int16Array(ab), seconds: Number((data.length / 32000).toFixed(2)) };
}

/** 从权重仓取小文件（示例 wav / trans.txt）；走本脚本自己的 scratch 缓存，不碰用户 cache。 */
async function fetchRepoFile(repo, revision, file) {
	const dest = join(dirs.wav, `${repo.replace(/\//g, "_")}-${file.replace(/\//g, "_")}`);
	if (!existsSync(dest)) {
		const res = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${file}`, { redirect: "follow" });
		if (!res.ok) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length === 0 || buf.length > 2 * 1024 * 1024) return null;
		writeFileSync(dest, buf);
	}
	return readFileSync(dest);
}

/** 归一化：去掉空白 / 常见标点并小写——只为比字符串，不是评分口径，也不是「质量 CER」。 */
const normText = (t) => String(t ?? "").replace(/[\s,，。.!?！？、"'“”‘’·-]/g, "").toLowerCase();
function editDistance(a, b) {
	const m = a.length;
	const n = b.length;
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		const cur = [i];
		for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[n];
}
/**
 * 与上游示例输出的一致度 = 1 - 归一化编辑距离 / 参考串长度。
 * **只表示「本机是否复现上游模型示例输出」**：不是 CER、不是识别准确率、不是中英文质量结论。
 */
const agreementScore = (ref, hyp) => {
	const r = normText(ref);
	if (!r.length) return null;
	return Number((1 - editDistance(r, normText(hyp)) / r.length).toFixed(3));
};

/**
 * 生产流式链路验收：LocalAsrStreamHub（真实 HTTP → 真 sidecar）+ 官方中英 wav 按 200ms 逐帧喂。
 * 断言：首 tentative 早于 stop、end 出 final、silence 触发 endpoint/reset、seq 重复不重复喂、
 * cancel 释放租约但 worker 不被杀；禁网后复用已有权重 / runtime 仍能真实流式转写。
 */
async function runStreamChecks({ spec, modelId, manager, ep, svc }) {
	const { LocalAsrStreamHub, AsrStreamError } = await import("../packages/server/src/local-asr/stream.ts");
	const repo = spec.manifest.repo;
	const revision = spec.manifest.revision;
	const zhBuf = await fetchRepoFile(repo, revision, STREAM_SAMPLES.zh.file);
	const enBuf = await fetchRepoFile(repo, revision, STREAM_SAMPLES.en.file);
	if (!zhBuf || !enBuf) throw new Error("官方示例 wav 下载失败（离线？）");
	const zh = parseWav(zhBuf);
	const en = parseWav(enBuf);
	log(`  流式样本：0.wav ${zh.seconds}s（中英混说）/ 1.wav ${en.seconds}s（中文夹 ALWAYS）——都不是纯英语语料（上游 test_wavs，scratch 缓存）`);
	// 权重仓的 test_wavs/trans.txt（尽力而为）：有就原样记进 report.reference 仅供追溯；
	// **不再用它算 CER**（没有人工转写真值语料，CER 不当质量指标）。该流式权重仓实测没有这个文件（404）。
	let ref = {};
	const trans = await fetchRepoFile(repo, revision, "test_wavs/trans.txt").catch(() => null);
	if (trans) {
		for (const line of String(trans).split(/\r?\n/)) {
			const mm = line.match(/^\s*(\S+\.wav)\s+(.+?)\s*$/);
			if (mm) ref[mm[1]] = mm[2];
		}
	}

	const makeHub = () =>
		new LocalAsrStreamHub({
			resolveTarget: async () => {
				// 每次重新解析端点：worker 重启（禁网复跑）后端口会变，用旧端点会 fetch failed。
				const current = asrEndpoint(spec.provider, modelId);
				if (!current) return { ok: false, error: new AsrStreamError(ASR_STREAM_ERRORS.notReady, 409, "本地流式端点未注册") };
				return { ok: true, target: { modelId, provider: spec.provider, capability: spec.adapter, baseUrl: current.baseUrl, token: current.token, sampleRate: 16000, lease: manager.acquireStreamLease() } };
			},
			selectionVersion: () => 0,
			now: () => Date.now(),
			setTimer: (fn, ms) => {
				const t = setTimeout(fn, ms);
				t.unref?.();
				return { cancel: () => clearTimeout(t) };
			},
		});
	const hub = makeHub();
	const FRAME = 3200; // 200 ms
	// 只喂音频、**不做实时 pacing**：每帧 decode 回来就喂下一帧，不等音频时长。
	// 所以这里所有毫秒数都是这个前提下（unpaced）的量，**不是用户「嘴到字」的交互延迟**。
	const PACING = "unpaced";
	const stats = {
		frames: 0,
		audioMs: 0,
		appendMs: [],
		firstTentativeEventMs: null,
		firstNonEmptyMs: null,
		firstNonEmptyText: null,
		firstNonEmptyAudioFedMs: null,
		endpoint: 0,
		tentative: 0,
		committed: 0,
		final: 0,
	};
	const events = [];
	const finalsBySegment = new Map();
	const feed = async (h, sid, seq, samples, segMap = finalsBySegment) => {
		const t0 = Date.now();
		for (let i = 0; i < samples.length; i += FRAME) {
			const piece = samples.subarray(i, Math.min(samples.length, i + FRAME));
			const bytes = new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength);
			const t = Date.now();
			const r = await h.append(sid, seq, bytes, { principal: "local" });
			stats.appendMs.push(Date.now() - t);
			stats.frames += 1;
			stats.audioMs += (piece.length / 16000) * 1000;
			const atMs = Date.now() - t0;
			for (const e of r.events) {
				events.push({ ...e, atMs });
				if (e.type === "endpoint") stats.endpoint += 1;
				if (e.type === "tentative") {
					stats.tentative += 1;
					// 任意 tentative（含空串）= 协议在回包；**只有 trim 后非空的才算「出字」**
					// （旧样例的 92 条 tentative 里大量是空串，拿第一条空串算「首字 3ms」是错的）。
					if (stats.firstTentativeEventMs === null) stats.firstTentativeEventMs = atMs;
					const txt = String(e.text ?? "").trim();
					if (txt && stats.firstNonEmptyMs === null) {
						stats.firstNonEmptyMs = atMs;
						stats.firstNonEmptyText = txt;
						stats.firstNonEmptyAudioFedMs = stats.audioMs;
					}
				}
				if (e.type === "committed") stats.committed += 1;
				// final 也可能在 append 里回（端点后 / 前端点）：不能只收 end() 返回的 finals，
				// 否则前面几段的 final 会丢（旧报告 finalBySegment 只有最后一段就是这么来的）。
				if (e.type === "final") {
					stats.final += 1;
					if (e.text) segMap.set(String(e.segmentId), e.text);
				}
			}
			seq += 1;
			if (stats.frames === 1) log(`    首帧已接受（${bytes.byteLength}B），decode ${Date.now() - t}ms`);
		}
		return seq;
	};
	/** 真 p 分位数（此前这里用的是 p95 估计算子却挂在 p50 字段上，已修）。 */
	const quantile = (xs, p) => {
		if (!xs.length) return null;
		const s = [...xs].sort((a, b) => a - b);
		return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
	};

	// —— 1) 正常会话：中文 → 静音（endpoint）→ 英文 → end(final)
	const startedAt = Date.now();
	const created = await hub.create({ principal: "local", agentId: "smoke", conversationId: "smoke" });
	const zhFeedAt = Date.now();
	let seq = await feed(hub, created.sessionId, 0, zh.samples);
	const zhFeedWallMs = Date.now() - zhFeedAt;
	// 协议事实：下面这几项是在我们**调用 end() 之前**就能观察到的；它不是人声延迟证据。
	const firstNonEmptyBeforeEndCall = stats.firstNonEmptyMs !== null;
	const firstNonEmptyBeforeSampleFed =
		stats.firstNonEmptyMs !== null && stats.firstNonEmptyMs < zhFeedWallMs;
	const zhEvents = [...events];
	seq = await feed(hub, created.sessionId, seq, new Int16Array(16000 * 3)); // 3s 静音 → endpoint（rule2 1.2s 尾部静音）
	seq = await feed(hub, created.sessionId, seq, en.samples);
	const ended = await hub.end(created.sessionId, { principal: "local", agentId: "smoke", conversationId: "smoke" });
	for (const f of ended.finals) if (f.text) finalsBySegment.set(String(f.segmentId), f.text);
	const finals = [...finalsBySegment.values()].filter(Boolean);
	const finalText = finals.join("");
	const allText = [...zhEvents, ...events].filter((e) => e.type === "committed" || e.type === "tentative" || e.type === "final").map((e) => e.text);
	const tailText = allText[allText.length - 1] ?? "";
	log(`  流式结果：frames=${stats.frames} endpoint=${stats.endpoint} tentative=${stats.tentative} committed=${stats.committed} finalEvent=${stats.final} finals=${JSON.stringify(finals)}`);
	log(`  首 tentative（含空串）=${stats.firstTentativeEventMs}ms；首**非空**文本=${stats.firstNonEmptyMs}ms（已喂音频 ${stats.firstNonEmptyAudioFedMs?.toFixed(0)}ms，文本 ${JSON.stringify(stats.firstNonEmptyText)}）pacing=${PACING}`);
	log(`  首非空文本在调用 end() 前已返回=${firstNonEmptyBeforeEndCall}；该 wav 喂完用时 ${zhFeedWallMs}ms（wall）→ 首非空早于「该 wav 喂完」=${firstNonEmptyBeforeSampleFed}`);
	log(`  ⚠ 以上毫秒均为 unpaced（解码完就喂下一帧）且含 HTTP 往返，只证明「分帧返回假设 + decode 吞吐」，**不是实时交互（嘴到字）延迟**。`);
	const hasZh = /[\u4e00-\u9fff]/.test(finalText || allText.join(""));
	const hasEn = /[A-Za-z]{2,}/.test(finalText || allText.join(""));
	if (!stats.frames) throw new Error("没有任何帧被接受");
	if (!firstNonEmptyBeforeEndCall) throw new Error("首非空文本没在 end 之前返回（分帧增量返回失败）");
	if (!finals.length) throw new Error("没有任何 final");
	if (!hasZh) throw new Error(`中文样本没出中文字符：${JSON.stringify(finals)}`);
	if (!hasEn) throw new Error(`英文样本没出英文字母：${JSON.stringify(finals)}`);
	// 真实时间口径：录音时长 vs 墙钟（含 HTTP + 解码）；只描述吞吐，不据此宣称质量。
	const wallMs = Date.now() - startedAt;
	const audioMs = stats.audioMs;
	const entry = {
		samples: { zh: zh.seconds, en: en.seconds },
		frames: stats.frames,
		frameMs: 200,
		pacing: PACING,
		pacingNote: "每帧 decode 回来就立即 append 下一帧，没有按音频时长节流；不是实时麦克风节奏",
		firstTentativeEventMs: stats.firstTentativeEventMs,
		firstNonEmptyMs: stats.firstNonEmptyMs,
		firstNonEmptyText: stats.firstNonEmptyText,
		firstNonEmptyAudioFedMs: stats.firstNonEmptyAudioFedMs === null ? null : Number(stats.firstNonEmptyAudioFedMs.toFixed(0)),
		firstNonEmptyBeforeEndCall,
		firstNonEmptyBeforeSampleFed,
		latencyNote:
			"以上毫秒均在本进程内（HTTP append + sidecar decode）且未做实时 pacing：「在 end() 之前就拿到非空增量假设」是协议事实，不等于实时（嘴到字）延迟；实时节奏下的首字时延本轮未测。",
		endpoints: stats.endpoint,
		finals,
		finalBySegment: Object.fromEntries(finalsBySegment),
		partialText: allText.slice(0, 60),
		tailText,
		audioSeconds: Number((audioMs / 1000).toFixed(2)),
		wallSeconds: Number((wallMs / 1000).toFixed(2)),
		rtfWall: Number((wallMs / audioMs).toFixed(3)),
		rtfNote:
			"RTF = 喂完整段音频的墙钟 / 音频时长（含 HTTP）；是 unpaced 喂音频的 decode 吞吐，不是交互端到端延迟，也不是质量指标。",
		decodeMs: {
			unit: "ms",
			what: "单次 append HTTP 往返（含 sidecar decode）",
			p50: quantile(stats.appendMs, 0.5),
			p95: quantile(stats.appendMs, 0.95),
			min: stats.appendMs.length ? Math.min(...stats.appendMs) : null,
			max: stats.appendMs.length ? Math.max(...stats.appendMs) : null,
			count: stats.appendMs.length,
			note: "旧报告的 decodeMs.p50 实际用了 p95 估计算子（脚本 bug，已修）；旧 json 不重写，见 REPORT-CAVEATS.md",
		},
		// 该权重仓没有 trans.txt（实测 404），确实没有可用参考；保字段仅为兼容旧结构。
		reference: { zh: ref["0.wav"] ?? null, en: ref["1.wav"] ?? null },
		// legacy 字段：不再用 CER 当质量指标（没有人工转写真值语料）。
		qualityCer: { zh: null, en: null },
		cer: { zh: null, en: null },
	};

	// —— 1b) 每个官方 wav 单独一个会话：中 / 英文本各归属清楚（如实记录实际文本，不做质量承诺）
	const oneShot = async (wav) => {
		const before = events.length;
		const s2 = await hub.create({ principal: "local" });
		// 自己的段表：不能污染上面主会话的 finalsBySegment。
		const seg = new Map();
		let q = await feed(hub, s2.sessionId, 0, wav.samples, seg);
		const e2 = await hub.end(s2.sessionId, { principal: "local" });
		for (const ev of events.slice(before)) if (ev.type === "final" && ev.text) seg.set(String(ev.segmentId), ev.text);
		for (const f of e2.finals) if (f.text) seg.set(String(f.segmentId), f.text);
		return { text: [...seg.values()].join(""), segments: Object.fromEntries(seg), events: events.slice(before) };
	};
	/** committed 只能增长且是前缀；committed + tentative 不得缩短（证明「不偷删重复口语」的 wire 语义）。 */
	const prefixInvariants = (evts) => {
		const state = new Map();
		const issues = [];
		for (const e of evts) {
			if (!e.segmentId && e.segmentId !== 0) continue;
			const key = String(e.segmentId);
			const s = state.get(key) ?? { committed: "", display: "" };
			if (e.type === "committed") {
				if (!e.text.startsWith(s.committed)) issues.push(`段 ${key} committed 不是原前缀的延伸：${s.committed} → ${e.text}`);
				s.committed = e.text;
			} else if (e.type === "tentative") {
				s.display = s.committed + e.text;
			} else if (e.type === "final") {
				if (!e.text.startsWith(s.committed)) issues.push(`段 ${key} final 不以 committed 开头：${s.committed} | ${e.text}`);
			}
			state.set(key, s);
		}
		return { ok: issues.length === 0, issues };
	};
	const zhAlone = await oneShot(zh);
	const enAlone = await oneShot(en);
	const zhInv = prefixInvariants(zhAlone.events);
	const enInv = prefixInvariants(enAlone.events);
	log(`  单样本文本：0.wav（中英混说，**不是纯中文**）=${JSON.stringify(zhAlone.text)}`);
	log(`  单样本文本：1.wav（中文夹 ALWAYS，**不是纯英文**）=${JSON.stringify(enAlone.text)}`);
	log(`  前缀自洽（committed 只增长 / final 以前缀开头）：0.wav=${zhInv.ok} 1.wav=${enInv.ok}`);
	if (!zhAlone.text) throw new Error("0.wav 单独识别结果为空");
	if (!enAlone.text) throw new Error("1.wav 单独识别结果为空");
	if (!zhInv.ok) throw new Error(`committed/tentative 前缀不自洽：${zhInv.issues.join(" | ")}`);
	if (!enInv.ok) throw new Error(`committed/tentative 前缀不自洽：${enInv.issues.join(" | ")}`);

	// 与**上游示例输出**的一致度（不是 CER、不是质量）。没源可核的样本不给结论。
	const perSample = (key, wav, alone, inv) => {
		const refDef = STREAM_EXPECT[key];
		const score = refDef.verified ? agreementScore(refDef.text, alone.text) : null;
		return {
			file: STREAM_SAMPLES[key === "0.wav" ? "zh" : "en"].file,
			audioSeconds: wav.seconds,
			text: alone.text,
			segments: alone.segments,
			referenceText: refDef.text,
			referenceKind: refDef.referenceKind,
			referenceSource: refDef.referenceSource,
			agreementScore: score,
			agreementNote: refDef.verified
				? "1 - 归一化编辑距离（去空白 / 标点）；只表示「是否复现上游示例输出」，不代表识别准确率 / 中英质量"
				: "对照串无可公开核对来源（该模型官方文档页面没有 0.wav 示例输出），不给一致度结论；legacy cer 字段保 null",
			qualityCer: null,
			prefixInvariants: { ok: inv.ok, issues: inv.issues },
		};
	};
	const reproduction = {
		basis: STREAM_EXPECT_SOURCE.kind,
		source: STREAM_EXPECT_SOURCE,
		note:
			"对照对象是上游文档里该模型的**示例输出**，不是人工转写真值（groundtruth）；0.wav 是中英混说、1.wav 是中文夹 ALWAYS，两者都不是纯英语语料，**不能当 zh / en 专项测试**。normText 归一化只为比字符串。",
		samples: {
			"0.wav": perSample("0.wav", zh, zhAlone, zhInv),
			"1.wav": perSample("1.wav", en, enAlone, enInv),
		},
	};
	for (const [k, s] of Object.entries(reproduction.samples)) {
		log(`  ${k} 与上游示例输出的一致度=${s.agreementScore}（${s.referenceKind}；非准确率 / 非质量）`);
	}
	const reproEn = reproduction.samples["1.wav"].agreementScore;
	if (reproEn !== null && reproEn < 0.8) throw new Error(`1.wav 与上游示例输出复现不一致（agreement=${reproEn}）：${enAlone.text}`);

	// —— 2) seq 重复：明确拒绝且不重复喂（下一次正确 seq 仍工作，文本不因此翻倍）
	const dup = await hub.create({ principal: "local" });
	await feed(hub, dup.sessionId, 0, zh.samples.subarray(0, FRAME * 3));
	let replayCode = null;
	try {
		await hub.append(dup.sessionId, 0, new Uint8Array(FRAME * 2), { principal: "local" });
	} catch (e) {
		replayCode = e instanceof AsrStreamError ? e.code : `not-asr-error:${e}`;
	}
	if (replayCode !== "asr_stream_seq_replay") throw new Error(`重复 seq 应被拒绝为 asr_stream_seq_replay，实际 ${replayCode}`);
	await hub.end(dup.sessionId, { principal: "local" });

	// —— 3) cancel：会话消失、租约释放，但 worker 不被杀
	const leasesBefore = manager.status().idle.leases;
	const cancelSession = await hub.create({ principal: "local" });
	await feed(hub, cancelSession.sessionId, 0, zh.samples.subarray(0, FRAME * 5));
	const pidBefore = manager.status().runtime.pid;
	await hub.cancel(cancelSession.sessionId, { principal: "local" });
	const leasesAfter = manager.status().idle.leases;
	const aliveAfterCancel = isAlive(pidBefore);
	if (hub.activeCount() !== 0) throw new Error(`cancel 后仍有活跃会话：${hub.activeCount()}`);
	if (leasesAfter !== 0) throw new Error(`cancel 后租约未释放：${leasesBefore}→${leasesAfter}`);
	if (!aliveAfterCancel) throw new Error("cancel 不应杀掉 worker（应只释放租约）");
	log(`  cancel：活跃会话 ${hub.activeCount()}，租约 ${leasesBefore}→${leasesAfter}，worker pid ${pidBefore} 存活=${aliveAfterCancel}`);

	// —— 4) **离线请求拦截**下复跑：已有权重 + runtime 不再拉网
	// 限定说明（重要）：这里只换掉**当前 Node 进程**的 globalThis.fetch，拦非回环 http(s)，
	// 证明的是「这条 JS 边界没有发出外部请求」——不是系统级断网 / 路由阻断，也不审计
	// Python sidecar 子进程自己的网络访问；所以结论只能写「离线请求拦截条件下本地复跑成功」。
	const realFetch = globalThis.fetch;
	let blockedFetches = 0;
	globalThis.fetch = (url, init) => {
		const u = String(url);
		if (!/^https?:\/\/(127\.0\.0\.1|localhost|[[]::1[]])(:|\/|$)/.test(u)) {
			blockedFetches += 1;
			return Promise.reject(new Error(`offline check: blocked ${u.slice(0, 80)}`));
		}
		return realFetch(url, init);
	};
	let offlineText = "";
	let offlineError = null;
	try {
		await manager.stop("smoke-offline");
		await manager.start();
		const st = manager.status();
		const ep2 = asrEndpoint(spec.provider, modelId);
		if (!ep2) throw new Error("端点未注册（offline）");
		const hub2 = makeHub();
		const s2 = await hub2.create({ principal: "local" });
		let q = await feed(hub2, s2.sessionId, 0, zh.samples.subarray(0, 16000 * 3));
		const end2 = await hub2.end(s2.sessionId, { principal: "local" });
		offlineText = (end2.finals.map((f) => f.text).join("") || "").trim();
		log(`  离线请求拦截条件下复跑：pid=${st.runtime.pid} final=${JSON.stringify(offlineText)} 本进程被拦外部请求=${blockedFetches}`);
		if (!offlineText) throw new Error("离线复跑没有出文本（只有准备完才能离线）");
	} catch (e) {
		offlineError = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
	} finally {
		globalThis.fetch = realFetch;
	}
	if (offlineError) throw new Error(`离线复跑失败：${offlineError}`);
	if (blockedFetches !== 0) throw new Error(`离线复跑期间本进程仍有 ${blockedFetches} 次外部网络请求（不应联网）`);

	return {
		...entry,
		reproduction,
		replayBlockedAs: replayCode,
		cancel: { active: 0, leasesAfter, workerAlive: aliveAfterCancel },
		offline: {
			text: offlineText,
			blockedFetches,
			scope: "in-process-fetch-guard",
			what: "只替换本 Node 进程的 globalThis.fetch，拦非回环 http(s)：证明「这条 JS 边界没有外部请求」",
			notProven: "不是系统级 / 物理断网，也不审计 Python sidecar 子进程自身的网络访问；不能据此说「全平台离线已验证」",
			runnerStaticNote:
				"生产 runner 由已 SHA256 校验的本地 ONNX 构造（OnlineRecognizer.from_transducer 读本地文件），运行期不下载权重：这是代码静态结论 + 本边界验证，不是物理断网实测",
		},
	};
}

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
		if (svc.managerFor(modelId).status().install.state !== "installed") {
			const hb = setInterval(() => {
				const st = svc.managerFor(modelId).status().install;
				const pct = st.total ? `${Math.min(100, Math.floor((st.received / st.total) * 100))}%` : "不定";
				log(`  [install 心跳] ${modelId} phase=${st.phase} state=${st.state} ${(st.received / 1e6).toFixed(1)}/${st.total ? (st.total / 1e6).toFixed(1) : "?"}MB ${pct}${st.error ? ` error=${st.error}` : ""}`);
			}, 10_000);
			try {
				await svc.install(modelId, { intent: "install" });
			} finally {
				clearInterval(hb);
			}
		}
		if (process.env.PIA_SMOKE_REWRITE_SERVE === "1") {
			// 只重写 sidecar 脚本（用生产 serveScript 源），用于「权重已装好、脚本修复后复跑」，
			// 不重新下载权重；这条路径只在本 smoke 脚本里，生产仍由 deps.activate 写。
			const { asrRunnerFamily } = await import("../packages/server/src/local-asr/runner.ts");
			const fam = asrRunnerFamily(spec.manifest.runner);
			const scriptPath = deps.paths(modelId).serve;
			writeFileSync(scriptPath, fam.serveScript({ roles: spec.manifest.fileRoles, sampleRate: spec.manifest.sampleRate, maxAudioBytes: 5 * 1024 * 1024 }));
			log(`  重新生成 sidecar 脚本（生产 serveScript 源）→ ${scriptPath}`);
		}
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

		const ep = asrEndpoint(spec.provider, modelId);
		if (!ep) throw new Error("端点未注册");
		if (spec.streaming) {
			// 原生流式模型没有 batch 端点：走生产 `LocalAsrStreamHub`（真实 start/append/end/cancel → 真 sidecar）。
			entry.stream = await runStreamChecks({ spec, modelId, manager: started, ep, svc, deps });
		} else {
			// 真实推理 1：该模型的官方示例（结果必须命中关键片段，不能是固定字幕）。
			const w = await fetchSample(sample);
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
