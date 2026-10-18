/** 从 http.ts 拆出的路由（行为不变）。 */
import { type AsrDeclaration } from "../voice/index.ts";
import { ASR_PROTOCOLS } from "../voice/contract.ts";
import { isAsrProtocol } from "../voice/asr.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { hasOwner } from "../auth.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { db, getSetting, setSetting } from "../db.ts";
import { identity } from "../identity.ts";
import { credentialBackend, customProviders, defaultModel, models, withProviderName } from "../models.ts";
import { onboardingState } from "../onboarding.ts";
import { checkPiCompat } from "../pi-adapter/index.ts";
import { pushLog, vapidPublicKey } from "../push.ts";
import { runtime } from "../runtime.ts";
import { dockerAvailable, sandboxMode } from "../sandbox.ts";
import { entryDomain, startTunnel, stopTunnel, tunnelStatus } from "../tunnel.ts";
import { BRAND } from "@pi-assistant/shared";
import { actOnItem, defaultLevel, type ItemRow, type Level, listItems, setDefaultLevel, unseenCount } from "../proactive.ts";
import { cancelDownload, listDownloads, startDownload } from "../downloads.ts";
import { isAdmin, localOnly, type Env } from "./common.ts";

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

/**
 * 云语音识别（ASR）声明：复用**已有 provider 的地址 / Key**，只额外记「这个模型走语音转写」。
 * 不新建第二套 Key（凭据仍由 Pi 按 provider 解析）；本地 SenseVoice 由 runtime 上报，不在这里声明。
 */
const asrProvidersJson = () => ({ protocols: ASR_PROTOCOLS, providers: getSetting<AsrDeclaration[]>("asrProviders", []) });

const itemJson = (i: ItemRow) => ({ id: i.id, agentId: i.agent_id, kind: i.kind, title: i.title, body: i.body, importance: i.importance, status: i.status, reason: i.reason, via: i.delivered_via, deliveredAt: i.delivered_at, deliverAfter: i.deliver_after, createdAt: i.created_at });

export function mountSystemRoutes(app: Hono<Env>) {
	// ---------------------------------------------------------------- 系统
	app.get("/api/system/public", (c) => c.json({ serverId: identity().serverId, publicKey: identity().publicKey, name: BRAND.name, server: config.headless, setup: config.headless && !hasOwner() }));
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
	/** 旧接口（按天 × 助理 × 模型）：现在从新的用量表算；新界面用 /api/usage/summary */
	app.get("/api/usage", (c) =>
		c.json(db.prepare("SELECT agent_id, day, provider, model, SUM(input + cache_read + cache_write) input, SUM(output) output, COALESCE(SUM(cost), 0) cost FROM usage_calls GROUP BY agent_id, day, provider, model ORDER BY day DESC LIMIT 200").all()),
	);
	// ---------------------------------------------------------------- 主动提醒
	app.get("/api/proactive/inbox", (c) => {
		const agentId = c.req.query("agentId") || undefined;
		return c.json({ items: listItems({ agentId, all: c.req.query("all") === "1" }).map(itemJson), count: unseenCount(), defaultLevel: defaultLevel() });
	});
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
	app.put("/api/proactive/defaults", async (c) => {
		try {
			setDefaultLevel((await c.req.json<{ level: Level }>()).level);
			return c.json({ ok: true, defaultLevel: defaultLevel() });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
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
	app.post("/api/downloads/:id/cancel", localOnly, async (c) => {
		try {
			return c.json({ ok: true, item: await cancelDownload(decodeURIComponent(c.req.param("id")!)) });
		} catch (e) {
			return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
}
