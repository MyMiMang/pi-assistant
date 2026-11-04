/**
 * 设置 › 操作这台电脑 › 快速执行：开关 + 决策模型 + 「带截图给决策模型」。
 * 只读写 /api/fast-executor；模型目录由服务端给（和 设置 › 模型 的 classifier 目录同源），前端不自己拼。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { SerialWriteQueue } from "../latest-write";
import { Fold, Help, Select } from "./ui";

interface Classifier {
	provider: string;
	id: string;
	name: string;
	image: boolean;
}
interface Settings {
	enabled: boolean;
	provider: string | null;
	id: string | null;
	images: boolean;
}
interface State {
	settings: Settings;
	models: Classifier[];
	/** 现在实际用的是哪个（null = 关着或没有可用模型） */
	effective: { provider: string; id: string; images: boolean } | null;
}
const AUTO = "auto";
const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

export function FastExecutorSetting() {
	const [d, setD] = useState<State | null>(null);
	const [err, setErr] = useState("");
	const [saving, setSaving] = useState(false);
	const [open, setOpen] = useState(false);
	// 每项改了立即保存：同一个客户端的写入按点击顺序串行发，前一次失败不卡住后一次
	const queue = useRef(new SerialWriteQueue());
	useEffect(() => {
		void api<State>("/api/fast-executor")
			.then((r) => setD(r))
			.catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
	}, []);
	const save = async (patch: Partial<Settings>) => {
		setSaving(true);
		setErr("");
		try {
			setD(await queue.current.run(() => api<State>("/api/fast-executor", { method: "PUT", json: patch })));
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};
	if (!d) return <section className="text-sm" data-testid="fast-executor">{err ? <div className="text-red-600">载入失败：{err}</div> : <div className="text-mut">正在载入…</div>}</section>;
	const s = d.settings;
	const chosen = s.provider && s.id ? d.models.find((m) => m.provider === s.provider && m.id === s.id) : undefined;
	const eff = d.effective ? d.models.find((m) => m.provider === d.effective!.provider && m.id === d.effective!.id) : undefined;
	const actual = d.effective ? (eff?.name ?? d.effective.id) : null;
	return (
		<section className="space-y-2 text-sm" data-testid="fast-executor">
			<div className="flex items-center gap-2 font-semibold">
				快速执行
				<Help>
					大模型先把几步写好，决策模型（如 TypeSafe 的 Jev）每一步只从页面上真实存在的元素里挑一个，要填的内容只用大模型写的；拿不准就停下交回大模型。
					<br />
					每个动作照常按你给的权限档位审批；被拒绝时会在那一步停下，不会自己换方式重试。决策模型按次计费，很便宜。
				</Help>
			</div>
			<p className="text-xs text-mut">已经想好的几步（填表、选下拉、逐个点）交给决策模型一步步挑元素执行，比每一步都等大模型想快很多。</p>
			<label className="flex items-center gap-2">
				<input type="checkbox" className="pa-switch" role="switch" aria-label="快速执行" checked={s.enabled} disabled={saving} onChange={(e) => void save({ enabled: e.target.checked })} data-testid="fast-executor-toggle" />
				<span>{s.enabled ? "开" : "关"}</span>
			</label>
			{d.models.length ? (
				<div className="space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<span>决策模型</span>
						<Select
							value={chosen ? keyOf(chosen) : AUTO}
							ariaLabel="决策模型"
							testId="fast-executor-model"
							disabled={saving}
							options={[{ value: AUTO, label: "自动（推荐）", desc: "用第一个可用的 Jev，没有就用第一个" }, ...d.models.map((m) => ({ value: keyOf(m), label: m.name, desc: `${m.provider}${m.image ? " · 能看图" : ""}` }))]}
							onChange={(v) => void (v === AUTO ? save({ provider: null, id: null }) : save({ provider: v.split("/")[0]!, id: v.split("/").slice(1).join("/") }))}
						/>
					</div>
					<div className="text-xs text-mut" data-testid="fast-executor-effective">
						{s.enabled ? (actual ? `现在实际用：${actual}${s.images && eff?.image ? "（会一起看截图）" : ""}` : "现在没有可用的决策模型，这个工具暂时不提供") : "已关闭，助理不会用快速执行"}
					</div>
				</div>
			) : (
				<p className="text-xs text-mut" data-testid="fast-executor-empty">还没有可用的决策模型。在 设置 › 模型 里添加带分类器的服务（例如 TypeSafe 的 Jev）后就能用。</p>
			)}
			<Fold title="高级" open={open} onToggle={() => setOpen(!open)} testId="fast-executor-advanced">
				<label className="flex items-center gap-2">
					<input type="checkbox" className="pa-switch" role="switch" aria-label="带截图给决策模型" checked={s.images} disabled={saving} onChange={(e) => void save({ images: e.target.checked })} data-testid="fast-executor-images" />
					<span>带截图给决策模型</span>
				</label>
				<p className="mt-1 text-xs text-mut">能帮它分清长得像的按钮；模型不支持看图时自动不带。</p>
			</Fold>
			{saving && <div className="text-xs text-mut">正在保存…</div>}
			{err && <div className="text-xs text-red-600" data-testid="fast-executor-error">{err}</div>}
		</section>
	);
}
