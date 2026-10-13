import { useEffect, useState } from "react";
import { ApiError, connectWs, getConn, refreshFromRendezvous, saveConn } from "./api";
import Chat from "./components/Chat";
import RoomChat from "./components/RoomChat";
import DeviceApproval from "./components/DeviceApproval";
import InfoPane from "./components/InfoPane";
import Onboarding from "./components/Onboarding";
import { isStandalone, PairCodeForm } from "./components/PairPage";
import Settings from "./components/Settings";
import Sidebar from "./components/Sidebar";
import { Button } from "./components/ui";
import { useStore } from "./store";
import { clampPane, clampSide, PANE, resolveLayout, SIDE, useWindowWidth } from "./layout";
import { Resizer } from "./components/Resizer";
import { BRAND } from "@pi-assistant/shared";

export default function App() {
	const { system, current, drawer, info, set, loadSystem, loadAgents, selectAgent, handle, layout, setLayout, room, paneAgent, loadRooms, selectRoom } = useStore();
	const width = useWindowWidth();
	const L = resolveLayout(width, layout);
	const [fatal, setFatal] = useState<null | "unpaired" | "offline">(null);
	/** Linux 服务器版：setup = 还没有主人设备（输设置码）；server = 已设置过（找主人设备要配对码） */
	const [setupMode, setSetupMode] = useState<null | "setup" | "server">(null);
	useEffect(() => {
		if (fatal !== "unpaired") return;
		void fetch("/api/system/public")
			.then((r) => (r.ok ? r.json() : null))
			.then((p: { server?: boolean; setup?: boolean } | null) => setSetupMode(p?.setup ? "setup" : p?.server ? "server" : null))
			.catch(() => {});
	}, [fatal]);

	useEffect(() => {
		let stop: (() => void) | undefined;
		(async () => {
			const c = getConn();
			if (c && c.base && c.base !== location.origin) await refreshFromRendezvous();
			try {
				await loadSystem();
				await loadAgents();
				await loadRooms().catch(() => {});
			} catch (e) {
				setFatal(e instanceof ApiError && e.status === 401 ? "unpaired" : "offline");
				return;
			}
			stop = connectWs(handle, (s) => {
				set({ conn: s });
				if (s === "open") {
					// 重连后重新拉取快照，保证所有设备一致
					void loadSystem();
					void loadAgents().then(() => {
						const st = useStore.getState();
						if (st.room) void selectRoom(st.room);
						else if (st.current) void selectAgent(st.current);
					});
					void loadRooms().catch(() => {});
				}
				if (s === "unauthorized") setFatal("unpaired");
			});
		})();
		const onMsg = (e: MessageEvent) => {
			if (e.data?.type === "server-url" && getConn()?.serverId === e.data.serverId) {
				saveConn({ ...getConn()!, base: e.data.url });
				location.reload();
			}
		};
		navigator.serviceWorker?.addEventListener("message", onMsg);
		return () => {
			stop?.();
			navigator.serviceWorker?.removeEventListener("message", onMsg);
		};
	}, []);

	useEffect(() => {
		if (current && !useStore.getState().room) void selectAgent(current);
	}, [current]);
	useEffect(() => {
		if (room) void selectRoom(room);
	}, [room]);
	const paneId = room ? paneAgent : current;

	if (fatal)
		return (
			<div className="flex min-h-full flex-col items-center justify-center gap-4 overflow-y-auto p-8 text-center" data-testid={fatal === "unpaired" ? "unpaired" : "offline"}>
				<img src="/icon-192.png" className="h-16 w-16 rounded-2xl" alt="" />
				<div className="text-lg font-semibold">{fatal === "unpaired" ? (setupMode === "setup" ? "欢迎使用，先完成首次设置" : "这台设备还没有配对") : "连不上你的电脑"}</div>
				<p className="max-w-sm text-sm text-zinc-500" data-testid={setupMode ? "server-setup" : undefined}>
					{fatal === "unpaired" && setupMode === "setup"
						? "首次设置：输入服务器控制台（或 sudo pi-assistant setup-code）显示的 8 位设置码。第一台登录的设备会成为主人设备，之后可以在网页上批准新设备、修改所有设置。"
						: fatal === "unpaired" && setupMode === "server"
						? "让主人设备在「设置 → 远程访问与设备」生成配对码，把配对码输入下面。"
						: fatal === "unpaired"
						? isStandalone()
							? `主屏 App 和浏览器的登录是分开的，需要在这里再配对一次：在电脑上打开 ${BRAND.name} →「设置 → 远程访问与设备」→ 生成配对二维码，把旁边的配对码输入下面。`
							: `在电脑上打开 ${BRAND.name} →「设置 → 远程访问与设备」，用手机扫描配对二维码，或把配对码输入下面。`
						: `请确认电脑已开机、${BRAND.name} 正在运行，并且开启了远程访问。`}
				</p>
				{fatal === "unpaired" && <PairCodeForm />}
				<div className="flex gap-2">
					<Button variant={fatal === "unpaired" ? "ghost" : "primary"} onClick={() => location.reload()}>
						重试
					</Button>
					{fatal === "unpaired" && getConn() && (
						<Button variant="ghost" onClick={() => (saveConn(null), location.reload())}>
							清除配对信息
						</Button>
					)}
				</div>
			</div>
		);
	if (!system) return <div className="flex h-full items-center justify-center text-sm text-zinc-500">正在连接…</div>;

	return (
		<div
			className={`pa-app ${L.sideDocked ? "side-docked" : "side-hidden"} ${L.sideDrawer ? "side-drawer" : ""} ${L.paneDocked ? "pane-docked" : "pane-overlay"}`}
			style={{ ["--side-w" as string]: `${layout.sideW}px`, ["--pane-w" as string]: `${layout.paneW}px` }}
		>
			<div className="pa-bg-layer" aria-hidden="true">
				<i className="pa-b1" />
				<i className="pa-b2" />
				<i className="pa-b3" />
			</div>
			{/* 左侧：助理列表（手机上为抽屉） */}
			{L.sideDrawer && <div className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${drawer ? "opacity-100" : "pointer-events-none opacity-0"}`} onClick={() => set({ drawer: false })} />}
			{(L.sideDocked || L.sideDrawer) && (
				<div className={`pa-drawer transition-transform ${L.sideDrawer ? (drawer ? "translate-x-0" : "-translate-x-[110%]") : ""}`}>
					<Sidebar />
					{L.sideDocked && <Resizer side="right" value={layout.sideW} onChange={(v) => setLayout({ sideW: clampSide(v) })} onReset={() => setLayout({ sideW: SIDE.def })} onCollapse={() => setLayout({ sideCollapsed: true })} label="调整助理列表宽度" />}
				</div>
			)}
			<main className="pa-chat">{room ? <RoomChat roomId={room} /> : current ? <Chat agentId={current} /> : null}</main>
			{info && paneId && (
				<>
					{!L.paneDocked && <div className="fixed inset-0 z-40 bg-black/40" onClick={() => set({ info: false })} />}
					<div className="pa-pane-wrap">
						<Resizer side="left" value={layout.paneW} onChange={(v) => setLayout({ paneW: clampPane(v) })} onReset={() => setLayout({ paneW: PANE.def })} onCollapse={() => set({ info: false })} label="调整信息面板宽度" />
						<InfoPane agentId={paneId} />
					</div>
				</>
			)}
			<Settings />
			<DeviceApproval />
			{!system.onboarded && <Onboarding />}
		</div>
	);
}
