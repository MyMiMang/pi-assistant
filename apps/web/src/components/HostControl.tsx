import { AlertTriangle, Hand, Loader2, Pause, Play, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Badge, Button, cx, Input } from "./ui";

interface HostApp {
	name: string;
	id: string;
}
interface HostInfo {
	settings: { enabled: boolean; agents: "all" | string[]; apps: HostApp[]; workspaceFiles: boolean; approvedHash?: string };
	status: { enabled: boolean; paused: boolean; daemon: { state: string; detail: string }; platform: string; installed: boolean; version: string };
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
			<span className="min-w-0 flex-1 truncate">{paused ? "已暂停操作你的电脑" : `助理可以操作你的电脑（${d.settings.apps.map((a) => a.name).join("、") || "未选应用"}），每个动作都会先问你`}</span>
			<button className="pa-btn sm" onClick={toggle} data-testid="host-pause">
				{paused ? <Play className="pa-ic" /> : <Pause className="pa-ic" />}
				{paused ? "继续" : "暂停"}
			</button>
		</div>
	);
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
	useEffect(() => {
		if (d && apps === null) {
			setApps(d.settings.apps);
			setScope(d.settings.agents);
			setFiles(d.settings.workspaceFiles);
		}
	}, [d]);
	if (!d || !apps) return null;
	const mac = d.status.platform === "darwin";
	const win = d.status.platform === "win32";
	const on = d.status.enabled;
	const save = async (enabled: boolean, hash?: string) => {
		setBusy(true);
		setMsg(null);
		try {
			const r = await api("/api/host-control", { method: "PUT", json: { enabled, agents: scope, apps, workspaceFiles: files, acknowledged: ack, manifestHash: hash } });
			if (r.ok === false) setMsg({ ok: false, text: r.error });
			else setMsg({ ok: true, text: enabled ? "已开启：助理现在可以在你允许的应用里操作，每个动作都会先问你" : "已关闭" });
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
			const r = await api("/api/host-control", { method: "PUT", json: { enabled: false, agents: scope, apps, workspaceFiles: files } });
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

			<section>
				<div className="mb-2 font-semibold">允许操作的应用</div>
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
			</section>

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
								<input type="checkbox" checked={scope.includes(a.id)} onChange={(e) => setScope(e.target.checked ? [...scope, a.id] : scope.filter((x) => x !== a.id))} /> {a.avatar} {a.name}
							</label>
						))}
					</div>
				)}
				<label className="flex items-center gap-2">
					<input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} /> 允许在这些应用里打开 / 保存助理工作区里的文件
				</label>
			</section>

			{!preview ? (
				<Button variant="primary" disabled={busy || !apps.length} onClick={review} data-testid="host-review">
					{busy && <Loader2 size={14} className="animate-spin" />} 查看权限清单并{on ? "更新" : "开启"}…
				</Button>
			) : (
				<section className="space-y-2" data-testid="host-manifest">
					<div className="text-sm font-semibold">Cua 能力清单（bounded 模式只允许这里列出的内容）</div>
					<pre className="pa-pre max-h-64 overflow-auto text-xs">{preview.yaml}</pre>
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="host-ack" />
						<span>我已阅读上面的提示和清单，允许助理在这些应用里操作我的电脑（每个动作仍会先问我）。</span>
					</label>
					<div className="flex gap-2">
						<Button variant="primary" disabled={busy || !ack} onClick={() => save(true, preview.hash)} data-testid="host-enable">
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
