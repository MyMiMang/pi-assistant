/**
 * 设置 › 关于 里的「版本与更新」（DESIGN §16.x）：
 *  - 桌面应用（Tauri 主窗口）：当前版本、检查更新、新版本说明、下载进度、安装并重启、自动检查开关、上次检查时间；
 *    状态来自托盘程序（apps/tray/src-tauri/src/updater.rs），托盘菜单和这里看到的是同一个状态。
 *  - Linux 服务器 / 网页 / 手机：只显示版本，提示用 `pi-assistant upgrade` 升级。
 */
import { CheckCircle2, Download, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Button, ErrorBox, Help } from "./ui";

export interface UpdState {
	phase: "idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "error";
	current: string;
	version?: string | null;
	notes?: string | null;
	pub_date?: string | null;
	downloaded: number;
	total?: number | null;
	error?: string | null;
	detail?: string | null;
	last_checked?: number | null;
	auto_check: boolean;
	platform: string;
}
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const tauri = (): Invoke | null => (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke ?? null;
const mb = (n: number) => `${(n / 1048576).toFixed(n > 100 * 1048576 ? 0 : 1)} MB`;
const ago = (ms: number) => {
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 60) return "刚刚";
	if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
	if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
	return new Date(ms).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export function AppUpdate() {
	const system = useStore((s) => s.system);
	const inv = tauri();
	const [st, setSt] = useState<UpdState | null>(null);
	const [err, setErr] = useState("");
	const call = async <T,>(cmd: string, args?: Record<string, unknown>) => {
		try {
			return await inv!<T>(cmd, args);
		} catch (e) {
			setErr(String(e));
			throw e;
		}
	};
	useEffect(() => {
		if (!inv) return;
		let alive = true;
		const tick = () => inv<UpdState>("app_update_status").then((s) => alive && setSt(s), (e) => alive && setErr(String(e)));
		void tick();
		const busy = st && ["checking", "downloading", "installing"].includes(st.phase);
		const id = setInterval(tick, busy ? 500 : 3000);
		return () => ((alive = false), clearInterval(id));
	}, [inv, st?.phase]);

	const ver = system?.app?.version;
	if (!inv) {
		// 网页 / 手机 / Linux 服务器：应用更新由服务器自己的命令完成
		const server = system?.server || system?.app?.launcher === "server";
		return (
			<section className="space-y-2" data-testid="about-update">
				<div className="font-semibold">版本与更新</div>
				<div className="flex items-center gap-2 text-sm">
					<span className="text-mut">当前版本</span>
					<code data-testid="about-version">{ver ?? "未知"}</code>
				</div>
				{server ? (
					<p className="text-xs text-mut">
						在服务器上运行 <code className="rounded bg-hover px-1">pi-assistant upgrade</code> 升级 <Help>升级会保留所有数据（助理、对话、登录状态）。也可以用 --version 指定版本。</Help>
					</p>
				) : (
					<p className="text-xs text-mut">在装了 Pi Assistant 的电脑上，从应用的「设置 › 关于」或托盘菜单更新。</p>
				)}
			</section>
		);
	}
	if (!st) return err ? <ErrorBox text={`读取更新状态失败\n${err}`} /> : null;
	const pct = st.total ? Math.min(100, Math.round((st.downloaded / st.total) * 100)) : null;
	const busy = ["checking", "downloading", "installing"].includes(st.phase);
	return (
		<section className="space-y-3" data-testid="about-update">
			<div className="font-semibold">版本与更新</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
				<span className="text-mut">当前版本</span>
				<code data-testid="about-version">v{st.current}</code>
				{st.phase === "latest" && (
					<span className="flex items-center gap-1 text-xs whitespace-nowrap text-green-600">
						<CheckCircle2 size={13} /> 已是最新
					</span>
				)}
				<span className="flex-1" />
				<Button size="sm" variant="outline" disabled={busy} onClick={() => (setErr(""), call<UpdState>("app_update_check").then(setSt))} data-testid="update-check">
					{st.phase === "checking" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 检查更新
				</Button>
			</div>

			{(st.phase === "available" || st.phase === "downloading" || st.phase === "installing" || (st.phase === "error" && st.version)) && st.version && (
				<div className="space-y-2 rounded-xl bg-hover p-3" data-testid="update-available">
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<span className="font-medium whitespace-nowrap">新版本 v{st.version}</span>
						{st.pub_date && <span className="text-xs text-mut whitespace-nowrap">{new Date(st.pub_date.replace(" ", "T").replace(/ \+00:00:00$/, "Z")).toLocaleDateString("zh-CN") || ""}</span>}
						<span className="flex-1" />
						{st.phase === "downloading" || st.phase === "installing" ? null : (
							<Button size="sm" variant="primary" onClick={() => (setErr(""), call("app_update_install"))} data-testid="update-install">
								{st.phase === "error" ? <RotateCcw size={14} /> : <Download size={14} />} {st.phase === "error" ? "重试" : "安装并重启"}
							</Button>
						)}
					</div>
					{st.phase === "downloading" && (
						<div className="space-y-1" data-testid="update-progress">
							<div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
								<div className="h-full bg-accent transition-all" style={{ width: `${pct ?? 5}%` }} />
							</div>
							<div className="text-xs text-mut">
								正在下载 {mb(st.downloaded)}
								{st.total ? ` / ${mb(st.total)}（${pct}%）` : ""}，下载完会自动安装并重启
							</div>
						</div>
					)}
					{st.phase === "installing" && (
						<div className="flex items-center gap-1.5 text-xs text-mut">
							<Loader2 size={13} className="animate-spin" /> 正在安装，马上重启…
						</div>
					)}
					{st.notes && <div className="max-h-48 overflow-auto text-xs leading-relaxed whitespace-pre-wrap text-mut [overflow-wrap:anywhere]" data-testid="update-notes">{st.notes}</div>}
				</div>
			)}

			{st.phase === "error" && st.error && <ErrorBox text={`${st.error}\n${st.detail ?? ""}`} />}
			{err && <ErrorBox text={`操作失败\n${err}`} />}

			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mut">
				<label className="flex cursor-pointer items-center gap-2 whitespace-nowrap">
					<input type="checkbox" checked={st.auto_check} onChange={(e) => call<UpdState>("app_update_set_auto", { on: e.target.checked }).then(setSt)} data-testid="update-auto" />
					自动检查更新 <Help>开着时启动后和每 12 小时检查一次；有新版本会弹通知，由你决定什么时候装。</Help>
				</label>
				<span className="whitespace-nowrap" data-testid="update-last">上次检查：{st.last_checked ? ago(st.last_checked) : "还没检查过"}</span>
			</div>
		</section>
	);
}
