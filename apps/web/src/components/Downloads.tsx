/**
 * 统一下载状态（对应服务端 downloads.ts）：未下载 / 下载中（已下 / 总共 / 百分比）/ 已下载 / 出错可重试 / 下载中可取消。
 * <Downloads /> 显示全部（设置 › 下载与组件）；<Downloads group="高级记忆" /> 只显示某一组（嵌在各功能设置里）。
 *
 * 两个入口共用同一行：设置 › 下载与组件，以及各功能里的同组下载区；状态来自同一个 job（GET + WS downloads.changed）。
 * 错误可见、可重试；列表读取失败**保留已加载的旧数据**，不做「读失败 = 没有组件」，也不用原生 alert。
 */
import { AlertCircle, CheckCircle2, CircleDashed, Download, Loader2, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Button, cx, fmtSize } from "./ui";

export interface DownloadInfo {
	id: string;
	name: string;
	group: string;
	state: "missing" | "downloading" | "ready" | "error";
	received: number;
	total: number | null;
	percent: number | null;
	size: number | null;
	detail: string | null;
	error: string | null;
	canStart: boolean;
	canCancel: boolean;
}

export function useDownloads() {
	const live = useStore((s) => s.downloads);
	const [items, setItems] = useState<DownloadInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = async () => {
		try {
			const j = await api<{ items: DownloadInfo[] }>("/api/downloads");
			setItems(j.items);
			setError(null);
		} catch (e) {
			// 读失败不能 `setItems([])`：那会把「读取失败」显示成「没有需要下载的组件」，误导用户。
			// 保留已加载的旧数据，只给一条可见错误 + 重试。
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	useEffect(() => {
		void load();
	}, []);
	const merged = items?.map((i) => live[i.id] ?? i) ?? null;
	// 新出现的（例如刚添加的扩展包）也显示
	const extra = Object.values(live).filter((x) => items && !items.some((i) => i.id === x.id));
	return { items: merged ? [...merged, ...extra] : null, error, reload: load };
}

export function DownloadRow({
	d,
	onStart,
	onCancel,
	pending,
	error,
}: {
	d: DownloadInfo;
	onStart?: () => void;
	onCancel?: () => void;
	pending?: boolean;
	error?: string | null;
}) {
	const size = d.total ?? d.size;
	const status =
		d.state === "ready" ? (
			<span className="inline-flex items-center gap-1 text-emerald-600">
				<CheckCircle2 size={13} /> 已下载
			</span>
		) : d.state === "downloading" ? (
			<span className="inline-flex items-center gap-1 text-accent">
				<Loader2 size={13} className="animate-spin" /> {d.percent != null ? `${d.percent}%` : "下载中"}
			</span>
		) : d.state === "error" ? (
			<span className="inline-flex items-center gap-1 text-red-600">
				<AlertCircle size={13} /> 出错
			</span>
		) : (
			<span className="inline-flex items-center gap-1 text-mut">
				<CircleDashed size={13} /> 未下载
			</span>
		);
	return (
		<div className="space-y-1.5 py-2.5" data-testid="download-row" data-id={d.id} data-state={d.state}>
			<div className="flex min-w-0 items-center gap-3">
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm" title={d.name}>
						{d.name}
					</div>
					<div className="truncate text-xs text-mut">
						{d.state === "downloading"
							? // 只展示真实进度：知道总量才显示 / 总量；不知道总量就不拿「约 xx」当已下载分母（跨阶段不混字节）。
								`${fmtSize(d.received)}${d.total ? ` / ${fmtSize(d.total)}` : ""}${d.detail ? ` · ${d.detail}` : ""}`
							: d.state === "error"
								? d.error
								: size
									? `${d.state === "ready" ? "" : "约 "}${fmtSize(size)}`
									: ""}
					</div>
				</div>
				<div className="shrink-0 text-xs">{status}</div>
				{d.canStart && (d.state === "missing" || d.state === "error") && (
					<Button size="sm" variant="outline" onClick={onStart} disabled={pending} data-testid="download-start">
						{pending ? <Loader2 size={13} className="animate-spin" /> : d.state === "error" ? <RotateCw size={13} /> : <Download size={13} />}
						{d.state === "error" ? "重试" : "下载"}
					</Button>
				)}
				{d.canCancel && d.state === "downloading" && (
					<Button size="sm" variant="outline" onClick={onCancel} disabled={pending} data-testid="download-cancel">
						{pending ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} 取消
					</Button>
				)}
			</div>
			{d.state === "downloading" && (
				<div className={cx("pa-dl-bar", d.percent == null && "indet")}>
					<i style={{ width: `${d.percent ?? 0}%` }} />
				</div>
			)}
			{error && (
				<div className="flex items-center gap-1 text-xs text-red-600" data-testid="download-row-error">
					<AlertCircle size={12} /> {error}
				</div>
			)}
		</div>
	);
}

export function Downloads({ group, empty }: { group?: string; empty?: string }) {
	const { items, error, reload } = useDownloads();
	const [pending, setPending] = useState<Record<string, boolean>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const act = async (id: string, path: "start" | "cancel") => {
		setPending((p) => ({ ...p, [id]: true }));
		setErrors((e) => {
			const n = { ...e };
			delete n[id];
			return n;
		});
		try {
			await api(`/api/downloads/${encodeURIComponent(id)}/${path}`, { method: "POST" });
		} catch (e) {
			// 起 / 停失败的短可见错误；不清空列表、不用 alert。
			setErrors((x) => ({ ...x, [id]: e instanceof Error ? e.message : String(e) }));
		} finally {
			setPending((p) => ({ ...p, [id]: false }));
			void reload();
		}
	};
	const banner = error ? (
		<div className="flex items-center gap-2 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700" data-testid="downloads-error">
			<AlertCircle size={13} /> 下载列表读取失败：{error}
			<Button size="sm" variant="outline" onClick={() => void reload()} data-testid="downloads-retry">
				<RotateCw size={13} /> 重试
			</Button>
		</div>
	) : null;
	if (!items) return banner;
	const list = items.filter((i) => !group || i.group === group);
	if (!list.length) return error ? banner : empty ? <div className="text-sm text-mut">{empty}</div> : null;
	const groups = group ? [group] : [...new Set(list.map((i) => i.group))];
	return (
		<div className="space-y-3" data-testid="downloads">
			{banner}
			{groups.map((g) => (
				<section key={g}>
					{!group && <div className="mb-1 text-xs font-medium text-mut">{g}</div>}
					<div className="divide-y divide-line rounded-xl border border-line px-3">
						{list
							.filter((i) => i.group === g)
							.map((d) => (
								<DownloadRow
									key={d.id}
									d={d}
									pending={!!pending[d.id]}
									error={errors[d.id] ?? null}
									onStart={() => void act(d.id, "start")}
									onCancel={() => void act(d.id, "cancel")}
								/>
							))}
					</div>
				</section>
			))}
		</div>
	);
}
