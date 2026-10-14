/**
 * 模型擅长标签：助理组建团队时按这些标签给角色挑模型。
 * 标签默认按模型系列和公开资料推断，可以按模型改。
 * 位置：只在「设置 › 模型 › 模型服务」里对应渠道展开后的模型行内编辑（不再有全局长清单）。
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { cx } from "./ui";

export interface StrengthTag {
	key: string;
	label: string;
}
export interface StrengthModel {
	provider: string;
	providerName: string;
	id: string;
	name?: string;
	tags: string[];
	tierLabel: string;
	userEdited: boolean;
}
export interface StrengthsData {
	labels: StrengthTag[];
	models: StrengthModel[];
}

/** 读一次全部模型的能力标签（按 `${provider}/${id}` 索引），并提供按模型改标签 */
export function useModelStrengths() {
	const [data, setData] = useState<StrengthsData | null>(null);
	const reload = () =>
		void api<StrengthsData>("/api/model-strengths")
			.then(setData)
			.catch(() => setData(null));
	useEffect(reload, []);
	const put = async (provider: string, id: string, tags: string[] | null) => {
		await api("/api/model-strengths", { method: "PUT", json: { provider, id, tags } });
		reload();
	};
	const byModel = new Map((data?.models ?? []).map((m) => [`${m.provider}/${m.id}`, m]));
	return { data, byModel, put, reload };
}

/** 一个模型的能力标签开关（展开在渠道的模型行里） */
export function StrengthTags({ labels, model, onPut }: { labels: StrengthTag[]; model: StrengthModel; onPut: (tags: string[] | null) => void }) {
	return (
		<div className="flex flex-wrap items-center gap-1" data-testid="strength-row" data-model={`${model.provider}/${model.id}`}>
			{labels.map((l) => {
				const on = model.tags.includes(l.key);
				return (
					<button key={l.key} className={cx("rounded-full border px-2 py-0.5 text-[11px]", on ? "border-accent bg-accent-soft text-accent" : "border-line text-mut2")} aria-pressed={on} onClick={() => onPut(on ? model.tags.filter((t) => t !== l.key) : [...model.tags, l.key])} data-testid={`tag-${l.key}`}>
						{l.label}
					</button>
				);
			})}
			<span className="ml-1 text-[11px] text-mut2">
				{model.tierLabel}
				{model.userEdited ? " · 已改" : ""}
			</span>
			{model.userEdited && (
				<button className="text-[11px] text-mut2 hover:text-fg" onClick={() => onPut(null)} data-testid="strength-reset">
					恢复默认
				</button>
			)}
		</div>
	);
}
