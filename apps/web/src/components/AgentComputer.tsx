/**
 * 助理设置里的「使用单独的电脑」（DESIGN §15.4）：默认所有助理共用一台助理电脑（同样的文件、浏览器登录状态、已装的应用）；
 * 打开后这个助理用自己的电脑（自己的家目录和登录状态）。关掉时数据保留，可以合并进共用电脑或继续留着。
 */
import { Loader2, Merge } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";
import { Button, cx, Help, useConfirm } from "./ui";

type Info = { separate: boolean; hasData: boolean | null; desktop?: { enabled: boolean; state: string } };

export function AgentComputer({ agentId, compact }: { agentId: string; compact?: boolean }) {
	const [info, setInfo] = useState<Info | null>(null);
	const [busy, setBusy] = useState<"" | "toggle" | "merge">("");
	const [err, setErr] = useState("");
	const [dialog, confirm] = useConfirm();
	const ver = useStore((s) => s.desktopVersion);
	const load = () => api<Info>(`/api/agents/${agentId}/computer`).then(setInfo).catch(() => setInfo(null));
	useEffect(() => {
		void load();
	}, [agentId, ver]);
	// 还没安装助理电脑：不显示（装好之后才有意义）
	if (!info || info.desktop?.enabled === false) return null;
	const run = async (kind: "toggle" | "merge", f: () => Promise<unknown>) => {
		setBusy(kind);
		setErr("");
		try {
			await f();
			await load();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};
	const toggle = () =>
		run("toggle", async () => {
			if (info.separate) {
				const ok = await confirm({
					title: t("改回共用电脑？"),
					body: t("这个助理会改用和其他助理共用的电脑（共用的文件和登录状态）。它单独电脑里的数据会保留，之后可以合并进共用电脑。"),
					ok: t("改回共用"),
				});
				if (!ok) return;
			}
			await api(`/api/agents/${agentId}/computer`, { method: "PUT", json: { separate: !info.separate } });
		});
	const merge = () =>
		run("merge", async () => {
			const ok = await confirm({
				title: t("合并进共用电脑？"),
				body: t("会先关掉这两台电脑。文件按“不覆盖已有文件”合并；浏览器登录状态、微信：共用电脑里还没有就整个搬过去，已经有了就放进共用电脑的「旧电脑-助理名」文件夹里。合并后单独的电脑会删掉，这个助理改用共用电脑。"),
				ok: t("合并"),
			});
			if (!ok) return;
			await api(`/api/agents/${agentId}/computer/merge`, { method: "POST" });
		});
	return (
		<div className={cx(compact ? "flex shrink-0 items-center gap-2" : "space-y-1.5 rounded-xl border border-line p-3")} data-testid="agent-computer">
			{dialog}
			<label className={cx("flex cursor-pointer gap-2", compact ? "items-center justify-end" : "items-start")}>
				<input type="checkbox" className={compact ? "" : "mt-0.5"} checked={info.separate} disabled={!!busy} onChange={toggle} data-testid="agent-separate" />
				<span className={compact ? "" : "flex-1"}>
					<span className="text-sm font-medium">{compact ? t("单独电脑") : t("使用单独的电脑")}</span>
					{busy === "toggle" && <Loader2 size={12} className="ml-1 inline animate-spin" />}
					{!compact && (
						<span className="block text-xs text-zinc-500">
							{info.separate ? t("用自己的文件和登录状态，和其他助理分开。") : t("现在和其他助理共用一台电脑。")}{" "}
							<Help>{t("共用时：同样的文件、浏览器登录状态和已装的应用；各自有自己的屏幕，不互相抢鼠标。需要长期分开账号时再打开。")}</Help>
						</span>
					)}
				</span>
			</label>
			{compact && info.hasData && (
				<Button size="sm" variant="ghost" disabled={!!busy} onClick={merge} title={t("它以前单独电脑里的数据还保留着，可以合并进共用电脑。")} data-testid="agent-merge">
					{busy === "merge" ? <Loader2 size={14} className="animate-spin" /> : <Merge size={14} />} {t("合并")}
				</Button>
			)}
			{!compact && !info.separate && info.hasData && (
				<div className="flex items-center gap-2 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-500 dark:bg-zinc-900" data-testid="agent-old-data">
					<span className="flex-1">{t("它以前单独电脑里的数据（文件、登录状态）还保留着。")}</span>
					<Button size="sm" variant="outline" disabled={!!busy} onClick={merge} data-testid="agent-merge">
						{busy === "merge" ? <Loader2 size={14} className="animate-spin" /> : <Merge size={14} />} {t("合并进共用电脑")}
					</Button>
				</div>
			)}
			{!compact && info.separate && info.hasData && (
				<div className="flex items-center gap-2 text-xs text-zinc-500">
					<span className="flex-1">{t("想让它和其他助理共用登录状态？可以把这台电脑的数据合并进共用电脑。")}</span>
					<Button size="sm" variant="ghost" disabled={!!busy} onClick={merge} data-testid="agent-merge">
						{busy === "merge" ? <Loader2 size={14} className="animate-spin" /> : <Merge size={14} />} {t("合并进共用电脑")}
					</Button>
				</div>
			)}
			{err && <div className="text-xs text-red-600">{err}</div>}
		</div>
	);
}
