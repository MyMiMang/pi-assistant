import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { ModelPickerButton } from "./ModelPicker";

type Ref = { provider: string; id: string };
type Info = { setting: Ref | null; current: (Ref & { providerName: string }) | null; source: "user" | "auto" | "none"; candidates: (Ref & { name: string; providerName: string })[] };

/** 识图模型：助理的模型不能看图时，由它替助理看图（读图片、确认搜到的图对不对）。和默认模型一样用同一个模型菜单。 */
export function VisionModelPicker() {
	const [info, setInfo] = useState<Info | null>(null);
	const load = () => void api("/api/models/vision").then(setInfo).catch(() => {});
	useEffect(load, []);
	if (!info) return null;
	const save = async (m: Ref | null) => {
		await api("/api/models/vision", { method: "PUT", json: m });
		load();
	};
	const cur = info.setting;
	const picked = cur ? (info.candidates.find((c) => c.provider === cur.provider && c.id === cur.id) ?? null) : null;
	const text = picked ? `${picked.providerName} · ${picked.name || picked.id}` : cur ? `${cur.provider} · ${cur.id}` : "自动选择（推荐）";
	return (
		<div className="space-y-2 text-sm" data-testid="vision-model">
			<ModelPickerButton
				testid="vision-model-picker"
				id="vision-model"
				models={info.candidates.map((m) => ({ provider: m.provider, id: m.id, name: m.name || m.id, providerName: m.providerName }))}
				providers={[]}
				value={cur}
				groupByProvider={false}
				placement="down"
				onOpen={load}
				buttonClass="max-w-full"
				text={text}
				title="选择识图模型"
				ariaLabel={`识图模型：${text}`}
				onPick={(m) => void save({ provider: m.provider, id: m.id })}
				header={(close) => (
					<button type="button" className="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover" data-testid="vision-model-auto" onClick={() => (close(), void save(null))}>
						<span className="min-w-0 flex-1 truncate">自动选择（推荐）</span>
						{!cur && <Check size={14} className="shrink-0 text-accent" />}
					</button>
				)}
			/>
			<div className="text-xs text-mut">
				{info.current
					? `${info.source === "auto" ? "自动选中" : "正在使用"}：${info.current.providerName} · ${info.current.id}`
					: "已配置的服务里没有支持识图的模型。助理的模型不能看图时，会告诉你它没法确认图片内容。可以添加一个支持图片的模型（如 qwen-vl、gpt-4o-mini、gemini-flash）。"}
			</div>
		</div>
	);
}
