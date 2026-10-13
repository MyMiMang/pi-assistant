/**
 * 「电脑」标签：助理电脑的实时画面（noVNC，经本机服务鉴权代理）、接管、一键暂停、启动/停止。
 * 共用电脑（DESIGN §15.4）：默认看这个助理自己用的屏幕，可以切换去看同一台电脑上其他助理的屏幕；可以给它开 / 关自己的屏幕。
 */
import { Hand, Loader2, Maximize2, MonitorPlay, Pause, Play, Power, Settings2, Users } from "lucide-react";
import { t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { api, base } from "../api";
import { useStore } from "../store";
import { Badge, Button, cx, ErrorBox, useConfirm } from "./ui";

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
	computer?: { id: string; shared: boolean; agents: { id: string; name: string }[] };
	screen?: string;
	screens?: { key: string; label: string; agentId?: string; mine: boolean }[];
};

export function DesktopView({ agentId }: { agentId: string }) {
	const [st, setSt] = useState<DeskStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [control, setControl] = useState(false);
	const [conn, setConn] = useState<"idle" | "connecting" | "connected" | "error">("idle");
	const box = useRef<HTMLDivElement>(null);
	const rfb = useRef<any>(null);
	/** 正在看的屏幕（空 = 这个助理自己用的屏幕） */
	const [view, setView] = useState("");
	const [dialog, confirm] = useConfirm();
	const ver = useStore((s) => s.desktopVersion);
	const load = () => api<DeskStatus>(`/api/agents/${agentId}/desktop`).then(setSt).catch(() => setSt(null));
	useEffect(() => {
		void load();
	}, [agentId, ver]);
	useEffect(() => setView(""), [agentId]);
	// 看的那块屏幕被关掉了：回到自己的
	useEffect(() => {
		if (view && st?.screens && !st.screens.some((x) => x.key === view)) setView("");
	}, [st?.screens, view]);
	const watching = view || st?.screen || "main";
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
			const { ticket } = await api(`/api/agents/${agentId}/desktop/ticket`, { method: "POST", json: { screen: watching } });
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
	}, [st?.state, agentId, watching]);

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
	const ownScreen = async (own: boolean) => {
		setBusy(true);
		setErr("");
		try {
			setSt(await api(`/api/agents/${agentId}/desktop/screen`, { method: "POST", json: { own } }));
			setView("");
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const others = (st?.computer?.agents ?? []).filter((a) => a.id !== agentId);
	const stop = async () => {
		if (st?.computer?.shared && others.length) {
			const ok = await confirm({
				title: t("关掉共用电脑？"),
				body: t("这台电脑 {names} 都在用，关机会让它们正在做的电脑操作都停下来（登录状态和文件都保留）。", { names: st.computer.agents.map((a) => a.name).join("、") }),
				ok: t("关机"),
				danger: true,
			});
			if (!ok) return;
		}
		void act("stop");
	};
	const takeOver = async (v: boolean) => {
		setControl(v);
		await act("pause", { paused: v }); // 接管时自动暂停助理的电脑操作，交还时恢复
	};

	if (!st) return null;
	return (
		<div className="space-y-2" data-testid="desktop-view">
			{dialog}
			{/* 窄面板：文字收起只留图标（悬停看文字），绝不把文字挤成竖排 */}
			<div className="@container">
				<div className="flex min-w-0 items-center gap-2" data-testid="desktop-header">
					<MonitorPlay size={16} className="shrink-0" aria-label={t("桌面")} />
					<span className="hidden shrink-0 font-medium whitespace-nowrap @[260px]:inline">{t("桌面")}</span>
					{(() => {
						const [label, tone, dot] = !st.enabled
							? [t("未安装"), "zinc", "bg-zinc-400"]
							: st.state === "running"
								? [t("运行中"), "accent", "bg-accent"]
								: st.state === "starting" || (busy && st.available)
									? [t("启动中"), "amber", "bg-amber-500"]
									: [t("已关机"), "zinc", "bg-zinc-400"];
						return (
							<span title={label} className="flex shrink-0 items-center" data-testid="desktop-state">
								<span className={cx("inline-block h-2 w-2 rounded-full @[200px]:hidden", dot)} aria-label={label} />
								<span className="hidden @[200px]:inline-flex">
									<Badge tone={tone as "zinc"}>{label}</Badge>
								</span>
							</span>
						);
					})()}
					{st.paused && <span className="hidden @[320px]:inline-flex"><Badge tone="amber">{t("已暂停操作")}</Badge></span>}
					{control && <span className="hidden @[320px]:inline-flex"><Badge tone="amber">{t("你在操作")}</Badge></span>}
					{st.computer && (
						<span className="ml-auto flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-zinc-500" data-testid="desktop-computer" title={`${st.computer.shared ? t("共用电脑（{n} 个助理）", { n: st.computer.agents.length }) : t("单独的电脑")}：${st.computer.agents.map((a) => a.name).join("、")}`}>
							<Users size={12} />
							<span className="hidden @[340px]:inline">{st.computer.shared ? t("共用电脑（{n} 个助理）", { n: st.computer.agents.length }) : t("单独的电脑")}</span>
							<span className="@[340px]:hidden">{st.computer.shared ? st.computer.agents.length : ""}</span>
						</span>
					)}
				</div>
			</div>
			{!st.enabled ? (
				<div className="flex items-center gap-2 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-500 dark:bg-zinc-900" data-testid="desktop-not-installed">
					<span className="flex-1">{t("未安装，去设置安装")}</span>
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
					{st.computer?.shared && (
						<div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="desktop-screens">
							<span className="text-zinc-500">{t("屏幕")}</span>
							{(st.screens ?? []).map((x) => (
								<button
									key={x.key}
									data-testid={`screen-${x.key}`}
									onClick={() => setView(x.mine ? "" : x.key)}
									className={cx("rounded-full border px-2 py-0.5", x.key === watching ? "border-accent bg-accent/10 text-accent" : "border-line text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800")}
								>
									{t(x.label)}
									{x.mine ? ` · ${t("它在用")}` : ""}
								</button>
							))}
							<span className="flex-1" />
							{st.screen && st.screen !== "main" ? (
								<Button size="sm" variant="ghost" disabled={busy} onClick={() => ownScreen(false)} data-testid="screen-release">
									{t("回主屏幕")}
								</Button>
							) : (
								<Button size="sm" variant="ghost" disabled={busy} onClick={() => ownScreen(true)} data-testid="screen-own" title={t("给这个助理开一块自己的屏幕：同样的文件和登录状态，不和别的助理抢鼠标键盘")}>
									{t("给它开自己的屏幕")}
								</Button>
							)}
						</div>
					)}
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
						<Button size="sm" variant="ghost" disabled={busy} onClick={stop} data-testid="desktop-stop">
							<Power size={14} /> {t("关机")}
						</Button>
					</div>
				</>
			)}
			{err && <ErrorBox text={err} />}
		</div>
	);
}
