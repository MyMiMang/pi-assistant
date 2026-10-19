/**
 * 本地语音识别**可选模块**（决策 0013）：默认不装、启动不自动下载；模块卡「先选再装」——
 * 窄接口按目录 modelId 只装所选模型（+ 首次的共享运行环境），装完设为语音来源（期间改选不覆盖，CAS），
 * 模块视图跟着所选模型走，共享运行环境只算一次；窄接口校验 modelId，手机（已配对）也能用。
 *
 * 全部用 fake deps（local-asr-harness.ts），不下载、不起真实 sidecar。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { asrModelSpec } from "../src/local-asr/catalog.ts";
import { ONLINE_ZIPFORMER_MODEL_ID } from "../src/local-asr/manifest.ts";
import { mountLocalAsrRoutes } from "../src/local-asr/routes.ts";
import { ASR_SHARED_RUNTIME_ESTIMATE_BYTES } from "../src/local-asr/service.ts";
import { senseVoicePlatform } from "../src/local-asr/platform.ts";
import { makeHarness } from "./local-asr-harness.ts";

const DEF = ONLINE_ZIPFORMER_MODEL_ID;
const WSMALL = "whisper-small-int8";
const PARA = "paraformer-zh-2023-09-14-int8";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("可选模块：没有启动时自动准备；新鲜用户点「安装」→ 装默认模型，完成后自动 selected & ready（CAS）", async () => {
	const h = makeHarness();
	h.selection.sel = null;
	h.selection.present = false;
	h.selection.ver = 0;
	assert.equal("ensureDefaultVoiceAutoPrep" in h.svc, false, "不再有启动时自动下载入口");
	assert.equal(h.svc.defaultVoicePrepView().prep.state, "not_prepared", "未安装前只是待安装，不会自己开始");
	assert.equal(h.svc.managerFor(DEF).status().install.state, "not_installed");
	assert.equal(h.svc.installDefaultVoice().started, true);
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(h.svc.managerFor(DEF).status().install.state, "installed");
	const sel = h.selection.sel as { location?: string; model?: string } | null;
	assert.equal(sel?.location, "local");
	assert.equal(sel?.model, DEF);
	// 已装好后再点安装：不重复安装。
	assert.equal(h.svc.installDefaultVoice().started, false);
});

test("可选模块视图：默认模型 / 实际状态 / 需用户显式安装 / 首次需联网（不假称断网可用）/ 不申请麦克风", () => {
	const h = makeHarness();
	h.selection.sel = null;
	h.selection.present = false;
	const view = h.svc.defaultVoicePrepView();
	assert.equal(view.defaultModelId, DEF);
	assert.equal(view.kind, "unconfigured");
	assert.equal(view.prep.state, "not_prepared");
	assert.equal(view.prep.jobId, `asr:${DEF}`);
	assert.equal(view.firstRunNeedsNetwork, true);
	assert.equal(view.offlineAfterReady, true);
	assert.equal(view.requiresUserAction, true);
	assert.equal(view.micPermissionRequested, false);
	assert.ok((view.approxBytes ?? 0) >= 198_270_793, "安装量至少是权重体积");
	assert.equal(JSON.stringify(view).includes("token"), false);
});

test("安装中途用户改选来源 → 安装完成不覆盖（CAS / stale intent）", async () => {
	const h = makeHarness();
	h.selection.sel = null;
	h.selection.present = false;
	h.selection.ver = 0;
	h.svc.installDefaultVoice(); // 捕获 selectionAtStart = null / ver 0
	h.selection.sel = { location: "cloud", provider: "openai", model: "whisper-1" };
	h.selection.ver = 1; // 用户中途改选
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(h.selection.sel?.location, "cloud");
	assert.equal(h.selection.sel?.model, "whisper-1");
});

test("取消安装 → 回到未安装（不自动重启）；再点安装走同一个 job 装好", async () => {
	const h = makeHarness();
	h.selection.sel = null;
	h.selection.present = false;
	h.selection.ver = 0;
	h.inst.hangDownload = true;
	assert.equal(h.svc.installDefaultVoice().started, true);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(h.svc.defaultVoicePrepView().prep.state, "preparing");

	assert.equal(h.svc.cancelDefaultVoicePrepare().ok, true);
	await new Promise((r) => setTimeout(r, 10));
	assert.notEqual(h.svc.defaultVoicePrepView().prep.state, "preparing");
	assert.equal(h.svc.cancelDefaultVoicePrepare().ok, false, "没在安装时取消返回 false");

	h.inst.hangDownload = false;
	assert.equal(h.svc.installDefaultVoice().started, true);
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(h.svc.defaultVoicePrepView().prep.state, "ready");
	assert.equal((h.selection.sel as { model?: string } | null)?.model, DEF);
});

test("显式清空来源（key 存在且 null）时 install_and_use 完成也不自动改来源", async () => {
	const h = makeHarness();
	h.selection.sel = null;
	h.selection.present = true; // 用户显式清空过
	h.selection.ver = 3;
	await h.svc.install(DEF, { intent: "install_and_use" });
	assert.equal(h.selection.sel, null, "显式清空不得被自动采用覆盖");
	assert.equal(h.selection.ver, 3, "也不应写来源版本");
	assert.equal(h.svc.managerFor(DEF).status().install.state, "installed");
});

// ------------------------------------------------------------- 先选再装

test("目录：每个模型都有一行「适合什么」；共享运行环境给下载量估算，装过任一模型后标为已就位", async () => {
	const h = makeHarness();
	const view = h.svc.catalog();
	for (const m of view.models) assert.ok(m.suits.length > 0 && m.suits.length <= 24, `${m.id} 适合说明要短：${m.suits}`);
	assert.equal(view.runtime.downloadBytes, ASR_SHARED_RUNTIME_ESTIMATE_BYTES);
	assert.equal(view.runtime.present, false);
	await h.svc.install(PARA, { intent: "install" });
	assert.equal(h.svc.catalog().runtime.present, true);
});

test("先选再装：传 modelId 只装所选模型；视图跟着它；取消省略 modelId 也取消它；装完即设为来源（即使之前选过云端）", async () => {
	const h = makeHarness();
	h.selection.sel = { location: "cloud", provider: "openai", model: "whisper-1" };
	h.selection.present = true;
	h.selection.ver = 2;
	const before = h.svc.defaultVoicePrepView();
	assert.equal(before.modelId, DEF, "还没选时模块对应目录默认");
	assert.equal(before.approxBytes, asrModelSpec(DEF)!.manifest.bytes + ASR_SHARED_RUNTIME_ESTIMATE_BYTES, "首次 = 权重 + 共享运行环境（只算一次）");

	h.inst.hangDownload = true;
	const out = h.svc.installDefaultVoice(WSMALL);
	assert.deepEqual([out.started, out.status], [true, 200]);
	await wait(10);
	const doing = h.svc.defaultVoicePrepView();
	assert.equal(doing.modelId, WSMALL);
	assert.equal(doing.modelName, asrModelSpec(WSMALL)!.name);
	assert.equal(doing.prep.state, "preparing");
	assert.equal(doing.prep.jobId, `asr:${WSMALL}`, "同一个统一下载 job");
	assert.equal(h.svc.cancelDefaultVoicePrepare().ok, true, "省略 modelId = 模块当前在装的那个");
	await wait(10);

	h.inst.hangDownload = false;
	assert.equal(h.svc.installDefaultVoice(WSMALL).started, true);
	await wait(40);
	assert.equal(h.svc.managerFor(WSMALL).status().install.state, "installed");
	assert.equal(h.svc.managerFor(DEF).status().install.state, "not_installed", "没顺带装默认模型");
	assert.deepEqual([...new Set(h.inst.downloads)], [WSMALL], "只下载了所选模型的权重");
	assert.deepEqual(h.selection.sel, { location: "local", provider: asrModelSpec(WSMALL)!.provider, model: WSMALL }, "亲手选的装完即设为来源");
	const ready = h.svc.defaultVoicePrepView();
	assert.equal(ready.prep.state, "ready");
	assert.equal(ready.modelId, WSMALL);
	assert.equal(ready.approxBytes, asrModelSpec(WSMALL)!.manifest.bytes, "运行环境已就位就不再计");
	assert.equal(h.svc.installDefaultVoice(WSMALL).status, 409, "已装不重复装");
});

test("先选再装：安装期间用户改选来源 → 装完不覆盖（CAS）", async () => {
	const h = makeHarness();
	h.selection.sel = { location: "cloud", provider: "openai", model: "whisper-1" };
	h.selection.present = true;
	h.selection.ver = 5;
	h.svc.installDefaultVoice(PARA);
	h.selection.sel = { location: "cloud", provider: "groq", model: "whisper-large-v3" };
	h.selection.ver = 6;
	await wait(40);
	assert.equal(h.svc.managerFor(PARA).status().install.state, "installed");
	assert.equal(h.selection.sel?.provider, "groq", "后来的选择保留");
});

test("窄接口：body.modelId 只认目录（未知 404 / 非字符串 400 / 本平台不可装 400 / 忙 409），不走 localOnly（手机已配对可用）", async () => {
	const h = makeHarness();
	const app = new Hono();
	// localOnly 一律拒绝：窄接口仍可用，证明手机（非本机、已配对）也能安装 / 取消。
	mountLocalAsrRoutes(app as never, async (c) => c.json({ ok: false }, 403), () => h.svc.managerFor("sensevoice-small-int8"), { service: () => h.svc });
	const post = (path: string, body?: unknown) =>
		app.request(`/api/local-models/asr/default-voice/${path}`, { method: "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

	assert.equal((await post("install", { modelId: "nope" })).status, 404);
	assert.equal((await post("install", { modelId: 42 })).status, 400);
	assert.equal((await post("cancel", { modelId: ["x"] })).status, 400);
	h.inst.hangDownload = true;
	const ok = await post("install", { modelId: PARA });
	assert.equal(ok.status, 200);
	assert.equal(((await ok.json()) as { defaultVoice: { modelId: string } }).defaultVoice.modelId, PARA);
	await wait(5);
	assert.equal((await post("install", { modelId: WSMALL })).status, 409, "全局串行：已有安装在进行");
	assert.equal((await post("cancel")).status, 200, "省略 body 取消当前在装的");
	await wait(10);
	h.inst.hangDownload = false;
	assert.equal((await post("install")).status, 200, "旧客户端不带 body：装模块当前模型（这里是刚失败 / 取消的或默认）");
	await wait(40);

	const other = makeHarness();
	other.deps.profile = () => senseVoicePlatform("linux", "ia32");
	const out = other.svc.installDefaultVoice(WSMALL);
	assert.deepEqual([out.started, out.status], [false, 400], "本平台不可装");
	assert.match(out.reason, /不支持/);
});
