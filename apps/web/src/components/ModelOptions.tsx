/** 模型显示统一用“服务名 / 模型名”（自定义服务显示用户起的名字，不显示内部 id），下拉框按服务分组 */
export interface LabeledModel {
	provider: string;
	providerName?: string;
	id: string;
	name?: string;
}
export const modelKey = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
export const providerLabel = (m: { provider: string; providerName?: string }) => m.providerName || m.provider;
export const modelLabel = (m: LabeledModel) => `${providerLabel(m)} / ${m.name || m.id}`;

/** <select> 里的选项：按服务分组（optgroup 标签是服务名，选项只写模型名；选中后显示“服务 / 模型”由调用方决定） */
export function ModelOptions({ models }: { models: LabeledModel[] }) {
	const groups = new Map<string, LabeledModel[]>();
	for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
	return (
		<>
			{[...groups.entries()].map(([p, ms]) => (
				<optgroup key={p} label={providerLabel(ms[0])} data-provider={p}>
					{ms.map((m) => (
						<option key={modelKey(m)} value={modelKey(m)}>
							{modelLabel(m)}
						</option>
					))}
				</optgroup>
			))}
		</>
	);
}
