import { useEffect, useState } from "react";
import { api } from "../api";

type Ref = { provider: string; id: string };
type Info = { setting: Ref | null; current: (Ref & { providerName: string }) | null; source: "user" | "auto" | "none"; candidates: (Ref & { name: string; providerName: string })[] };

/** 识图模型：助理的模型不能看图时，由它替助理看图（读图片、确认搜到的图对不对） */
export function VisionModelPicker() {
	const [info, setInfo] = useState<Info | null>(null);
	const load = () => void api("/api/models/vision").then(setInfo).catch(() => {});
	useEffect(load, []);
	if (!info) return null;
	const val = info.setting ? `${info.setting.provider}\u0000${info.setting.id}` : "";
	return (
		<div className="space-y-2 text-sm" data-testid="vision-model">
			<select
				value={val}
				onChange={async (e) => {
					const [provider, id] = e.target.value.split("\u0000");
					await api("/api/models/vision", { method: "PUT", json: e.target.value ? { provider, id } : null });
					load();
				}}
				className="h-9 w-full max-w-md rounded-lg border border-line bg-card px-2 text-sm"
			>
				<option value="">自动选择（推荐）</option>
				{info.candidates.map((m) => (
					<option key={`${m.provider}/${m.id}`} value={`${m.provider}\u0000${m.id}`}>
						{m.providerName} · {m.name || m.id}
					</option>
				))}
			</select>
			<div className="text-xs text-mut">
				{info.current
					? `${info.source === "auto" ? "自动选中" : "正在使用"}：${info.current.providerName} · ${info.current.id}`
					: "已配置的服务里没有支持识图的模型。助理的模型不能看图时，会告诉你它没法确认图片内容。可以添加一个支持图片的模型（如 qwen-vl、gpt-4o-mini、gemini-flash）。"}
			</div>
		</div>
	);
}
