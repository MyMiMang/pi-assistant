#!/usr/bin/env node
/**
 * **状态：未运行（2026-10-18 用户取消专项实验）——只做过 `node --check`，一次都没执行；保留作证据，不得当产品能力、不得被 `packages/` / `apps/` import。**
 * 浏览器专项 checkpoint（`cklxx/laya-browser` v19s，revision `645cf366…`）**隔离加载实验**（第一阶段）。
 *
 * 只做三件事，不做质量测试：
 *  1. 按固定清单（size + SHA256）校验已下载的 checkpoint；
 *  2. 用**本机已装**的 local-laya venv（不重装依赖、不动系统 Python）起一个**本次独占**的 `laya-serve`，
 *     环境白名单 + 隔离 HOME/TMP/HF_HOME，只绑 127.0.0.1，token 只在进程内；
 *  3. 读 `/health` 证明真实设备（Apple/MPS）与真实加载，**最多一次** `/v1/systemone` v5 探测（链路证明，不是准确率）。
 *
 * 16GB 单机不热第二个模型：启动前若生产 Laya 在跑，先走**生产回环 API** 停它（记 baseline），
 * 本进程 sidecar 完全退出后再用同一 API 恢复，并 fresh GET 复核。异常 / 超时由外部 supervisor 兜底。
 *
 * 边界（与用户 2026-10-18 纠正一致）：
 *  - 这个 checkpoint 只是**网页分支**的可选实验；原生窗口 AX / 桌面路径与它无关，必须原样保留。
 *  - 不注册产品模型卡、不写产品目录 / 生产 DB、不读凭据、不改用户设置 / 阈值 / 提示词、不 push。
 *  - 不盲用历史 pid / port：生产状态一律先 GET 实际值。
 *
 * 用法（必须经外部 supervisor）：
 *   node scripts/laya-browser-v19s-supervisor.mjs --timeout-ms=1200000 -- \
 *     node --import tsx scripts/laya-browser-v19s-experiment.mjs
 *   PIA_V19S_ROOT=<隔离实验根>       默认工作区下的 laya-browser-v19s-exp
 *   PIA_V19S_SKIP_LOAD=1             只校验，不启动 sidecar
 *   PIA_V19S_ALLOW_STOP_PROD=1       允许为单热模型停生产 Laya（默认 1；设 0 则生产在跑时直接有界失败）
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, userInfo } from "node:os";
import { join } from "node:path";

const OWNER = "amv7oy7ejb00";
const REPO = "cklxx/laya-browser";
const REVISION = "645cf366a2ae35f1086e8c20eff48f909bb49206";
const MODEL_ID = "laya-browser";
const API_BASE = (process.env.PIA_BENCH_APP_API ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const ROOT = process.env.PIA_V19S_ROOT || "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/laya-browser-v19s-exp";
const LAYA_ENV = "/Users/dengdeng/Library/Application Support/Pi Assistant/local-laya/runtime/env";
const SKIP_LOAD = process.env.PIA_V19S_SKIP_LOAD === "1";
const ALLOW_STOP_PROD = process.env.PIA_V19S_ALLOW_STOP_PROD !== "0";
const HEALTH_BUDGET_MS = 240_000;

/** 固定文件清单：来自 docs/research/laya-browser-checkpoint-review.md §2.3（与 HF API 本次复核一致）。 */
const FILES = [
	{ path: ".gitattributes", size: 2106, sha256: "98cd84714c4e072e237100fefa38d4d88770059e157926cefc7a17f4689469ae", optional: true },
	{ path: "README.md", size: 8512, sha256: "09dd7dc3675472a53ee8ab2996ae28ba7831e384503d889947b9811959f540e2", optional: true },
	{ path: "encoder/config.json", size: 1968, sha256: "252795756225d703e1913d5647eb542ded520cfd6684f232cc8f4a5ccb6faf9d" },
	{ path: "model.safetensors", size: 643_835_524, sha256: "82844f2528b9915f8408146384409ccc99f860f56ba0e37d19d0d5775b098e52" },
	{ path: "rl_agent_config.json", size: 561, sha256: "b78796b604532688de6749c61912503cc89b2f998a07b06ef27c280989a34eea" },
	{ path: "tokenizer/tokenizer.json", size: 34_363_188, sha256: "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f" },
	{ path: "tokenizer/tokenizer_config.json", size: 624, sha256: "f2ff584a8f78ac9f3b6fd0afcf9ab310e41c2d445ef628f9ab4b0d594e992b7a" },
];

const paths = {
	root: ROOT,
	home: join(ROOT, "home"),
	tmp: join(ROOT, "tmp"),
	hf: join(ROOT, "hf"),
	ckpt: join(ROOT, "ckpt"),
	logs: join(ROOT, "logs"),
	state: join(ROOT, "worker-state.json"),
	result: join(ROOT, "logs", `result-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
};
for (const d of [paths.root, paths.home, paths.tmp, paths.hf, paths.ckpt, paths.logs]) mkdirSync(d, { recursive: true });
writeFileSync(join(paths.root, ".pia-laya-bench-owner"), `${OWNER}\n`);

const startedAt = new Date().toISOString();
const evidence = { schema: "laya-browser-v19s-experiment/1", owner: OWNER, startedAt, repo: REPO, revision: REVISION, modelId: MODEL_ID, root: paths.root, steps: {} };
const log = (line) => {
	appendFileSync(join(paths.logs, "experiment.log"), `${new Date().toISOString()} ${String(line).replace(/\b[a-f0-9]{32,}\b/gi, "***")}\n`);
	console.error(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saveState = (patch) => {
	const cur = existsSync(paths.state) ? JSON.parse(readFileSync(paths.state, "utf8")) : {};
	writeFileSync(paths.state, JSON.stringify({ ...cur, ...patch, updatedAt: new Date().toISOString() }, null, 2));
};
const saveResult = () => writeFileSync(paths.result, JSON.stringify(evidence, null, 2));

async function sha256File(p) {
	const h = createHash("sha256");
	const { createReadStream } = await import("node:fs");
	await new Promise((res, rej) => {
		const s = createReadStream(p, { highWaterMark: 4 * 1024 * 1024 });
		s.on("data", (b) => h.update(b));
		s.on("end", res);
		s.on("error", rej);
	});
	return h.digest("hex");
}

/** 复用生产校验实现（只读 import，不修改）：verifyPinnedFiles 的清单规则与物化逻辑。 */
async function verify() {
	const { verifyCheckpointFiles } = await import("../packages/server/src/local-laya/verify.ts");
	const { hfTrustRoots, hfSnapshotDir } = await import("../packages/server/src/local-laya/hf-metadata.ts");
	const dir = hfSnapshotDir(paths.hf, REPO, REVISION);
	evidence.steps.verify = { dir, files: [], ok: false };
	if (!existsSync(dir)) throw new Error(`snapshot 目录不存在（还没下载完？）：${dir}`);
	const t0 = Date.now();
	const res = await verifyCheckpointFiles(dir, FILES, hfTrustRoots(paths.hf, REPO));
	evidence.steps.verify = { dir, ok: res.ok, problems: res.problems ?? [], wallMs: Date.now() - t0, files: FILES.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, optional: !!f.optional })) };
	// 逐个文件的实际大小 + 本地重算 SHA256（只有非可选文件必须过；可选文件存在也校验）
	const perFile = [];
	for (const f of FILES) {
		const p = join(dir, f.path);
		if (!existsSync(p)) {
			perFile.push({ path: f.path, present: false, ok: !!f.optional });
			continue;
		}
		const size = statSync(p).size;
		const sha = await sha256File(p);
		perFile.push({ path: f.path, present: true, size, sha256: sha, sizeOk: size === f.size, shaOk: sha === f.sha256 });
	}
	evidence.steps.verify.actual = perFile;
	const bad = perFile.filter((x) => x.present && (!x.sizeOk || !x.shaOk));
	if (!res.ok || bad.length) throw new Error(`校验未通过：${(res.problems ?? []).slice(0, 3).join("；")} ${bad.map((b) => b.path).join(",")}`);
	return dir;
}

/** 把校验过的 snapshot 物化成普通文件（复用生产 materializePinnedFiles；硬链接失败会退回副本）。 */
async function materialize(dir) {
	const { materializePinnedFiles } = await import("../packages/server/src/managed-weights/verify.ts");
	const { hfTrustRoots } = await import("../packages/server/src/local-laya/hf-metadata.ts");
	rmSync(paths.ckpt, { recursive: true, force: true });
	mkdirSync(paths.ckpt, { recursive: true });
	const t0 = Date.now();
	const res = await materializePinnedFiles(dir, paths.ckpt, FILES.filter((f) => !f.optional), hfTrustRoots(paths.hf, REPO));
	evidence.steps.materialize = { dir: paths.ckpt, ok: res.ok, problems: res.problems ?? [], wallMs: Date.now() - t0 };
	if (!res.ok) throw new Error(`物化失败：${(res.problems ?? []).slice(0, 3).join("；")}`);
	const bytes = FILES.filter((f) => !f.optional).reduce((a, f) => a + f.size, 0);
	evidence.steps.materialize.bytes = bytes;
	return paths.ckpt;
}

async function api(pathname, method = "GET", timeoutMs = 10_000) {
	const res = await fetch(`${API_BASE}${pathname}`, { method, signal: AbortSignal.timeout(timeoutMs) });
	const text = await res.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = { raw: text.slice(0, 300) };
	}
	return { status: res.status, body };
}

const prodHealth = (st) => {
	const h = st?.health ?? null;
	return { ok: !!h?.ok, device: h?.device ?? null, loaded: h?.loaded ?? null, checkpointDevices: h?.checkpointDevices ?? null, cpuFallbacks: h?.cpuFallbacks ?? null };
};

async function readProd() {
	const r = await api("/api/local-models/laya/status");
	const st = r.body ?? {};
	return { httpStatus: r.status, runtime: st.runtime ?? null, health: prodHealth(st), configured: !!st.configured, registered: st.registered ?? null };
}

/** 生产 Laya 控制：只走回环 API，先 GET 实际值，不盲用历史 pid / port。 */
async function stopProdIfRunning() {
	const before = await readProd();
	evidence.steps.prodBefore = before;
	saveState({ prodBaselineRunning: before.runtime?.state === "running", prodStopped: false, prodRestored: false });
	if (before.runtime?.state !== "running") return { stopped: false, before };
	if (!ALLOW_STOP_PROD) throw new Error("生产 Laya 正在运行，且本轮不允许停它（PIA_V19S_ALLOW_STOP_PROD=0）");
	log(`停生产 Laya（GET 实际 pid=${before.runtime?.pid} port=${before.runtime?.port}）`);
	const r = await api("/api/local-models/laya/stop", "POST", 30_000);
	const after = await readProd();
	evidence.steps.prodStop = { httpStatus: r.status, after };
	saveState({ prodStopped: true });
	if (after.runtime?.state === "running") throw new Error("生产 Laya 停止后仍报告 running，放弃启动第二个模型");
	return { stopped: true, before, after };
}

async function restoreProd() {
	const st = existsSync(paths.state) ? JSON.parse(readFileSync(paths.state, "utf8")) : {};
	if (!st.prodStopped || st.prodRestored) return { restored: false, reason: "not_needed" };
	const r = await api("/api/local-models/laya/start", "POST", 240_000);
	const deadline = Date.now() + 240_000;
	let last = null;
	for (;;) {
		last = await readProd();
		if (last.runtime?.state === "running" && last.health?.ok) break;
		if (Date.now() > deadline) break;
		await sleep(1000);
	}
	evidence.steps.prodRestore = { httpStatus: r.status, after: last };
	saveState({ prodRestored: true });
	const ok = last.runtime?.state === "running" && last.health?.ok && last.health?.device === "mps";
	if (!ok) throw new Error(`生产 Laya 恢复复核未通过：${JSON.stringify(last).slice(0, 300)}`);
	return { restored: true, after: last };
}

let sidecar = null;

async function findFreePort() {
	const { createServer } = await import("node:net");
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", rej);
		srv.listen(0, "127.0.0.1", () => {
			const a = srv.address();
			srv.close(() => res(typeof a === "object" && a ? a.port : 0));
		});
	});
}

async function startSidecar(ckpt) {
	const port = await findFreePort();
	const token = randomBytes(32).toString("hex");
	const cleanEnv = {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: paths.home,
		TMPDIR: paths.tmp,
		HF_HOME: paths.hf,
		PYTHONNOUSERSITE: "1",
		PYTHONPATH: "",
		VIRTUAL_ENV: "",
		LAYA_HOST: "127.0.0.1",
		LAYA_PORT: String(port),
		LAYA_API_KEY: token,
		LAYA_JEV_STRICT: "1",
		LAYA_THREADS: String(Math.max(1, Math.min(64, availableParallelism()))),
		LAYA_IDLE_UNLOAD_SECONDS: "0",
		LAYA_MAX_LOADED: "1",
		LAYA_PRELOAD: "1",
		LAYA_MODELS: MODEL_ID,
		LAYA_EXTRA_MODELS: JSON.stringify({ [MODEL_ID]: ckpt }),
	};
	const exe = join(LAYA_ENV, "bin", "laya-serve");
	const logFile = join(paths.logs, "serve.log");
	const child = spawn(exe, [], { cwd: paths.root, env: cleanEnv, stdio: ["ignore", "pipe", "pipe"], detached: false });
	const redact = (b) => String(b).replace(/\b[a-f0-9]{32,}\b/gi, "***");
	child.stdout.on("data", (b) => appendFileSync(logFile, redact(b)));
	child.stderr.on("data", (b) => appendFileSync(logFile, redact(b)));
	const exits = [];
	child.on("exit", (code) => {
		for (const cb of exits) cb(code);
	});
	child.on("error", () => {
		for (const cb of exits) cb(null);
	});
	sidecar = { pid: child.pid ?? null, port, token, child, onExit: (cb) => exits.push(cb) };
	saveState({ ownLayaPid: sidecar.pid, ownLayaPort: port });
	evidence.steps.sidecar = { pid: sidecar.pid, port, exe, envKeys: Object.keys(cleanEnv), cwd: paths.root };
	return sidecar;
}

async function health(port, token) {
	const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
	const j = await res.json().catch(() => null);
	return { httpStatus: res.status, body: j };
}

async function waitHealthy(sc) {
	const deadline = Date.now() + HEALTH_BUDGET_MS;
	let last = null;
	let exited = null;
	sc.onExit((code) => {
		exited = code;
	});
	for (;;) {
		try {
			last = await health(sc.port, sc.token);
			const b = last.body ?? {};
			if (b.status === "ok" && Array.isArray(b.loaded) && b.loaded.includes(MODEL_ID)) return { health: last, wallMs: HEALTH_BUDGET_MS - (deadline - Date.now()) };
		} catch {
			/* 还没起来 */
		}
		if (exited !== null) throw new Error(`sidecar 提前退出（code=${exited}）：见 logs/serve.log`);
		if (Date.now() > deadline) throw new Error(`等待 /health 超时（${HEALTH_BUDGET_MS}ms）：最后 ${JSON.stringify(last).slice(0, 300)}`);
		await sleep(500);
	}
}

/** 一次 v5 探测（只证明链路，不判准确率、不设阈值）：合成页，不复用旧四题 / stepwise 页。 */
async function probeOnce(sc) {
	const { buildBrowserRequest, interpretBrowserAnswers } = await import("./laya-browser-input.ts");
	const page = {
		url: "https://example.invalid/checkout",
		title: "Cart",
		text: "Your cart contains one item. Proceed to checkout.",
		actions: [
			{ id: "a1", kind: "click", node: "n1", label: "Continue shopping", role: "link" },
			{ id: "a2", kind: "click", node: "n2", label: "Checkout", role: "button" },
		],
	};
	const req = buildBrowserRequest(page, "Proceed to checkout with the item in the cart.");
	const body = { model: MODEL_ID, state: req.state, questions: req.questions };
	const t0 = Date.now();
	const res = await fetch(`http://127.0.0.1:${sc.port}/v1/systemone`, {
		method: "POST",
		headers: { authorization: `Bearer ${sc.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(120_000),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	const wallMs = Date.now() - t0;
	const answers = json?.answers ?? {};
	const decision = json ? interpretBrowserAnswers(req, answers) : null;
	const out = {
		httpStatus: res.status,
		wallMs,
		requestQuestionIds: Object.keys(req.questions),
		answerIds: Object.keys(answers),
		operation: decision?.operation ?? null,
		actionId: decision?.actionId ?? null,
		reason: decision?.reason ?? null,
		confidence: decision?.confidence ?? null,
		rawError: json ? null : text.slice(0, 400),
		usage: json?.usage ?? null,
	};
	evidence.steps.probe = out;
	return out;
}

async function stopSidecar() {
	if (!sidecar) return { stopped: false, reason: "none" };
	const pid = sidecar.pid;
	try {
		sidecar.child.kill("SIGTERM");
	} catch {
		/* 已退出 */
	}
	const deadline = Date.now() + 20_000;
	let gone = false;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			gone = true;
			break;
		}
		await sleep(300);
	}
	if (!gone) {
		try {
			sidecar.child.kill("SIGKILL");
		} catch {
			/* 已退出 */
		}
		await sleep(1500);
		try {
			process.kill(pid, 0);
			gone = false;
		} catch {
			gone = true;
		}
	}
	evidence.steps.sidecarStop = { pid, gone, forced: !gone };
	saveState({ ownLayaPid: null });
	if (!gone) throw new Error(`自有 sidecar pid ${pid} 仍未退出`);
	return { stopped: true, pid, gone };
}

async function main() {
	log(`start owner=${OWNER} root=${paths.root} user=${userInfo().username}`);
	const dir = await verify();
	evidence.steps.verify.ok = true;
	if (SKIP_LOAD) {
		evidence.result = "verify_only";
		saveResult();
		log("verify_only 完成");
		return;
	}
	const ckpt = await materialize(dir);
	const prod = await stopProdIfRunning();
	if (prod.stopped) {
		// 停完再确认内存/进程状态，给系统一点回收时间
		await sleep(1500);
	}
	const sc = await startSidecar(ckpt);
	const { health: h, wallMs } = await waitHealthy(sc);
	const b = h.body ?? {};
	evidence.steps.health = { httpStatus: h.httpStatus, wallMs, device: b.device ?? null, loaded: b.loaded ?? null, checkpointDevices: b.checkpoint_devices ?? null, cpuFallbacks: b.cpu_fallbacks ?? null, revisions: b.revisions ?? null, status: b.status ?? null };
	evidence.deviceProof = { device: b.device ?? null, isMps: b.device === "mps", checkpointDevice: (b.checkpoint_devices ?? {})[MODEL_ID] ?? null };
	await probeOnce(sc);
	await stopSidecar();
	await restoreProd();
	evidence.result = evidence.deviceProof.isMps && evidence.steps.probe?.operation ? "loaded_on_mps_with_v5_probe" : "loaded_but_incomplete_evidence";
	saveResult();
	log(`完成 result=${evidence.result} device=${evidence.deviceProof.device} probe=${evidence.steps.probe?.operation}/${evidence.steps.probe?.actionId}`);
}

let cleaning = false;
async function cleanupAndExit(code) {
	if (cleaning) return;
	cleaning = true;
	try {
		await stopSidecar().catch((e) => log(`stopSidecar 失败：${e.message}`));
	} catch {
		/* ignore */
	}
	try {
		await restoreProd();
	} catch (e) {
		log(`恢复生产 Laya 失败：${e.message}`);
		code = 1;
	}
	saveResult();
	process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		log(`收到 ${sig}`);
		void cleanupAndExit(1);
	});
}
process.on("unhandledRejection", (e) => {
	log(`unhandledRejection: ${e}`);
	void cleanupAndExit(1);
});

try {
	await main();
	await cleanupAndExit(0);
} catch (e) {
	evidence.error = String(e?.message ?? e).slice(0, 600);
	log(`失败：${evidence.error}`);
	await cleanupAndExit(1);
}
