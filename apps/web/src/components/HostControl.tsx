import { AlertTriangle, Hand, Loader2, Pause, Play, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Badge, Button, cx, ErrorBox, Input, avatarText, Help, useConfirm } from "./ui";

/** 启用“完全权限”前的确认框（不再要求输入确认语） */
const FULL_ASK = { title: "启用完全权限？", body: "助理几乎能做你在这台电脑上能做的任何事，包括使用已登录的账号和文件。这个档位下应用层不再弹审批：关机、删除、改系统设置这类受保护操作也会直接执行，随时可以一键暂停。仍然拦得住的只有凭据/密钥文件（直接拒绝）、暂停或调低档位、系统自己的权限弹窗和网站上的登录/验证码。", ok: "确定启用", danger: true };
/** 与服务端 host-control.ts 的 FULL_CONFIRM 一致（旧版确认语，服务端仍兼容） */
export const FULL_CONFIRM = "我了解风险，允许完全控制这台电脑";
export type Tier = "observe" | "bounded" | "trusted" | "full";
export const TIER_INFO: Record<Tier, { label: string; desc: string; tone: string }> = {
	observe: { label: "只看", desc: "截图、读取窗口内容，不能点击或输入", tone: "zinc" },
	bounded: { label: "限定", desc: "只能操作勾选的应用，每个动作都问你（默认）；不能用你的 Chrome 做网页任务，需要“信任”或以上", tone: "green" },
	trusted: { label: "信任", desc: "日常操作不问，发送、付款、删除前会问；可以连接你的 Chrome 操作网页", tone: "amber" },
	full: { label: "完全权限", desc: "应用层不再弹审批（含关机/删除等受保护操作）", tone: "red" },
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
	activity?: { active: boolean; agent: string | null; summary: string | null };
}

export function useHostControl() {
	const v = useStore((s) => s.hostVersion);
	const [d, setD] = useState<HostInfo | null>(null);
	const [err, setErr] = useState("");
	const [loading, setLoading] = useState(true);
	// 只让最后一次请求落地：旧请求迟到 / 组件卸载后不再覆盖当前数据
	const seq = useRef(0);
	const load = async () => {
		const my = ++seq.current;
		try {
			const r = await api<HostInfo>("/api/host-control");
			if (my !== seq.current) return;
			setD(r);
			setErr("");
		} catch (e) {
			if (my !== seq.current) return;
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			if (my === seq.current) setLoading(false);
		}
	};
	useEffect(() => {
		void load();
		return () => {
			seq.current++;
		};
	}, [v]);
	return { d, load, err, loading };
}

/**
 * 聊天顶部：只在助理“真的正在操作你的电脑”时出现（开启了操作这台电脑 + 最近几秒有 host 动作）。
 * 只是思考、只用助理自己的电脑、或没开启时都不显示。小胶囊样式，带一键暂停（电脑和手机都能点）。
 */
export function HostControlBar() {
	const { d, load } = useHostControl();
	const acts = useStore((s) => s.actionsVersion);
	const [tick, setTick] = useState(0);
	useEffect(() => void load(), [acts]);
	const live = !!d?.status.enabled && !!d.activity?.active;
	// 正在显示时每 3 秒复查一次，动作结束几秒后自动收起
	useEffect(() => {
		if (!live) return;
		const t = setTimeout(() => (load(), setTick(tick + 1)), 3000);
		return () => clearTimeout(t);
	}, [live, tick]);
	if (!d || !live) return null;
	const paused = d.status.paused;
	const toggle = async () => {
		await api("/api/host-control/pause", { method: "POST", json: { paused: !paused } });
		void load();
	};
	const who = d.activity?.agent ?? "助理";
	const text = paused ? "已暂停操作你的电脑" : `${who} 正在操作你的电脑${d.activity?.summary ? `：${d.activity.summary}` : ""}`;
	return (
		<div className="pa-hostbar-wrap">
			<div className={cx("pa-hostbar", paused && "paused")} data-testid="host-bar" title={text}>
				<span className="pa-hostbar-dot" />
				<span className="min-w-0 truncate">{text}</span>
				<button className="pa-hostbar-btn" onClick={toggle} data-testid="host-pause" aria-label={paused ? "继续" : "暂停"}>
					{paused ? <Play className="pa-ic" /> : <Pause className="pa-ic" />}
					{paused ? "继续" : "暂停"}
				</button>
			</div>
		</div>
	);
}

const PERM: Record<string, string> = { granted: "已授权", denied: "未授权", unknown: "未知" };

/** 设置 › 操作这台电脑 */
export function HostControlSettings() {
	const { d, load, err: loadErr, loading } = useHostControl();
	const agents = useStore((s) => s.agents);
	const [apps, setApps] = useState<HostApp[] | null>(null);
	const [scope, setScope] = useState<"all" | string[]>("all");
	const [files, setFiles] = useState(true);
	const [ack, setAck] = useState(false);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "ok" | "error">("idle");
	const [busy, setBusy] = useState(false);
	const [suggest, setSuggest] = useState<HostApp[] | null>(null);
	const [custom, setCustom] = useState({ name: "", id: "" });
	const [preview, setPreview] = useState<{ yaml: string; hash: string } | null>(null);
	const [defaultTier, setDefaultTier] = useState<Tier>("bounded");
	const [dlg, ask] = useConfirm();
	useEffect(() => {
		if (d && apps === null) {
			setDefaultTier(d.settings.defaultTier ?? "bounded");
			setApps(d.settings.apps);
			setScope(d.settings.agents);
			setFiles(d.settings.workspaceFiles);
		}
	}, [d]);
	const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 关闭状态下：选项改动自动保存成草稿（带反馈）；开启中改的是权限计划，必须用底部按钮重新确认
	useEffect(() => {
		if (!d || !apps || d.status.enabled) return;
		const sameScope = scope === "all" ? d.settings.agents === "all" : Array.isArray(d.settings.agents) && scope.length === d.settings.agents.length && scope.every((x) => d.settings.agents.includes(x));
		const sameApps = apps.length === d.settings.apps.length && apps.every((x) => d.settings.apps.some((y) => y.id === x.id));
		if (defaultTier === (d.settings.defaultTier ?? "bounded") && sameScope && files === d.settings.workspaceFiles && sameApps) return;
		if (autoTimer.current) clearTimeout(autoTimer.current);
		autoTimer.current = setTimeout(async () => {
			setSaveState("saving");
			setMsg(null);
			try {
				await api("/api/host-control", { method: "PUT", json: { enabled: false, agents: scope, apps, workspaceFiles: files, defaultTier } });
				setSaveState("ok");
				await load();
			} catch (e) {
				setSaveState("error");
				setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
			}
		}, 600);
		return () => {
			if (autoTimer.current) clearTimeout(autoTimer.current);
		};
	}, [d, apps, scope, files, defaultTier]);
	if (!d || !apps) {
		if (loading) return <div className="text-sm text-mut" data-testid="host-loading">正在载入…</div>;
		return (
			<div className="space-y-2 text-sm" data-testid="host-load-error">
				<div className="text-red-600">载入失败：{loadErr || "无法连接本机服务"}</div>
				<Button size="sm" variant="outline" onClick={() => void load()} data-testid="host-retry">
					<RefreshCw size={13} /> 重试
				</Button>
			</div>
		);
	}
	const mac = d.status.platform === "darwin";
	const win = d.status.platform === "win32";
	const on = d.status.enabled;
	const allowedIds = scope === "all" ? agents.map((a) => a.id) : scope;
	const tierOf = (id: string): Tier => d.tiers?.[id] ?? d.settings.defaultTier ?? "bounded";
	const anyBounded = defaultTier === "bounded" || allowedIds.some((id) => tierOf(id) === "bounded");
	const anyFull = defaultTier === "full" || allowedIds.some((id) => tierOf(id) === "full");
	const sameScope = scope === "all" ? d.settings.agents === "all" : Array.isArray(d.settings.agents) && scope.length === d.settings.agents.length && scope.every((x) => d.settings.agents.includes(x));
	const sameApps = apps.length === d.settings.apps.length && apps.every((x) => d.settings.apps.some((y) => y.id === x.id));
	const dirty = defaultTier !== (d.settings.defaultTier ?? "bounded") || !sameScope || files !== d.settings.workspaceFiles || !sameApps;
	const save = async (enabled: boolean, hash?: string, confirmFull = false) => {
		setBusy(true);
		setMsg(null);
		try {
			const r = await api("/api/host-control", { method: "PUT", json: { enabled, agents: scope, apps, workspaceFiles: files, acknowledged: ack, manifestHash: hash, defaultTier, confirmFull } });
			if (r.ok === false) setMsg({ ok: false, text: r.error });
			else setMsg({ ok: true, text: enabled ? "已开启：按各助理的档位操作你的电脑；非完全权限档位的受保护操作一律先问你，随时可以一键暂停" : "已关闭" });
			setPreview(null);
			await load();
		} catch (e) {
			setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
		} finally {
			setBusy(false);
		}
	};
	/** 先向服务端要一份草稿权限计划给用户审阅，确认后再保存（不会影响正在运行的守护进程） */
	const review = async () => {
		setBusy(true);
		setMsg(null);
		try {
			const p = await api<{ yaml: string; hash: string }>("/api/host-control/plan", { method: "POST", json: { agents: scope, apps, workspaceFiles: files, defaultTier } });
			setPreview({ yaml: p.yaml, hash: p.hash });
		} catch (e) {
			setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
		} finally {
			setBusy(false);
		}
	};
	const add = (a: HostApp) => !apps.some((x) => x.id === a.id) && setApps([...apps, a]);
	return (
		<div className="space-y-5" data-testid="host-settings">
			{dlg}
			{loadErr && <div className="text-xs text-amber-600" data-testid="host-refresh-error">刷新失败：{loadErr}（下面显示的是上次的数据）</div>}
			<div className="rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
				<div className="mb-1 flex items-center gap-2 font-semibold">
					<AlertTriangle size={16} /> 让助理操作你自己的电脑
				</div>
				助理像人一样在你的电脑上点击、输入。默认关闭，每步先问你，随时可暂停。
				<Help className="ml-1">
					<ul className="list-disc space-y-1 pl-4">
						<li>“限定”档位只能操作你勾选的应用（Cua Driver bounded 模式强制），看不到整个屏幕。</li>
						<li>每个动作都会先问你（可选“本任务内都允许”）；电脑和手机都能一键暂停。</li>
						<li>操作期间请不要同时用鼠标键盘；网页上的事更推荐用助理自己的电脑完成。</li>
						<li>助理可能被网页或文档里的恶意内容误导，不要允许网银、密码管理器等应用。</li>
					</ul>
				</Help>
			</div>

			<section>
				<div className="mb-2 flex items-center gap-2 font-semibold">
					状态 <Badge tone={on ? (d.status.paused ? "amber" : "green") : "zinc"}>{on ? (d.status.paused ? "已暂停" : d.status.daemon.state === "running" ? "运行中" : d.status.daemon.detail) : "未开启"}</Badge>
				</div>
				<div className="text-xs text-mut">
					Cua Driver {d.status.version} {d.status.installed ? "· 已安装" : "· 开启时自动下载"} · {d.status.daemon.detail}
					<Help className="ml-1">MIT 开源，按固定版本下载并校验 SHA256。</Help>
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
						<button key={t} className={cx("min-w-0 whitespace-normal break-words rounded-xl border p-2.5 text-left text-xs text-mut transition", defaultTier === t ? (t === "full" ? "border-red-500/60 bg-red-500/10" : "border-accent bg-accent-soft") : "border-line hover:bg-hover")} onClick={() => (setDefaultTier(t), setPreview(null))} data-testid={`default-tier-${t}`}>
							<b className={cx("text-sm", t === "full" ? "text-red-600" : t === "trusted" ? "text-amber-600" : "text-fg")}>{TIER_INFO[t].label}</b>
							<div className="break-words">{TIER_INFO[t].desc}</div>
						</button>
					))}
				</div>
				<p className="text-xs text-mut">只影响之后新建的助理。 <Help>每个助理的权限在 助理设置 › 电脑 里单独切换（调高需要确认）。“完全权限”以外的档位：受保护的操作都必须你明确批准；“完全权限”档位应用层不再弹审批（凭据/密钥文件仍然直接拒绝）。任何档位一键暂停都有效，所有动作都会记录。</Help></p>
				{anyFull && (
					<div className="space-y-1 rounded-xl border border-red-500/50 bg-red-500/10 p-4 text-sm leading-relaxed text-red-800 dark:text-red-300" data-testid="host-full-warning">
						<div className="flex items-center gap-2 font-semibold">
							<AlertTriangle size={16} /> {defaultTier === "full" ? "新助理默认完全权限" : "有助理是完全权限"}：助理可以做你在这台电脑上能做的几乎任何事
						</div>
						<ul className="list-disc pl-5">
							<li>能打开任何应用、读写文件、使用你已登录的账号（聊天、邮箱、网银、云盘……），Cua Driver 以 unrestricted 模式运行，没有应用清单，日常动作不再问你。</li>
							<li>网页、文档、聊天消息里的恶意内容可能诱导助理做出你不想要的操作（提示注入），后果可能无法撤回。</li>
							<li>受保护的操作（结束/卸载 Pi Assistant、关机重启、格式化、改系统设置/防火墙/账户、大范围删除、改开机启动项等）在“完全权限”档位下也会直接执行、不再问你；“信任”“限定”档位仍然每次都会问你。</li>
							<li>建议只在你在电脑旁边时使用；电脑和手机上都能一键暂停；所有动作都会记录。</li>
						</ul>
					</div>
				)}
			</section>

			{mac && (
				<section className="rounded-xl bg-hover p-3 text-sm" data-testid="host-mac-perms">
					<div className="font-semibold">macOS 权限</div>
					<p className="mt-1 text-mut">给 <b>CuaDriver</b> 打开“辅助功能”和“屏幕录制”，助理才能看和点。 <Help>系统设置 › 隐私与安全性 › 辅助功能 / 屏幕与系统录音，打开 CuaDriver 的开关（授权归属于 CuaDriver.app，而不是终端或本应用）。点下面的按钮会弹出系统授权引导。</Help></p>
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
			{win && <div className="rounded-xl bg-hover p-3 text-sm text-mut">Windows：无需额外授权。 <Help>若要操作“以管理员身份运行”的程序，本应用也需要以管理员身份运行（不推荐）。</Help></div>}

			{anyBounded && <section>
				<div className="mb-2 font-semibold">允许操作的应用（“限定”档位）{apps.length > 0 && <span className="ml-1 text-xs font-normal text-mut">{apps.length} 个</span>}</div>
				<ul className="max-h-60 space-y-1 overflow-y-auto" data-testid="host-apps">
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
					<div className="flex max-h-40 flex-wrap gap-3 overflow-y-auto pl-6">
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
				<div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-3 py-2">
					<Button variant="primary" disabled={busy || (anyBounded && !apps.length)} onClick={review} data-testid="host-review">
						{busy && <Loader2 size={14} className="animate-spin" />} {on ? (dirty ? "保存更改并重新确认…" : "查看权限清单…") : "查看权限清单并开启…"}
					</Button>
					{on && dirty && <span className="text-xs text-amber-600" data-testid="host-dirty">有未保存的更改</span>}
					{!on && saveState === "saving" && <span className="flex items-center gap-1 text-xs text-mut"><Loader2 size={12} className="animate-spin" /> 正在保存草稿…</span>}
					{!on && saveState === "ok" && <span className="text-xs text-green-600" data-testid="host-autosave">已保存草稿（未开启）</span>}
				</div>
			) : (
				<section className="space-y-2" data-testid="host-manifest">
					<div className="text-sm font-semibold">权限计划（各助理档位 + “限定”档位的 Cua 能力清单）</div>
					<pre className="pa-pre max-h-64 overflow-auto text-xs">{preview.yaml}</pre>
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="host-ack" />
						<span>我已阅读上面的提示和权限计划，允许助理按这些档位操作我的电脑。</span>
					</label>
					<div className="flex gap-2">
						<Button variant={anyFull ? "danger" : "primary"} disabled={busy || !ack} onClick={async () => (!anyFull || (await ask(FULL_ASK))) && save(true, preview.hash, anyFull)} data-testid="host-enable">
							{busy && <Loader2 size={14} className="animate-spin" />} {on ? "确认更新" : "确认开启"}
						</Button>
						<Button variant="ghost" onClick={() => setPreview(null)}>
							取消
						</Button>
					</div>
				</section>
			)}
			{msg && <div className={cx("text-sm", msg.ok ? "text-green-600" : "text-red-600")} data-testid="host-msg">{msg.text}</div>}
		</div>
	);
}

/** 切换某个助理的档位：调低直接生效；调高弹确认框（完全权限是红色的“确定启用”） */
function TierPicker({ agentId, d, load }: { agentId: string; d: HostInfo; load: () => void }) {
	const [err, setErr] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [dlg, ask] = useConfirm();
	const cur: Tier = d.tiers?.[agentId] ?? d.settings.defaultTier ?? "bounded";
	const rank = (t: Tier) => TIER_ORDER.indexOf(t);
	const apply = async (t: Tier, raise: boolean) => {
		setErr("");
		setSaving(true);
		setSaved(false);
		try {
			const r = await api(`/api/host-control/tier/${agentId}`, { method: "PUT", json: { tier: t, acknowledged: raise, confirmFull: t === "full" } });
			if (r.ok === false) return setErr(r.error);
			setSaved(true);
			load();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};
	const pick = async (t: Tier) => {
		if (t === cur) return;
		if (rank(t) < rank(cur)) return apply(t, false);
		const ok = await ask(t === "full" ? FULL_ASK : { title: `调到「${TIER_INFO[t].label}」？`, body: `${TIER_INFO[t].desc}。受保护的操作仍会先问你。`, ok: "确定" });
		if (ok) await apply(t, true);
	};
	return (
		<div className="space-y-2" data-testid="tier-picker">
			<div className="flex flex-wrap gap-1">
				{TIER_ORDER.map((t) => (
					<button key={t} title={TIER_INFO[t].desc} aria-pressed={cur === t} className={cx("pa-chip", cur === t && (t === "full" ? "!bg-red-500/15 !text-red-600" : "!bg-accent-soft !text-accent"))} onClick={() => pick(t)} data-testid={`tier-${t}`}>
						{TIER_INFO[t].label}
					</button>
				))}
			</div>
			<div className="text-xs text-mut">{TIER_INFO[cur].desc}</div>
			{saving && <div className="flex items-center gap-1 text-xs text-mut"><Loader2 size={12} className="animate-spin" /> 正在保存…</div>}
			{saved && !saving && <div className="text-xs text-green-600">已保存</div>}
			{err && <div className="text-xs text-red-600">{err}</div>}
			{dlg}
		</div>
	);
}

/** 助理设置页（次要入口）：同样的档位切换。加载中 / 读失败也给明确状态，不直接返回空。 */
export function AgentHostTier({ agentId }: { agentId: string }) {
	const { d, load, err, loading } = useHostControl();
	const allowed = !!d && (d.settings.agents === "all" || d.settings.agents.includes(agentId));
	const paused = !!d?.status.enabled && d.status.paused;
	return (
		<section className="min-w-0 space-y-2" data-testid="agent-host-tier">
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
				<span className="flex items-center gap-2">
					<Hand size={14} className="shrink-0" /> 操作你的电脑
				</span>
				{loading && !d && <span className="text-xs font-normal text-mut">正在读取…</span>}
				{d && !d.status.enabled && <span className="min-w-0 text-xs font-normal break-words text-mut">（未开启，在 设置 › 操作这台电脑 开启）</span>}
				{d?.status.enabled && !allowed && <span className="min-w-0 text-xs font-normal break-words text-mut">（这个助理不在允许名单里）</span>}
				{paused && <Badge tone="amber">已暂停</Badge>}
			</div>
			{err && (
				<div className="flex flex-wrap items-center gap-2">
					<ErrorBox text={err} className="min-w-0 flex-1" />
					<Button size="sm" variant="outline" onClick={() => void load()} disabled={loading} data-testid="agent-host-tier-retry">
						<RefreshCw size={12} /> 重试
					</Button>
				</div>
			)}
			{d && (
				<>
					<TierPicker agentId={agentId} d={d} load={load} />
				</>
			)}
		</section>
	);
}
