/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono } from "hono";
import { bus } from "../bus.ts";
import { dockerAvailable } from "../sandbox.ts";
import { purgeAll, resetAvailability, shutdownAll, startInstall, vmResourceApplied, vmResourceDiskError, vmResourceInfo } from "../desktop.ts";
import { backend as desktopBackend, builtinFor, dockerBackend } from "../desktop/backend.ts";
import { cancelInstall, imagePresent, installState, pinnedInfo } from "../desktop/image.ts";
import { installWsl, wslInstalling } from "../desktop/wsl.ts";
import { desktopSettings, updateDesktopSettings } from "../desktop/settings.ts";
import { saveSandboxComputerSettings, sandboxComputerSettings, hostStatus } from "../host-control.ts";
import { downloadInfo } from "../downloads.ts";
import { localOnly, type Env } from "./common.ts";

export const deskChanged = (agentId?: string) => bus.emit({ type: "desktop.changed", agentId } as never);

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

export function mountDesktopRoutes(app: Hono<Env>) {
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
}
