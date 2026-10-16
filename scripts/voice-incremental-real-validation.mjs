/**
 * 语音**分段增量**「真实本地模型多段中文」验证（手动运行；不进默认 npm test）。
 *
 * 目的：补上 docs/design/voice-input.md §9 里如实标注的「未验」——用**产品** `VoiceInputController`
 * 接**真实** `LocalAsrService` / `LocalAsrManager` sidecar（**禁 mock**），喂「官方 zh.wav + 静音」多段组合，
 * 验证用户点名的：首段录音尚未 stop 前可见、尾段 flush 不丢、每段按语音原序、结果文本如实记录。
 *
 * 安全边界（与 scripts/local-asr-real-smoke.mjs 同）：
 *  - 只用**带 owner 标记**的 owned scratch（`$TMPDIR/pia-asr-smoke-amv7oy7ejb00`，owner=amv7oy7ejb00）；
 *    未标记的 PIA_SMOKE_DIR 一律拒绝，绝不删除非自有路径。
 *  - 进程内显式覆盖 PIA_DATA_DIR / PIA_WORKSPACE / HOME / UV_CACHE_DIR / UV_PYTHON_INSTALL_DIR / PIP_CONFIG_FILE，
 *    不碰用户真实数据目录 / DB / key / credentials / secrets.ts；不下载 GB 权重（只用已缓存 SenseVoice）。
 *  - 不用真实麦克风：假 getUserMedia + 假 startCapture（音频来自官方样例 WAV）。
 *  - CPU：把 physical/logical cores 覆盖为 4，sidecar `--num-threads` ≤ 4，不霸满 8 核。
 *  - finally：release 录音租约 + stop worker + 断言 pid 退出；只清自己的进程。
 *
 * 用法：node --import tsx scripts/voice-incremental-real-validation.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const OWNER = "amv7oy7ejb00";
const MODEL_ID = "sensevoice-small-int8";
const PROVIDER = "local-sensevoice";
const SR = 48_000; // 采集侧真实采样率：控制器要真重采样到 16k
const CHUNK_MS = 100; // 按真实时间节奏喂 PCM（100ms 一块）

// ---------------------------------------------------------------- owned scratch
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
const dirs = { data: join(root, "data"), workspace: join(root, "workspace"), home: join(root, "home"), uvCache: join(root, "uv-cache"), python: join(root, "python"), wav: join(root, "wav") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
process.env.PIA_DATA_DIR = dirs.data;
process.env.PIA_WORKSPACE = dirs.workspace;
process.env.HOME = dirs.home;
process.env.UV_CACHE_DIR = dirs.uvCache;
process.env.UV_PYTHON_INSTALL_DIR = dirs.python;
process.env.PIP_CONFIG_FILE = "/dev/null";

const { createAsrDeps } = await import("../packages/server/src/local-asr/deps.ts");
const { LocalAsrService } = await import("../packages/server/src/local-asr/service.ts");
const { LocalAsrManager } = await import("../packages/server/src/local-asr/manager.ts");
const { asrEndpoint } = await import("../packages/server/src/local-asr/adapter-registry.ts");
const { transcribeWav } = await import("../packages/server/src/local-asr/transcribe.ts");
const { VoiceInputController } = await import("../apps/web/src/voice-input.ts");

const logged = [];
const log = (...a) => {
	const line = `${new Date().toISOString().slice(11, 19)} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
	logged.push(line);
	console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 官方样例 zh.wav
const ZH_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
const ZH_FILE = "test_wavs/zh.wav";
const zhPath = join(dirs.wav, `${ZH_REPO.replace(/\//g, "_")}-${ZH_FILE.replace(/\//g, "_")}`);
if (!existsSync(zhPath)) throw new Error(`缺少已缓存的官方样例 ${zhPath}（本脚本不下载 GB 权重；请先在 owned scratch 里准备好）`);
const zhBuf = readFileSync(zhPath);

/** 解析标准 PCM WAV → Float32（16k mono）。 */
function wavToFloat32(buf) {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "RIFF") throw new Error("不是 RIFF WAV");
	let at = 12;
	let sampleRate = 0;
	let channels = 0;
	let bits = 0;
	let dataOff = -1;
	let dataLen = 0;
	while (at + 8 <= buf.byteLength) {
		const id = String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
		const size = dv.getUint32(at + 4, true);
		const body = at + 8;
		if (id === "fmt ") {
			channels = dv.getUint16(body + 2, true);
			sampleRate = dv.getUint32(body + 4, true);
			bits = dv.getUint16(body + 14, true);
		} else if (id === "data") {
			dataOff = body;
			dataLen = size;
		}
		at = body + size + (size % 2);
	}
	if (dataOff < 0 || sampleRate !== 16_000 || channels !== 1 || bits !== 16) throw new Error(`样例 WAV 参数不符：rate=${sampleRate} ch=${channels} bits=${bits}`);
	const n = dataLen / 2;
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = dv.getInt16(dataOff + i * 2, true) / 0x8000;
	return out;
}

const zh16k = wavToFloat32(zhBuf);
/** 最近邻升采样 ×3 → 48k（保持内容；用于真正走一次 48k→16k 重采样）。 */
function upsample3(src) {
	const out = new Float32Array(src.length * 3);
	for (let i = 0; i < src.length; i++) {
		out[i * 3] = src[i];
		out[i * 3 + 1] = src[i];
		out[i * 3 + 2] = src[i];
	}
	return out;
}
const zh48k = upsample3(zh16k);
const sil1s = new Float32Array(SR); // 1.0s 静音
/** 组合：zh + 静音1s + zh + 静音1s + zh（≈18.8s，远低于 60s 上限；最后一段不补静音以逼出 flush 尾段）。 */
const combo = new Float32Array(zh48k.length * 3 + sil1s.length * 2);
combo.set(zh48k, 0);
combo.set(sil1s, zh48k.length);
combo.set(zh48k, zh48k.length + sil1s.length);
combo.set(sil1s, zh48k.length * 2 + sil1s.length);
combo.set(zh48k, zh48k.length * 2 + sil1s.length * 2);
const comboSeconds = combo.length / SR;
log(`样例 zh.wav ${zhBuf.length}B sha256=${createHash("sha256").update(zhBuf).digest("hex").slice(0, 16)}…；组合时长 ${comboSeconds.toFixed(2)}s（48k 单声道）`);

// ---------------------------------------------------------------- 服务（CPU ≤4 线程）
const baseDeps = createAsrDeps();
const deps = { ...baseDeps, physicalCores: () => 4, logicalCores: () => 4 };

let selection = null;
const phases = new Map();
const svc = new LocalAsrService({
	createManager: (spec) => {
		let mgr = null;
		mgr = new LocalAsrManager(
			deps,
			{ source: spec.source, license: spec.license, model: spec.manifest, ids: { provider: spec.provider, modelId: spec.id, protocol: "local-asr-http" } },
			() => {
				const st = mgr?.status();
				if (st?.install.state === "installing") {
					const set = phases.get(spec.id) ?? new Set();
					set.add(st.install.phase);
					phases.set(spec.id, set);
				}
			},
		);
		return mgr;
	},
	selection: { read: () => selection, version: () => 0, write: (s) => { selection = s; } },
	onChange: () => {},
	hardware: () => ({ os: process.platform, arch: process.arch, cpuCores: 4, memoryBytes: 16 * 1024 ** 3 }),
});
// 动态 import manager 模块（service 内部也用它，这里直接引用）。
const report = { startedAt: new Date().toISOString(), scratchRoot: root, model: MODEL_ID, sampleRate: SR, comboSeconds: Number(comboSeconds.toFixed(2)), assertions: {}, segments: [], transcribe: { calls: 0, requestIds: [], maxWavMs: 0, errors: [], perCall: [] } };
const transcribeRecords = [];

let manager = null;
let lease = null;
let watchdog = null;
let failure = null;

try {
	if (svc.managerFor(MODEL_ID).status().install.state !== "installed") {
		log("SenseVoice 未安装：开始安装（只用已有缓存 / 自有目录，不碰用户数据）");
		await svc.install(MODEL_ID, { intent: "install" });
	}
	const st0 = svc.managerFor(MODEL_ID).status();
	if (st0.install.state !== "installed") throw new Error(`模型未安装：${st0.install.error}`);
	report.installState = st0.install.state;

	await svc.select(MODEL_ID);
	manager = svc.managerFor(MODEL_ID);
	const rt = manager.status();
	if (rt.runtime.state !== "running") throw new Error(`worker 未运行：${rt.runtime.state} ${rt.runtime.lastError}`);
	report.worker = { pid: rt.runtime.pid, port: rt.runtime.port, health: { ok: rt.health?.ok ?? false, device: rt.health?.device ?? null, loaded: rt.health?.loaded ?? null, modelId: rt.health?.modelId ?? null } };
	log(`真实 sidecar pid=${rt.runtime.pid} port=${rt.runtime.port} health=${JSON.stringify(report.worker.health)}`);
	if (!rt.health?.ok) throw new Error("health 未通过");
	if (rt.health.modelId !== MODEL_ID) throw new Error(`health.modelId=${rt.health.modelId} != ${MODEL_ID}（选错模型）`);

	const ep = asrEndpoint(PROVIDER, MODEL_ID);
	if (!ep) throw new Error("端点未注册");

	// 录音租约：模拟 hook「录音期间持有」，防止 idle 卸载。
	lease = manager.acquireRecording();

	// ------------------------------------------------------------ 产品 controller → 真实 transcribe
	let driver = null;
	let stopped = false;
	let trackStopped = false;
	let captureStops = 0;
	const t0 = Date.now();
	const segs = [];
	const errors = [];
	const controller = new VoiceInputController(
		{
			getUserMedia: async () => ({ getTracks: () => [{ stop: () => { trackStopped = true; } }] }),
			startCapture: async (_stream, onData) => {
				driver = onData;
				return { sampleRate: SR, stop: () => { captureStops++; } };
			},
			transcribe: async ({ audio, requestId, provider, model }) => {
				report.transcribe.calls++;
				report.transcribe.requestIds.push(requestId);
				const wavMs = ((audio.byteLength - 44) / 2 / 16_000) * 1000;
				report.transcribe.maxWavMs = Math.max(report.transcribe.maxWavMs, wavMs);
				if (provider !== PROVIDER || model !== MODEL_ID) throw new Error(`transcribe 收到非预期来源 ${provider}/${model}`);
				const s = Date.now();
				const out = await transcribeWav(manager, ep, Buffer.from(audio), { timeoutMs: 180_000 });
				const rec = { requestId, wavMs: Number(wavMs.toFixed(0)), inferenceMs: Date.now() - s, audioSeconds: out.usage?.audioSeconds ?? null, text: (out.text ?? "").trim() };
				transcribeRecords.push(rec);
				return { text: out.text ?? "" };
			},
		},
		{
			onSegment: (s) => {
				segs.push({ index: s.index, text: s.text, requestId: s.requestId, atMs: Date.now() - t0, beforeStop: !stopped });
				log(`  [段 ${s.index}]${stopped ? "（stop 后 flush）" : "（录音中，边说边出字）"} ${s.text}`);
			},
			onError: (e) => { errors.push(e); log(`  onError ${e.code}: ${e.message}`); },
		},
	);

	watchdog = setTimeout(() => {
		log("看门狗：超过 20 分钟，强制收尾");
		void controller.cancel();
	}, 20 * 60_000);

	await controller.start({ provider: PROVIDER, model: MODEL_ID, anchor: 0, incremental: true });
	if (controller.getState() !== "recording") throw new Error(`控制器未进入 recording：${controller.getState()}`);
	const chunkSamples = Math.round((SR * CHUNK_MS) / 1000);
	for (let off = 0; off < combo.length; off += chunkSamples) {
		driver?.(combo.subarray(off, Math.min(off + chunkSamples, combo.length)));
		await sleep(CHUNK_MS);
	}
	const beforeStopSegs = segs.length;
	const beforeStopText = segs.map((s) => s.text).join("");
	log(`喂完组合音频（${comboSeconds.toFixed(2)}s）；stop 前已出 ${beforeStopSegs} 段：${beforeStopText}`);
	report.assertions.firstSegmentBeforeStop = beforeStopSegs >= 1 && segs[0]?.beforeStop === true;

	stopped = true;
	await controller.stop();
	await sleep(300);
	report.assertions.stateAfterStop = controller.getState();
	report.assertions.stoppedBeforeTail = beforeStopSegs;

	// 段序 / 唯一性
	report.segments = segs;
	const indices = segs.map((s) => s.index);
	report.assertions.segmentIndices = indices;
	report.assertions.ordered = indices.every((v, i) => v === i);
	report.assertions.uniqueRequestIds = new Set(report.transcribe.requestIds).size === report.transcribe.requestIds.length;
	report.assertions.noWholeRetranscribe = report.transcribe.calls === segs.length;
	report.assertions.tailFlushed = segs.length >= 3 && segs[segs.length - 1].beforeStop === false;
	report.assertions.maxWavWithinServerBound = report.transcribe.maxWavMs <= 60_000;
	report.assertions.noError = errors.length === 0;
	report.assertions.trackStopped = trackStopped;
	report.assertions.captureStopped = captureStops >= 1;

	// 整段一次转写基线（同一组合 WAV）
	const wholePcm = Buffer.alloc(44 + (combo.length / 3) * 2); // 48k→16k 后样本数 = len/3
	{
		const n = Math.floor(combo.length / 3);
		const dv = new DataView(wholePcm.buffer);
		const ascii = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
		ascii(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
		dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
		dv.setUint32(24, 16_000, true); dv.setUint32(28, 32_000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
		ascii(36, "data"); dv.setUint32(40, n * 2, true);
		for (let i = 0; i < n; i++) {
			const s = Math.max(-1, Math.min(1, combo[i * 3]));
			dv.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
		}
	}
	const bt = Date.now();
	const base = await transcribeWav(manager, ep, wholePcm, { timeoutMs: 180_000 });
	report.baseline = { text: (base.text ?? "").trim(), seconds: Number(((Date.now() - bt) / 1000).toFixed(2)), audioSeconds: base.usage?.audioSeconds ?? null };
	log(`整段基线（${report.baseline.seconds}s）：${report.baseline.text}`);

	// 关键词命中（每段 + 拼接），如实记录命中次数（不夸大）
	const keywords = ["早上", "下午", "点"];
	const joined = segs.map((s) => s.text).join("");
	const count = (t, k) => (t.match(new RegExp(k, "g")) ?? []).length;
	report.keywordHits = { keywords, perSegment: segs.map((s) => Object.fromEntries(keywords.map((k) => [k, count(s.text, k)]))), joined: Object.fromEntries(keywords.map((k) => [k, count(joined, k)])), baseline: Object.fromEntries(keywords.map((k) => [k, count(report.baseline.text, k)])) };
	log(`关键词命中：拼接=${JSON.stringify(report.keywordHits.joined)} 基线=${JSON.stringify(report.keywordHits.baseline)}`);
} catch (e) {
	failure = e;
	log(`失败：${e?.stack ?? e}`);
} finally {
	if (watchdog) clearTimeout(watchdog);
	try {
		lease?.release();
		report.leaseReleased = true;
	} catch (e) {
		report.leaseReleased = false;
		log(`release 租约失败：${e}`);
	}
	if (manager) {
		const pid = manager.status().runtime.pid;
		try {
			await manager.stop("validation");
		} catch (e) {
			log(`stop 失败：${e}`);
		}
		const end = Date.now() + 5000;
		let dead = !pid;
		while (pid && Date.now() < end) {
			try { process.kill(pid, 0); await sleep(100); } catch { dead = true; break; }
		}
		report.workerStop = { pid, state: manager.status().runtime.state, pidReleased: dead };
		log(`stop：state=${report.workerStop.state} pid=${pid} 已退出=${dead}`);
		if (pid && !dead) failure = failure ?? new Error(`stop 后 pid ${pid} 仍存活（泄漏）`);
	}
	report.finishedAt = new Date().toISOString();
	report.transcribe.perCall = transcribeRecords;
	report.ok = !failure && Object.values(report.assertions).every((v) => v !== false) && report.workerStop?.pidReleased !== false;

	const evidenceDir = resolve(import.meta.dirname, "..", "evidence", "voice-incremental-real");
	mkdirSync(evidenceDir, { recursive: true });
	writeFileSync(join(evidenceDir, "OWNER"), `${OWNER} / voice-incremental-real-validation\n`);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	writeFileSync(join(evidenceDir, `validation-${stamp}.log`), `${logged.join("\n")}\n`);
	writeFileSync(join(evidenceDir, `report-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
	log(`证据写入 evidence/voice-incremental-real/（validation-${stamp}.log / report-${stamp}.json）`);
}

if (failure) {
	console.error(`\n=== VALIDATION FAILED ===\n${failure?.stack ?? failure}`);
	process.exitCode = 1;
} else if (!report.ok) {
	console.error("\n=== VALIDATION FAILED（有断言未通过）===");
	console.error(JSON.stringify(report.assertions, null, 2));
	process.exitCode = 1;
} else {
	console.log("\n=== VALIDATION OK ===");
	console.log(JSON.stringify({ assertions: report.assertions, segments: report.segments.map((s) => `${s.index}:${s.text}`), baseline: report.baseline?.text, keywordHits: report.keywordHits, maxWavMs: report.transcribe.maxWavMs }, null, 2));
}
