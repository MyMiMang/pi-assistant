import { Bell, Copy, Globe, Info, Monitor, Moon, Palette, QrCode, Smartphone, Sun, Trash2, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { getLang, setLang, t } from "../i18n";
import { applyTheme, useStore } from "../store";
import type { Device, Provider } from "../types";
import { DefaultModelPicker, ProviderList, ProviderSetup, useProviders } from "./Models";
import { Badge, Button, cx, fmtTime, Input, Modal } from "./ui";

const TABS = [
	["models", "模型", Monitor],
	["remote", "远程访问与设备", Wifi],
	["entry", "入口域名", Globe],
	["appearance", "外观", Palette],
	["about", "关于", Info],
] as const;

export default function Settings() {
	const { settings, set } = useStore();
	return (
		<Modal open={!!settings} onClose={() => set({ settings: null })} title={t("设置")} wide>
			<div className="flex min-h-[70dvh] flex-col sm:flex-row">
				<nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-200 p-2 sm:w-52 sm:flex-col sm:border-r sm:border-b-0 dark:border-zinc-800">
					{TABS.map(([k, label, Icon]) => (
						<button key={k} onClick={() => set({ settings: k })} className={cx("flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", settings === k ? "bg-accent-soft font-medium text-accent" : "hover:bg-zinc-100 dark:hover:bg-zinc-800")}>
							<Icon size={16} /> {t(label)}
						</button>
					))}
				</nav>
				<div className="min-w-0 flex-1 p-5">
					{settings === "models" && <ModelsTab />}
					{settings === "remote" && <RemoteTab />}
					{settings === "entry" && <EntryTab />}
					{settings === "appearance" && <AppearanceTab />}
					{settings === "about" && <AboutTab />}
				</div>
			</div>
		</Modal>
	);
}

const H = ({ children, desc }: { children: React.ReactNode; desc?: string }) => (
	<div className="mb-3">
		<div className="font-semibold">{children}</div>
		{desc && <div className="mt-0.5 text-sm text-zinc-500">{desc}</div>}
	</div>
);

function ModelsTab() {
	const { providers, reload } = useProviders();
	const [sel, setSel] = useState<Provider | null>(null);
	const system = useStore((s) => s.system);
	const current = sel ? (providers.find((p) => p.id === sel.id) ?? sel) : null;
	return (
		<div className="space-y-6">
			<section>
				<H desc={system?.defaultModel ? `当前：${system.defaultModel.provider} / ${system.defaultModel.id}` : "还没有设置默认模型"}>默认模型</H>
				<DefaultModelPicker key={providers.filter((p) => p.configured).length} />
			</section>
			<section>
				<H desc="列表来自 Pi 的模型服务目录，升级 Pi 后新的服务会自动出现。凭据加密保存在本机。">模型服务</H>
				{current ? (
					<div className="space-y-3">
						<Button size="sm" variant="ghost" onClick={() => setSel(null)}>
							← 返回列表
						</Button>
						<div className="font-medium">{current.name}</div>
						<ProviderSetup provider={current} onConfigured={() => void reload()} />
					</div>
				) : (
					<ProviderList providers={providers} onPick={setSel} />
				)}
			</section>
		</div>
	);
}

function RemoteTab() {
	const system = useStore((s) => s.system)!;
	const [pair, setPair] = useState<{ url: string; directUrl: string; qr: string; expiresAt: number; viaEntry: boolean; remote: boolean } | null>(null);
	const [devices, setDevices] = useState<Device[]>([]);
	const [left, setLeft] = useState(0);
	const [pushState, setPushState] = useState<string>(typeof Notification !== "undefined" ? Notification.permission : "unsupported");
	const loadDevices = () => api<Device[]>("/api/devices").then(setDevices);
	useEffect(() => {
		void loadDevices();
		const off = useStore.subscribe((s, p) => s.pendingDevices !== p.pendingDevices && void loadDevices());
		const i = setInterval(() => void loadDevices(), 5000);
		return () => (off(), clearInterval(i));
	}, []);
	useEffect(() => {
		if (!pair) return;
		const i = setInterval(() => setLeft(Math.max(0, Math.round((pair.expiresAt - Date.now()) / 1000))), 1000);
		return () => clearInterval(i);
	}, [pair]);
	const tun = system.tunnel;
	const toggle = (v: boolean) => api("/api/settings", { method: "PUT", json: { remoteEnabled: v } }).then(() => useStore.getState().loadSystem());
	const enablePush = async () => {
		try {
			const perm = await Notification.requestPermission();
			setPushState(perm);
			if (perm !== "granted") return;
			const reg = await navigator.serviceWorker.ready;
			const { publicKey } = await api("/api/push/key");
			const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (publicKey.length % 4)) % 4)), (c) => c.charCodeAt(0));
			const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
			await api("/api/push/subscribe", { method: "POST", json: sub.toJSON() });
			setPushState("subscribed");
		} catch (e) {
			setPushState(`失败：${e instanceof Error ? e.message : e}`);
		}
	};
	return (
		<div className="space-y-6">
			<section>
				<H desc="开启后，手机在任何网络（4G/5G、外面的 Wi-Fi）下都能连回这台电脑。使用内置加密隧道，无需任何网络设置。">远程访问</H>
				<div className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
					<div className="min-w-0 flex-1 text-sm">
						<div className="flex items-center gap-2">
							状态：
							<Badge tone={tun.state === "online" ? "green" : tun.state === "off" ? "zinc" : tun.state === "starting" ? "accent" : "red"}>
								{{ off: "已关闭", starting: "正在建立隧道…", online: "在线", error: "异常", missing: "缺少隧道组件" }[tun.state] ?? tun.state}
							</Badge>
							{tun.state === "online" && <Badge tone={tun.rendezvous.state === "ok" ? "green" : "amber"}>{tun.rendezvous.state === "ok" ? "入口已同步" : "入口未同步"}</Badge>}
						</div>
						{tun.url && <div className="mt-1 truncate text-xs text-zinc-500">{tun.url}</div>}
						{tun.error && <div className="mt-1 text-xs text-red-500">{tun.error}</div>}
						{tun.rendezvous.state === "error" && <div className="mt-1 text-xs text-amber-600">入口域名同步失败（{tun.rendezvous.error}），二维码将使用直连地址。</div>}
					</div>
					{system.local && (
						<Button variant={tun.enabled ? "outline" : "primary"} onClick={() => toggle(!tun.enabled)}>
							{tun.enabled ? "关闭" : "开启"}
						</Button>
					)}
				</div>
			</section>
			{system.local && (
				<section>
					<H desc="用手机相机扫码，在手机上确认后即可使用。二维码 5 分钟内有效、只能用一次。">配对新设备</H>
					{pair && left > 0 ? (
						<div className="flex flex-col items-center gap-3 rounded-xl border border-zinc-200 p-4 sm:flex-row sm:items-start dark:border-zinc-800">
							<img src={pair.qr} alt="配对二维码" className="h-48 w-48 rounded-lg bg-white p-2" />
							<div className="min-w-0 flex-1 space-y-2 text-sm">
								<div>
									{left} 秒后失效 · {pair.viaEntry ? "通过入口域名" : pair.remote ? "隧道直连" : "仅本机网络（未开启远程访问）"}
								</div>
								<div className="flex gap-2">
									<Input readOnly value={pair.url} />
									<Button variant="outline" size="icon" onClick={() => navigator.clipboard.writeText(pair.url)} aria-label="复制">
										<Copy size={15} />
									</Button>
								</div>
								{!pair.remote && <div className="text-xs text-amber-600">提示：先开启远程访问，手机才能在外网扫码连接。</div>}
							</div>
						</div>
					) : (
						<Button variant="primary" onClick={async () => setPair(await api("/api/pair/start", { method: "POST" }))}>
							<QrCode size={16} /> 生成配对二维码
						</Button>
					)}
				</section>
			)}
			<section>
				<H desc="已配对的设备可以随时访问助理。丢失设备时请立即移除。">已配对设备</H>
				<div className="space-y-1.5">
					{devices.length === 0 && <div className="text-sm text-zinc-500">还没有配对的设备</div>}
					{devices.map((d) => (
						<div key={d.id} className="flex items-center gap-3 rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-800/50">
							<Smartphone size={16} className="text-zinc-400" />
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium">
									{d.name} {d.id === system.deviceId && <Badge tone="accent">本设备</Badge>} {d.status === "pending" && <Badge tone="amber">待确认</Badge>}
								</div>
								<div className="text-xs text-zinc-500">{d.last_seen_at ? `最近使用 ${fmtTime(d.last_seen_at)}` : `添加于 ${fmtTime(d.created_at)}`}</div>
							</div>
							<Button variant="ghost" size="icon" onClick={async () => (await api(`/api/devices/${d.id}`, { method: "DELETE" }), loadDevices())} aria-label="移除设备">
								<Trash2 size={15} />
							</Button>
						</div>
					))}
				</div>
			</section>
			<section>
				<H desc="审批请求、后台任务完成时通知这台设备。iPhone 需先“添加到主屏幕”。">通知</H>
				<Button variant="outline" onClick={enablePush} disabled={pushState === "subscribed" || pushState === "unsupported"}>
					<Bell size={15} /> {pushState === "subscribed" ? "已开启通知" : pushState === "unsupported" ? "此浏览器不支持" : "在这台设备上开启通知"}
				</Button>
				{pushState.startsWith("失败") && <div className="mt-1 text-xs text-red-500">{pushState}</div>}
			</section>
		</div>
	);
}

function EntryTab() {
	const system = useStore((s) => s.system)!;
	const [v, setV] = useState(system.entryDomain);
	const [msg, setMsg] = useState("");
	const save = async (d: string) => {
		try {
			await api("/api/settings", { method: "PUT", json: { entryDomain: d } });
			setV(d);
			setMsg("已保存");
			await useStore.getState().loadSystem();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};
	return (
		<div className="space-y-4">
			<H desc="手机扫码打开的固定网址，同时负责告诉手机“你的电脑现在在哪个地址”（只交换地址，不经手任何聊天内容）。可以改成你自己部署的入口，无需重新安装。">入口域名</H>
			<div className="flex gap-2">
				<Input value={v} onChange={(e) => setV(e.target.value)} placeholder={system.defaultEntryDomain} />
				<Button variant="primary" onClick={() => save(v)}>
					{t("保存")}
				</Button>
			</div>
			<div className="flex items-center gap-2 text-xs text-zinc-500">
				默认：{system.defaultEntryDomain}
				{v !== system.defaultEntryDomain && (
					<button className="text-accent" onClick={() => save(system.defaultEntryDomain)}>
						恢复默认
					</button>
				)}
				{msg && <span className="ml-2">{msg}</span>}
			</div>
		</div>
	);
}

const ACCENTS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#18181b"];
function AppearanceTab() {
	const { theme, accent, set } = useStore();
	const upd = (th = theme, ac = accent) => {
		localStorage.setItem("huhao.theme", th);
		localStorage.setItem("huhao.accent", ac);
		set({ theme: th, accent: ac });
		applyTheme(th, ac);
	};
	return (
		<div className="space-y-6">
			<section>
				<H>主题</H>
				<div className="flex gap-2">
					{(
						[
							["light", "浅色", Sun],
							["dark", "深色", Moon],
							["system", "跟随系统", Monitor],
						] as const
					).map(([k, label, Icon]) => (
						<Button key={k} variant={theme === k ? "primary" : "outline"} onClick={() => upd(k)}>
							<Icon size={15} /> {label}
						</Button>
					))}
				</div>
			</section>
			<section>
				<H>强调色</H>
				<div className="flex gap-2">
					{ACCENTS.map((c) => (
						<button key={c} onClick={() => upd(theme, c)} className={cx("h-8 w-8 rounded-full border border-black/10 ring-offset-2 dark:border-white/25 dark:ring-offset-zinc-900", c === accent && "ring-2 ring-zinc-400")} style={{ background: c }} aria-label={c} />
					))}
				</div>
			</section>
			<section>
				<H>语言 / Language</H>
				<div className="flex gap-2">
					<Button variant={getLang() === "zh" ? "primary" : "outline"} onClick={() => setLang("zh")}>
						简体中文
					</Button>
					<Button variant={getLang() === "en" ? "primary" : "outline"} onClick={() => setLang("en")}>
						English
					</Button>
				</div>
			</section>
		</div>
	);
}

function AboutTab() {
	const system = useStore((s) => s.system)!;
	const setSandbox = (v: string) => api("/api/settings", { method: "PUT", json: { sandbox: v } }).then(() => useStore.getState().loadSystem());
	const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
		<div className="flex gap-4 border-b border-zinc-100 py-2 text-sm dark:border-zinc-800">
			<div className="w-28 shrink-0 text-zinc-500">{k}</div>
			<div className="min-w-0 flex-1 break-all">{v}</div>
		</div>
	);
	return (
		<div className="space-y-6">
			<section>
				<H>系统</H>
				<Row k="Pi 版本" v={<span className={system.pi.compatible ? "" : "text-amber-600"}>{system.pi.message}</span>} />
				<Row k="服务 ID" v={<code className="text-xs">{system.serverId}</code>} />
				<Row k="凭据存储" v={{ "macos-keychain": "macOS 钥匙串 + AES-256-GCM", "windows-dpapi": "Windows DPAPI + AES-256-GCM", file: "本地密钥文件 + AES-256-GCM" }[system.credentialBackend] ?? system.credentialBackend} />
				<Row k="工作区" v={<code className="text-xs">{system.workspaceRoot}</code>} />
				{system.mock && <Row k="开发模式" v={<Badge tone="amber">Mock 模型已启用</Badge>} />}
			</section>
			<section>
				<H desc="工作区模式：助理在专属目录里工作，危险操作靠审批兜底。Docker 模式：在容器里运行命令，隔离更强（需要安装 Docker）。">沙箱</H>
				<div className="flex flex-wrap gap-2">
					<Button variant={system.sandbox.preference !== "docker" ? "primary" : "outline"} onClick={() => setSandbox("workspace")}>
						工作区目录
					</Button>
					<Button variant={system.sandbox.preference === "docker" ? "primary" : "outline"} disabled={!system.sandbox.dockerAvailable} onClick={() => setSandbox("docker")}>
						Docker 容器{system.sandbox.dockerAvailable ? "" : "（未检测到 Docker）"}
					</Button>
				</div>
				<div className="mt-1 text-xs text-zinc-500">当前生效：{system.sandbox.mode === "docker" ? "Docker 容器" : "工作区目录"}（新对话轮次生效）</div>
			</section>
		</div>
	);
}
