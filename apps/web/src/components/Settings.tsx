import { Brain, Puzzle, Bell, Check, CheckCircle2, Copy, Globe, Info, Loader2, Monitor, Moon, Palette, Plus, QrCode, Smartphone, Sun, Trash2, Wifi, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { getLang, setLang, t } from "../i18n";
import { setAppearance, useStore } from "../store";
import { getTheme, type Mode, THEMES } from "../themes/registry";
import { ThemePreview } from "./ThemePreview";
import { MemorySettings, SkillsTab } from "./SkillsTab";
import type { Device, PermCheck, Provider } from "../types";
import { CustomProviderForm, useCustomProviders } from "./CustomProvider";
import { DefaultModelPicker, ProviderList, ProviderSetup, useProviders } from "./Models";
import { Badge, Button, cx, fmtTime, Input, Modal } from "./ui";

const TABS = [
	["models", "模型", Monitor],
	["skills", "技能库", Puzzle],
	["memory", "记忆", Brain],
	["remote", "远程访问与设备", Wifi],
	["entry", "固定地址 / 入口", Globe],
	["appearance", "外观", Palette],
	["about", "关于", Info],
] as const;

export default function Settings() {
	const { settings, set } = useStore();
	return (
		<Modal open={!!settings} onClose={() => set({ settings: null })} title={t("设置")} wide>
			<div className="flex min-h-[70dvh] flex-col sm:flex-row">
				<nav className="sticky top-0 z-10 flex shrink-0 gap-1 overflow-x-auto border-b bg-white sm:self-start dark:bg-zinc-900 border-zinc-200 p-2 sm:w-52 sm:flex-col sm:min-h-[70dvh] sm:border-r sm:border-b-0 dark:border-zinc-800">
					{TABS.map(([k, label, Icon]) => (
						<button key={k} onClick={() => set({ settings: k })} className={cx("flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", settings === k ? "bg-accent-soft font-medium text-accent" : "hover:bg-zinc-100 dark:hover:bg-zinc-800")}>
							<Icon size={16} /> {t(label)}
						</button>
					))}
				</nav>
				<div className="min-w-0 flex-1 p-5">
					{settings === "models" && <ModelsTab />}
					{settings === "skills" && <SkillsTab />}
					{settings === "memory" && <MemorySettings />}
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
	const custom = useCustomProviders();
	const [sel, setSel] = useState<Provider | null>(null);
	const [customEdit, setCustomEdit] = useState<{ id?: string; k: number } | null>(null);
	const system = useStore((s) => s.system);
	const current = sel ? (providers.find((p) => p.id === sel.id) ?? sel) : null;
	const reloadAll = () => (void reload(), void custom.reload(), void useStore.getState().loadSystem());
	const back = () => (setSel(null), setCustomEdit(null));
	return (
		<div className="space-y-6">
			<section>
				<H desc={system?.defaultModel ? `当前：${system.defaultModel.provider} / ${system.defaultModel.id}` : "还没有设置默认模型"}>默认模型</H>
				<DefaultModelPicker key={providers.filter((p) => p.configured).length + providers.length * 100} />
			</section>
			<section>
				<H desc="列表来自 Pi 的模型服务目录，升级 Pi 后新的服务会自动出现。也可以添加任意中转站、第三方或本地模型服务。凭据加密保存在本机。">模型服务</H>
				{customEdit ? (
					<div className="space-y-3">
						<Button size="sm" variant="ghost" onClick={back}>
							← 返回列表
						</Button>
						<div className="font-medium">{customEdit.id ? "编辑自定义服务" : "添加自定义服务"}</div>
						<CustomProviderForm
							key={customEdit.k}
							apis={custom.apis}
							initial={custom.providers.find((m) => m.id === customEdit.id)}
							onSaved={(m) => (reloadAll(), setCustomEdit((x) => ({ id: m.id, k: x?.k ?? 0 })))}
							onCancel={back}
							onDeleted={() => (reloadAll(), back())}
						/>
					</div>
				) : current ? (
					<div className="space-y-3">
						<Button size="sm" variant="ghost" onClick={back}>
							← 返回列表
						</Button>
						<div className="font-medium">{current.name}</div>
						<ProviderSetup provider={current} onConfigured={() => void reload()} />
					</div>
				) : (
					<div className="space-y-3">
						<Button variant="outline" onClick={() => setCustomEdit({ k: Date.now() })}>
							<Plus size={15} /> 添加自定义服务（中转站 / 第三方 / 本地模型）
						</Button>
						<ProviderList providers={providers} onPick={(p) => (p.custom ? setCustomEdit({ id: p.id, k: Date.now() }) : setSel(p))} />
					</div>
				)}
			</section>
		</div>
	);
}

function RemoteTab() {
	const system = useStore((s) => s.system)!;
	const [pair, setPair] = useState<{ url: string; directUrl: string; qr: string; expiresAt: number; viaEntry: boolean; remote: boolean; preApproved?: boolean } | null>(null);
	const [preApproved, setPreApproved] = useState(false);
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
							<Badge tone={tun.state === "online" ? "green" : tun.state === "off" ? "zinc" : tun.state === "starting" || tun.state === "downloading" ? "accent" : tun.state === "cooldown" ? "amber" : "red"}>
								{{ off: "已关闭", downloading: "正在准备隧道组件…", starting: "正在建立隧道…", online: "在线", error: "异常", cooldown: "限流冷却中", missing: "缺少隧道组件" }[tun.state] ?? tun.state}
							</Badge>
							{tun.enabled && <Badge tone={tun.mode === "named" ? "green" : "zinc"}>{tun.mode === "named" ? "固定地址" : "临时地址"}</Badge>}
							{tun.state === "online" && tun.mode === "quick" && <Badge tone={tun.rendezvous.state === "ok" ? "green" : "amber"}>{tun.rendezvous.state === "ok" ? "入口已同步" : "入口未同步"}</Badge>}
						</div>
						{tun.url && <div className="mt-1 truncate text-xs text-zinc-500">{tun.url}</div>}
						{tun.error && <div className={cx("mt-1 text-xs", tun.state === "cooldown" || tun.state === "downloading" ? "text-amber-600" : "text-red-500")}>{tun.error}</div>}
						{tun.enabled && tun.mode === "quick" && tun.named.check && !tun.named.check.ok && (
							<div className="mt-1 text-xs text-zinc-500">
								当前用的是临时地址（会变）。想要固定地址：{tun.named.check.hint}{" "}
								<button className="text-accent underline" onClick={() => useStore.getState().set({ settings: "entry" })}>去设置</button>
							</div>
						)}
						{tun.rendezvous.state === "error" && <div className="mt-1 text-xs text-amber-600">入口域名同步失败（{tun.rendezvous.error}），二维码将使用直连地址。</div>}
					</div>
					{system.local && tun.enabled && (tun.state === "error" || tun.state === "cooldown" || tun.state === "missing") && (
						<Button
							variant="outline"
							onClick={() => {
								if (tun.state === "cooldown" && !confirm("现在正处于 Cloudflare 限流冷却期，立即重试很可能再次被限流、冷却时间会更长。仍然重试？")) return;
								void api("/api/remote/tunnel/retry", { method: "POST" });
							}}
						>
							重新连接
						</Button>
					)}
					{system.local && (
						<Button variant={tun.enabled ? "outline" : "primary"} onClick={() => toggle(!tun.enabled)}>
							{tun.enabled ? "关闭" : "开启"}
						</Button>
					)}
				</div>
			</section>
			{system.local && (
				<section>
					<H desc="用手机相机扫码，在电脑上点“允许”后即可使用（也可以勾选免确认）。二维码 5 分钟内有效、只能用一次。">配对新设备</H>
					{pair && left > 0 ? (
						<div className="flex flex-col items-center gap-3 rounded-xl border border-zinc-200 p-4 sm:flex-row sm:items-start dark:border-zinc-800">
							<img src={pair.qr} alt="配对二维码" className="h-48 w-48 rounded-lg bg-white p-2" />
							<div className="min-w-0 flex-1 space-y-2 text-sm">
								<div>
									{left} 秒后失效 · {pair.viaEntry ? "通过入口域名" : pair.remote ? "隧道直连" : "仅本机网络（未开启远程访问）"}
									{pair.preApproved && <span className="ml-1 text-amber-600">· 扫码即通过，无需确认</span>}
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
						<div className="space-y-3">
							<label className="flex items-start gap-2 text-sm">
								<input type="checkbox" className="mt-0.5 accent-[var(--acc)]" checked={preApproved} onChange={(e) => setPreApproved(e.target.checked)} data-testid="pre-approved" />
								<span>
									扫码后无需在电脑上确认
									<span className="block text-xs text-mut2">适合人不在电脑旁时（比如把二维码截图发给自己的手机）。这个二维码相当于一次性钥匙：5 分钟内有效、只能用一次，请勿发给别人。</span>
								</span>
							</label>
							<Button variant="primary" onClick={async () => setPair(await api("/api/pair/start", { method: "POST", json: { preApproved } }))}>
								<QrCode size={16} /> 生成配对二维码
							</Button>
						</div>
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

type CfStep = { step: string; state: "running" | "ok" | "error"; detail?: string };
function EntryTab() {
	const system = useStore((s) => s.system)!;
	const steps = useStore((s) => s.cloudflareSteps);
	const [st, setSt] = useState<{ configured: boolean; hasToken: boolean; config: { hostname: string; zone: string; subdomain: string; deployedAt: number } | null } | null>(null);
	const [zone, setZone] = useState("");
	const [sub, setSub] = useState("assistant");
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const load = () =>
		api("/api/remote/cloudflare")
			.then((r) => {
				setSt(r);
				if (r.config) (setZone(r.config.zone), setSub(r.config.subdomain));
			})
			.catch(() => setSt(null));
	useEffect(() => {
		void load();
	}, []);
	const deploy = async () => {
		setBusy(true);
		setErr("");
		useStore.setState({ cloudflareSteps: [] });
		try {
			await api("/api/remote/cloudflare/deploy", { method: "POST", json: { zone, subdomain: sub, token: token || undefined } });
			setToken("");
			await load();
			await useStore.getState().loadSystem();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const remove = async () => {
		if (!confirm("删除远程入口？会解绑域名并删除 Worker，本机保存的 Token 也会清除。")) return;
		await api("/api/remote/cloudflare", { method: "DELETE" });
		await load();
		await useStore.getState().loadSystem();
	};
	if (!system.local) return <p className="text-sm text-zinc-500">远程入口只能在电脑上设置。</p>;
	return (
		<div className="space-y-5">
			<NamedTunnelSection defaultZone={zone} hasToken={!!st?.hasToken} />
			<div className="border-t border-line" />
			<H desc="备选（没有给 Token 隧道/DNS 权限时用）。用你自己的域名做一个固定网址：手机扫一次码，以后在任何网络下都能打开，电脑的隧道地址变了也会自动找到。部署在你自己的 Cloudflare 账号里，只交换“电脑现在在哪个地址”，不经手任何聊天内容。">入口页（Rendezvous）</H>
			{st?.config && (
				<div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
					<CheckCircle2 size={16} className="text-emerald-600" /> 已部署：
					<a className="font-medium text-accent" href={`https://${st.config.hostname}`} target="_blank" rel="noreferrer">
						https://{st.config.hostname}
					</a>
					<span className="text-xs text-zinc-500">{new Date(st.config.deployedAt).toLocaleString()}</span>
					<Button size="sm" variant="ghost" className="ml-auto text-red-600" onClick={remove}>
						<Trash2 size={14} /> 删除
					</Button>
				</div>
			)}
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="space-y-1">
					<span className="text-xs font-medium text-zinc-500">你的域名（已托管在 Cloudflare）</span>
					<Input placeholder="example.com" value={zone} onChange={(e) => setZone(e.target.value)} />
				</label>
				<label className="space-y-1">
					<span className="text-xs font-medium text-zinc-500">子域名</span>
					<div className="flex items-center gap-1.5">
						<Input value={sub} onChange={(e) => setSub(e.target.value)} />
						<span className="shrink-0 text-xs text-zinc-400">.{zone || "example.com"}</span>
					</div>
				</label>
			</div>
			<label className="block space-y-1">
				<span className="text-xs font-medium text-zinc-500">Cloudflare API Token</span>
				<Input type="password" autoComplete="off" placeholder={st?.hasToken ? "已加密保存在本机，留空则沿用" : "在 Cloudflare 控制台 → 我的个人资料 → API 令牌 创建"} value={token} onChange={(e) => setToken(e.target.value)} />
				<span className="block text-xs leading-relaxed text-zinc-500">
					创建令牌时选择模板「编辑 Cloudflare Workers」，区域资源选你的域名即可。Token 只加密保存在这台电脑，只发给 api.cloudflare.com。
				</span>
			</label>
			<div className="flex items-center gap-2">
				<Button variant="primary" disabled={busy || !zone || !sub || (!token && !st?.hasToken)} onClick={deploy}>
					{busy && <Loader2 size={14} className="animate-spin" />} {st?.config ? "重新部署 / 更新" : "一键部署"}
				</Button>
				{err && <span className="text-sm text-red-600">{err}</span>}
			</div>
			{steps.length > 0 && (
				<ul className="space-y-1 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
					{steps.map((x) => (
						<li key={x.step} className="flex items-start gap-2">
							{x.state === "running" ? <Loader2 size={15} className="mt-0.5 animate-spin text-accent" /> : x.state === "ok" ? <CheckCircle2 size={15} className="mt-0.5 text-emerald-500" /> : <XCircle size={15} className="mt-0.5 text-red-500" />}
							<span>
								{x.step}
								{x.detail && <span className="ml-1.5 break-all text-xs text-zinc-500">{x.detail}</span>}
							</span>
						</li>
					))}
				</ul>
			)}
			<div className="rounded-xl bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-500 dark:bg-zinc-800/50">
				<div className="mb-1 font-medium text-zinc-600 dark:text-zinc-300">Cloudflare 免费套餐额度（个人使用远远够用）</div>
				Workers：每天 10 万次请求、每次 10ms CPU；KV：每天 10 万次读取、1000 次写入、1 GB 存储；静态资源（PWA 外壳）请求免费且不限量；自定义域名与 HTTPS 证书免费。平时每次打开只读 1 次 KV，地址变化时才写 1 次。
				<div className="mt-2 font-medium text-zinc-600 dark:text-zinc-300">没有域名？</div>
				也能用：「远程访问与设备」里打开远程访问会得到一个临时链接（*.trycloudflare.com），每次电脑重启地址会变，需要重新扫码；或者只在同一 Wi‑Fi 下使用。
			</div>
		</div>
	);
}

type NamedInfo = { config: { zone: string; subdomain: string; hostname: string; tunnelId: string; tunnelName: string; createdAt: number } | null; mode: string; zone: string | null; subdomain: string; hasToken: boolean };
/** 固定地址（命名隧道）：推荐方式。地址永远不变，二维码直接指向它，不需要 Rendezvous，也不受临时隧道 429 限流影响。 */
function NamedTunnelSection({ defaultZone, hasToken }: { defaultZone: string; hasToken: boolean }) {
	const steps = useStore((s) => s.tunnelSteps);
	const [info, setInfo] = useState<NamedInfo | null>(null);
	const [zone, setZone] = useState("");
	const [sub, setSub] = useState("pi");
	const [token, setToken] = useState("");
	const [check, setCheck] = useState<PermCheck | null>(null);
	const [busy, setBusy] = useState<"" | "check" | "setup" | "remove">("");
	const [err, setErr] = useState("");
	const load = () =>
		api<NamedInfo>("/api/remote/named").then((r) => {
			setInfo(r);
			setZone((z) => z || r.config?.zone || r.zone || defaultZone || "");
			setSub(r.config?.subdomain || r.subdomain || "pi");
		});
	useEffect(() => {
		void load();
	}, [defaultZone]);
	const run = async (kind: "check" | "setup" | "remove", fn: () => Promise<unknown>) => {
		setBusy(kind);
		setErr("");
		try {
			await fn();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};
	const doCheck = () => run("check", async () => setCheck(await api<PermCheck>("/api/remote/named/check", { method: "POST", json: { zone, token: token || undefined } })));
	const doSetup = () =>
		run("setup", async () => {
			useStore.setState({ tunnelSteps: [] });
			await api("/api/remote/named", { method: "POST", json: { zone, subdomain: sub, token: token || undefined } });
			setToken("");
			setCheck(null);
			await load();
		});
	const doRemove = () => {
		if (!confirm("删除固定地址？会删除 Cloudflare 里的隧道和这条 DNS 记录，之后改用临时地址。已配对的手机需要重新扫码。")) return;
		void run("remove", async () => (await api("/api/remote/named", { method: "DELETE" }), await load()));
	};
	const tokenKnown = hasToken || info?.hasToken;
	const perm = (ok: boolean | null, label: string) => (
		<li className="flex items-center gap-2">
			{ok === true ? <CheckCircle2 size={14} className="text-emerald-500" /> : ok === false ? <XCircle size={14} className="text-red-500" /> : <Info size={14} className="text-zinc-400" />}
			{label}
		</li>
	);
	return (
		<section className="space-y-4" data-testid="named-tunnel">
			<H desc="推荐。在你自己的 Cloudflare 账号里建一条专属隧道，手机访问地址永远不变（例如 https://pi.example.com），扫一次码长期可用；不需要上面的临时链接，也不会遇到临时隧道的 429 限流。只要你开启了远程访问并且 Token 权限足够，会自动优先使用。">
				固定地址（推荐）
			</H>
			{info?.config ? (
				<div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
					<CheckCircle2 size={16} className="text-emerald-600" /> 已设置：
					<a className="font-medium text-accent" href={`https://${info.config.hostname}`} target="_blank" rel="noreferrer">
						https://{info.config.hostname}
					</a>
					<span className="text-xs text-zinc-500">隧道 {info.config.tunnelName}</span>
					<Button size="sm" variant="ghost" className="ml-auto text-red-600" disabled={!!busy} onClick={doRemove}>
						{busy === "remove" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} 删除
					</Button>
				</div>
			) : (
				<>
					<div className="grid gap-3 sm:grid-cols-2">
						<label className="space-y-1">
							<span className="text-xs font-medium text-zinc-500">你的域名（已托管在 Cloudflare）</span>
							<Input placeholder="example.com" value={zone} onChange={(e) => setZone(e.target.value)} />
						</label>
						<label className="space-y-1">
							<span className="text-xs font-medium text-zinc-500">子域名</span>
							<div className="flex items-center gap-1.5">
								<Input value={sub} onChange={(e) => setSub(e.target.value)} />
								<span className="shrink-0 text-xs text-zinc-400">.{zone || "example.com"}</span>
							</div>
						</label>
					</div>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-zinc-500">Cloudflare API Token</span>
						<Input type="password" autoComplete="off" placeholder={tokenKnown ? "已加密保存在本机（与远程入口共用），留空则沿用" : "在 Cloudflare 控制台 → 我的个人资料 → API 令牌 创建"} value={token} onChange={(e) => setToken(e.target.value)} />
					</label>
					<div className="rounded-xl bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300">
						<div className="mb-1 font-medium">Token 需要这些权限（可以在已有 Token 上「编辑」添加，Token 字符串不变）：</div>
						<ul className="space-y-0.5">
							{perm(check ? check.tunnelEdit ?? (check.tunnelRead ? null : false) : null, "账户 › Cloudflare Tunnel › 编辑（Account › Cloudflare Tunnel › Edit）")}
							{perm(check ? check.dnsRead : null, "区域 › DNS › 编辑（Zone › DNS › Edit）—— 区域资源选你的域名")}
							{perm(check ? check.zoneRead : null, "区域 › 区域 › 读取（Zone › Zone › Read）——「编辑 Cloudflare Workers」模板已包含")}
						</ul>
						<div className="mt-1.5 text-zinc-500">注意：「编辑 Cloudflare Workers」模板默认不含前两项。检查权限时会临时创建并立即删除一个测试隧道。</div>
					</div>
					{check && <div className={cx("text-sm", check.ok ? "text-emerald-600" : "text-amber-600")}>{check.ok ? "权限齐全，可以创建固定地址。" : check.hint}</div>}
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="outline" disabled={!!busy || !zone || (!token && !tokenKnown)} onClick={doCheck}>
							{busy === "check" && <Loader2 size={14} className="animate-spin" />} 检查权限
						</Button>
						<Button variant="primary" disabled={!!busy || !zone || !sub || (!token && !tokenKnown)} onClick={doSetup}>
							{busy === "setup" && <Loader2 size={14} className="animate-spin" />} 创建固定地址
						</Button>
					</div>
				</>
			)}
			{err && <div className="text-sm text-red-600">{err}</div>}
			{steps.length > 0 && !info?.config && (
				<ul className="space-y-1 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
					{steps.map((x) => (
						<li key={x.step} className="flex items-start gap-2">
							{x.state === "running" ? <Loader2 size={15} className="mt-0.5 animate-spin text-accent" /> : x.state === "ok" ? <CheckCircle2 size={15} className="mt-0.5 text-emerald-500" /> : <XCircle size={15} className="mt-0.5 text-red-500" />}
							<span>
								{x.step}
								{x.detail && <span className="ml-1.5 break-all text-xs text-zinc-500">{x.detail}</span>}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function AppearanceTab() {
	const { theme, accent, skin } = useStore();
	const def = getTheme(skin);
	const sysDark = matchMedia("(prefers-color-scheme: dark)").matches;
	const mode: Mode = theme === "system" ? (sysDark ? "dark" : "light") : theme;
	return (
		<div className="space-y-6">
			<section>
				<H>主题</H>
				<div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="主题">
					{THEMES.map((th) => (
						<button
							key={th.id}
							role="radio"
							aria-checked={th.id === skin}
							aria-label={th.name}
							data-theme-id={th.id}
							onClick={() => setAppearance({ skin: th.id })}
							className={cx("group rounded-2xl border p-2 text-left transition", th.id === skin ? "border-accent ring-2 ring-accent/30" : "border-line hover:border-zinc-400")}
						>
							<ThemePreview theme={th} mode={mode} accent={th.id === skin ? accent || undefined : undefined} />
							<div className="flex items-center gap-2 px-1.5 pt-2">
								<span className="font-medium">{th.name}</span>
								<span className="text-xs text-mut2">{th.id}</span>
								{th.id === skin && <Check size={15} className="ml-auto text-accent" />}
							</div>
							<div className="px-1.5 pb-1 text-xs text-mut">{th.tagline}</div>
						</button>
					))}
				</div>
			</section>
			<section>
				<H>明暗</H>
				<div className="flex flex-wrap gap-2">
					{(
						[
							["light", "浅色", Sun],
							["dark", "深色", Moon],
							["system", "跟随系统", Monitor],
						] as const
					).map(([k, label, Icon]) => (
						<Button key={k} variant={theme === k ? "primary" : "outline"} onClick={() => setAppearance({ theme: k })}>
							<Icon size={15} /> {label}
						</Button>
					))}
				</div>
			</section>
			<section>
				<H>强调色</H>
				<div className="flex flex-wrap items-center gap-2">
					<button onClick={() => setAppearance({ accent: "" })} className={cx("h-8 rounded-full border px-3 text-xs transition", !accent ? "border-accent text-accent" : "border-line text-mut hover:border-zinc-400")} aria-label="主题默认">
						<span className="mr-1.5 inline-block h-3 w-3 rounded-full align-[-2px]" style={{ background: def.accent[mode] }} />
						主题默认
					</button>
					{def.accents.map((c) => (
						<button key={c} onClick={() => setAppearance({ accent: c })} className={cx("h-8 w-8 rounded-full border border-black/10 ring-offset-2 ring-offset-[var(--card)] dark:border-white/25", c === accent && "ring-2 ring-zinc-400")} style={{ background: c }} aria-label={c} />
					))}
				</div>
				<p className="mt-2 text-xs text-mut2">主题、明暗与强调色只保存在这台设备上（每台手机/电脑可以不同）。</p>
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
