/**
 * 设置 › 助理电脑（DESIGN §15.2）：「给助理安装电脑」开关、运行方式（自带运行时 / 已装的 Docker）、
 * 空闲自动关机、镜像加速、下载进度；关掉后可关机或删除虚拟机和镜像释放空间。
 * 共用电脑（§15.4）：默认所有助理共用一台；列出每个助理用哪台电脑，可以单独开 / 关、把单独电脑合并进共用电脑。
 */
import { Loader2, Power, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";
import { AgentComputer } from "./AgentComputer";
import { FastComputerSettingsSection } from "./FastComputerSettings";
import { Avatar, avatarText, Badge, Button, Help, Input, Select, useConfirm } from "./ui";

type ResourceNums = { cpus?: number; memoryGiB?: number; diskGiB?: number };

export type DesktopGlobal = {
	settings: { enabled: boolean; backend: "auto" | "docker"; idleMinutes: number; mirror: string; fileMirror: string; separate?: string[]; resources?: ResourceNums };
	backend: { id: string; label: string; ok: boolean | null; reason?: string; fix?: "install-wsl" | "reboot" };
	builtin: { id: string; label: string; ready: boolean };
	dockerAvailable: boolean;
	image: { ref: string; version: string; digest: string | null; downloadBytes: number; diskBytes: number; custom: boolean };
	installed: boolean;
	install: { phase: "idle" | "downloading" | "done" | "error"; progress: number; layersDone: number; layersTotal: number; error?: string; detail?: string };
	/** 自带虚拟机 / 发行版（macOS Lima、Windows WSL）状态；其他情况为 null */
	vm: { phase: string; detail?: string; running: boolean } | null;
	/** 虚拟机资源：能不能调、用户选择、建议值、可调范围、现有实例实际值 */
	resources: {
		supported: boolean;
		choice: ResourceNums;
		suggested: { cpus: number; memoryGiB: number; diskGiB: number };
		bounds: { cpus: { min: number; max: number }; memoryGiB: { min: number; max: number }; diskGiB: { min: number; max: number } };
		applied: ResourceNums | null;
		note: string | null;
	};
	/** Windows：正在安装 WSL（等 UAC / 安装中） */
	wslInstalling?: boolean;
};
const GB = (n: number) => `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, "")} GB`;

export function useDesktopGlobal() {
	const [g, setG] = useState<DesktopGlobal | null>(null);
	const [loadErr, setLoadErr] = useState("");
	const [loading, setLoading] = useState(true);
	const ver = useStore((s) => s.desktopVersion);
	// 只让最后一次请求落地：旧请求迟到 / 组件卸载后不再覆盖当前数据
	const seq = useRef(0);
	const load = async () => {
		const my = ++seq.current;
		try {
			const r = await api<DesktopGlobal>("/api/desktop");
			if (my !== seq.current) return;
			setG(r);
			setLoadErr("");
		} catch (e) {
			if (my !== seq.current) return;
			setLoadErr(e instanceof Error ? e.message : String(e));
		} finally {
			if (my === seq.current) setLoading(false);
		}
	};
	useEffect(() => {
		void load();
		return () => {
			seq.current++;
		};
	}, [ver]);
	// 下载中每秒刷新进度
	useEffect(() => {
		if (g?.install.phase !== "downloading") return;
		const i = setInterval(() => void load(), 1000);
		return () => clearInterval(i);
	}, [g?.install.phase]);
	return { g, setG, load, loadErr, loading };
}

/** 开关旁的说明：预计下载量 / 磁盘 / 内存（向导和设置共用） */
export function DesktopCost({ image }: { image?: DesktopGlobal["image"] }) {
	return (
		<div className="text-xs text-zinc-500" data-testid="desktop-cost">
			{t("预计下载 ≈{d}，磁盘占用 ≈{disk}，运行时内存 3–4 GB。开启前什么都不会下载。", { d: GB(image?.downloadBytes ?? 1.5e9), disk: GB(image?.diskBytes ?? 5e9) })}
		</div>
	);
}

export function DesktopSettings() {
	const { g, setG, load, loadErr, loading } = useDesktopGlobal();
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState("");
	const [mirror, setMirror] = useState<string | null>(null);
	const [fileMirror, setFileMirror] = useState<string | null>(null);
	const [offered, setOffered] = useState(false);
	const [wslMsg, setWslMsg] = useState("");
	const [confirmDlg, askConfirm] = useConfirm();
	const purgeRef = useRef(false);
	// 下载源（镜像加速）属于高级设置，默认收起；有自定义值 / 下载或保存失败时自动展开，方便发现
	const [dlOpen, setDlOpen] = useState(false);
	useEffect(() => {
		if (g?.settings.mirror || g?.settings.fileMirror || g?.install.phase === "error" || err) setDlOpen(true);
	}, [g?.settings.mirror, g?.settings.fileMirror, g?.install.phase, err]);
	if (!g) {
		if (loading) return <div className="text-sm text-zinc-500" data-testid="desktop-loading">{t("正在载入…")}</div>;
		return (
			<div className="space-y-2 text-sm" data-testid="desktop-load-error">
				<div className="text-red-600">{t("载入失败：")}{loadErr || t("无法连接本机服务")}</div>
				<Button size="sm" variant="outline" onClick={() => void load()} data-testid="desktop-retry">
					<RefreshCw size={13} /> {t("重试")}
				</Button>
			</div>
		);
	}
	/** Windows：一键安装 WSL（服务端用 UAC 提权执行 wsl --install --no-distribution） */
	const installWsl = async () => {
		setBusy("wsl");
		setWslMsg(t("请在弹出的“用户账户控制”窗口里点“是”…"));
		try {
			const r = await api<{ ok: boolean; reboot: boolean; message: string; desktop: DesktopGlobal }>("/api/desktop/wsl/install", { method: "POST" });
			setWslMsg(t(r.message));
			setG(r.desktop);
		} catch (e) {
			setWslMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};
	const s = g.settings;
	const put = async (b: Partial<DesktopGlobal["settings"]>) => {
		setErr("");
		try {
			const r = await api<DesktopGlobal>("/api/desktop", { method: "PUT", json: b });
			setG(r);
			return r;
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	};
	const post = async (path: string, label: string) => {
		setBusy(label);
		setErr("");
		try {
			setG(await api<DesktopGlobal>(`/api/desktop/${path}`, { method: "POST" }));
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};
	const toggle = async (on: boolean) => {
		const r = await put({ enabled: on });
		if (r && !on) setOffered(true);
	};
	const purge = async () => {
		if (purgeRef.current) return;
		const ok = await askConfirm({ title: t("删除助理电脑的虚拟机和镜像？"), body: t("删除后助理电脑里的登录状态（微信、各网站账号）都会清掉，下次开启要重新下载。"), ok: t("删除"), danger: true });
		if (!ok || purgeRef.current) return;
		purgeRef.current = true;
		try {
			await post("purge", "purge");
			setOffered(false);
		} finally {
			purgeRef.current = false;
		}
	};
	const ins = g.install;
	return (
		<div className="space-y-6" data-testid="desktop-settings">
			{confirmDlg}
			{loadErr && <div className="text-xs text-amber-600" data-testid="desktop-refresh-error">{t("刷新失败：{e}（下面显示的是上次的数据）", { e: loadErr })}</div>}
			<section className="space-y-2">
				<div className="mb-3">
					<div className="font-semibold">{t("给助理安装电脑")}</div>
					<div className="mt-0.5 text-sm text-zinc-500">{t("每个助理一台自己的桌面电脑。")} <Help>{t("每个助理一台自己的 Linux 桌面电脑（浏览器、微信等应用），登录状态长期保留，你可以在「电脑」标签里随时看它的屏幕、接管操作。不开启时助理照常聊天，浏览器自动化在本机独立的浏览器里进行。")}</Help></div>
				</div>
				<label className="flex items-start gap-3 rounded-xl border border-line p-3">
					<input type="checkbox" className="mt-1 accent-[var(--acc)]" checked={s.enabled} onChange={(e) => void toggle(e.target.checked)} data-testid="desktop-enabled" />
					<span className="space-y-1">
						<span className="flex items-center gap-2 font-medium">
							{t("给助理安装电脑")}
							{s.enabled ? g.installed ? <Badge tone="green">{t("已安装")}</Badge> : ins.phase === "downloading" ? <Badge tone="accent">{t("下载中")}</Badge> : <Badge tone="amber">{t("未下载")}</Badge> : <Badge>{t("未安装")}</Badge>}
						</span>
						<DesktopCost image={g.image} />
					</span>
				</label>
				{s.enabled && ins.phase === "downloading" && (
					<div className="space-y-1" data-testid="desktop-download">
						<div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
							<div className="h-full bg-accent transition-all" style={{ width: `${Math.round(ins.progress * 100)}%` }} />
						</div>
						<div className="text-xs text-zinc-500">
							{ins.detail ? t(ins.detail) : t("正在下载助理电脑")} {Math.round(ins.progress * 100)}%{!ins.detail?.includes("虚拟机") && ins.layersTotal ? ` · ${ins.layersDone}/${ins.layersTotal}` : ""}　{t("断了会自动续传，已下载的部分不会重下。")}
						</div>
					</div>
				)}
				{s.enabled && g.backend.ok === false && (
					<div className="space-y-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200" data-testid="desktop-backend-problem">
						<div>{g.backend.reason}</div>
						{g.backend.fix === "install-wsl" && (
							<div className="flex flex-wrap items-center gap-2">
								<Button size="sm" disabled={!!busy || g.wslInstalling} onClick={() => void installWsl()} data-testid="desktop-install-wsl">
									{busy === "wsl" || g.wslInstalling ? <Loader2 size={14} className="animate-spin" /> : null} {t("安装 WSL")}
								</Button>
								<span>{t("会弹出一次管理员确认；装完可能需要重启电脑。")}</span>
							</div>
						)}
						{g.backend.fix === "reboot" && <div className="font-medium">{t("请保存好手头的工作后重启电脑，重启后回到这里继续。")}</div>}
					</div>
				)}
				{wslMsg && <div className="rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-800" data-testid="desktop-wsl-msg">{wslMsg}</div>}
				{s.enabled && ins.phase === "error" && (
					<div className="flex items-center gap-2 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
						<span className="min-w-0 flex-1 break-words">{t("下载失败：")}{ins.error}</span>
						<Button size="sm" variant="outline" onClick={() => void post("install", "install")}>{t("重试")}</Button>
					</div>
				)}
				{!s.enabled && offered && (
					<div className="space-y-2 rounded-xl border border-line p-3" data-testid="desktop-off-actions">
						<div className="text-sm">{t("助理电脑已关闭。还要做什么？")}</div>
						<div className="flex flex-wrap gap-2">
							<Button size="sm" variant="outline" disabled={!!busy} onClick={() => void post("shutdown", "shutdown")}>
								{busy === "shutdown" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />} {t("关机")}
							</Button>
							<Button size="sm" variant="danger" disabled={!!busy} onClick={() => void purge()} data-testid="desktop-purge">
								{busy === "purge" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} {t("删除虚拟机和镜像（登录状态会清掉）")}
							</Button>
						</div>
					</div>
				)}
			</section>

			<section className="space-y-2">
				<div className="font-semibold">{t("运行方式")}</div>
				<div className="space-y-1.5 text-sm">
					<label className="flex items-start gap-2">
						<input type="radio" name="desk-backend" className="mt-1" checked={s.backend === "auto"} onChange={() => void put({ backend: "auto" })} />
						<span>
							{t("自带运行时（推荐）")}
							<span className="block text-xs text-zinc-500">
								{g.builtin.ready ? g.builtin.label : t("{label}正在开发中，暂时使用本机已装的 Docker", { label: g.builtin.label })}
							</span>
						</span>
					</label>
					{g.vm && s.backend === "auto" && s.enabled && (
						<div className="ml-6 text-xs text-zinc-500" data-testid="desktop-vm-state">
							{t("虚拟机：")}
							{g.vm.phase === "creating" || g.vm.phase === "booting" ? t(g.vm.detail ?? "正在启动") : g.vm.phase === "stopping" ? t("正在关机") : g.vm.running ? t("运行中") : t("已关机")}
							{g.vm.phase === "error" && g.vm.detail ? ` · ${g.vm.detail}` : ""}
						</div>
					)}
					<label className="flex items-start gap-2">
						<input type="radio" name="desk-backend" className="mt-1" checked={s.backend === "docker"} onChange={() => void put({ backend: "docker" })} data-testid="desktop-backend-docker" />
						<span>
							{t("使用已安装的 Docker")}
							<span className="block text-xs text-zinc-500">{g.dockerAvailable ? t("检测到本机 Docker / Podman") : t("没有检测到 Docker / Podman")}</span>
						</span>
					</label>
				</div>
			</section>

			{s.enabled && <SharedComputerSection />}

			<SandboxComputerSettings />

			<section className="space-y-2">
				<div className="font-semibold">{t("空闲自动关机")}</div>
				<div className="text-sm text-zinc-500">{t("闲置多久后关机，登录状态不丢。")} <Help>{t("没有工具调用、没人在看画面、没有任务占用超过这个时间，就自动关机释放内存；登录状态不会丢，下次用到时自动开机。")}</Help></div>
				<Select
					value={s.idleMinutes}
					ariaLabel={t("空闲自动关机")}
					testId="desktop-idle"
					className="w-36"
					onChange={(v) => void put({ idleMinutes: Number(v) })}
					options={[5, 10, 30, 0].map((m) => ({ value: m, label: m ? t("{m} 分钟", { m }) : t("从不") }))}
				/>
			</section>

			{s.enabled && <VmResources g={g} put={put} />}

			<section className="space-y-2" data-testid="desktop-fast-computer">
				<div className="font-semibold">{t("快速操作模型")}</div>
				<div className="text-sm text-zinc-500">{t("助理操作这台电脑（虚拟机）时，可选让一个快速模型帮忙挑控件。只影响这台助理电脑。")}</div>
				<FastComputerSettingsSection scope="computer" />
				<p className="text-xs text-zinc-500">
					本地快速操作模型（Laya）不是语音识别；安装只有一份、两台电脑共用，在「操作这台电脑」里管理。
					<button type="button" className="ml-1 text-accent underline" onClick={() => useStore.getState().set({ settings: "host" })} data-testid="desktop-laya-link">
						去安装 / 查看
					</button>
				</p>
			</section>

			<details className="rounded-xl border border-line" open={dlOpen} onToggle={(e) => setDlOpen(e.currentTarget.open)} data-testid="desktop-download-source">
				<summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
					{t("下载来源")} <span className="ml-1 text-xs font-normal text-zinc-500">{t("国内下载慢时可改（高级）")}</span>
				</summary>
				<div className="space-y-4 px-3 pb-3">
					<section className="space-y-2">
						<div className="font-semibold">{t("镜像下载地址")}</div>
						<div className="text-sm text-zinc-500">{t("国内下载慢时可以填加速地址（替换 ghcr.io），例如 ghcr.nju.edu.cn。下载内容按固定版本校验，换地址不影响安全。")}</div>
						<div className="flex gap-2">
							<Input value={mirror ?? s.mirror} placeholder="ghcr.io" onChange={(e) => setMirror(e.target.value)} data-testid="desktop-mirror" />
							<Button variant="outline" disabled={mirror === null || mirror === s.mirror} onClick={() => void put({ mirror: mirror ?? "" }).then((r) => r && setMirror(null))}>{t("保存")}</Button>
						</div>
						<div className="break-all text-xs text-zinc-400">{g.image.ref}{g.image.custom ? `（${t("自定义镜像")}）` : ""}</div>
					</section>
					{(g.builtin.id === "lima" || g.builtin.id === "wsl") && (
						<section className="space-y-2">
							<div className="font-semibold">{t("虚拟机组件下载加速")}</div>
							<div className="text-sm text-zinc-500">{t("从 GitHub 下载运行时组件慢时填加速前缀，例如 https://ghfast.top/ 。文件按固定摘要校验，加速失败会自动回到官方地址。")}</div>
							<div className="flex gap-2">
								<Input value={fileMirror ?? s.fileMirror} placeholder={t("留空 = 直连 GitHub")} onChange={(e) => setFileMirror(e.target.value)} data-testid="desktop-file-mirror" />
								<Button variant="outline" disabled={fileMirror === null || fileMirror === s.fileMirror} onClick={() => void put({ fileMirror: fileMirror ?? "" }).then((r) => r && setFileMirror(null))}>{t("保存")}</Button>
							</div>
						</section>
					)}
				</div>
			</details>
			{err && <div className="text-xs text-red-600">{err}</div>}
		</div>
	);
}

/** 共用电脑：说明 + 每个助理用哪台电脑 */
function VmResources({ g, put }: { g: DesktopGlobal; put: (b: Partial<DesktopGlobal["settings"]>) => Promise<DesktopGlobal | undefined> }) {
	const r = g.resources;
	if (!r.supported) {
		return (
			<section className="space-y-2" data-testid="desktop-resources">
				<div className="font-semibold">{t("虚拟机资源")}</div>
				<div className="text-sm text-zinc-500" data-testid="desktop-resources-note">{r.note}</div>
			</section>
		);
	}
	const eff = {
		cpus: r.choice.cpus ?? r.applied?.cpus ?? r.suggested.cpus,
		memoryGiB: r.choice.memoryGiB ?? r.applied?.memoryGiB ?? r.suggested.memoryGiB,
		diskGiB: r.choice.diskGiB ?? r.applied?.diskGiB ?? r.suggested.diskGiB,
	};
	const diskMin = Math.max(r.bounds.diskGiB.min, r.applied?.diskGiB ?? 0);
	// 现有虚拟机可能带着超出「按当前宿主收窄后范围」的值（换机器 / 旧环境变量）：一定要能显示和保留，不能空白
	const nums = (lo: number, hi: number, cur: number) => [...new Set([...Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i), cur].filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
	const diskOpts = [...new Set([...([diskMin, 40, 60, 80, 100, 128, 160, 200, 256].filter((n) => n >= diskMin && n <= r.bounds.diskGiB.max)), eff.diskGiB])].sort((a, b) => a - b);
	const set = (patch: Partial<typeof eff>) => void put({ resources: { ...eff, ...patch } });
	const changed = !!r.applied && (r.applied.cpus !== eff.cpus || r.applied.memoryGiB !== eff.memoryGiB || r.applied.diskGiB !== eff.diskGiB);
	return (
		<section className="space-y-3" data-testid="desktop-resources">
			<div>
				<div className="font-semibold">{t("虚拟机资源")}</div>
				<div className="mt-0.5 text-sm text-zinc-500">
					{t("给助理电脑分配多少 CPU、内存和磁盘。")} <Help>{t("改动在虚拟机关机后生效，不会打断正在跑的任务。磁盘是稀疏分配，这里填的是上限，用多少占多少；磁盘只能扩大，不能缩小。内存上限按这台电脑的实际内存算，不会把整台机器占满。")}</Help>
				</div>
			</div>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<label className="space-y-1 text-sm">
					<span className="text-zinc-500">{t("CPU 核数")}</span>
					<Select value={eff.cpus} ariaLabel={t("CPU 核数")} testId="desktop-cpus" className="w-full" options={nums(r.bounds.cpus.min, r.bounds.cpus.max, eff.cpus).map((n) => ({ value: n, label: String(n) }))} onChange={(v) => set({ cpus: Number(v) })} />
				</label>
				<label className="space-y-1 text-sm">
					<span className="text-zinc-500">{t("内存")}</span>
					<Select value={eff.memoryGiB} ariaLabel={t("内存")} testId="desktop-memory" className="w-full" options={nums(r.bounds.memoryGiB.min, r.bounds.memoryGiB.max, eff.memoryGiB).map((n) => ({ value: n, label: String(n), hint: "GiB" }))} onChange={(v) => set({ memoryGiB: Number(v) })} />
				</label>
				<label className="space-y-1 text-sm">
					<span className="text-zinc-500">{t("磁盘")}</span>
					<Select value={eff.diskGiB} ariaLabel={t("磁盘")} testId="desktop-disk" className="w-full" options={diskOpts.map((n) => ({ value: n, label: String(n), hint: "GiB" }))} onChange={(v) => set({ diskGiB: Number(v) })} />
				</label>
			</div>
			<div className="text-xs text-zinc-500" data-testid="desktop-resources-state">
				{t("当前虚拟机：{c} 核 / {m} GiB 内存 / {d} GiB 磁盘（上限）。", { c: r.applied?.cpus ?? eff.cpus, m: r.applied?.memoryGiB ?? eff.memoryGiB, d: r.applied?.diskGiB ?? eff.diskGiB })}
				{changed ? ` ${t("有改动，关机后生效（磁盘只扩不缩）。")}` : ""}
			</div>
		</section>
	);
}

/** 共用电脑：说明 + 每个助理用哪台电脑 */
function SharedComputerSection() {
	const agents = useStore((st) => st.agents);
	return (
		<section className="space-y-2" data-testid="desktop-shared">
			<div className="font-semibold">{t("共用电脑")}</div>
			<div className="text-sm text-zinc-500">
				{t("所有助理默认共用一台电脑：同样的文件、浏览器登录状态（在一个助理里登录过，其他助理也能用）和已装的应用。")}{" "}
				<Help>{t("每个助理有自己的屏幕和浏览器标签页，同时干活不互相抢鼠标键盘；需要时助理会自己开一块屏幕，或者开一个不带登录状态的浏览器环境。需要长期分开账号的助理，可以给它开“单独的电脑”。")}</Help>
			</div>
			<div className="divide-y divide-line rounded-xl border border-line">
				{agents.map((a) => (
					<div key={a.id} className="flex items-start gap-3 p-3" data-testid={`desktop-agent-${a.id}`}>
						<Avatar agentId={a.id} text={avatarText(a.avatar)} color={a.color} size={28} />
						<div className="min-w-0 flex-1">
							<div className="text-sm font-medium">{a.name}</div>
							<AgentComputer agentId={a.id} compact />
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

/**
 * 助理自己的电脑（Docker 桌面）：默认完全权限，不逐项审批。
 * 属于「助理电脑」页（与操作用户自己的电脑分开），服务端 `sandboxComputer` 语义不变。
 */
function SandboxComputerSettings() {
	const v = useStore((s) => s.hostVersion);
	const [a, setA] = useState<"all" | "sensitive" | "none" | null>(null);
	useEffect(() => void api("/api/sandbox-computer").then((r) => setA(r.approvals)), [v]);
	if (!a) return null;
	const set = (approvals: "all" | "sensitive" | "none") => api("/api/sandbox-computer", { method: "PUT", json: { approvals } }).then((r) => setA(r.approvals));
	return (
		<section className="space-y-2 rounded-xl bg-hover p-4 text-sm" data-testid="sandbox-approvals">
			<div className="font-semibold">助理自己的电脑</div>
			<p className="text-mut">助理自己的隔离电脑，默认完全权限。 <Help>如果它登录了你在意的账号（比如它的微信、邮箱），可以要求它在关键动作前先问你。一键暂停始终有效（在助理的「电脑」页）。</Help></p>
			<label className="flex items-center gap-2">
				<input type="radio" checked={a === "none"} onChange={() => set("none")} /> 完全权限，不用问我（默认）
			</label>
			<label className="flex items-center gap-2">
				<input type="radio" checked={a === "sensitive"} onChange={() => set("sensitive")} /> 发送 / 付款 / 删除类动作先问我
			</label>
			<label className="flex items-center gap-2">
				<input type="radio" checked={a === "all"} onChange={() => set("all")} /> 每个动作都先问我
			</label>
		</section>
	);
}
