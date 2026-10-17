/** 创建/编辑表单的模型草稿：只改调用方草稿，最终由原确认/保存接口提交。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../api";
import { fitThinkingLevel, THINKING_LABEL } from "../thinking-slider";
import type { Provider } from "../types";
import { modelLabel } from "./ModelOptions";
import { ModelPickerButton, ThinkingButton, type ModelEntry } from "./ModelPicker";

type ModelRef = { provider: string; id: string };
export interface ModelDefaults { model: ModelRef | null; thinking: string | null }

/** 读取真正的新助理默认值；失败有状态和重试，不猜 medium 或模型档位。 */
export function useModelDefaults(enabled = true) {
	const [data, setData] = useState<ModelDefaults>({ model: null, thinking: null });
	const [loading, setLoading] = useState(enabled);
	const [error, setError] = useState(false);
	const generation = useRef(0);
	const reload = useCallback(() => {
		if (!enabled) return;
		const gen = ++generation.current;
		setLoading(true);
		void api<ModelDefaults>("/api/models/defaults").then((d) => {
			if (gen !== generation.current) return;
			setData(d);
			setError(false);
		}).catch(() => {
			if (gen === generation.current) setError(true);
		}).finally(() => {
			if (gen === generation.current) setLoading(false);
		});
	}, [enabled]);
	useEffect(() => { reload(); return () => { generation.current++; }; }, [reload]);
	return { ...data, loading, error, reload };
}

export function DraftModelSettings({ id, models, providers = [], value, thinking, defaults, loading = false, error = false, disabled = false, reload, onModel, onThinking }: {
	id: string;
	models: ModelEntry[];
	providers?: Provider[];
	value: ModelRef | null;
	thinking: string | null;
	defaults: ReturnType<typeof useModelDefaults>;
	loading?: boolean;
	error?: boolean;
	disabled?: boolean;
	reload: () => void;
	onModel: (m: ModelRef | null) => void;
	onThinking: (level: string | null) => void;
}) {
	const actual = value ?? defaults.model;
	const entry = models.find((m) => m.provider === actual?.provider && m.id === actual?.id);
	// 默认强度尚未知时不能用最低档冒充默认；保留明确加载/错误状态。
	const levels = thinking === null && defaults.thinking === null && (defaults.loading || defaults.error) ? [] : entry?.thinking ?? [];
	const effective = fitThinkingLevel(levels, thinking ?? defaults.thinking);
	const needsDefault = !value || thinking === null;
	const pending = loading || (needsDefault && defaults.loading);
	const missingModel = !!actual && !entry && !loading && !error;
	const failed = error || (needsDefault && defaults.error) || missingModel;
	const retry = () => { reload(); defaults.reload(); };
	const modelText = value ? (entry ? modelLabel(entry) : `${value.provider} / ${value.id}`) : `默认模型${entry ? ` · ${entry.name}` : ""}`;
	const wanted = thinking ? (THINKING_LABEL[thinking] ?? thinking) : "默认";
	const actualLabel = effective ? (THINKING_LABEL[effective] ?? effective) : "";
	const strengthText = pending && !levels.length ? "加载中" : failed && !levels.length ? "加载失败" : levels.length === 0 ? "不可调" : thinking && thinking !== effective ? `${wanted} → ${actualLabel}` : thinking ? wanted : `默认·${actualLabel}`;
	return (
		<div className="min-w-0 space-y-1.5" data-testid={id}>
			<div className="flex min-w-0 flex-wrap items-center gap-1.5">
				<ModelPickerButton
					testid={`${id}-model`}
					models={models}
					providers={providers}
					value={actual}
					groupByProvider
					placement="down"
					disabled={disabled}
					loading={loading}
					error={error}
					onRetry={retry}
					onOpen={reload}
					buttonClass="max-w-full"
					text={modelText}
					title="按服务分组选择模型"
					ariaLabel={`模型：${modelText}`}
					onPick={(m) => onModel({ provider: m.provider, id: m.id })}
					header={(close) => <button type="button" className="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover" data-testid={`${id}-default`} onClick={() => { close(); onModel(null); }}>
						<span className="min-w-0 flex-1 truncate">使用默认模型</span>{!value && <Check size={14} className="shrink-0 text-accent" />}
					</button>}
				/>
				<ThinkingButton
					testid={`${id}-thinking`}
					levels={levels}
					current={thinking}
					effective={effective}
					followLabel="跟随默认"
					modelName={entry?.name ?? actual?.id}
					text={strengthText}
					ariaLabel={`思考强度：${strengthText}`}
					loading={pending}
					error={failed}
					onRetry={retry}
					disabled={disabled}
					onPick={onThinking}
				/>
			</div>
			{failed && <div className="text-xs text-red-600" role="alert">{missingModel ? "当前模型不在可用目录中，请重新选择或重试。" : "模型配置没加载完整，已保留当前选择。"}<button type="button" className="ml-1 underline" disabled={disabled} onClick={retry}>重试</button></div>}
		</div>
	);
}
