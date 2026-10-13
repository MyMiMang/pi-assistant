/** 设置 › 模型 › 模型擅长：建群时按这些标签给角色挑模型。默认按模型系列和 models.dev 数据推断，可以按模型改 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { Help, cx } from "./ui";

interface Prof {
	provider: string;
	providerName: string;
	id: string;
	name?: string;
	tags: string[];
	tierLabel: string;
	userEdited: boolean;
}
export function ModelStrengths() {
	const [d, setD] = useState<{ labels: { key: string; label: string }[]; models: Prof[] } | null>(null);
	const [open, setOpen] = useState(false);
	const load = () => void api<typeof d>("/api/model-strengths").then(setD).catch(() => {});
	useEffect(load, []);
	if (!d || !d.models.length) return null;
	const label = new Map(d.labels.map((l) => [l.key, l.label]));
	const put = async (m: Prof, tags: string[] | null) => {
		await api("/api/model-strengths", { method: "PUT", json: { provider: m.provider, id: m.id, tags } });
		load();
	};
	const shown = open ? d.models : d.models.slice(0, 6);
	return (
		<section data-testid="model-strengths">
			<div className="mb-3 flex items-center gap-1.5 font-semibold">
				模型擅长
				<Help>助理帮你组建团队时，会按每个角色需要的能力，从你配置的模型里挑合适的（还会看价格）。标签默认按模型系列和公开资料推断，点标签可以开关。</Help>
			</div>
			<div className="space-y-1.5">
				{shown.map((m) => (
					<div key={`${m.provider}/${m.id}`} className="rounded-lg border border-line p-2" data-testid="strength-row">
						<div className="flex min-w-0 items-center gap-2 text-sm">
							<span className="min-w-0 flex-1 truncate">
								{m.name || m.id} <small className="text-mut2">{m.providerName} · {m.tierLabel}</small>
							</span>
							{m.userEdited && (
								<button className="shrink-0 text-[11px] text-mut2 hover:text-fg" onClick={() => void put(m, null)}>
									恢复默认
								</button>
							)}
						</div>
						<div className="mt-1.5 flex flex-wrap gap-1">
							{d.labels.map((l) => {
								const on = m.tags.includes(l.key);
								return (
									<button key={l.key} className={cx("rounded-full border px-2 py-0.5 text-[11px]", on ? "border-accent bg-accent-soft text-accent" : "border-line text-mut2")} aria-pressed={on} onClick={() => void put(m, on ? m.tags.filter((t) => t !== l.key) : [...m.tags, l.key])} data-testid={`tag-${l.key}`}>
										{label.get(l.key)}
									</button>
								);
							})}
						</div>
					</div>
				))}
			</div>
			{d.models.length > 6 && (
				<button className="mt-2 text-xs text-mut hover:text-fg" onClick={() => setOpen(!open)}>
					{open ? "收起" : `展开全部 ${d.models.length} 个模型`}
				</button>
			)}
		</section>
	);
}
