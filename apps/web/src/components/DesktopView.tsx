/**
 * 「电脑」标签：助理电脑的实时画面（noVNC，经本机服务鉴权代理）、接管、一键暂停、启动/停止。
 */
import { Hand, Loader2, Maximize2, MonitorPlay, Pause, Play, Power, Settings2 } from "lucide-react";
import { t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { ActionLog } from "./ActionLog";
import { api, base } from "../api";
import { useStore } from "../store";
import { Badge, Button, cx } from "./ui";

type DeskStatus = {
	available: boolean;
	reason?: string;
	enabled: boolean;
	installed: boolean;
	state: "none" | "stopped" | "starting" | "running";
	paused: boolean;
	image: string;
	idleMinutes: number;
	install: { phase: "idle" | "downloading" | "done" | "error"; progress: number; error?: string; detail?: string };
	/** macOS 自带虚拟机的阶段（正在创建 / 启动虚拟机…） */
	vm?: { running: boolean; phase: string; detail?: string };
};

export function DesktopView({ agentId }: { agentId: string }) {
	const [st, setSt] = useState<DeskStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [control, setControl] = useState(false);
	const [conn, setConn] = useState<"idle" | "connecting" | "connected" | "error">("idle");
	const box = useRef<HTMLDivElement>(null);
	const rfb = useRef<any>(null);
	const ver = useStore((s) => s.desktopVersion);
	const load = () => api<DeskStatus>(`/api/agents/${agentId}/desktop`).then(setSt).catch(() => setSt(null));
	useEffect(() => {
		void load();
	}, [agentId, ver]);
	// 下载中 / 开机中轮询进度（开机时显示虚拟机阶段）
	useEffect(() => {
		if (st?.install?.phase !== "downloading" && !busy && st?.state !== "starting") return;
		const i = setInterval(() => void load(), 1500);
		return () => clearInterval(i);
	}, [st?.install?.phase, st?.state, busy, agentId]);
	// 按需启动：打开「电脑」标签时，已安装但关着机就自动开机（每个助理每次打开只自动一次）
	const autoStarted = useRef<string | null>(null);
	useEffect(() => {
		if (!st?.available || (st.state !== "stopped" && st.state !== "none") || autoStarted.current === agentId) return;
		autoStarted.current = agentId;
		void act("start");
	}, [st?.available, st?.state, agentId]);

	useEffect(() => {
		if (st?.state !== "running" || !box.current) return;
		let cancelled = false;
		setConn("connecting");
		(async () => {
			const { default: RFB } = await import("@novnc/novnc");
			const { ticket } = await api(`/api/agents/${agentId}/desktop/ticket`, { method: "POST" });
			if (cancelled || !box.current) return;
			const url = `${(base() || location.origin).replace(/^http/, "ws")}/desktop/ws?ticket=${encodeURIComponent(ticket)}`;
			const r = new RFB(box.current, url);
			r.viewOnly = true;
			r.scaleViewport = true;
			r.background = "transparent";
			r.addEventListener("connect", () => setConn("connected"));
			r.addEventListener("disconnect", () => setConn("error"));
			rfb.current = r;
		})().catch(() => setConn("error"));
		return () => {
			cancelled = true;
			rfb.current?.disconnect();
			rfb.current = null;
		};
	}, [st?.state, agentId]);

	useEffect(() => {
		if (rfb.current) rfb.current.viewOnly = !control;
	}, [control, conn]);

	const act = async (path: string, json?: unknown) => {
		setBusy(true);
		setErr("");
		try {
			setSt(await api(`/api/agents/${agentId}/desktop/${path}`, { method: "POST", json }));
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const takeOver = async (v: boolean) => {
		setControl(v);
		await act("pause", { paused: v }); // 接管时自动暂停助理的电脑操作，交还时恢复
	};

	if (!st) return null;
	return (
		<div className="space-y-2" data-testid="desktop-view">
			<div className="flex items-center gap-2">
				<MonitorPlay size={16} />
				<span className="font-medium">桌面</span>
				{!st.enabled ? (
					<Badge>{t("未安装")}</Badge>
				) : st.state === "running" ? (
					<Badge tone="accent">{t("运行中")}</Badge>
				) : st.state === "starting" || (busy && st.available) ? (
					<Badge tone="amber">{t("启动中")}</Badge>
				) : (
					<Badge>{t("已关机")}</Badge>
				)}
				{st.paused && <Badge tone="amber">已暂停操作</Badge>}
				{control && <Badge tone="amber">你在操作</Badge>}
			</div>
			{!st.enabled ? (
				<div className="flex items-center gap-2 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-500 dark:bg-zinc-900" data-testid="desktop-not-installed">
					<span className="flex-1">{t("未安装，去设置安装")}。{t("安装后助理有一台自己的桌面电脑（浏览器、微信等应用）。")}</span>
					<Button size="sm" variant="outline" onClick={() => useStore.getState().set({ settings: "computer" })}>
						<Settings2 size={14} /> {t("去设置")}
					</Button>
				</div>
			) : st.install?.phase === "downloading" ? (
				<div className="space-y-1 text-xs text-zinc-500" data-testid="desktop-downloading">
					<div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
						<div className="h-full bg-accent transition-all" style={{ width: `${Math.round(st.install.progress * 100)}%` }} />
					</div>
					{st.install.detail ? t(st.install.detail) : t("正在下载助理电脑")} {Math.round(st.install.progress * 100)}%
				</div>
			) : !st.available ? (
				<div className="flex items-center gap-2 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-500 dark:bg-zinc-900">
					<span className="flex-1">{st.install?.phase === "error" ? `${t("下载失败：")}${st.install.error}` : (st.reason ?? "助理电脑不可用")}</span>
					<Button size="sm" variant="outline" onClick={() => useStore.getState().set({ settings: "computer" })}>
						<Settings2 size={14} /> {t("去设置")}
					</Button>
				</div>
			) : st.state !== "running" ? (
				<div className="space-y-1">
					<Button variant="primary" size="sm" disabled={busy || st.state === "starting"} onClick={() => act("start")}>
						{busy || st.state === "starting" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />} {busy || st.state === "starting" ? (st.vm && st.vm.detail && (st.vm.phase === "creating" || st.vm.phase === "booting") ? t(st.vm.detail) : t("正在开机（第一次约 10–20 秒）")) : t("开机")}
					</Button>
					<div className="text-xs text-zinc-500">{t("助理要用电脑时也会自动开机；登录状态都保留。")}</div>
				</div>
			) : (
				<>
					<div className={cx("relative aspect-[16/10] w-full overflow-hidden rounded-lg border bg-zinc-900", control ? "border-amber-400 ring-2 ring-amber-300" : "border-line")}>
						<div ref={box} className="absolute inset-0" />
						{conn !== "connected" && (
							<div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-400">{conn === "error" ? "画面连接断开" : <Loader2 size={18} className="animate-spin" />}</div>
						)}
					</div>
					<div className="flex flex-wrap gap-1.5">
						<Button size="sm" variant={control ? "primary" : "outline"} onClick={() => takeOver(!control)}>
							<Hand size={14} /> {control ? "交还给助理" : "接管"}
						</Button>
						<Button size="sm" variant="outline" disabled={busy || control} onClick={() => act("pause", { paused: !st.paused })}>
							{st.paused ? <Play size={14} /> : <Pause size={14} />} {st.paused ? "继续操作" : "暂停操作"}
						</Button>
						<Button size="sm" variant="ghost" onClick={() => box.current?.requestFullscreen?.()}>
							<Maximize2 size={14} />
						</Button>
						<span className="ml-auto self-center text-xs text-zinc-400">{st.idleMinutes ? t("空闲 {m} 分钟自动关机", { m: st.idleMinutes }) : ""}</span>
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => act("stop")}>
							<Power size={14} /> {t("关机")}
						</Button>
					</div>
				</>
			)}
			{err && <div className="text-xs text-red-600">{err}</div>}
			<details className="pt-1" data-testid="desktop-action-log">
				<summary className="cursor-pointer text-xs font-semibold text-mut">操作记录（可逐步回放）</summary>
				<div className="pt-1">
					<ActionLog agentId={agentId} limit={50} />
				</div>
			</details>
		</div>
	);
}
