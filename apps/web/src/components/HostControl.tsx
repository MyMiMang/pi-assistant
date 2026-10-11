import { AlertTriangle, ChevronDown, Hand, Loader2, Pause, Play, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Badge, Button, cx, Input, avatarText } from "./ui";
import { ActionLog } from "./ActionLog";

/** 与服务端 host-control.ts 的 FULL_CONFIRM 一致 */
export const FULL_CONFIRM = "我了解风险，允许完全控制这台电脑";
export type Tier = "observe" | "bounded" | "trusted" | "full";
export const TIER_INFO: Record<Tier, { label: string; desc: string; tone: string }> = {
	observe: { label: "只看", desc: "截图、读取窗口内容，不能点击或输入", tone: "zinc" },
	bounded: { label: "限定", desc: "只能操作勾选的应用，每个动作都问你（默认）", tone: "green" },
	trusted: { label: "信任", desc: "所有应用；日常动作不问，发送 / 付款 / 删除 / 提交仍要问", tone: "amber" },
	full: { label: "完全权限", desc: "几乎不问（受保护的操作仍要问）；需要输入确认语", tone: "red" },
};
const TIER_ORDER: Tier[] = ["observe", "bounded", "trusted", "full"];

interface HostApp {
	name: string;
	id: string;
}
interface HostInfo {
	settings: { enabled: boolean; agents: "all" | string[]; apps: HostApp[]; workspaceFiles: boolean; approvedHash?: string; tiers: Record<string, Tier>; defaultTier: Tier };
	tiers: Record<string, Tier>;
	status: { enabled: boolean; tiers: Record<string, Tier>; paused: boolean; daemon: { state: string; detail: string }; platform: string; installed: boolean; version: string };
	manifest: string;
	manifestHash: string;
	permissions: { accessibility: string; screenRecording: string } | null;
}

export function useHostControl() {
	const v = useStore((s) => s.hostVersion);
	const [d, setD] = useState<HostInfo | null>(null);
	const load = () => api("/api/host-control").then(setD).catch(() => {});
	useEffect(() => void load(), [v]);
	return { d, load };
}

/** 聊天顶部：允许操作这台电脑时的醒目提示 + 一键暂停（电脑和手机都能点） */
export function HostControlBar() {
	const { d, load } = useHostControl();
	if (!d?.status.enabled) return null;
	const paused = d.status.paused;
	const toggle = async () => {
		await api("/api/host-control/pause", { method: "POST", json: { paused: !paused } });
		void load();
	};
	return (
		<div className={cx("pa-hostbar", paused && "paused")} data-testid="host-bar">
			<Hand className="pa-ic" />
			<span className="min-w-0 flex-1 truncate">
				{paused ? "已暂停操作你的电脑" : `助理可以操作你的电脑：${barText(d)}`}
			</span>
			<button className="pa-btn sm" onClick={toggle} data-testid="host-pause">
				{paused ? <Play className="pa-ic" /> : <Pause className="pa-ic" />}
				{paused ? "继续" : "暂停"}
			</button>
		</div>
	);
}

function barText(d: HostInfo) {
	const agents = useStore.getState().agents;
	const by = new Map<Tier, string[]>();
	for (const [id, t] of Object.entries(d.status.tiers ?? {})) by.set(t, [...(by.get(t) ?? []), agents.find((a) => a.id === id)?.name ?? id]);
	return TIER_ORDER.filter((t) => by.has(t)).map((t) => `${TIER_INFO[t].label}（${by.get(t)!.join("、")}）`).join("；") || "没有允许的助理";
}

const PERM: Record<string, string> = { granted: "已授权", denied: "未授权", unknown: "未知" };

/** 设置 › 操作这台电脑 */
export function HostControlSettings() {
	const { d, load } = useHostControl();
	const agents = useStore((s) => s.agents);
	const [apps, setApps] = useState<HostApp[] | null>(null);
	const [scope, setScope] = useState<"all" | string[]>("all");
	const [files, setFiles] = useState(true);
	const [ack, setAck] = useState(false);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [suggest, setSuggest] = useState<HostApp[] | null>(null);
	const [custom, setCustom] = useState({ name: "", id: "" });
	const [preview, setPreview] = useState<{ yaml: string; hash: string } | null>(null);
	const [defaultTier, setDefaultTier] = useState<Tier>("bounded");
	const [confirmText, setConfirmText] = useState("");
	useEffect(() => {
		if (d && apps === null) {
			setDefaultTier(d.settings.defaultTier ?? "bounded");
			setApps(d.settings.apps);
			setScope(d.settings.agents);
			setFiles(d.settings.workspaceFiles);
		}
	}, [d]);
	if (!d || !apps) return null;
	const mac = d.status.platform === "darwin";
	const win = d.status.platform === "win32";
	const on = d.status.enabled;
	const allowedIds = scope === "all" ? agents.map((a) => a.id) : scope;
	const tierOf = (id: string): Tier => d.tiers?.[id] ?? d.settings.defaultTier ?? "bounded";
	const anyBounded = defaultTier === "bounded" || allowedIds.some((id) => tierOf(id) === "bounded");
	const anyFull = defaultTier === "full" || allowedIds.some((id) => tierOf(id) === "full");
	const save = async (enabled: boolean, hash?: string) => {
		setBusy(true);
		setMsg(null);
		try {
			const r = await api("/api/host-control", { method: "PUT", json: { enabled, agents: scope, apps, workspaceFiles: files, acknowledged: ack, manifestHash: hash, defaultTier, confirmText } });
			if (r.ok === false) setMsg({ ok: false, text: r.error });
			else setMsg({ ok: true, text: enabled ? "已开启：按各助理的档位操作你的电脑，受保护的操作一律先问你，随时可以一键暂停" : "已关闭" });
			setConfirmText("");
			setPreview(null);
			await load();
		} catch (e) {
			setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
		} finally {
			setBusy(false);
		}
	};
	/** 先保存草稿（关闭状态）拿到对应的清单给用户审阅，确认后再开启 */
	const review = async () => {
		setBusy(true);
		try {
			const r = await api("/api/host-control", { method: "PUT", json: { enabled: false, agents: scope, apps, workspaceFiles: files, defaultTier } });
			const j = (await api("/api/host-control")) as HostInfo;
			setPreview({ yaml: j.manifest, hash: r.manifestHash ?? j.manifestHash });
			void load();
		} finally {
			setBusy(false);
		}
	};
	const add = (a: HostApp) => !apps.some((x) => x.id === a.id) && setApps([...apps, a]);
	return (
		<div className="space-y-5" data-testid="host-settings">
			<div className="rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
				<div className="mb-1 flex items-center gap-2 font-semibold">
					<AlertTriangle size={16} /> 让助理操作你自己的电脑
				</div>
				助理会像人一样在<b>你的电脑</b>上点击、输入、打开应用。默认关闭。开启后：
				<ul className="mt-1 list-disc pl-5">
					<li>只能操作下面<b>你勾选的应用</b>（由 Cua Driver 的 bounded 模式强制，清单之外直接拒绝）；看不到整个屏幕，也碰不到其他窗口。</li>
					<li><b>每个动作都会先问你</b>（可选“本任务内都允许”）；电脑和手机上都能随时一键暂停。</li>
					<li>操作期间请不要同时使用鼠标键盘；网页上的事情更推荐让助理用它自己的浏览器 / 电脑完成。</li>
					<li>助理可能被网页或文档里的恶意内容误导，请只允许你信任的应用，不要允许网银、密码管理器等。</li>
				</ul>
			</div>

			<section>
				<div className="mb-2 flex items-center gap-2 font-semibold">
					状态 <Badge tone={on ? (d.status.paused ? "amber" : "green") : "zinc"}>{on ? (d.status.paused ? "已暂停" : d.status.daemon.state === "running" ? "运行中" : d.status.daemon.detail) : "未开启"}</Badge>
				</div>
				<div className="text-xs text-mut">
					Cua Driver {d.status.version}（MIT，按固定版本下载并校验 SHA256）{d.status.installed ? "· 已安装" : "· 开启时自动下载"} · {d.status.daemon.detail}
				</div>
				{on && (
					<div className="mt-2 flex gap-2">
						<Button size="sm" onClick={() => api("/api/host-control/pause", { method: "POST", json: { paused: !d.status.paused } }).then(load)}>
							{d.status.paused ? <Play size={14} /> : <Pause size={14} />} {d.status.paused ? "继续" : "一键暂停"}
						</Button>
						<Button size="sm" variant="danger" disabled={busy} onClick={() => save(false)}>
							关闭
						</Button>
					</div>
				)}
			</section>

			<section className="space-y-2" data-testid="host-tiers">
				<div className="font-semibold">新助理的默认权限</div>
				<div className="grid gap-1.5 sm:grid-cols-2">
					{TIER_ORDER.map((t) => (
						<button key={t} className={cx("rounded-xl border p-2.5 text-left text-xs text-mut transition", defaultTier === t ? (t === "full" ? "border-red-500/60 bg-red-500/10" : "border-accent bg-accent-soft") : "border-line hover:bg-hover")} onClick={() => (setDefaultTier(t), setPreview(null))} data-testid={`default-tier-${t}`}>
							<b className={cx("text-sm", t === "full" ? "text-red-600" : t === "trusted" ? "text-amber-600" : "text-fg")}>{TIER_INFO[t].label}</b>
							<div>{TIER_INFO[t].desc}</div>
						</button>
					))}
				</div>
				<p className="text-xs text-mut">每个助理的权限在输入框下方「助理电脑」旁边的 <ShieldCheck size={11} className="inline" /> 按钮里单独切换（调高需要确认）。改这里只影响之后新建的助理。</p>
				{anyFull && (
					<div className="space-y-1 rounded-xl border border-red-500/50 bg-red-500/10 p-4 text-sm leading-relaxed text-red-800 dark:text-red-300" data-testid="host-full-warning">
						<div className="flex items-center gap-2 font-semibold">
							<AlertTriangle size={16} /> {defaultTier === "full" ? "新助理默认完全权限" : "有助理是完全权限"}：助理可以做你在这台电脑上能做的几乎任何事
						</div>
						<ul className="list-disc pl-5">
							<li>能打开任何应用、读写文件、使用你已登录的账号（聊天、邮箱、网银、云盘……），Cua Driver 以 unrestricted 模式运行，没有应用清单，日常动作不再问你。</li>
							<li>网页、文档、聊天消息里的恶意内容可能诱导助理做出你不想要的操作（提示注入），后果可能无法撤回。</li>
							<li>受保护的操作（结束/卸载 Pi Assistant、关机重启、格式化、改系统设置/防火墙/账户、大范围删除、改开机启动项等）仍然每次都会问你。</li>
							<li>建议只在你在电脑旁边时使用；电脑和手机上都能一键暂停；所有动作都会记录。</li>
						</ul>
					</div>
				)}
				<p className="text-xs text-mut">无论哪个档位：受保护的操作都必须你明确批准，一键暂停始终有效，所有动作都会记录。</p>
			</section>

			{mac && (
				<section className="rounded-xl bg-hover p-3 text-sm" data-testid="host-mac-perms">
					<div className="font-semibold">macOS 权限</div>
					<p className="mt-1 text-mut">需要给 <b>CuaDriver</b> 打开“辅助功能”和“屏幕录制”：系统设置 › 隐私与安全性 › 辅助功能 / 屏幕与系统录音，打开 CuaDriver 的开关（授权归属于 CuaDriver.app，而不是终端或本应用）。点下面的按钮会弹出系统授权引导。</p>
					<div className="mt-2 flex items-center gap-3">
						<Button size="sm" onClick={() => api("/api/host-control/permissions", { method: "POST" })}>
							<ShieldCheck size={14} /> 打开授权引导
						</Button>
						{d.permissions && (
							<span className="text-xs text-mut">
								辅助功能：{PERM[d.permissions.accessibility] ?? d.permissions.accessibility} · 屏幕录制：{PERM[d.permissions.screenRecording] ?? d.permissions.screenRecording}
							</span>
						)}
					</div>
				</section>
			)}
			{win && <div className="rounded-xl bg-hover p-3 text-sm text-mut">Windows：无需额外授权。若要操作“以管理员身份运行”的程序，本应用也需要以管理员身份运行（不推荐）。</div>}

			{anyBounded && <section>
				<div className="mb-2 font-semibold">允许操作的应用（“限定”档位）</div>
				<ul className="space-y-1" data-testid="host-apps">
					{apps.map((a) => (
						<li key={a.id} className="flex items-center gap-2 rounded-lg bg-hover px-3 py-2 text-sm">
							<b>{a.name}</b>
							<code className="min-w-0 flex-1 truncate text-xs text-mut">{a.id}</code>
							<button className="pa-icon-btn ghost" aria-label={`移除 ${a.name}`} onClick={() => setApps(apps.filter((x) => x !== a))}>
								<Trash2 size={14} />
							</button>
						</li>
					))}
					{!apps.length && <li className="text-sm text-mut">还没有选择应用</li>}
				</ul>
				<div className="mt-2 flex flex-wrap gap-2">
					<Button size="sm" variant="ghost" onClick={() => api("/api/host-control/apps").then(setSuggest)}>
						从已安装的应用里选…
					</Button>
				</div>
				{suggest && (
					<div className="mt-2 flex max-h-48 flex-wrap gap-1.5 overflow-auto rounded-lg border border-line p-2">
						{suggest.length === 0 && <span className="text-xs text-mut">没有找到，可以在下面手动填写</span>}
						{suggest.map((a) => (
							<button key={a.id} className="pa-chip" onClick={() => add(a)} title={a.id}>
								<Plus className="pa-ic" />
								{a.name}
							</button>
						))}
					</div>
				)}
				<div className="mt-2 flex gap-2">
					<Input className="w-32" placeholder="名称" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
					<Input className="flex-1" placeholder={mac ? "Bundle ID，例如 com.apple.TextEdit" : win ? "完整路径，例如 C:\\Windows\\System32\\notepad.exe" : "完整路径，例如 /usr/bin/gedit"} value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value })} />
					<Button size="sm" disabled={!custom.id.trim()} onClick={() => (add({ name: custom.name || custom.id, id: custom.id.trim() }), setCustom({ name: "", id: "" }))}>
						添加
					</Button>
				</div>
			</section>}

			<section className="space-y-2 text-sm">
				<div className="font-semibold">哪些助理可以操作</div>
				<label className="flex items-center gap-2">
					<input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> 所有助理
				</label>
				<label className="flex items-center gap-2">
					<input type="radio" checked={scope !== "all"} onChange={() => setScope([])} /> 只允许：
				</label>
				{scope !== "all" && (
					<div className="flex flex-wrap gap-3 pl-6">
						{agents.map((a) => (
							<label key={a.id} className="flex items-center gap-1.5">
								<input type="checkbox" checked={scope.includes(a.id)} onChange={(e) => setScope(e.target.checked ? [...scope, a.id] : scope.filter((x) => x !== a.id))} /> {avatarText(a.avatar)} {a.name}
							</label>
						))}
					</div>
				)}
				{anyBounded && (
					<label className="flex items-center gap-2">
						<input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} /> 允许在这些应用里打开 / 保存助理工作区里的文件
					</label>
				)}
			</section>

			{!preview ? (
				<Button variant="primary" disabled={busy || (anyBounded && !apps.length)} onClick={review} data-testid="host-review">
					{busy && <Loader2 size={14} className="animate-spin" />} 查看权限清单并{on ? "更新" : "开启"}…
				</Button>
			) : (
				<section className="space-y-2" data-testid="host-manifest">
					<div className="text-sm font-semibold">权限计划（各助理档位 + “限定”档位的 Cua 能力清单）</div>
					<pre className="pa-pre max-h-64 overflow-auto text-xs">{preview.yaml}</pre>
					{anyFull && (
						<label className="block text-sm">
							请一字不差地输入「<b>{FULL_CONFIRM}</b>」以确认：
							<Input className="mt-1" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={FULL_CONFIRM} data-testid="host-confirm-text" />
						</label>
					)}
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="host-ack" />
						<span>我已阅读上面的提示和权限计划，允许助理按这些档位操作我的电脑。</span>
					</label>
					<div className="flex gap-2">
						<Button variant={anyFull ? "danger" : "primary"} disabled={busy || !ack || (anyFull && confirmText.trim() !== FULL_CONFIRM)} onClick={() => save(true, preview.hash)} data-testid="host-enable">
							{busy && <Loader2 size={14} className="animate-spin" />} {on ? "确认更新" : "确认开启"}
						</Button>
						<Button variant="ghost" onClick={() => setPreview(null)}>
							取消
						</Button>
					</div>
				</section>
			)}
			{msg && <div className={cx("text-sm", msg.ok ? "text-green-600" : "text-red-600")} data-testid="host-msg">{msg.text}</div>}

			<SandboxComputerSettings />

			<section className="space-y-2">
				<div className="font-semibold">本机操作记录</div>
				<p className="text-xs text-mut">助理在这台电脑上的每个动作（包括被拒绝、被暂停拦下的）都会记录在这里，任何模式下都记录。</p>
				<ActionLog target="host" />
			</section>
		</div>
	);
}

/** 助理自己的电脑（Docker 桌面）：默认完全权限，不逐项审批 */
function SandboxComputerSettings() {
	const v = useStore((s) => s.hostVersion);
	const [a, setA] = useState<"all" | "sensitive" | "none" | null>(null);
	useEffect(() => void api("/api/sandbox-computer").then((r) => setA(r.approvals)), [v]);
	if (!a) return null;
	const set = (approvals: "all" | "sensitive" | "none") => api("/api/sandbox-computer", { method: "PUT", json: { approvals } }).then((r) => setA(r.approvals));
	return (
		<section className="space-y-2 rounded-xl bg-hover p-4 text-sm" data-testid="sandbox-approvals">
			<div className="font-semibold">助理自己的电脑</div>
			<p className="text-mut">助理电脑是一台只属于助理的虚拟电脑（与你的电脑隔离），默认拥有完全权限。如果它登录了你在意的账号（比如它的微信、邮箱），可以要求它在关键动作前先问你。暂停和操作记录始终有效（在助理的「电脑」页）。</p>
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

/** 切换某个助理的档位：调低直接生效；调高要勾选风险，完全权限还要输入确认语 */
function TierPicker({ agentId, d, load, onDone, compact }: { agentId: string; d: HostInfo; load: () => void; onDone?: () => void; compact?: boolean }) {
	const [want, setWant] = useState<Tier | null>(null);
	const [ack, setAck] = useState(false);
	const [text, setText] = useState("");
	const [err, setErr] = useState("");
	const cur: Tier = d.tiers?.[agentId] ?? d.settings.defaultTier ?? "bounded";
	const rank = (t: Tier) => TIER_ORDER.indexOf(t);
	const apply = async (t: Tier) => {
		setErr("");
		try {
			const r = await api(`/api/host-control/tier/${agentId}`, { method: "PUT", json: { tier: t, acknowledged: ack, confirmText: text } });
			if (r.ok === false) return setErr(r.error);
			setWant(null);
			setAck(false);
			setText("");
			load();
			onDone?.();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	};
	return (
		<div className={cx("space-y-2", compact && "w-72")} data-testid="tier-picker">
			<div className={cx(compact ? "flex flex-col" : "flex flex-wrap gap-1")}>
				{TIER_ORDER.map((t) =>
					compact ? (
						<button key={t} className={cx("rounded-lg px-2.5 py-1.5 text-left hover:bg-hover", (want ?? cur) === t && "bg-hover")} onClick={() => (t === cur ? onDone?.() : rank(t) < rank(cur) ? apply(t) : (setWant(t), setAck(false)))} data-testid={`tier-${t}`}>
							<div className={cx("text-sm font-medium", t === "full" && "text-red-600", t === "trusted" && "text-amber-600")}>
								{TIER_INFO[t].label} {t === cur && <span className="text-xs text-mut">（当前）</span>}
							</div>
							<div className="text-xs text-mut">{TIER_INFO[t].desc}</div>
						</button>
					) : (
						<button key={t} title={TIER_INFO[t].desc} className={cx("pa-chip", cur === t && (t === "full" ? "!bg-red-500/15 !text-red-600" : "!bg-accent-soft !text-accent"))} onClick={() => (t === cur ? null : rank(t) < rank(cur) ? apply(t) : setWant(t))} data-testid={`tier-${t}`}>
							{TIER_INFO[t].label}
						</button>
					),
				)}
			</div>
			{!compact && <div className="text-xs text-mut">{TIER_INFO[cur].desc}</div>}
			{want && (
				<div className={cx("space-y-2 rounded-xl border p-3 text-sm", want === "full" ? "border-red-500/50 bg-red-500/10" : "border-amber-400/50 bg-amber-500/10")} data-testid="tier-confirm">
					<div>
						调到「{TIER_INFO[want].label}」：{TIER_INFO[want].desc}。{want === "full" ? "助理能使用你已登录的所有账号和文件，网页/消息里的恶意内容可能诱导它做出无法撤回的操作。" : ""}受保护的操作仍会每次问你。
					</div>
					<label className="flex items-center gap-2">
						<input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="tier-ack" /> 我了解风险
					</label>
					{want === "full" && <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={`输入：${FULL_CONFIRM}`} data-testid="tier-confirm-text" />}
					<div className="flex gap-2">
						<Button size="sm" variant={want === "full" ? "danger" : "primary"} disabled={!ack || (want === "full" && text.trim() !== FULL_CONFIRM)} onClick={() => apply(want)}>
							确认
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setWant(null)}>
							取消
						</Button>
					</div>
				</div>
			)}
			{err && <div className="text-xs text-red-600">{err}</div>}
		</div>
	);
}

/** 输入框工具栏（「助理电脑」右边）：这个助理操作你电脑的档位（按钮 + 向上弹出的菜单） */
export function HostTierPill({ agentId }: { agentId: string }) {
	const { d, load } = useHostControl();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [open]);
	if (!d) return null;
	if (d.settings.agents !== "all" && !d.settings.agents.includes(agentId)) return null;
	const cur: Tier = d.tiers?.[agentId] ?? d.settings.defaultTier ?? "bounded";
	return (
		<div className="relative" ref={ref}>
			<button className={cx("pa-chip sm", !d.status.enabled && "opacity-70", cur === "full" && "!border-red-500/50 !text-red-600", cur === "trusted" && "!text-amber-600")} onClick={() => setOpen(!open)} title={`操作你的电脑：${TIER_INFO[cur].desc}`} data-testid="host-tier-pill">
				<ShieldCheck className="pa-ic" />
				<span>{TIER_INFO[cur].label}</span>
				<ChevronDown size={12} />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-30 mb-2 rounded-xl border border-line bg-card p-1.5 shadow-lg" data-testid="host-tier-menu">
					<div className="px-2.5 pb-1 pt-0.5 text-xs text-mut">{d.status.enabled ? "这个助理操作你电脑的权限" : "这个助理操作你电脑的权限（“操作这台电脑”还没开启，在 设置 里开启后生效）"}</div>
					<TierPicker agentId={agentId} d={d} load={load} onDone={() => setOpen(false)} compact />
				</div>
			)}
		</div>
	);
}

/** 助理设置页（次要入口）：同样的档位切换 */
export function AgentHostTier({ agentId }: { agentId: string }) {
	const { d, load } = useHostControl();
	if (!d) return null;
	const allowed = d.settings.agents === "all" || d.settings.agents.includes(agentId);
	return (
		<section className="space-y-2" data-testid="agent-host-tier">
			<div className="flex items-center gap-2 text-sm font-semibold">
				<Hand size={14} /> 操作你的电脑
				{!d.status.enabled && <span className="text-xs font-normal text-mut">（未开启，在 设置 › 操作这台电脑 开启）</span>}
				{d.status.enabled && !allowed && <span className="text-xs font-normal text-mut">（这个助理不在允许名单里）</span>}
			</div>
			<TierPicker agentId={agentId} d={d} load={load} />
			<div className="text-xs text-mut">也可以在输入框下方「助理电脑」旁边的权限按钮里切换。</div>
		</section>
	);
}
