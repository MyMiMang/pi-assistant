/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono } from "hono";
import { bus } from "../bus.ts";
import { workspaceOf } from "../files.ts";
import { getAgent, listAgents } from "../runtime.ts";
import { listActions } from "../action-log.ts";
import { draftHostSettings, FULL_CONFIRM, TIERS, tierOf, type HostTier, hostPlan, setHostEnv, hostSettings, hostStatus, hostActive, macGrantPermissions, macPermissions, manifestHash, saveHostSettings, setHostPaused, startDaemon, stopDaemon, suggestApps, type HostApp } from "../host-control.ts";
import { localOnly, type Env } from "./common.ts";

// ---------------------------------------------------------------- 操作这台电脑（Cua bounded）
const hostManifest = (s = hostSettings()) => (setHostEnv({ workspaceOf, agentIds: () => listAgents().map((a) => a.id) }), hostPlan(s));

const RANK: Record<HostTier, number> = { observe: 0, bounded: 1, trusted: 2, full: 3 };

/** 完全权限：用户在确认框里点了“确定启用”（confirmFull）；旧客户端输入确认语也认 */
const fullConfirmed = (b: { confirmFull?: boolean; confirmText?: string }) => b.confirmFull === true || (b.confirmText ?? "").trim() === FULL_CONFIRM;

/** 悬浮条被用户关掉时记下当时的状态；状态变了（新操作 / 暂停或继续）再弹出 */
let barDismissed: string | null = null;

const barKey = (paused: boolean, active: boolean, lastId: unknown) => `${paused ? 1 : 0}:${active ? 1 : 0}:${lastId ?? ""}`;

export function mountHostControlRoutes(app: Hono<Env>) {
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
	app.post("/api/host-control/bar/dismiss", localOnly, (c) => {
		const st = hostStatus();
		const last = listActions({ target: "host", limit: 1 })[0];
		const active = st.enabled && hostActive(last);
		barDismissed = barKey(st.paused, active, last?.id);
		return c.json({ ok: true });
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
}
