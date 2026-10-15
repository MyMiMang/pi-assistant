import { mountSubagentRoutes } from "./subagent-routes.ts";
import { mountFastComputerRoutes } from "./fast-computer/routes.ts";
import { mountLocalLayaRoutes } from "./local-laya/routes.ts";
import { mountAsrRoutes, registryAsrProviders, type AsrDeclaration } from "./voice/index.ts";
import { ASR_PROTOCOLS } from "./voice/contract.ts";
import { isAsrProtocol } from "./voice/asr.ts";
import { mountLocalAsrRoutes } from "./local-asr/routes.ts";
import { createRuntimeBenchmarkHost } from "./fast-computer/benchmark-runtime.ts";
import { isStopCommand } from "./interject.ts";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type Next } from "hono";
import QRCode from "qrcode";
import { WebSocket, WebSocketServer } from "ws";
import {
	approveDevice, hasOwner, isOwnerDevice, setOwner, type Caller, claimPairCode, clientIp, createPairCode, deviceForToken, isLocalRequest, listDevices, pairStatus, rateLimit, rejectDevice, revokeDevice, touchDevice,
} from "./auth.ts";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { db, getSetting, now, setSetting } from "./db.ts";
import { attachmentInputFor, fileInfo, getFile, insideWorkspace, listFiles, listWorkspace, mimeOf, saveRoomUpload, saveUpload, workspaceOf } from "./files.ts";
import { identity } from "./identity.ts";
import { answerLogin, cancelLogin, loginLog, startLogin } from "./login-flows.ts";
import { getMessageByClientId, insertMessage, listMessages, toMessage, type MessageRow } from "./messages.ts";
import { credentialBackend, customProviders, defaultModel, defaultThinking, models, providerNames, providerReferences, clearProviderReferences, withProviderName } from "./models.ts";
import { onboardingState } from "./onboarding.ts";
import { getModelPicks, recordModelPick } from "./model-picks.ts";
import { buildRegistry, type RegistryImageProvider, type RegistryProviderHint } from "./model-registry.ts";
import { localModelHints } from "./local-models.ts";
import { hasKey as hasImageKey, listProviders as listImageProviders } from "./image-gen/index.ts";
import { costNote, supportsEdit } from "./image-gen/providers.ts";
import { supportedApis, MODEL_CAPABILITIES, type CustomProviderInput } from "./pi-adapter/custom-providers.ts";
import type { ModelCapability } from "./model-registry.ts";
import { classifierProtocols } from "./pi-adapter/index.ts";
import { checkPiCompat, sessionStats } from "./pi-adapter/index.ts";
import { pushLog, subscribe, vapidPublicKey } from "./push.ts";
import { requests } from "./requests.ts";
import { describeRoutine, disposeConversationRuntime, disposeRuntime, getAgent, getTask, listAgents, runtime, tasks } from "./runtime.ts";
import { dockerAvailable, sandboxMode } from "./sandbox.ts";
import { desktopPause, desktopStatus, ensureOwnScreen, forgetAgentComputer, hasSeparateData, issueTicket, mergeIntoShared, purgeAll, releaseScreen, resetAvailability, screenshotDesktop, setSeparateComputer, shutdownAll, startDesktop, startIdleWatcher, startInstall, stopDesktop, useTicket, viewerClose, viewerOpen, viewToken, vmResourceApplied, vmResourceDiskError, vmResourceInfo } from "./desktop.ts";
import { backend as desktopBackend, builtinFor, dockerBackend } from "./desktop/backend.ts";
import { cancelInstall, imagePresent, installState, pinnedInfo } from "./desktop/image.ts";
import { installWsl, wslInstalling } from "./desktop/wsl.ts";
import { desktopSettings, updateDesktopSettings } from "./desktop/settings.ts";
import "./desktop/image-download.ts";
import { ensureMcpPackage, syncMcpDownloads } from "./mcp-install.ts";
import { agentBusy } from "./runtime.ts";
import { cfStatus, deployRendezvous, removeRendezvous } from "./cloudflare.ts";
import { entryDomain, restartTunnel, retryTunnel, startTunnel, stopTunnel, tunnelStatus } from "./tunnel.ts";
import { checkNamedPerms, namedConfig, removeNamedTunnel, setupNamedTunnel } from "./named-tunnel.ts";
import { sealJson } from "./secrets.ts";
import { createConversation, currentConversation, deleteConversation, getConversation, listConversations, renameConversation, setCurrentConversation } from "./conversations.ts";
import { globalMemoryProviderId, hindsightInUse, listMemoryProviders, memory } from "./memory/index.ts";
import { flush, hindsightMemory, resyncAll } from "./memory/hindsight/provider.ts";
import { configuredModels, resetEmbeddingStore, resolveMemoryModel, sidecar } from "./memory/hindsight/sidecar.ts";
import { embeddingSignature, LOCAL_EMBEDDINGS, LOCAL_RERANKERS, pickMemoryModel, publicSettings, saveHindsightSettings } from "./memory/hindsight/settings.ts";
import { llmProxy } from "./llm-proxy.ts";
import { deleteSkill, getSkill, listSkills } from "./skills.ts";
import { agentsUsingSkill, assignedSkillIds, enableSkillForAgents, setAssignedSkillIds, unassignSkillEverywhere } from "./skill-assignments.ts";
import { ImportConflict, importSkillFromPath, importSkillFromZip } from "./skill-import.ts";
import { agentsOf, configOf, deleteMcp, getMcp, listMcp, type McpServerRow, redact, saveMcp, setMcpEnabled, testMcp } from "./mcp.ts";
import { addPackage, install as installPackage, listPackages, type PiPackageRow, removePackage, setPackageEnabled } from "./pi-packages.ts";
import { listVersions, rollbackSkill, saveSkillVersioned, searchSkills, setSuggestSettings, skillDiff, suggestSettings } from "./skill-intel.ts";
import { createRoutine, deleteAgentRoutines, deleteRoutine, getRoutine, listRoutines, listRuns, type RoutineInput, type RoutineRow, runRoutine, setRoutineStatus, updateRoutine, verifyWebhook, webhookPath } from "./routines.ts";
import { BRAND } from "@pi-assistant/shared";
import { verifySigned } from "./channels/media.ts";
import { startHousekeeping } from "./housekeeping.ts";
import { actionShot, clearActions, listActions } from "./action-log.ts";
import { openWechat, saveWechatSettings, wechatSettings, wechatStatus } from "./wechat.ts";
import { accountJson, deleteAccount, getAccount, listAccounts, PRESETS, saveAccount, saveOAuthAccount, testAccount } from "./email.ts";
import { finishGoogle, googleClient, saveGoogleClient, startGoogle } from "./email-oauth.ts";
import { actOnItem, cancelFollowup, defaultLevel, type ItemRow, type Level, listItems, proactiveJson, runHeartbeat, saveProactive, setDefaultLevel, unseenCount } from "./proactive.ts";
import { cancelWait, listWaits, refreshWait } from "./task-waits.ts";
import { channelJson, clawbotCancel, clawbotLogin, clawbotStatus, clawbotVerify, deleteChannel, getChannel, listChannels, rotateBindCode, saveChannel, setPeerAllowed, testChannel, wecomCallback, type ChannelKind } from "./channels/index.ts";
import { hostAgentsChanged, draftHostSettings, FULL_CONFIRM, TIERS, tierOf, type HostTier, hostPlan, setHostEnv, saveSandboxComputerSettings, sandboxComputerSettings, currentManifest, hostSettings, hostStatus, hostActive, macGrantPermissions, macPermissions, manifestHash, saveHostSettings, setHostPaused, startDaemon, stopDaemon, suggestApps, type HostApp } from "./host-control.ts";
import { downloadInfo, listDownloads, startDownload } from "./downloads.ts";
import { availableModels, confirmMemberProposal, confirmProposal, continueRoom, createRoom, deleteRoom, getRoom, listRoomMessages, markRead as markRoomRead, membersOf, normalizeProposal, onAgentChanged, onAgentDeleted, postUserMessage, roomJson, listRooms, stop as stopRoom, updateRoom, createRoomAgent } from "./rooms/index.ts";
import { copyAgentToUser } from "./rooms/copy.ts";
import { getMessage, updateMessage as patchMessage } from "./messages.ts";
import { buildReplySnapshot, formatQuotedContext, ReplyError, resolveReplyTarget } from "./replies.ts";
import { mountImageRoutes } from "./image-gen/routes.ts";
import { mountPetRoutes } from "./pet/routes.ts";
import { mountUsageRoutes } from "./usage/routes.ts";

type Env = { Bindings: { incoming: IncomingMessage }; Variables: { caller: Caller } };
const app = new Hono<Env>();

const remoteOf = (c: Context<Env>) => c.env.incoming.socket.remoteAddress;

// ---------------------------------------------------------------- 安全头 / CORS / 鉴权 / 限流
app.use("*", async (c, next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "no-referrer");
	c.header("X-Frame-Options", "DENY");
	if (!c.req.path.startsWith("/api/"))
		c.header(
			"Content-Security-Policy",
			"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
		);
});

app.use("/api/*", async (c, next) => {
	const origin = c.req.header("origin");
	const allowed = origin && ((!!entryDomain() && origin === `https://${entryDomain()}`) || origin === new URL(c.req.url).origin);
	if (allowed) {
		c.header("Access-Control-Allow-Origin", origin!);
		c.header("Vary", "Origin");
		c.header("Access-Control-Allow-Headers", "authorization, content-type");
		c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
	}
	if (c.req.method === "OPTIONS") return c.body(null, 204);
	const local = isLocalRequest(remoteOf(c), c.req.raw.headers);
	const ip = clientIp(remoteOf(c), c.req.raw.headers);
	const auth = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
	const deviceId = local ? null : deviceForToken(auth);
	if (!local && !rateLimit(`ip:${ip}:${deviceId ? "auth" : "anon"}`, deviceId ? 600 : 30)) return c.json({ error: "rate_limited" }, 429);
	c.set("caller", { local, deviceId, ip, owner: isOwnerDevice(deviceId) });
	const pub = ["/api/pair/claim", "/api/pair/status/", "/api/system/public", "/hooks/"].some((p) => c.req.path.startsWith(p));
	if (!local && !deviceId && !pub) return c.json({ error: "unauthorized" }, 401);
	if (deviceId) touchDevice(deviceId, ip);
	return next();
});

/** 管理类接口：本机，或主人设备（Linux 服务器版用设置码登录的第一台设备，DESIGN §15.3） */
const isAdmin = (c: Context<Env>) => c.get("caller").local || !!c.get("caller").owner;
const localOnly = async (c: Context<Env>, next: Next) => (isAdmin(c) ? next() : c.json({ error: "local_only" }, 403));
const by = (c: Context<Env>) => c.get("caller").deviceId ?? "local";

// ---------------------------------------------------------------- 系统
app.get("/api/system/public", (c) => c.json({ serverId: identity().serverId, publicKey: identity().publicKey, name: BRAND.name, server: config.headless, setup: config.headless && !hasOwner() }));
/** 安装包里的 app-version.json（scripts/stage-app.mjs 写入）；源码运行时用 tauri.conf.json 的版本 */
let appVer: { version: string; builtAt?: string; launcher: string } | null = null;
function appVersion() {
	if (appVer) return appVer;
	const here = fileURLToPath(new URL("../../..", import.meta.url));
	let v: { version?: string; builtAt?: string } = {};
	for (const f of [process.env.PIA_APP_DIR && join(process.env.PIA_APP_DIR, "app-version.json"), join(here, "app-version.json")])
		try {
			if (f) (v = JSON.parse(readFileSync(f, "utf8"))), (v.version ??= undefined);
			if (v.version) break;
		} catch {}
	if (!v.version)
		try {
			v = { version: `${JSON.parse(readFileSync(join(here, "apps/tray/src-tauri/tauri.conf.json"), "utf8")).version}（源码）` };
		} catch {}
	return (appVer = { version: v.version ?? "未知", builtAt: v.builtAt, launcher: process.env.PIA_LAUNCHER ?? (config.headless ? "server" : "source") });
}
app.get("/api/system", async (c) => {
	const ob = onboardingState();
	return c.json({
		serverId: identity().serverId,
		publicKey: identity().publicKey,
		pi: checkPiCompat(),
		app: appVersion(),
		mock: config.mock,
		// local：能不能改所有设置（本机，或服务器版的主人设备）；界面按它显示管理功能
		local: isAdmin(c),
		owner: !!c.get("caller").owner,
		server: config.headless,
		deviceId: c.get("caller").deviceId,
		onboarded: ob.onboarded,
		modelSetupDone: ob.modelSetupDone,
		modelReady: ob.modelReady,
		defaultModel: (() => {
			const d = defaultModel();
			return d ? withProviderName(d) : d;
		})(),
		credentialBackend,
		sandbox: { mode: await sandboxMode(), preference: getSetting("sandbox", config.sandbox), dockerAvailable: await dockerAvailable() },
		entryDomain: entryDomain(),
		tunnel: tunnelStatus(),
		workspaceRoot: config.workspaceRoot,
		push: { publicKey: vapidPublicKey(), recent: pushLog.slice(-5) },
		seq: bus.seq,
	});
});

app.get("/api/settings", (c) => c.json({ entryDomain: entryDomain(), remoteEnabled: getSetting("remoteEnabled", false), sandbox: getSetting("sandbox", config.sandbox), onboarded: getSetting("onboarded", false) }));
app.put("/api/settings", async (c) => {
	const b = await c.req.json<{ entryDomain?: string | null; remoteEnabled?: boolean; sandbox?: string; onboarded?: boolean }>();
	if (b.entryDomain === "" || b.entryDomain === null) setSetting("entryDomain", null);
	else if (b.entryDomain !== undefined) {
		const d = b.entryDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
		if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return c.json({ error: "入口域名格式不正确" }, 400);
		setSetting("entryDomain", d);
	}
	if (b.sandbox && ["auto", "workspace", "docker"].includes(b.sandbox)) setSetting("sandbox", b.sandbox);
	if (b.onboarded !== undefined) setSetting("onboarded", !!b.onboarded);
	if (b.remoteEnabled !== undefined) {
		if (!isAdmin(c) && !b.remoteEnabled) return c.json({ error: "只能在电脑上关闭远程访问" }, 403);
		setSetting("remoteEnabled", !!b.remoteEnabled);
		if (b.remoteEnabled) startTunnel();
		else stopTunnel();
	}
	bus.emit({ type: "settings.changed" });
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- 模型（完全由 Pi 的 provider 目录驱动）
app.get("/api/models/providers", (c) => {
	const custom = new Map(customProviders.list().map((m) => [m.id, m]));
	return c.json(models.listProviders().map((p) => ({ ...p, custom: custom.has(p.id), configured: p.configured || !!custom.get(p.id)?.configured })));
});
// 自定义模型服务（中转站 / 第三方 / 本地），写入 Pi 的 models.json
app.get("/api/models/custom", (c) => c.json({ providers: customProviders.list().map((p) => ({ ...p, references: providerReferences(p.id) })), apis: supportedApis(), classifierProtocols: classifierProtocols() }));
const customErr = (c: Context<Env>, e: unknown) => c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
app.post("/api/models/custom", async (c) => {
	try {
		return c.json(await customProviders.save(null, await c.req.json<CustomProviderInput>()));
	} catch (e) {
		return customErr(c, e);
	}
});
app.put("/api/models/custom/:id", async (c) => {
	try {
		return c.json(await customProviders.save(c.req.param("id"), await c.req.json<CustomProviderInput>()));
	} catch (e) {
		return customErr(c, e);
	}
});
app.delete("/api/models/custom/:id", async (c) => {
	const id = c.req.param("id");
	try {
		const ok = await customProviders.remove(id);
		const cleared = ok ? clearProviderReferences(id) : null;
		bus.emit({ type: "settings.changed" });
		return c.json({ ok, cleared });
	} catch (e) {
		return customErr(c, e);
	}
});
app.post("/api/models/custom/fetch-models", async (c) => {
	try {
		return c.json({ models: await customProviders.fetchModels(await c.req.json()) });
	} catch (e) {
		return customErr(c, e);
	}
});
// 图片生成模型（image-gen/routes.ts）
mountImageRoutes(app, localOnly);
mountPetRoutes(app, localOnly);
mountUsageRoutes(app);
mountSubagentRoutes(app);
mountFastComputerRoutes(app, createRuntimeBenchmarkHost({ agentId: () => listAgents()[0]?.id ?? null, desktopKind: () => desktopBackend().id }).host);
mountLocalLayaRoutes(app, localOnly);
mountLocalAsrRoutes(app, localOnly);
mountAsrRoutes(app);
app.get("/api/models", (c) => {
	const names = providerNames();
	return c.json(models.listModels(c.req.query("provider") || undefined).map((m) => withProviderName(m, names)));
});
/** 统一模型服务注册表：一份带能力的元数据视图（内置 + 自定义 + 生图 + 本地；凭据仍由 Pi 按 provider 解析）。 */
const registryJson = () => {
	const names = providerNames();
	const providers: RegistryProviderHint[] = models.listProviders().map((p) => ({ id: p.id, name: p.name, configured: p.configured, source: p.source }));
	const image: RegistryImageProvider[] = listImageProviders().map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, models: p.models, configured: hasImageKey(p), credentialProvider: p.keyFrom || undefined }));
	return {
		providers: buildRegistry({
			providers,
			chatModels: models.listModels(),
			classifierModels: models.listClassifierModels(),
			custom: customProviders.list().map((p) => ({ ...p, name: p.name || names.get(p.id) || p.id })),
			image: { providers: image, supportsEdit: (kind, model) => supportsEdit(kind as Parameters<typeof supportsEdit>[0], model), costNote },
			local: localModelHints(),
			asr: registryAsrProviders(),
		}),
	};
};
app.get("/api/models/registry", (c) => c.json(registryJson()));
/**
 * 手动设置自定义模型的能力（统一注册表「手动设能力」的落点）。
 * 只改我们的元数据（不写 Pi 的 models.json）；内置 / 生图 / 本地模型的能力由事实来源决定，不能手改。
 * 返回最新注册表，UI 可直接刷新。
 */
app.put("/api/models/registry/:provider/models/:model/capabilities", async (c) => {
	const b = await c.req.json<{ capabilities?: unknown }>().catch(() => ({ capabilities: undefined }));
	const caps = Array.isArray(b.capabilities) ? [...new Set(b.capabilities.filter((x): x is string => typeof x === "string"))] : [];
	const bad = caps.find((x) => !(MODEL_CAPABILITIES as readonly string[]).includes(x));
	if (bad) return c.json({ error: `不支持的能力：${bad}` }, 400);
	try {
		customProviders.setModelCapabilities(c.req.param("provider"), c.req.param("model"), caps as ModelCapability[]);
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
	bus.emit({ type: "settings.changed" });
	return c.json(registryJson());
});
app.post("/api/models/refresh", async (c) => (await models.refresh(), c.json({ ok: true })));
/**
 * 云语音识别（ASR）声明：复用**已有 provider 的地址 / Key**，只额外记「这个模型走语音转写」。
 * 不新建第二套 Key（凭据仍由 Pi 按 provider 解析）；本地 SenseVoice 由 runtime 上报，不在这里声明。
 */
const asrProvidersJson = () => ({ protocols: ASR_PROTOCOLS, providers: getSetting<AsrDeclaration[]>("asrProviders", []) });
app.get("/api/audio/asr/providers", (c) => c.json(asrProvidersJson()));
app.post("/api/audio/asr/providers", async (c) => {
	const b = await c.req.json<{ provider?: string; model?: string; protocol?: string; name?: string; language?: string }>().catch(() => ({}) as Record<string, string>);
	const provider = String(b.provider ?? "").trim();
	const model = String(b.model ?? "").trim();
	const protocol = String(b.protocol ?? ASR_PROTOCOLS[0]).trim();
	if (!provider || !model) return c.json({ error: "请选择服务和模型" }, 400);
	if (!isAsrProtocol(protocol)) return c.json({ error: "不支持的语音协议" }, 400);
	const known = models.listProviders().some((p) => p.id === provider) || customProviders.list().some((p) => p.id === provider);
	if (!known) return c.json({ error: "服务不存在" }, 400);
	const list = getSetting<AsrDeclaration[]>("asrProviders", []).filter((d) => !(d.provider === provider && d.model === model));
	list.push({ provider, model, protocol, ...(b.name?.trim() ? { name: b.name.trim() } : {}), ...(b.language?.trim() ? { language: b.language.trim() } : {}) });
	setSetting("asrProviders", list);
	bus.emit({ type: "settings.changed" });
	return c.json(asrProvidersJson());
});
app.delete("/api/audio/asr/providers/:provider/:model", (c) => {
	const list = getSetting<AsrDeclaration[]>("asrProviders", []).filter((d) => !(d.provider === c.req.param("provider") && d.model === c.req.param("model")));
	setSetting("asrProviders", list);
	bus.emit({ type: "settings.changed" });
	return c.json(asrProvidersJson());
});
// 用户选过哪些模型：输入栏「常用」置顶（只记 provider/id 的频次和最近一次时间，不存凭据）
app.get("/api/models/picks", (c) => c.json({ picks: getModelPicks() }));
app.post("/api/models/picks", async (c) => {
	const b = await c.req.json<{ provider?: string; id?: string }>();
	if (!b.provider || !b.id || !models.getModel(b.provider, b.id)) return c.json({ error: "模型不存在" }, 400);
	return c.json({ picks: recordModelPick(b.provider, b.id) });
});
app.post("/api/models/login", async (c) => {
	const b = await c.req.json<{ provider: string; type: "api_key" | "oauth" }>();
	return c.json({ flowId: startLogin(b.provider, b.type) });
});
app.get("/api/models/login/:id", (c) => c.json(loginLog(c.req.param("id"))));
app.post("/api/models/login/:id", async (c) => {
	const b = await c.req.json<{ promptId: string; value: string }>();
	return c.json({ ok: answerLogin(c.req.param("id"), b.promptId, b.value) });
});
app.delete("/api/models/login/:id", (c) => c.json({ ok: cancelLogin(c.req.param("id")) }));
app.post("/api/models/logout", async (c) => {
	const b = await c.req.json<{ provider: string }>();
	await models.logout(b.provider);
	return c.json({ ok: true });
});
app.post("/api/models/test", async (c) => {
	const b = await c.req.json<{ provider: string; model: string }>();
	return c.json(await models.test(b.provider, b.model));
});
// 识图模型（legacy，已废弃）：图片现在只跟随当前对话模型，这里仅保留只读兼容旧界面，不再影响路由。
app.get("/api/models/vision", async (c) => {
	const { pickVisionModel, supportsVision } = await import("./vision.ts");
	const names = providerNames();
	const configured = new Set(models.listProviders().filter((p) => p.configured).map((p) => p.id));
	const candidates = models.listModels().filter((m) => configured.has(m.provider) && supportsVision(m)).map((m) => ({ provider: m.provider, id: m.id, name: m.name, providerName: names.get(m.provider) ?? m.provider }));
	const setting = getSetting<{ provider: string; id: string } | null>("visionModel", null);
	const pick = pickVisionModel();
	return c.json({
		deprecated: true,
		deprecatedNote: "识图模型设置已废弃：图片只跟随当前对话模型，不再单独选识图模型；此接口仅为旧界面保留。",
		setting,
		current: pick.model ? withProviderName(pick.model, names) : null,
		source: pick.source,
		candidates,
	});
});
app.put("/api/models/vision", async (c) => {
	// legacy 写入：只保存设置（旧界面用），不再影响图片路由；不删凭据 / 模型。
	const b = await c.req.json<{ provider?: string; id?: string } | null>();
	if (b?.provider && b.id) {
		if (!models.getModel(b.provider, b.id)) return c.json({ error: "模型不存在" }, 400);
		setSetting("visionModel", { provider: b.provider, id: b.id });
	} else setSetting("visionModel", null);
	return c.json({ ok: true, deprecated: true });
});
app.get("/api/models/defaults", (c) => c.json({ model: defaultModel(), thinking: defaultThinking() }));
app.put("/api/models/default", async (c) => {
	const b = await c.req.json<{ provider?: string; model?: string; thinking?: string }>();
	if (b.thinking !== undefined) {
		if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(b.thinking)) return c.json({ error: "思考强度不对" }, 400);
		setSetting("defaultThinking", b.thinking);
	}
	if (b.provider && b.model) {
		if (!models.getModel(b.provider, b.model)) return c.json({ error: "模型不存在" }, 400);
		setSetting("defaultModel", { provider: b.provider, id: b.model });
	}
	bus.emit({ type: "settings.changed" });
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- 助理与聊天
const agentJson = (a: NonNullable<ReturnType<typeof getAgent>>) => {
	const last = db.prepare("SELECT content, role, created_at FROM messages WHERE agent_id = ? AND task_id IS NULL AND subagent_id IS NULL AND room_id IS NULL AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 1").get(a.id);
	return { ...a, session_file: undefined, model: runtime(a.id).modelFor(a), thinking: runtime(a.id).thinkingFor(a), thinkingSetting: a.thinking, workspace: join(config.workspaceRoot, a.id), last, conversation_id: currentConversation(a.id) };
};
app.get("/api/agents", (c) => c.json(listAgents().map(agentJson)));
type AgentInput = { name?: string; avatar?: string; color?: string; persona?: string; description?: string; model?: { provider: string; id: string } | null; thinking?: string | null };
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const cleanAvatar = (v: string | undefined, name: string) => {
	const t = (v ?? "").trim();
	if (t.startsWith("img:")) return t; // 上传的图片（img:<版本>）
	return [...(t || name.trim() || "A")].slice(0, 2).join(""); // emoji 或 1–2 个字
};
app.post("/api/agents", async (c) => {
	const b = await c.req.json<AgentInput>();
	const name = (b.name ?? "").trim().slice(0, 40);
	if (!name) return c.json({ error: "请给助理起个名字" }, 400);
	const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
	const model = b.model && models.getModel(b.model.provider, b.model.id) ? b.model : defaultModel();
	db.prepare("INSERT INTO agents(id, name, avatar, color, persona, description, model_provider, model_id, sort, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
		id, name, cleanAvatar(b.avatar, name), b.color || "#6366f1", (b.persona ?? "").slice(0, 8000), (b.description ?? "").slice(0, 200), model?.provider ?? null, model?.id ?? null, listAgents().length, now(),
	);
	void hostAgentsChanged();
	db.prepare("UPDATE agents SET thinking = ? WHERE id = ?").run(b.thinking && THINKING.includes(b.thinking) ? b.thinking : defaultThinking(), id);
	insertMessage({ agentId: id, role: "assistant", content: `你好，我是${name} 👋\n\n我有自己的电脑，可以写代码、处理文件、上网查资料、操作网页和桌面应用，也能把耗时的活放到后台去做。想让我做点什么？` });
	bus.emit({ type: "agents.changed" });
	return c.json(agentJson(getAgent(id)!));
});
app.patch("/api/agents/:id", async (c) => {
	const a = getAgent(c.req.param("id"));
	if (!a) return c.json({ error: "not_found" }, 404);
	const b = await c.req.json<AgentInput>();
	if (b.model !== undefined && b.model && !models.getModel(b.model.provider, b.model.id)) return c.json({ error: "模型不存在" }, 400);
	const name = b.name !== undefined ? b.name.trim().slice(0, 40) || a.name : a.name;
	db.prepare("UPDATE agents SET name = ?, avatar = ?, color = ?, persona = ?, description = ?, model_provider = ?, model_id = ? WHERE id = ?").run(
		name, b.avatar !== undefined ? cleanAvatar(b.avatar, name) : a.avatar, b.color ?? a.color, b.persona ?? a.persona, b.description ?? a.description,
		b.model === undefined ? a.model_provider : (b.model?.provider ?? null), b.model === undefined ? a.model_id : (b.model?.id ?? null), a.id,
	);
	if (b.thinking !== undefined) {
		if (b.thinking !== null && !THINKING.includes(b.thinking)) return c.json({ error: "思考强度不对" }, 400);
		db.prepare("UPDATE agents SET thinking = ? WHERE id = ?").run(b.thinking, a.id);
	}
	onAgentChanged(a.id);
	bus.emit({ type: "agents.changed" });
	return c.json(agentJson(getAgent(a.id)!));
});
async function deleteAgentFully(id: string) {
	const a = getAgent(id);
	if (!a) return false;
	await disposeRuntime(a.id);
	await forgetAgentComputer(a.id).catch(() => {});
	deleteAgentRoutines(a.id);
	await memory.purgeAgent(a.id);
	onAgentDeleted(a.id);
	// 群里的消息保留（标“已删除”），其余一并删除
	db.prepare("DELETE FROM messages WHERE agent_id = ? AND room_id IS NULL").run(a.id);
	for (const t of ["tasks", "requests", "files", "conversations"]) db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(a.id);
	db.prepare("DELETE FROM agents WHERE id = ?").run(a.id);
	void hostAgentsChanged();
	// 工作区与会话移到回收站（不直接删除，误删可找回）
	const trash = join(config.dataDir, "trash", `${a.id}-${Date.now()}`);
	mkdirSync(trash, { recursive: true });
	for (const [src, dst] of [[join(config.workspaceRoot, a.id), "workspace"], [join(config.agentsDir, a.id), "agent"]] as const) if (existsSync(src)) renameSync(src, join(trash, dst));
	rmSync(join(config.dataDir, "avatars", a.id), { force: true, recursive: true });
	bus.emit({ type: "agents.changed" });
	return true;
}
app.delete("/api/agents/:id", async (c) => ((await deleteAgentFully(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404)));
app.post("/api/agents/:id/avatar", async (c) => {
	const a = getAgent(c.req.param("id"));
	if (!a) return c.json({ error: "not_found" }, 404);
	const f = (await c.req.parseBody()).file;
	if (!(f instanceof File)) return c.json({ error: "no_file" }, 400);
	if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) return c.json({ error: "只支持 PNG / JPG / WebP / GIF" }, 400);
	if (f.size > 2 * 1024 * 1024) return c.json({ error: "头像图片不能超过 2MB" }, 413);
	const dir = join(config.dataDir, "avatars", a.id);
	rmSync(dir, { force: true, recursive: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `avatar.${f.type.split("/")[1]}`), Buffer.from(await f.arrayBuffer()));
	db.prepare("UPDATE agents SET avatar = ? WHERE id = ?").run(`img:${Date.now().toString(36)}`, a.id);
	bus.emit({ type: "agents.changed" });
	return c.json(agentJson(getAgent(a.id)!));
});
app.get("/api/agents/:id/avatar", (c) => {
	const dir = join(config.dataDir, "avatars", c.req.param("id").replace(/[^a-zA-Z0-9_-]/g, ""));
	const f = existsSync(dir) ? readdirSync(dir)[0] : undefined;
	if (!f) return c.json({ error: "not_found" }, 404);
	return c.body(readFileSync(join(dir, f)), 200, { "content-type": `image/${f.split(".").pop() === "jpeg" ? "jpeg" : f.split(".").pop()}`, "cache-control": "private, max-age=31536000, immutable" });
});
app.get("/api/agents/:id/messages", (c) => {
	const before = c.req.query("before");
	return c.json(listMessages(c.req.param("id"), { conversationId: c.req.query("conversation") || undefined, before: before ? Number(before) : undefined, limit: Number(c.req.query("limit") ?? 200) }));
});
app.post("/api/agents/:id/messages", async (c) => {
	const id = c.req.param("id");
	if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
	const b = await c.req.json<{ text: string; attachments?: string[]; conversationId?: string; replyToId?: string; clientId?: string }>();
	const conv = b.conversationId && getConversation(b.conversationId)?.agent_id === id ? b.conversationId : currentConversation(id);
	// 幂等：同 clientId 重复投递直接返回已存在的那条，不再唤醒
	if (b.clientId) {
		const dup = getMessageByClientId({ conversationId: conv, clientId: b.clientId });
		if (dup) return c.json(dup);
	}
	// 引用：服务端解析，失败 fail closed（不落库、不唤醒）
	let snapshot = null;
	if (b.replyToId) {
		try {
			const target = resolveReplyTarget({ scope: { kind: "conversation", id: conv }, messageId: b.replyToId });
			snapshot = buildReplySnapshot(target, { kind: "conversation", id: conv });
		} catch (e) {
			if (e instanceof ReplyError) return c.json({ error: e.message, code: e.code }, e.status as 400 | 403 | 404);
			throw e;
		}
	}
	const files = (b.attachments ?? []).map(getFile).filter((f) => f && f.agent_id === id) as NonNullable<ReturnType<typeof getFile>>[];
	const text = (b.text ?? "").slice(0, 100_000);
	if (!text.trim() && !files.length) return c.json({ error: "empty" }, 400);
	const msg = insertMessage({ agentId: id, conversationId: conv, role: "user", content: text, replyToId: b.replyToId ?? null, replySnapshot: snapshot, clientId: b.clientId ?? null, meta: { attachments: files.map(fileInfo), from: by(c), ...(b.replyToId ? { replyTo: b.replyToId } : {}) } });
	// 正在工作时：停止词立即停；其他消息插进正在进行的任务（delivery: queued → delivered）
	const r = runtime(id, conv);
	const busy = r.busy;
	void r.send(text, files.map((f) => attachmentInputFor(id, f)), { messageId: msg.id, quote: snapshot ? formatQuotedContext(snapshot) : undefined });
	return c.json(busy ? { ...msg, meta: { ...msg.meta, delivery: isStopCommand(text) && !files.length ? "stop" : "queued" } } : msg);
});
app.post("/api/agents/:id/abort", async (c) => {
	const conv = c.req.query("conversation");
	await runtime(c.req.param("id"), conv || undefined).abort();
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- 群聊
const roomErr = (c: Context, e: unknown) => {
	if (e instanceof ReplyError) return c.json({ error: e.message, code: e.code }, e.status as 400 | 403 | 404);
	return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
};
app.get("/api/rooms", (c) => c.json(listRooms()));
app.post("/api/rooms", async (c) => {
	const b = await c.req.json<{ name?: string; purpose?: string; memberIds?: string[]; managerId?: string }>();
	try {
		return c.json(roomJson(createRoom({ name: b.name, purpose: b.purpose, memberIds: b.memberIds ?? [], managerId: b.managerId })));
	} catch (e) {
		return roomErr(c, e);
	}
});
app.get("/api/rooms/:rid", (c) => {
	const r = getRoom(c.req.param("rid"));
	return r ? c.json(roomJson(r)) : c.json({ error: "not_found" }, 404);
});
app.patch("/api/rooms/:rid", async (c) => {
	try {
		return c.json(roomJson(updateRoom(c.req.param("rid"), await c.req.json())));
	} catch (e) {
		return roomErr(c, e);
	}
});
app.delete("/api/rooms/:rid", async (c) => {
	const b = await c.req.json<{ keepAgents?: string[] }>().catch(() => ({}) as { keepAgents?: string[] });
	const r = await deleteRoom(c.req.param("rid"), { keepAgents: b.keepAgents });
	if (!r) return c.json({ error: "not_found" }, 404);
	// 没有保留的群专属助理：和普通删除助理一样清理
	for (const id of r.deletedAgents) await deleteAgentFully(id).catch(() => {});
	return c.json({ ok: true, deletedAgents: r.deletedAgents });
});
app.get("/api/rooms/:rid/messages", (c) => {
	const before = c.req.query("before");
	return c.json(listRoomMessages(c.req.param("rid"), { before: before ? Number(before) : undefined, limit: Number(c.req.query("limit") ?? 200) }));
});
app.post("/api/rooms/:rid/upload", async (c) => {
	const rid = c.req.param("rid");
	if (!getRoom(rid)) return c.json({ error: "not_found" }, 404);
	const f = (await c.req.parseBody()).file;
	if (!(f instanceof File)) return c.json({ error: "no_file" }, 400);
	if (f.size > 100 * 1024 * 1024) return c.json({ error: "文件超过 100MB" }, 413);
	return c.json(fileInfo(saveRoomUpload(rid, f.name, Buffer.from(await f.arrayBuffer()))));
});
app.post("/api/rooms/:rid/messages", async (c) => {
	const b = await c.req.json<{ text: string; mentions?: string[]; attachments?: string[]; replyToId?: string; clientId?: string }>();
	try {
		return c.json(postUserMessage(c.req.param("rid"), String(b.text ?? ""), {
			mentions: Array.isArray(b.mentions) ? b.mentions.map(String) : [],
			from: by(c),
			attachments: Array.isArray(b.attachments) ? b.attachments.map(String) : [],
			replyToId: typeof b.replyToId === "string" && b.replyToId ? b.replyToId : undefined,
			clientId: typeof b.clientId === "string" && b.clientId ? b.clientId : undefined,
		}));
	} catch (e) {
		return roomErr(c, e);
	}
});
/** 单条消息（引用跳转用）；带 roomId / conversationId 时校验容器，不一致 fail closed 不泄露。 */
app.get("/api/messages/:mid", (c) => {
	const m = getMessage(c.req.param("mid"));
	if (!m) return c.json({ error: "not_found" }, 404);
	const rid = c.req.query("roomId");
	const cid = c.req.query("conversationId");
	if (rid && m.room_id !== rid) return c.json({ error: "不在这个群里", code: "reply_cross_scope" }, 403);
	if (cid && (m.room_id || m.conversation_id !== cid)) return c.json({ error: "不在这个对话里", code: "reply_cross_scope" }, 403);
	return c.json(m);
});
/** 目标消息的有界上下文窗口（前后各 ≤ limit/2），用于点击引用后定位，不拉全量历史。 */
app.get("/api/messages/:mid/context", (c) => {
	const mid = c.req.param("mid");
	const m = getMessage(mid);
	if (!m) return c.json({ error: "not_found" }, 404);
	const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 100);
	const rid = c.req.query("roomId");
	const cid = c.req.query("conversationId");
	const half = Math.floor(limit / 2);
	if (m.room_id) {
		if (rid && m.room_id !== rid) return c.json({ error: "不在这个群里", code: "reply_cross_scope" }, 403);
		const row = db.prepare("SELECT rowid AS seq FROM messages WHERE id = ?").get(mid) as { seq: number };
		const rows = db.prepare("SELECT rowid AS seq, * FROM messages WHERE room_id = ? AND rowid >= ? AND rowid <= ? ORDER BY rowid").all(m.room_id, row.seq - half, row.seq + half) as unknown as (MessageRow & { seq: number })[];
		return c.json(rows.map((r) => ({ ...toMessage(r), seq: r.seq })));
	}
	if (m.subagent_id || m.task_id || !m.conversation_id) return c.json({ error: "not_found" }, 404);
	if (cid && m.conversation_id !== cid) return c.json({ error: "不在这个对话里", code: "reply_cross_scope" }, 403);
	const row = db.prepare("SELECT rowid AS seq FROM messages WHERE id = ?").get(mid) as { seq: number };
	const rows = db.prepare("SELECT rowid AS seq, * FROM messages WHERE conversation_id = ? AND task_id IS NULL AND subagent_id IS NULL AND rowid >= ? AND rowid <= ? ORDER BY rowid").all(m.conversation_id, row.seq - half, row.seq + half) as unknown as (MessageRow & { seq: number })[];
	return c.json(rows.map((r) => ({ ...toMessage(r), seq: r.seq })));
});
app.post("/api/rooms/:rid/stop", async (c) => c.json({ ok: await stopRoom(c.req.param("rid")) }));
app.post("/api/rooms/:rid/continue", (c) => {
	try {
		return c.json({ ok: continueRoom(c.req.param("rid")) });
	} catch (e) {
		return roomErr(c, e);
	}
});
app.post("/api/rooms/:rid/read", (c) => (markRoomRead(c.req.param("rid")), c.json({ ok: true })));
/** 一键创建内置管理者（群里没有合适的助理当管理者时） */
app.post("/api/rooms/builtin-manager", async (c) => {
	const b = await c.req.json<{ roomId?: string }>().catch(() => ({}) as { roomId?: string });
	const id = createRoomAgent(b.roomId ?? null, {
		name: "管家",
		avatar: "🧭",
		color: "#0f766e",
		role: "群管理者：理解需求、分配任务、汇总结果",
		persona: "你是群聊的管理者。先弄清用户真正想要什么，再把工作拆给最合适的成员，自己只做协调和简单的事。分配时写清楚每个人要交付什么。成员做完后，给用户一个简短、可执行的总结。",
		model: null,
	});
	if (!b.roomId) db.prepare("UPDATE agents SET scope = 'user' WHERE id = ?").run(id);
	const { safeTier } = await import("./rooms/permissions.ts");
	safeTier(id);
	if (b.roomId && getRoom(b.roomId)) updateRoom(b.roomId, { memberIds: [...membersOf(b.roomId).map((m) => m.agent_id), id], managerId: id });
	bus.emit({ type: "agents.changed" });
	return c.json(agentJson(getAgent(id)!));
});
/** 提议卡片（propose_room / room_propose_member）：用户在卡片上改完点确认才创建 */
app.post("/api/proposals/:mid/confirm", async (c) => {
	const m = getMessage(c.req.param("mid"));
	if (!m || m.role !== "card" || !["room-proposal", "member-proposal"].includes(String(m.meta.kind))) return c.json({ error: "not_found" }, 404);
	if (m.meta.status !== "pending") return c.json({ error: "这张卡片已经处理过了" }, 409);
	const b = await c.req.json<{ proposal?: unknown; member?: unknown }>().catch(() => ({}) as { proposal?: unknown; member?: unknown });
	try {
		if (m.meta.kind === "room-proposal") {
			const p = normalizeProposal((b.proposal ?? m.meta.proposal) as never);
			const room = await confirmProposal(p);
			patchMessage(m.id, { meta: { status: "confirmed", proposal: p, roomId: room.id } });
			return c.json({ ok: true, room: roomJson(getRoom(room.id)!) });
		}
		const roomId = String(m.meta.roomId);
		const [mem] = normalizeProposal({ members: [(b.member ?? m.meta.member) as never] }).members;
		const id = await confirmMemberProposal(roomId, mem);
		patchMessage(m.id, { meta: { status: "confirmed", member: mem, agentId: id } });
		return c.json({ ok: true, agentId: id });
	} catch (e) {
		return roomErr(c, e);
	}
});
app.post("/api/proposals/:mid/dismiss", (c) => {
	const m = getMessage(c.req.param("mid"));
	if (!m || m.role !== "card") return c.json({ error: "not_found" }, 404);
	if (m.meta.status === "pending") patchMessage(m.id, { meta: { status: "dismissed" } });
	return c.json({ ok: true });
});
/** 群专属助理 →「复制到我的助理」 */
app.post("/api/agents/:id/copy", async (c) => {
	const b = await c.req.json<{ name?: string; memory?: boolean }>().catch(() => ({}) as { name?: string; memory?: boolean });
	try {
		const r = await copyAgentToUser(c.req.param("id"), b);
		return c.json({ ...agentJson(getAgent(r.id)!), copiedMemories: r.memories });
	} catch (e) {
		return roomErr(c, e);
	}
});

// ---------------------------------------------------------------- 对话
app.get("/api/agents/:id/conversations", (c) => {
	const id = c.req.param("id");
	if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
	return c.json({ current: currentConversation(id), items: listConversations(id).map((x) => ({ ...x, session_file: undefined })) });
});
app.post("/api/agents/:id/conversations", async (c) => {
	const id = c.req.param("id");
	if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
	const b = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
	return c.json(createConversation(id, (b.title ?? "").slice(0, 60)));
});
app.post("/api/agents/:id/conversations/:cid/select", (c) => c.json({ ok: setCurrentConversation(c.req.param("id"), c.req.param("cid")) }));
app.patch("/api/conversations/:cid", async (c) => {
	const b = await c.req.json<{ title: string }>();
	renameConversation(c.req.param("cid"), String(b.title ?? ""));
	return c.json({ ok: true });
});
app.delete("/api/conversations/:cid", async (c) => {
	await disposeConversationRuntime(c.req.param("cid"));
	return c.json({ ok: !!deleteConversation(c.req.param("cid")) });
});
/** 上下文用量（输入框旁的圆环）：会话还没在内存里时只返回模型的上下文窗口 */
app.get("/api/conversations/:cid/context", async (c) => {
	const conv = getConversation(c.req.param("cid"));
	if (!conv) return c.json({ error: "not_found" }, 404);
	const s = runtime(conv.agent_id, conv.id).session;
	if (s) {
		const st = sessionStats(s);
		return c.json({ ...st, model: st.model ? withProviderName(st.model) : st.model });
	}
	return c.json({ tokens: null, contextWindow: null, percent: null, model: null, session: null });
});
/** 手动整理上下文（Pi compaction） */
app.post("/api/conversations/:cid/compact", async (c) => {
	const conv = getConversation(c.req.param("cid"));
	if (!conv) return c.json({ error: "not_found" }, 404);
	try {
		return c.json({ ok: true, ...(await runtime(conv.agent_id, conv.id).compact()) });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});

// ---------------------------------------------------------------- 记忆（与后端无关）
app.get("/api/memory/providers", (c) => c.json({ global: globalMemoryProviderId(), providers: listMemoryProviders() }));
app.put("/api/memory/provider", async (c) => {
	const { id } = await c.req.json<{ id: string }>();
	if (!listMemoryProviders().some((p) => p.id === id)) return c.json({ error: "unknown_provider" }, 400);
	setSetting("memoryProvider", id);
	syncSidecarWanted();
	return c.json({ ok: true });
});
/** 有人用 Hindsight 就保证它在跑；没人用了就停掉省内存 */
function syncSidecarWanted() {
	if (hindsightInUse()) void sidecar.ensure();
	else if (sidecar.status.state !== "off") void sidecar.stop();
}

// ---------------------------------------------------------------- 高级记忆（Hindsight）
app.get("/api/memory/hindsight", async (c) => {
	const proxy = await llmProxy();
	const ms = await configuredModels();
	return c.json({
		settings: publicSettings(),
		status: hindsightMemory.status(),
		inUse: hindsightInUse(),
		models: ms.map((m) => withProviderName({ provider: m.provider, id: m.id, name: m.name })),
		autoModel: (() => {
			const a = pickMemoryModel(ms, defaultModel());
			return a ? withProviderName(a) : a;
		})(),
		effectiveModel: resolveMemoryModel(),
		localEmbeddings: LOCAL_EMBEDDINGS,
		localRerankers: LOCAL_RERANKERS,
		usage: proxy.stats,
	});
});
app.put("/api/memory/hindsight", localOnly, async (c) => {
	try {
		const { before, after } = saveHindsightSettings(await c.req.json());
		const sigChanged = embeddingSignature(before.embedding) !== embeddingSignature(after.embedding) || before.mode !== after.mode || before.remoteUrl !== after.remoteUrl;
		const needRestart = sigChanged || JSON.stringify(before.reranker) !== JSON.stringify(after.reranker) || before.mirror !== after.mirror;
		const embChanged = embeddingSignature(before.embedding) !== embeddingSignature(after.embedding);
		if (needRestart && sidecar.status.state !== "off")
			void sidecar.restart({ resetStore: embChanged }).then(() => (sigChanged ? resyncAll() : flush()));
		// 没在运行：现在就清掉旧维度的内嵌库，否则下次启动 Hindsight 会因向量维度不一致直接报错
		else if (embChanged) resetEmbeddingStore();
		const running = sidecar.status.state !== "off";
		// 只有已在运行时才会重启 / 重建；没在用时保存只是改设置
		return c.json({ ok: true, restarting: needRestart && running, rebuild: sigChanged && running });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.post("/api/memory/hindsight/restart", localOnly, async (c) => {
	void sidecar.restart();
	return c.json({ ok: true });
});
/** 测试记忆用模型：经本机网关走一遍（与 Hindsight 实际调用路径相同） */
app.post("/api/memory/hindsight/test-model", async (c) => {
	const proxy = await llmProxy();
	// 可以测还没保存的选择（设置页里刚选的）；不传就测当前生效的
	const body = await c.req.json<{ llm?: { provider: string; id: string } | null }>().catch(() => ({}) as { llm?: { provider: string; id: string } | null });
	const m = body.llm ?? resolveMemoryModel();
	if (!m) return c.json({ ok: false, message: "还没有可用的模型，请先在「模型」里配置" });
	const t0 = Date.now();
	try {
		const r = await fetch(`${proxy.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: `${m.provider}/${m.id}`, messages: [{ role: "user", content: "Say 'ok'" }], max_tokens: 16 }), signal: AbortSignal.timeout(60_000) });
		const j = (await r.json()) as { choices?: { message: { content: string } }[]; error?: { message: string } };
		if (!r.ok) return c.json({ ok: false, message: j.error?.message ?? `HTTP ${r.status}` });
		return c.json({ ok: true, message: `${m.provider}/${m.id} 可用（${Date.now() - t0} ms）：${j.choices?.[0]?.message.content?.slice(0, 40) ?? ""}` });
	} catch (e) {
		return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) });
	}
});
app.get("/api/agents/:id/memory", async (c) => {
	const id = c.req.param("id");
	const a = getAgent(id);
	if (!a) return c.json({ error: "not_found" }, 404);
	const items = await memory.list(id, undefined, c.req.query("q") || undefined);
	const p = listMemoryProviders().find((x) => x.id === (a.memory_provider ?? globalMemoryProviderId()))!;
	return c.json({ provider: p, agentProvider: a.memory_provider ?? null, items: items.map((i) => ({ id: i.id, text: i.text, kind: i.kind, scope: i.scope, status: i.status, taskId: i.taskId ?? null, createdAt: i.createdAt, expiresAt: i.expiresAt ?? null, conversationId: i.conversationId ?? null, source: i.origin?.source ?? i.meta?.source ?? null })) });
});
app.post("/api/agents/:id/memory", async (c) => {
	const b = await c.req.json<{ text: string; kind?: "fact" | "experience" | "note"; scope?: "user" | "agent" | "conversation"; conversationId?: string; ttlDays?: number }>();
	try {
		const r = await memory.remember(c.req.param("id"), b.conversationId ?? null, { content: String(b.text ?? ""), kind: b.kind, scope: b.scope, ttlDays: b.ttlDays, source: "user", actor: "user" });
		bus.emit({ type: "memory.changed", agentId: c.req.param("id") });
		return c.json(r);
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.patch("/api/agents/:id/memory/:mid", async (c) => {
	const b = await c.req.json<{ text?: string; kind?: "fact" | "experience" | "note"; scope?: "user" | "agent" | "conversation" }>();
	const id = await memory.update(c.req.param("id"), c.req.param("mid"), b, null, { actor: "user" });
	bus.emit({ type: "memory.changed", agentId: c.req.param("id") });
	return id ? c.json({ ok: true, id }) : c.json({ error: "not_found" }, 404);
});
app.delete("/api/agents/:id/memory/:mid", async (c) => {
	let ok = false;
	try {
		ok = await memory.forget(c.req.param("id"), c.req.param("mid"), { actor: "user" });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 403);
	}
	bus.emit({ type: "memory.changed", agentId: c.req.param("id") });
	return c.json({ ok });
});
app.get("/api/agents/:id/memory/export", async (c) => {
	try {
		const data = await memory.exportAgent(c.req.param("id"));
		return c.body(JSON.stringify(data, null, 2), 200, { "content-type": "application/json", "content-disposition": `attachment; filename="memory-${c.req.param("id")}.json"` });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
/** 反思：在记忆上推理作答（后端支持时，如 Hindsight） */
app.post("/api/agents/:id/memory/reflect", async (c) => {
	const { query } = await c.req.json<{ query: string }>();
	try {
		const r = await memory.reflect(c.req.param("id") as string, String(query ?? "").slice(0, 1000), { actor: "user" });
		if (!r) return c.json({ error: "当前记忆后端不支持反思" }, 400);
		return c.json({ answer: r.answer, citations: (r.citations ?? []).slice(0, 8).map((i) => ({ id: i.id, text: i.text })) });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
/** 导入统一格式的记忆 JSON（本应用导出的文件；可以来自另一个后端或另一台电脑） */
app.post("/api/agents/:id/memory/import", async (c) => {
	try {
		const n = await memory.importAgent(c.req.param("id") as string, await c.req.json());
		bus.emit({ type: "memory.changed", agentId: c.req.param("id") });
		return c.json({ ok: true, count: n });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.put("/api/agents/:id/memory-provider", async (c) => {
	const { id } = await c.req.json<{ id: string | null }>();
	if (id && !listMemoryProviders().some((p) => p.id === id)) return c.json({ error: "unknown_provider" }, 400);
	db.prepare("UPDATE agents SET memory_provider = ? WHERE id = ?").run(id, c.req.param("id"));
	syncSidecarWanted();
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- 技能库（Pi 原生 Agent Skills）
// 库存带 canonical id / 来源 / 启用了它的助理列表，供界面显示「启用数」与按 agent 配置。
const skillJson = (s: ReturnType<typeof listSkills>[number]) => ({ id: s.id, name: s.name, description: s.description, source: s.source, builtin: s.builtin, size: s.body.length, enabledAgents: agentsUsingSkill(s.id) });
app.get("/api/skills", (c) => c.json(listSkills().map(skillJson)));
app.get("/api/skills/:name", (c) => {
	const s = getSkill(c.req.param("name"));
	return s ? c.json({ ...skillJson(s), body: s.body }) : c.json({ error: "not_found" }, 404);
});
// 某助理启用的技能（canonical id 列表）；缺失 / [] 都是不启用任何技能。
app.get("/api/agents/:id/skills", (c) => c.json({ enabled: assignedSkillIds(c.req.param("id")) }));
app.put("/api/agents/:id/skills", async (c) => {
	const b = await c.req.json<{ ids?: unknown }>();
	if (!Array.isArray(b.ids) || !b.ids.every((x) => typeof x === "string")) return c.json({ error: "ids 必须是字符串数组" }, 400);
	if (!getAgent(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
	setAssignedSkillIds(c.req.param("id"), b.ids as string[]);
	return c.json({ enabled: assignedSkillIds(c.req.param("id")) });
});
// 批量给当前所有助理启用某技能（UI 的「给所有助理启用」）；不建立对未来新助理的继承。
app.post("/api/skills/:name/enable-all", (c) => {
	const s = getSkill(c.req.param("name"));
	if (!s) return c.json({ error: "not_found" }, 404);
	enableSkillForAgents(listAgents().map((a) => a.id), s.id);
	return c.json({ ok: true, id: s.id, agents: agentsUsingSkill(s.id) });
});
// 外部导入：zip 文件或本机路径（目录 / 单个 SKILL.md）。先入库，可选只 enable 目标助理。
// 同名内容不同返回 409 conflict，由界面让用户选 update / newName，绝不静默覆盖。
app.post("/api/skills/import", async (c) => {
	const body = await c.req.parseBody();
	const mode = (typeof body.mode === "string" && ["conflict", "update", "rename"].includes(body.mode) ? body.mode : "conflict") as "conflict" | "update" | "rename";
	const newName = typeof body.newName === "string" && body.newName.trim() ? body.newName.trim() : undefined;
	const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;
	try {
		const file = body.file as { arrayBuffer?: () => Promise<ArrayBuffer> } | undefined;
		const r = file?.arrayBuffer
			? await importSkillFromZip(new Uint8Array(await file.arrayBuffer()), { mode, newName })
			: typeof body.path === "string" && body.path.trim()
				? importSkillFromPath(body.path.trim(), { mode, newName })
				: null;
		if (!r) return c.json({ error: "请上传 zip，或填写本机目录 / SKILL.md 路径" }, 400);
		if (agentId && getAgent(agentId)) setAssignedSkillIds(agentId, [...new Set([...assignedSkillIds(agentId), r.id])]);
		return c.json(r);
	} catch (e) {
		if (e instanceof ImportConflict) return c.json({ error: "conflict", existing: e.existing, incoming: e.incoming }, 409);
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.post("/api/skills", async (c) => {
	const b = await c.req.json<{ name: string; description: string; body: string; previousName?: string; agentId?: string }>();
	if (getSkill(b.name)?.builtin) return c.json({ error: "内置技能不能覆盖，请换一个名字" }, 400);
	try {
		const s = saveSkillVersioned(b, "user");
		// 模型给某个助理新建的技能：默认只启用给那个助理（没有 target 就是不给任何人启用）
		if (b.agentId && getAgent(b.agentId)) setAssignedSkillIds(b.agentId, [...new Set([...assignedSkillIds(b.agentId), s.id])]);
		return c.json({ ...s, path: undefined });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
// 删除物理库存：先提示影响哪些已启用它的助理；未确认（?force 缺失）且有助理在用则返回 409。
app.delete("/api/skills/:name", (c) => {
	const s = getSkill(c.req.param("name"));
	if (!s) return c.json({ error: "not_found" }, 404);
	const affected = agentsUsingSkill(s.id);
	if (affected.length && c.req.query("force") !== "1") return c.json({ error: "in_use", agents: affected }, 409);
	unassignSkillEverywhere(s.id);
	return c.json({ ok: deleteSkill(s.name), agents: affected });
});
app.get("/api/skills-search", (c) => c.json(searchSkills(c.req.query("q") ?? "")));
app.get("/api/skills/:name/versions", (c) => {
	const vs = listVersions(c.req.param("name"));
	// 每个版本附上相对上一版本的 diff
	return c.json(vs.map((v, i) => ({ ...v, diff: skillDiff(v.name, vs[i + 1] ?? null, v) })));
});
app.post("/api/skills/:name/rollback", async (c) => {
	const { version } = await c.req.json<{ version: number }>();
	try {
		return c.json({ ...rollbackSkill(c.req.param("name"), version), path: undefined });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.get("/api/skill-suggest", (c) => c.json(suggestSettings()));
app.put("/api/skill-suggest", async (c) => (setSuggestSettings(await c.req.json()), c.json(suggestSettings())));

// ---------------------------------------------------------------- MCP 服务器与 Pi 扩展包
// 写操作只允许在这台电脑上做（stdio MCP 会在电脑上运行命令，扩展包会运行代码）
const mcpJson = (r: McpServerRow) => ({ id: r.id, name: r.name, enabled: !!r.enabled, agents: agentsOf(r), config: redact(configOf(r)), status: r.status, tools: r.tools ? JSON.parse(r.tools) : null, error: r.error, checkedAt: r.checked_at });
const errJson = (c: Context<Env>, e: unknown) => c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
app.get("/api/mcp", (c) => c.json(listMcp().map(mcpJson)));
app.post("/api/mcp", localOnly, async (c) => {
	try {
		const r = saveMcp(await c.req.json());
		void ensureMcpPackage(r.id).then(() => testMcp(r.id)).then(() => bus.emit({ type: "mcp.changed" } as never));
		return c.json(mcpJson(r));
	} catch (e) {
		return errJson(c, e);
	}
});
app.put("/api/mcp/:id", localOnly, async (c) => {
	try {
		const r = saveMcp({ ...(await c.req.json()), id: (c.req.param("id") as string) });
		void ensureMcpPackage(r.id).then(() => testMcp(r.id)).then(() => bus.emit({ type: "mcp.changed" } as never));
		return c.json(mcpJson(r));
	} catch (e) {
		return errJson(c, e);
	}
});
app.patch("/api/mcp/:id", localOnly, async (c) => {
	const b = await c.req.json<{ enabled: boolean; agents?: string[] | null }>();
	if (!getMcp((c.req.param("id") as string))) return c.json({ error: "not_found" }, 404);
	setMcpEnabled((c.req.param("id") as string), b.enabled, b.agents);
	return c.json(mcpJson(getMcp((c.req.param("id") as string))!));
});
app.post("/api/mcp/:id/test", localOnly, async (c) => {
	try {
		const r = await testMcp((c.req.param("id") as string));
		return c.json({ ...r, server: mcpJson(getMcp((c.req.param("id") as string))!) });
	} catch (e) {
		return errJson(c, e);
	}
});
app.delete("/api/mcp/:id", localOnly, (c) => {
	const ok = deleteMcp(c.req.param("id") as string);
	syncMcpDownloads();
	return c.json({ ok });
});
syncMcpDownloads();

const pkgJson = (p: PiPackageRow) => ({ ...p, enabled: !!p.enabled, agents: p.agents ? JSON.parse(p.agents) : null, resources: p.resources ? JSON.parse(p.resources) : null });
app.get("/api/pi-packages", (c) => c.json(listPackages().map(pkgJson)));
app.post("/api/pi-packages", localOnly, async (c) => {
	const b = await c.req.json<{ source: string; agents?: string[] | null }>();
	try {
		return c.json(pkgJson(await addPackage(b.source, b.agents ?? null)));
	} catch (e) {
		return errJson(c, e);
	}
});
app.post("/api/pi-packages/:id/reinstall", localOnly, async (c) => (void installPackage((c.req.param("id") as string)), c.json({ ok: true })));
app.patch("/api/pi-packages/:id", localOnly, async (c) => {
	const b = await c.req.json<{ enabled: boolean; agents?: string[] | null }>();
	setPackageEnabled((c.req.param("id") as string), b.enabled, b.agents);
	return c.json({ ok: true });
});
app.delete("/api/pi-packages/:id", localOnly, async (c) => c.json({ ok: await removePackage((c.req.param("id") as string)) }));

// ---------------------------------------------------------------- 定时与触发
const routineJson = (r: RoutineRow) => {
	const last = listRuns(r.id, 1)[0] ?? null;
	return { ...r, webhook_secret: undefined, quiet: r.quiet ? JSON.parse(r.quiet) : null, webhookPath: webhookPath(r), lastRun: last };
};
app.get("/api/agents/:id/routines", (c) => c.json(listRoutines(c.req.param("id")).map(routineJson)));
app.post("/api/routines/preview", async (c) => {
	const b = await c.req.json<{ trigger: string; cron?: string; quietHours?: boolean }>();
	try {
		return c.json({ ok: true, text: describeRoutine(b) });
	} catch (e) {
		return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
	}
});
app.post("/api/agents/:id/routines", async (c) => {
	const id = c.req.param("id");
	if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
	try {
		const b = await c.req.json<RoutineInput>();
		return c.json(routineJson(createRoutine(id, { ...b, conversationId: b.conversationId ?? currentConversation(id) }, by(c))));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.patch("/api/routines/:rid", async (c) => {
	try {
		return c.json(routineJson(updateRoutine(c.req.param("rid"), await c.req.json<Partial<RoutineInput>>())));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.post("/api/routines/:rid/:action{pause|resume|run}", (c) => {
	const rid = c.req.param("rid");
	if (!getRoutine(rid)) return c.json({ error: "not_found" }, 404);
	const action = c.req.param("action");
	if (action === "run") return c.json(runRoutine(rid, "manual"));
	return c.json(routineJson(setRoutineStatus(rid, action === "pause" ? "paused" : "active")!));
});
app.delete("/api/routines/:rid", (c) => c.json({ ok: deleteRoutine(c.req.param("rid")) }));
app.get("/api/routines/:rid/runs", (c) => c.json(listRuns(c.req.param("rid"), 50)));
/** Webhook 触发（公开地址，凭 URL 里的密钥；请求体作为外部数据附在指令后） */
app.post("/hooks/:rid/:secret", async (c) => {
	const ip = c.get("caller").ip;
	if (!rateLimit(`hook:${c.req.param("rid")}`, 2, 5) || !rateLimit(`hookip:${ip}`, 10, 10)) return c.json({ error: "rate_limited" }, 429);
	const r = verifyWebhook(c.req.param("rid"), c.req.param("secret"));
	if (!r) return c.json({ error: "not_found" }, 404);
	if (r.status !== "active") return c.json({ error: "paused" }, 409);
	const body = (await c.req.text()).slice(0, 16_000);
	const run = runRoutine(r.id, "webhook", body || undefined);
	return c.json({ ok: true, runId: run.id, status: run.status }, 202);
});
app.post("/api/agents/:id/read", (c) => {
	db.prepare("UPDATE agents SET unread = 0 WHERE id = ?").run(c.req.param("id"));
	bus.emit({ type: "agent.read", agentId: c.req.param("id") });
	return c.json({ ok: true });
});
app.post("/api/agents/:id/upload", async (c) => {
	const id = c.req.param("id");
	if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
	const body = await c.req.parseBody();
	const f = body.file;
	if (!(f instanceof File)) return c.json({ error: "no_file" }, 400);
	if (f.size > 100 * 1024 * 1024) return c.json({ error: "文件超过 100MB" }, 413);
	const row = saveUpload(id, f.name, Buffer.from(await f.arrayBuffer()));
	return c.json(fileInfo(row));
});
app.get("/api/agents/:id/files", (c) => c.json(listFiles(c.req.param("id"))));
app.get("/api/agents/:id/workspace", (c) => {
	try {
		return c.json(listWorkspace(c.req.param("id"), c.req.query("path") ?? ""));
	} catch (e) {
		return c.json({ error: String(e) }, 400);
	}
});
app.get("/api/agents/:id/workspace/file", (c) => {
	const abs = insideWorkspace(c.req.param("id"), c.req.query("path") ?? "");
	if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return c.json({ error: "not_found" }, 404);
	return sendFile(c, abs, abs.split(/[\\/]/).pop()!, mimeOf(abs));
});
app.get("/api/agents/:id/tasks", (c) => c.json(tasks.list(c.req.param("id"))));
app.get("/api/tasks/:id/messages", (c) => {
	const t = getTask(c.req.param("id"));
	return t ? c.json(listMessages(t.agent_id, { taskId: t.id })) : c.json({ error: "not_found" }, 404);
});
app.post("/api/tasks/:id/cancel", async (c) => c.json({ ok: await tasks.cancel(c.req.param("id")) }));
/** 任务等待：状态 + 最后检查时间可查询；手动刷新让用户问“现在怎么样了”立刻有结果 */
app.get("/api/agents/:id/task-waits", (c) => c.json(listWaits(c.req.param("id"))));
app.post("/api/task-waits/:id/refresh", async (c) => {
	try {
		const r = await refreshWait(c.req.param("id"));
		return c.json({ wait: r.wait, outcome: r.outcome, fired: r.fired });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
	}
});
app.post("/api/task-waits/:id/cancel", (c) => c.json({ ok: cancelWait(c.req.param("id")) }));
/** 旧接口（按天 × 助理 × 模型）：现在从新的用量表算；新界面用 /api/usage/summary */
app.get("/api/usage", (c) =>
	c.json(db.prepare("SELECT agent_id, day, provider, model, SUM(input + cache_read + cache_write) input, SUM(output) output, COALESCE(SUM(cost), 0) cost FROM usage_calls GROUP BY agent_id, day, provider, model ORDER BY day DESC LIMIT 200").all()),
);

function sendFile(c: Context<Env>, path: string, name: string, mime: string) {
	const inline = c.req.query("inline") === "1" && /^(image\/(png|jpeg|gif|webp)|text\/plain)$/.test(mime);
	c.header("Content-Type", inline ? mime : mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime);
	c.header("Content-Length", String(statSync(path).size));
	c.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
	c.header("Cache-Control", "private, max-age=3600");
	return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
}
// 渠道里发不了的文件：签名的公开下载链接（只在配置了固定地址时生成，7 天有效）
app.get("/hooks/dl/:id/:exp/:sig", (c) => {
	const id = c.req.param("id");
	if (!verifySigned(id, c.req.param("exp"), c.req.param("sig"))) return c.json({ error: "link_expired" }, 403);
	const f = getFile(id);
	if (!f || !existsSync(f.stored_path)) return c.json({ error: "not_found" }, 404);
	return sendFile(c, f.stored_path, f.name, f.mime);
});
app.get("/api/files/:id", (c) => {
	const f = getFile(c.req.param("id"));
	if (!f || !existsSync(f.stored_path)) return c.json({ error: "not_found" }, 404);
	return sendFile(c, f.stored_path, f.name, f.mime);
});

// ---------------------------------------------------------------- 审批 / 提问
app.post("/api/requests/:id", async (c) => {
	const b = await c.req.json<{ approved?: boolean; answer?: string; note?: string; scope?: string }>();
	return c.json(requests.resolve(c.req.param("id"), { approved: b.approved, answer: b.answer, note: b.note, scope: b.scope === "task" ? "task" : undefined }, by(c)));
});

// ---------------------------------------------------------------- 聊天渠道（企业微信 / 飞书 / 钉钉）
app.get("/api/channels", (c) => {
	const t = tunnelStatus();
	return c.json({ items: listChannels().map(channelJson), publicUrl: t.state === "online" ? t.url : null, tunnelMode: t.mode });
});
app.post("/api/channels", localOnly, async (c) => {
	try {
		const b = await c.req.json<{ kind: ChannelKind; name?: string; agentId: string; config?: Record<string, unknown>; secret?: Record<string, unknown> }>();
		return c.json(channelJson(saveChannel(b)));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.put("/api/channels/:id", localOnly, async (c) => {
	const cur = getChannel(c.req.param("id")!);
	if (!cur) return c.json({ error: "not_found" }, 404);
	try {
		const b = await c.req.json<{ name?: string; agentId?: string; enabled?: boolean; config?: Record<string, unknown>; secret?: Record<string, unknown> }>();
		return c.json(channelJson(saveChannel({ ...b, id: cur.id, kind: cur.kind, agentId: b.agentId ?? cur.agent_id })));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.delete("/api/channels/:id", localOnly, async (c) => {
	await deleteChannel(c.req.param("id")!);
	return c.json({ ok: true });
});
// ---------------------------------------------------------------- 主动提醒
app.get("/api/proactive/inbox", (c) => {
	const agentId = c.req.query("agentId") || undefined;
	return c.json({ items: listItems({ agentId, all: c.req.query("all") === "1" }).map(itemJson), count: unseenCount(), defaultLevel: defaultLevel() });
});
const itemJson = (i: ItemRow) => ({ id: i.id, agentId: i.agent_id, kind: i.kind, title: i.title, body: i.body, importance: i.importance, status: i.status, reason: i.reason, via: i.delivered_via, deliveredAt: i.delivered_at, deliverAfter: i.deliver_after, createdAt: i.created_at });
app.post("/api/proactive/items/:id", async (c) => {
	try {
		const b = await c.req.json<{ action: "dismiss" | "done" | "snooze"; mute?: boolean; until?: number }>();
		if (!["dismiss", "done", "snooze"].includes(b.action)) return c.json({ error: "bad_action" }, 400);
		actOnItem(c.req.param("id")!, b.action, { mute: !!b.mute, until: b.until });
		return c.json({ ok: true });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.get("/api/agents/:id/proactive", (c) => {
	try {
		return c.json(proactiveJson(c.req.param("id")!));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
	}
});
app.put("/api/agents/:id/proactive", async (c) => {
	try {
		return c.json(saveProactive(c.req.param("id")!, await c.req.json()));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.post("/api/agents/:id/proactive/run", (c) => {
	try {
		return c.json({ runId: runHeartbeat(c.req.param("id")!, "manual") });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.delete("/api/agents/:id/proactive/followups/:fid", (c) => c.json({ ok: cancelFollowup(c.req.param("id")!, c.req.param("fid")!) }));
app.put("/api/proactive/defaults", async (c) => {
	try {
		setDefaultLevel((await c.req.json<{ level: Level }>()).level);
		return c.json({ ok: true, defaultLevel: defaultLevel() });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});

// 微信 ClawBot 扫码连接：已配对的手机也能看二维码（在手机上长按识别），所以不限本机
app.post("/api/channels/:id/clawbot/login", async (c) => {
	try {
		return c.json(await withQr(await clawbotLogin(c.req.param("id")!)));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.get("/api/channels/:id/clawbot/login", async (c) => c.json(await withQr(clawbotStatus(c.req.param("id")!))));
async function withQr<T extends { qrUrl?: string }>(s: T) {
	return { ...s, qrImg: s.qrUrl ? await QRCode.toDataURL(s.qrUrl, { margin: 1, width: 320 }) : undefined };
}
app.post("/api/channels/:id/clawbot/verify", async (c) => {
	try {
		clawbotVerify(c.req.param("id")!, String((await c.req.json<{ code: string }>()).code ?? ""));
		return c.json({ ok: true });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.delete("/api/channels/:id/clawbot/login", (c) => (clawbotCancel(c.req.param("id")!), c.json({ ok: true })));
app.post("/api/channels/:id/test", localOnly, async (c) => {
	try {
		return c.json({ ok: true, message: await testChannel(c.req.param("id")!) });
	} catch (e) {
		return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) });
	}
});
app.post("/api/channels/:id/bind-code", localOnly, (c) => c.json({ bindCode: rotateBindCode(c.req.param("id")!) }));
app.put("/api/channels/:id/users/:peer", localOnly, async (c) => {
	const { allowed } = await c.req.json<{ allowed: boolean }>();
	setPeerAllowed(c.req.param("id")!, c.req.param("peer")!, !!allowed);
	return c.json({ ok: true });
});
/** 企业微信回调（公网经隧道访问；用 Token + EncodingAESKey 验签解密，不走设备登录） */
const wecomHook = async (c: Context<Env>) => {
	const r = wecomCallback(c.req.param("id") ?? "", c.req.method, c.req.query(), c.req.method === "POST" ? await c.req.text() : "");
	return c.text(r.body, r.status as 200);
};
app.get("/hooks/channels/wecom/:id", wecomHook);
app.post("/hooks/channels/wecom/:id", wecomHook);

// ---------------------------------------------------------------- 邮箱（IMAP / SMTP）
// Gmail OAuth：用用户自己的 Google OAuth 客户端（桌面应用类型），回调到本机回环地址
app.get("/api/email/oauth/google", (c) => {
	const g = googleClient();
	return c.json({ configured: !!g, clientId: g?.clientId ?? null, redirectUri: `http://127.0.0.1:${config.port}/api/email/oauth/google/callback` });
});
app.put("/api/email/oauth/google", localOnly, async (c) => {
	const b = await c.req.json<{ clientId?: string; clientSecret?: string; clear?: boolean }>();
	try {
		saveGoogleClient(b.clear ? null : { clientId: b.clientId ?? "", clientSecret: b.clientSecret ?? "" });
		return c.json({ ok: true });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.post("/api/email/oauth/google/start", localOnly, async (c) => {
	const b = await c.req.json<{ agentId?: string | null; name?: string }>().catch(() => ({}) as { agentId?: string; name?: string });
	try {
		return c.json(startGoogle({ redirectUri: `http://127.0.0.1:${config.port}/api/email/oauth/google/callback`, agentId: b.agentId ?? null, name: b.name }));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.get("/api/email/oauth/google/callback", localOnly, async (c) => {
	const page = (title: string, msg: string) => c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui;padding:48px;max-width:560px;margin:auto"><h2>${title}</h2><p>${msg}</p><p style="color:#888">可以关闭这个页面，回到 ${BRAND.name}。</p><script>try{window.opener&&window.opener.postMessage({type:"pia-oauth",ok:${title.startsWith("✅")}},"*")}catch(e){}</script></body>`);
	const esc = (x: string) => x.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
	const err = c.req.query("error");
	if (err) return page("❌ 没有完成授权", esc(err));
	try {
		const r = await finishGoogle(c.req.query("code") ?? "", c.req.query("state") ?? "");
		const a = saveOAuthAccount(r);
		return page("✅ 已连接 Gmail", `${esc(a.address)} 已添加，助理可以读邮件、写草稿；发送前仍会先问你。`);
	} catch (e) {
		return page("❌ 连接失败", esc(e instanceof Error ? e.message : String(e)));
	}
});
app.get("/api/email", (c) => c.json({ items: listAccounts().map(accountJson), presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, help: p.help, imap: p.imap, smtp: p.smtp })) }));
app.post("/api/email", localOnly, async (c) => {
	try {
		const a = saveAccount(await c.req.json());
		return c.json(accountJson(a));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.put("/api/email/:id", localOnly, async (c) => {
	const cur = getAccount(c.req.param("id")!);
	if (!cur) return c.json({ error: "not_found" }, 404);
	try {
		return c.json(accountJson(saveAccount({ ...(await c.req.json()), id: cur.id })));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.delete("/api/email/:id", localOnly, (c) => (deleteAccount(c.req.param("id")!), c.json({ ok: true })));
app.post("/api/email/:id/test", localOnly, async (c) => {
	try {
		return c.json({ ok: true, message: await testAccount(c.req.param("id")!) });
	} catch (e) {
		return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) });
	}
});

// ---------------------------------------------------------------- 个人微信（可选，实验）
app.get("/api/wechat", (c) => c.json(wechatSettings()));
app.put("/api/wechat", localOnly, async (c) => {
	const b = (await c.req.json()) as { enabled?: boolean; acknowledge?: boolean; agentIds?: string[] };
	try {
		return c.json(saveWechatSettings({ ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.agentIds ? { agentIds: b.agentIds } : {}), ...(b.acknowledge ? { acknowledgedAt: Date.now() } : {}) }));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.get("/api/wechat/:agentId/status", async (c) => c.json(await wechatStatus(c.req.param("agentId")!)));
app.post("/api/wechat/:agentId/open", localOnly, async (c) => {
	try {
		return c.json(await openWechat(c.req.param("agentId")!));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});

// ---------------------------------------------------------------- 操作这台电脑（Cua bounded）
const hostManifest = (s = hostSettings()) => (setHostEnv({ workspaceOf, agentIds: () => listAgents().map((a) => a.id) }), hostPlan(s));
app.get("/api/host-control", async (c) => {
	const yaml = hostManifest();
	const s = hostSettings();
	const st = hostStatus();
	const last = listActions({ target: "host", limit: 1 })[0];
	const agent = last ? getAgent(last.agent_id) : null;
	const activity = { active: st.enabled && hostActive(last), agent: agent?.name ?? last?.agent_id ?? null, summary: last ? last.summary || last.tool : null };
	return c.json({ settings: s, status: st, activity, manifest: yaml, manifestHash: manifestHash(yaml), tiers: Object.fromEntries(listAgents().map((a) => [a.id, tierOf(a.id, s)])), fullConfirm: FULL_CONFIRM, permissions: c.get("caller").local ? await macPermissions() : null });
});
app.get("/api/host-control/apps", localOnly, async (c) => c.json(await suggestApps()));
const RANK: Record<HostTier, number> = { observe: 0, bounded: 1, trusted: 2, full: 3 };
/** 按草稿设置预览权限计划：不保存、不影响正在运行的守护进程（用户确认后才写） */
app.post("/api/host-control/plan", localOnly, async (c) => {
	const next = draftHostSettings(await c.req.json<{ agents?: "all" | string[]; apps?: HostApp[]; workspaceFiles?: boolean; defaultTier?: HostTier }>());
	if (Object.values(next.tiers).some((t) => !TIERS.includes(t)) || !TIERS.includes(next.defaultTier)) return c.json({ error: "权限档位不对" }, 400);
	if (process.platform !== "darwin" && next.apps.some((a) => !/^([a-zA-Z]:\\|\/)/.test(a.id))) return c.json({ error: "Windows / Linux 上应用要填可执行文件的完整路径" }, 400);
	const yaml = hostManifest(next);
	return c.json({ yaml, hash: manifestHash(yaml) });
});
/** 保存设置。开启需要带上用户在页面上看到的权限计划哈希（= 用户审阅过），计划变了就要重新确认 */
app.put("/api/host-control", localOnly, async (c) => {
	const b = await c.req.json<{ enabled?: boolean; agents?: "all" | string[]; apps?: HostApp[]; workspaceFiles?: boolean; acknowledged?: boolean; manifestHash?: string; tiers?: Record<string, HostTier>; defaultTier?: HostTier; confirmText?: string; confirmFull?: boolean }>();
	const cur = hostSettings();
	const next = draftHostSettings(b);
	if (Object.values(next.tiers).some((t) => !TIERS.includes(t)) || !TIERS.includes(next.defaultTier)) return c.json({ error: "权限档位不对" }, 400);
	if (process.platform !== "darwin" && next.apps.some((a) => !/^([a-zA-Z]:\\|\/)/.test(a.id))) return c.json({ error: "Windows / Linux 上应用要填可执行文件的完整路径" }, 400);
	const yaml = hostManifest(next);
	if (b.enabled) {
		if (!b.acknowledged) return c.json({ error: "请先阅读并确认风险提示" }, 400);
		if (b.manifestHash !== manifestHash(yaml)) return c.json({ error: "权限设置已变化，请重新查看后再确认", manifestHash: manifestHash(yaml) }, 409);
		const ids = (next.agents === "all" ? listAgents().map((a) => a.id) : next.agents) as string[];
		const fullNow = ids.filter((a) => tierOf(a, next) === "full");
		const needFull = fullNow.some((a) => !cur.fullAck[a] || tierOf(a, cur) !== "full" || !cur.enabled) || (next.defaultTier === "full" && (cur.defaultTier !== "full" || !cur.enabled));
		if (needFull && !fullConfirmed(b)) return c.json({ error: "涉及“完全权限”，需要先确认启用" }, 400);
		if (ids.some((a) => tierOf(a, next) === "bounded") && !next.apps.length) return c.json({ error: "“限定”档位至少要选择一个允许操作的应用" }, 400);
		const fullAck = Object.fromEntries(fullNow.map((a) => [a, cur.fullAck[a] && tierOf(a, cur) === "full" ? cur.fullAck[a] : Date.now()]));
		saveHostSettings({ ...next, enabled: true, approvedHash: manifestHash(yaml), enabledAt: Date.now(), fullAck });
		try {
			await startDaemon(yaml);
		} catch (e) {
			return c.json({ ok: false, error: e instanceof Error ? e.message : String(e), status: hostStatus() });
		}
	} else {
		saveHostSettings({ ...next, enabled: false, approvedHash: undefined });
		await stopDaemon();
	}
	return c.json({ ok: true, status: hostStatus(), manifestHash: manifestHash(yaml) });
});
/**
 * 单个助理的档位（助理设置页 / 设置页都用）。调低立即生效；调高需要确认风险，调到“完全权限”还要输入确认语。
 * 已开启时会按新的权限计划重启 Cua 守护进程。
 */
app.put("/api/host-control/tier/:agentId", localOnly, async (c) => {
	const agentId = c.req.param("agentId")!;
	const b = await c.req.json<{ tier: HostTier; acknowledged?: boolean; confirmText?: string; confirmFull?: boolean }>();
	if (!TIERS.includes(b.tier)) return c.json({ error: "权限档位不对" }, 400);
	const cur = hostSettings();
	const from = tierOf(agentId, cur);
	if (RANK[b.tier] > RANK[from] && !b.acknowledged) return c.json({ error: "调高权限需要先确认风险提示" }, 400);
	if (b.tier === "full" && from !== "full" && !fullConfirmed(b)) return c.json({ error: "设为“完全权限”需要先确认启用" }, 400);
	if (b.tier === "bounded" && !cur.apps.length && cur.enabled) return c.json({ error: "“限定”档位需要先在 设置 › 操作这台电脑 里选择允许的应用" }, 400);
	const fullAck = { ...cur.fullAck };
	if (b.tier === "full") fullAck[agentId] = from === "full" ? (fullAck[agentId] ?? Date.now()) : Date.now();
	else delete fullAck[agentId];
	saveHostSettings({ tiers: { ...cur.tiers, [agentId]: b.tier }, fullAck });
	const yaml = hostManifest();
	if (cur.enabled) {
		saveHostSettings({ approvedHash: manifestHash(yaml) });
		try {
			await startDaemon(yaml);
		} catch (e) {
			return c.json({ ok: false, error: e instanceof Error ? e.message : String(e), status: hostStatus() });
		}
	}
	bus.emit({ type: "host.changed", status: hostStatus() } as never);
	return c.json({ ok: true, tier: b.tier, status: hostStatus() });
});
/** 完全权限：用户在确认框里点了“确定启用”（confirmFull）；旧客户端输入确认语也认 */
const fullConfirmed = (b: { confirmFull?: boolean; confirmText?: string }) => b.confirmFull === true || (b.confirmText ?? "").trim() === FULL_CONFIRM;
/** 悬浮条被用户关掉时记下当时的状态；状态变了（新操作 / 暂停或继续）再弹出 */
let barDismissed: string | null = null;
const barKey = (paused: boolean, active: boolean, lastId: unknown) => `${paused ? 1 : 0}:${active ? 1 : 0}:${lastId ?? ""}`;
app.post("/api/host-control/bar/dismiss", localOnly, (c) => {
	const st = hostStatus();
	const last = listActions({ target: "host", limit: 1 })[0];
	const active = st.enabled && hostActive(last);
	barDismissed = barKey(st.paused, active, last?.id);
	return c.json({ ok: true });
});
/** 统一下载状态（所有组件 / 模型 / 安装包）：设置页「下载」与各功能页里的下载条都用它 */
app.get("/api/downloads", (c) => c.json({ items: listDownloads() }));
app.post("/api/downloads/:id/start", localOnly, async (c) => {
	try {
		return c.json({ ok: true, item: await startDownload(decodeURIComponent(c.req.param("id")!)) });
	} catch (e) {
		return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
/** 托盘悬浮条用：是否开着、是否暂停、最近一次操作（90 秒内算“正在操作”） */
app.get("/api/host-control/bar", localOnly, (c) => {
	const st = hostStatus();
	const last = listActions({ target: "host", limit: 1 })[0];
	const agent = last ? getAgent(last.agent_id) : null;
	const active = st.enabled && hostActive(last);
	const key = barKey(st.paused, active, last?.id);
	return c.json({ enabled: st.enabled, paused: st.paused, active, dismissed: barDismissed === key, last: last ? { agent: agent?.name ?? last.agent_id, avatar: agent?.avatar ?? "", tool: last.tool, summary: last.summary, outcome: last.outcome, at: last.started_at } : null });
});
/** 一键暂停 / 继续：任何已配对的设备（包括手机）都能点 */
app.post("/api/host-control/pause", async (c) => {
	const { paused } = await c.req.json<{ paused: boolean }>();
	hostManifest();
	await setHostPaused(!!paused);
	return c.json(hostStatus());
});
app.post("/api/host-control/permissions", localOnly, async (c) => {
	await macGrantPermissions();
	return c.json({ ok: true });
});
/** 助理自己的电脑：审批策略（默认不审批） */
app.get("/api/sandbox-computer", (c) => c.json(sandboxComputerSettings()));
app.put("/api/sandbox-computer", localOnly, async (c) => {
	try {
		const r = saveSandboxComputerSettings(await c.req.json());
		bus.emit({ type: "host.changed", status: hostStatus() } as never);
		return c.json(r);
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
/** 电脑操作记录 */
app.get("/api/actions", (c) =>
	c.json({ items: listActions({ agentId: c.req.query("agentId") || undefined, target: c.req.query("target") || undefined, before: Number(c.req.query("before")) || undefined, limit: Number(c.req.query("limit")) || 100 }) }),
);
app.get("/api/actions/:id/shot", (c) => {
	const png = actionShot(c.req.param("id")!);
	return png ? new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=86400" } }) : c.json({ error: "not_found" }, 404);
});
app.delete("/api/actions", localOnly, (c) => (clearActions(c.req.query("agentId") || undefined), c.json({ ok: true })));

// ---------------------------------------------------------------- 助理电脑（sandbox desktop）
const deskJson = async (id: string) => ({ ...(await desktopStatus(id)), paused: desktopPause.isPaused(id) });
const deskChanged = (agentId?: string) => bus.emit({ type: "desktop.changed", agentId } as never);
startIdleWatcher({ busy: agentBusy, changed: deskChanged });
startHousekeeping();
/** 全局：安装开关、运行方式、空闲关机、镜像加速、下载进度 */
const deskGlobal = async () => {
	const s = desktopSettings();
	const b = desktopBackend();
	const builtin = builtinFor();
	const [det, docker] = await Promise.all([s.enabled ? b.detect() : Promise.resolve(null), dockerBackend.detect()]);
	return {
		settings: s,
		backend: { id: b.id, label: b.label, ok: det?.ok ?? null, reason: det?.reason, fix: det?.fix },
		builtin: { id: builtin.id, label: builtin.label, ready: builtin.id === "docker" || b.id === builtin.id },
		dockerAvailable: docker.ok,
		// 自带虚拟机 / 发行版：下载量再加上运行时组件（macOS：Lima + Debian 系统盘 + containerd；Windows：WSL 发行版）
		image: b.downloadId ? { ...pinnedInfo(), downloadBytes: pinnedInfo().downloadBytes + (downloadInfo(b.downloadId)?.size ?? 0), diskBytes: pinnedInfo().diskBytes + 2e9 } : pinnedInfo(),
		installed: s.enabled && det?.ok ? await imagePresent() : false,
		install: installState(),
		resources: vmResourceInfo(),
		vm: b.phase ? { ...b.phase(), running: s.enabled && det?.ok ? await b.engineRunning() : false } : null,
		wslInstalling: wslInstalling(),
	};
};
/** Windows：没有 WSL 时一键安装（一次 UAC 管理员确认；需要重启时返回 reboot: true）。只能在这台电脑上操作 */
app.post("/api/desktop/wsl/install", localOnly, async (c) => {
	if (process.platform !== "win32" && process.env.PIA_TEST_WSL !== "1") return c.json({ error: "只有 Windows 需要安装 WSL" }, 400);
	const r = await installWsl();
	resetAvailability();
	deskChanged();
	if (r.ok && !r.reboot && desktopSettings().enabled) void startInstall().then(() => (resetAvailability(), deskChanged()));
	return c.json({ ...r, desktop: await deskGlobal() });
});
app.get("/api/desktop", async (c) => c.json(await deskGlobal()));
app.put("/api/desktop", async (c) => {
	const b = await c.req.json<Partial<ReturnType<typeof desktopSettings>>>();
	const before = desktopSettings();
	try {
		const diskErr = b.resources !== undefined ? vmResourceDiskError(b.resources as { diskGiB?: number }) : null;
		if (diskErr) return c.json({ error: diskErr }, 400);
		const s = updateDesktopSettings(b, vmResourceApplied());
		if (before.enabled && !s.enabled) cancelInstall();
		if (before.backend !== s.backend || before.mirror !== s.mirror) resetAvailability();
		// 开启 = 开始下载（之前什么都不下载）
		if (s.enabled && (!before.enabled || before.backend !== s.backend || b.enabled)) void startInstall().then(() => (resetAvailability(), deskChanged()));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
	resetAvailability();
	deskChanged();
	return c.json(await deskGlobal());
});
app.post("/api/desktop/install", async (c) => {
	if (!desktopSettings().enabled) return c.json({ error: "请先开启“给助理安装电脑”" }, 400);
	void startInstall().then(() => (resetAvailability(), deskChanged()));
	return c.json(await deskGlobal());
});
/** 关掉开关后：shutdown = 关机（登录状态保留）；purge = 删除虚拟机和镜像（登录状态清掉，仅本机可操作） */
app.post("/api/desktop/shutdown", async (c) => (await shutdownAll(), deskChanged(), c.json(await deskGlobal())));
app.post("/api/desktop/purge", localOnly, async (c) => {
	if (desktopSettings().enabled) return c.json({ error: "请先关闭“给助理安装电脑”" }, 400);
	await purgeAll();
	deskChanged();
	return c.json(await deskGlobal());
});
app.get("/api/agents/:id/desktop", async (c) => c.json(await deskJson(c.req.param("id"))));
app.post("/api/agents/:id/desktop/start", async (c) => {
	try {
		const p = startDesktop(c.req.param("id"));
		deskChanged(c.req.param("id")); // 界面先显示“启动中”
		await p;
		deskChanged(c.req.param("id"));
		return c.json(await deskJson(c.req.param("id")));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.post("/api/agents/:id/desktop/stop", async (c) => {
	await stopDesktop(c.req.param("id"));
	bus.emit({ type: "desktop.changed", agentId: c.req.param("id") } as never);
	return c.json(await deskJson(c.req.param("id")));
});
app.post("/api/agents/:id/desktop/pause", async (c) => {
	const { paused } = await c.req.json<{ paused: boolean }>();
	desktopPause.set(c.req.param("id"), paused);
	if (paused) await runtime(c.req.param("id")).abort();
	bus.emit({ type: "desktop.changed", agentId: c.req.param("id") } as never);
	return c.json(await deskJson(c.req.param("id")));
});
/** 单独的电脑：开 / 关（关掉时数据保留）；hasData = 这个助理有单独电脑留下的数据（null = 虚拟机关着，不知道） */
app.get("/api/agents/:id/computer", async (c) => {
	const id = c.req.param("id");
	return c.json({ separate: desktopSettings().separate.includes(id), hasData: await hasSeparateData(id).catch(() => null), desktop: await deskJson(id) });
});
app.put("/api/agents/:id/computer", async (c) => {
	const id = c.req.param("id");
	const b = await c.req.json<{ separate: boolean }>();
	if (agentBusy(id)) return c.json({ error: "这个助理正在工作，等它做完再切换电脑" }, 409);
	await setSeparateComputer(id, !!b.separate);
	deskChanged(id);
	return c.json({ separate: desktopSettings().separate.includes(id), hasData: await hasSeparateData(id).catch(() => null), desktop: await deskJson(id) });
});
/** 把单独电脑的数据合并进共用电脑（两台电脑都会先关机），之后这个助理用共用电脑 */
app.post("/api/agents/:id/computer/merge", async (c) => {
	const id = c.req.param("id");
	try {
		const r = await mergeIntoShared(id, agentBusy);
		deskChanged(id);
		return c.json({ ok: true, result: r, desktop: await deskJson(id) });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
/** 用户在「电脑」标签里给这个助理开 / 关自己的屏幕 */
app.post("/api/agents/:id/desktop/screen", async (c) => {
	const id = c.req.param("id");
	const b = await c.req.json<{ own: boolean }>();
	try {
		if (b.own) await ensureOwnScreen(id);
		else await releaseScreen(id);
		deskChanged(id);
		return c.json(await deskJson(id));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.post("/api/agents/:id/desktop/ticket", async (c) => {
	const b = await c.req.json<{ screen?: string }>().catch(() => ({}) as { screen?: string });
	return c.json({ ticket: issueTicket(c.req.param("id"), b.screen) });
});
app.get("/api/agents/:id/desktop/screenshot", async (c) => {
	try {
		return c.body(new Uint8Array(await screenshotDesktop(c.req.param("id"), c.req.query("screen") || undefined)), 200, { "content-type": "image/png", "cache-control": "no-store" });
	} catch {
		return c.json({ error: "not_running" }, 409);
	}
});

// ---------------------------------------------------------------- 远程稳定入口：部署到用户自己的 Cloudflare（仅本机可操作）
app.get("/api/remote/cloudflare", localOnly, (c) => c.json(cfStatus()));
app.post("/api/remote/cloudflare/deploy", localOnly, async (c) => {
	const b = await c.req.json<{ zone: string; subdomain: string; token?: string }>();
	try {
		return c.json({ ok: true, config: await deployRendezvous(b) });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.delete("/api/remote/cloudflare", localOnly, async (c) => {
	await removeRendezvous();
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- 固定地址（命名隧道）与隧道控制（仅本机可操作）
const namedJson = () => {
	const n = namedConfig();
	return { config: n && { zone: n.zone, subdomain: n.subdomain, hostname: n.hostname, tunnelId: n.tunnelId, tunnelName: n.tunnelName, createdAt: n.createdAt }, mode: getSetting("tunnelMode", "auto"), zone: getSetting<string | null>("namedZone", null) ?? cfStatus().config?.zone ?? null, subdomain: getSetting("namedSubdomain", "pi"), hasToken: cfStatus().hasToken };
};
const cleanZone = (z: string) => String(z ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
app.get("/api/remote/named", localOnly, (c) => c.json(namedJson()));
app.post("/api/remote/named/check", localOnly, async (c) => {
	const b = await c.req.json<{ zone: string; token?: string }>();
	try {
		return c.json(await checkNamedPerms(cleanZone(b.zone), b.token?.trim() || undefined, { probeEdit: true }));
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});
app.post("/api/remote/named", localOnly, async (c) => {
	const b = await c.req.json<{ zone: string; subdomain: string; token?: string }>();
	const zone = cleanZone(b.zone);
	if (b.token?.trim()) setSetting("cloudflareToken", sealJson(b.token.trim()));
	setSetting("namedZone", zone);
	setSetting("namedSubdomain", String(b.subdomain ?? "").trim().toLowerCase());
	try {
		const cfg = await setupNamedTunnel({ zone, subdomain: b.subdomain });
		restartTunnel();
		return c.json({ ok: true, hostname: cfg.hostname });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e), missing: (e as { missing?: string[] }).missing }, 400);
	}
});
app.delete("/api/remote/named", localOnly, async (c) => {
	await removeNamedTunnel();
	restartTunnel();
	return c.json({ ok: true });
});
app.post("/api/remote/tunnel/retry", localOnly, (c) => (retryTunnel(), c.json(tunnelStatus())));
app.post("/api/remote/tunnel/mode", localOnly, async (c) => {
	const { mode } = await c.req.json<{ mode: "auto" | "quick" }>();
	setSetting("tunnelMode", mode === "quick" ? "quick" : "auto");
	return c.json(namedJson());
});

// ---------------------------------------------------------------- 配对与设备
app.post("/api/pair/start", localOnly, async (c) => {
	const b = await c.req.json<{ preApproved?: boolean }>().catch(() => ({}) as { preApproved?: boolean });
	const { code, shortCode, expiresAt, preApproved } = createPairCode({ preApproved: b.preApproved === true });
	const id = identity();
	const t = tunnelStatus();
	const reqOrigin = new URL(c.req.url).origin;
	const direct = t.url ?? reqOrigin;
	const params = new URLSearchParams({ sid: id.serverId, u: direct, pk: id.publicKey, c: code }).toString();
	// 入口域名可用（已成功注册 Rendezvous）时，二维码指向固定入口；否则直连隧道/本机地址
	const viaEntry = !!(t.url && entryDomain() && t.rendezvous.state === "ok");
	const url = viaEntry ? `https://${entryDomain()}/pair#${params}` : `${direct}/pair#${params}`;
	return c.json({ url, directUrl: `${direct}/pair#${params}`, shortCode, viaEntry, expiresAt, preApproved, qr: await QRCode.toDataURL(url, { margin: 1, width: 320 }), remote: !!t.url });
});
app.post("/api/pair/claim", async (c) => {
	const ip = c.get("caller").ip;
	if (!rateLimit(`pair:${ip}`, 0.5, 5)) return c.json({ error: "rate_limited" }, 429);
	const b = await c.req.json<{ code: string; name: string; platform?: string }>();
	const r = claimPairCode(String(b.code ?? ""), String(b.name ?? ""), String(b.platform ?? ""));
	return r.ok ? c.json({ deviceId: r.deviceId, serverId: identity().serverId, publicKey: identity().publicKey, preApproved: !!r.preApproved }) : c.json({ error: r.error }, r.error === "too_many_attempts" ? 429 : 400);
});
app.get("/api/pair/status/:id", (c) => {
	const ip = c.get("caller").ip;
	if (!rateLimit(`pairpoll:${ip}`, 60)) return c.json({ error: "rate_limited" }, 429);
	return c.json(pairStatus(c.req.param("id")));
});
app.get("/api/devices", (c) => c.json(listDevices()));
app.post("/api/devices/:id/approve", localOnly, (c) => c.json({ ok: approveDevice(c.req.param("id")!) }));
app.post("/api/devices/:id/reject", localOnly, (c) => (rejectDevice(c.req.param("id")!), c.json({ ok: true })));
// 吊销：本机 / 主人可以吊销任何设备；其他设备只能退出自己
app.delete("/api/devices/:id", (c) => {
	const id = c.req.param("id");
	if (!isAdmin(c) && c.get("caller").deviceId !== id) return c.json({ error: "local_only" }, 403);
	revokeDevice(id);
	return c.json({ ok: true });
});
app.post("/api/devices/:id/owner", localOnly, async (c) => {
	const { owner } = await c.req.json<{ owner: boolean }>();
	try {
		return c.json({ ok: setOwner(c.req.param("id")!, owner === true) });
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
});

// ---------------------------------------------------------------- 推送
app.get("/api/push/key", (c) => c.json({ publicKey: vapidPublicKey() }));
app.post("/api/push/subscribe", async (c) => {
	const sub = await c.req.json<{ endpoint: string }>();
	if (!sub?.endpoint?.startsWith("https://")) return c.json({ error: "invalid" }, 400);
	subscribe(sub, c.get("caller").deviceId);
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- PWA 静态文件
if (existsSync(config.webDist)) {
	app.use("/*", serveStatic({ root: config.webDist }));
	const index = readFileSync(join(config.webDist, "index.html"), "utf8");
	app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not_found" }, 404) : c.html(index)));
} else {
	app.get("/", (c) => c.text("Web UI 尚未构建：npm run build -w apps/web"));
}

// ---------------------------------------------------------------- 助理电脑实时画面：WebSocket 反向代理到容器的 noVNC（websockify）
const deskWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, handleProtocols: (p) => (p.has("binary") ? "binary" : false) });
async function proxyDesktop(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, url: URL) {
	const t = useTicket(url.searchParams.get("ticket")); // 一次性票据：只能由已认证的设备/本机通过 API 申请
	if (!t) return socket.destroy();
	const { agentId } = t;
	const st = await desktopStatus(agentId);
	if (st.state !== "running" || !st.port) return socket.destroy();
	// 看哪块屏幕：票据里指定的（同一台电脑上的其他屏幕），默认这个助理自己用的屏幕；noVNC 按 token 转到那块屏幕
	const token = await viewToken(agentId, t.screen);
	deskWss.handleUpgrade(req, socket, head, (client) => {
		viewerOpen(agentId); // 有人在看画面：不会空闲关机
		client.once("close", () => viewerClose(agentId));
		const upstream = new WebSocket(`ws://127.0.0.1:${st.port}/websockify?token=${encodeURIComponent(token)}`, ["binary"]);
		const pending: (Buffer | ArrayBuffer | Buffer[])[] = [];
		upstream.on("open", () => pending.splice(0).forEach((d) => upstream.send(d)));
		upstream.on("message", (d, isBinary) => client.readyState === 1 && client.send(d, { binary: isBinary }));
		client.on("message", (d, isBinary) => (upstream.readyState === 1 ? upstream.send(d, { binary: isBinary }) : pending.push(d)));
		const close = () => (client.close(), upstream.close());
		upstream.on("close", close);
		upstream.on("error", close);
		client.on("close", close);
	});
}

// ---------------------------------------------------------------- 启动 HTTP + WebSocket
export function startHttp() {
	const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	const clients = new Map<WebSocket, { deviceId: string | null; authed: boolean }>();
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://x");
		if (url.pathname === "/desktop/ws") return void proxyDesktop(req, socket, head, url);
		if (url.pathname !== "/ws") return socket.destroy();
		const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(",") : v] as [string, string]])));
		const local = isLocalRequest(req.socket.remoteAddress, headers);
		const ip = clientIp(req.socket.remoteAddress, headers);
		if (!local && !rateLimit(`ws:${ip}`, 30)) return socket.destroy();
		wss.handleUpgrade(req, socket, head, (ws) => {
			const st = { deviceId: null as string | null, authed: local };
			clients.set(ws, st);
			const timer = setTimeout(() => !st.authed && ws.close(4401, "unauthorized"), 5000);
			const hello = () => ws.send(JSON.stringify({ type: "hello", seq: bus.seq, serverId: identity().serverId, local: local || isOwnerDevice(st.deviceId) }));
			if (local) hello();
			ws.on("message", (raw) => {
				let m: { type?: string; token?: string };
				try {
					m = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (m.type === "auth" && !st.authed) {
					const d = deviceForToken(m.token);
					if (!d) return ws.close(4401, "unauthorized");
					st.authed = true;
					st.deviceId = d;
					clearTimeout(timer);
					hello();
				} else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
			});
			ws.on("close", () => clients.delete(ws));
		});
	});
	bus.on((e) => {
		const data = JSON.stringify(e);
		for (const [ws, st] of clients) {
			if (!st.authed) continue;
			if (e.type === "device.revoked" && st.deviceId === e.deviceId) {
				ws.close(4401, "revoked");
				continue;
			}
			ws.send(data);
		}
	});
	setInterval(() => {
		for (const ws of clients.keys()) ws.ping();
	}, 25_000).unref();
	return server;
}
