/**
 * 统一下载状态（对应服务端 downloads.ts）：未下载 / 下载中（已下 / 总共 / 百分比）/ 已下载 / 出错可重试。
 * <Downloads /> 显示全部（设置 › 下载与组件）；<Downloads group="高级记忆" /> 只显示某一组（嵌在各功能设置里）。
 */
import { AlertCircle, CheckCircle2, CircleDashed, Download, Loader2, RotateCw } from "lucide-react";
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
}

export function useDownloads() {
	const live = useStore((s) => s.downloads);
	const [items, setItems] = useState<DownloadInfo[] | null>(null);
	const load = () => api<{ items: DownloadInfo[] }>("/api/downloads").then((j) => setItems(j.items)).catch(() => setItems([]));
	useEffect(() => {
		void load();
	}, []);
	const merged = items?.map((i) => live[i.id] ?? i) ?? null;
	// 新出现的（例如刚添加的扩展包）也显示
	const extra = Object.values(live).filter((x) => items && !items.some((i) => i.id === x.id));
	return { items: merged ? [...merged, ...extra] : null, reload: load };
}

export function DownloadRow({ d, onStart }: { d: DownloadInfo; onStart?: () => void }) {
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
							? `${fmtSize(d.received)}${d.total ? ` / ${fmtSize(d.total)}` : d.size ? ` / 约 ${fmtSize(d.size)}` : ""}${d.detail ? ` · ${d.detail}` : ""}`
							: d.state === "error"
								? d.error
								: size
									? `${d.state === "ready" ? "" : "约 "}${fmtSize(size)}`
									: ""}
					</div>
				</div>
				<div className="shrink-0 text-xs">{status}</div>
				{d.canStart && (d.state === "missing" || d.state === "error") && (
					<Button size="sm" variant="outline" onClick={onStart} data-testid="download-start">
						{d.state === "error" ? <RotateCw size={13} /> : <Download size={13} />}
						{d.state === "error" ? "重试" : "下载"}
					</Button>
				)}
			</div>
			{d.state === "downloading" && (
				<div className={cx("pa-dl-bar", d.percent == null && "indet")}>
					<i style={{ width: `${d.percent ?? 0}%` }} />
				</div>
			)}
		</div>
	);
}

export function Downloads({ group, empty }: { group?: string; empty?: string }) {
	const { items, reload } = useDownloads();
	if (!items) return null;
	const list = items.filter((i) => !group || i.group === group);
	if (!list.length) return empty ? <div className="text-sm text-mut">{empty}</div> : null;
	const start = async (id: string) => {
		await api(`/api/downloads/${encodeURIComponent(id)}/start`, { method: "POST" }).catch(() => {});
		void reload();
	};
	const groups = group ? [group] : [...new Set(list.map((i) => i.group))];
	return (
		<div className="space-y-3" data-testid="downloads">
			{groups.map((g) => (
				<section key={g}>
					{!group && <div className="mb-1 text-xs font-medium text-mut">{g}</div>}
					<div className="divide-y divide-line rounded-xl border border-line px-3">
						{list
							.filter((i) => i.group === g)
							.map((d) => (
								<DownloadRow key={d.id} d={d} onStart={() => start(d.id)} />
							))}
					</div>
				</section>
			))}
		</div>
	);
}
