/**
 * 「电脑」标签：助理电脑的实时画面（noVNC，经本机服务鉴权代理）、接管、一键暂停、启动/停止。
 */
import { Hand, Loader2, Maximize2, MonitorPlay, Pause, Play, Power } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, base } from "../api";
import { useStore } from "../store";
import { Badge, Button, cx } from "./ui";

type DeskStatus = { available: boolean; reason?: string; state: "none" | "stopped" | "running"; paused: boolean; image: string };

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
				{st.state === "running" ? <Badge tone="accent">运行中</Badge> : <Badge>{st.state === "stopped" ? "已停止" : "未创建"}</Badge>}
				{st.paused && <Badge tone="amber">已暂停操作</Badge>}
				{control && <Badge tone="amber">你在操作</Badge>}
			</div>
			{!st.available ? (
				<div className="rounded-lg bg-zinc-50 p-2 text-xs text-zinc-500 dark:bg-zinc-900">{st.reason ?? "助理电脑不可用"}。安装并启动 Docker 后即可使用完整桌面（浏览器、微信等应用）。</div>
			) : st.state !== "running" ? (
				<Button variant="primary" size="sm" disabled={busy} onClick={() => act("start")}>
					{busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />} 启动助理电脑
				</Button>
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
						<Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => act("stop")}>
							<Power size={14} /> 停止
						</Button>
					</div>
				</>
			)}
			{err && <div className="text-xs text-red-600">{err}</div>}
		</div>
	);
}
