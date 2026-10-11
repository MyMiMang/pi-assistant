import { useEffect, useState } from "react";
import { ApiError, connectWs, getConn, refreshFromRendezvous, saveConn } from "./api";
import Chat from "./components/Chat";
import DeviceApproval from "./components/DeviceApproval";
import InfoPane from "./components/InfoPane";
import Onboarding from "./components/Onboarding";
import Settings from "./components/Settings";
import Sidebar from "./components/Sidebar";
import { Button } from "./components/ui";
import { useStore } from "./store";
import { BRAND } from "@pi-assistant/shared";

export default function App() {
	const { system, current, drawer, info, set, loadSystem, loadAgents, selectAgent, handle } = useStore();
	const [fatal, setFatal] = useState<null | "unpaired" | "offline">(null);

	useEffect(() => {
		let stop: (() => void) | undefined;
		(async () => {
			const c = getConn();
			if (c && c.base && c.base !== location.origin) await refreshFromRendezvous();
			try {
				await loadSystem();
				await loadAgents();
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
						const id = useStore.getState().current;
						if (id) void selectAgent(id);
					});
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
		if (current) void selectAgent(current);
	}, [current]);

	if (fatal)
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
				<img src="/icon-192.png" className="h-16 w-16 rounded-2xl" alt="" />
				<div className="text-lg font-semibold">{fatal === "unpaired" ? "这台设备还没有配对" : "连不上你的电脑"}</div>
				<p className="max-w-sm text-sm text-zinc-500">
					{fatal === "unpaired"
						? `请在电脑上打开 ${BRAND.name} →「设置 → 远程访问与设备」，用手机扫描配对二维码。`
						: `请确认电脑已开机、${BRAND.name} 正在运行，并且开启了远程访问。`}
				</p>
				<div className="flex gap-2">
					<Button variant="primary" onClick={() => location.reload()}>
						重试
					</Button>
					{fatal === "unpaired" && getConn() && (
						<Button variant="outline" onClick={() => (saveConn(null), location.reload())}>
							清除配对信息
						</Button>
					)}
				</div>
			</div>
		);
	if (!system) return <div className="flex h-full items-center justify-center text-sm text-zinc-500">正在连接…</div>;

	return (
		<div className="pa-app">
			<div className="pa-bg-layer" aria-hidden="true">
				<i className="pa-b1" />
				<i className="pa-b2" />
				<i className="pa-b3" />
			</div>
			{/* 左侧：助理列表（手机上为抽屉） */}
			<div className={`fixed inset-0 z-40 bg-black/40 transition-opacity lg:hidden ${drawer ? "opacity-100" : "pointer-events-none opacity-0"}`} onClick={() => set({ drawer: false })} />
			<div className={`pa-drawer transition-transform ${drawer ? "max-lg:translate-x-0" : "max-lg:-translate-x-[110%]"}`}>
				<Sidebar />
			</div>
			<main className="pa-chat">{current ? <Chat agentId={current} /> : null}</main>
			{info && current && (
				<>
					<div className="fixed inset-0 z-40 bg-black/40 xl:hidden" onClick={() => set({ info: false })} />
					<div className="pa-pane-wrap">
						<InfoPane agentId={current} />
					</div>
				</>
			)}
			<Settings />
			<DeviceApproval />
			{!system.onboarded && <Onboarding />}
		</div>
	);
}
