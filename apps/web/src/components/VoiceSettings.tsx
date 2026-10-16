/**
 * 设置 › 语音配置：显式选择语音识别来源（云端 / 本地），并管理本地 SenseVoice。
 *
 * 契约（与后端 owner 对齐，前端只消费）：
 *  - GET  /api/audio/asr/source → { source: null | { location:"cloud"|"local", provider, model } }
 *  - PUT  /api/audio/asr/source   同形状；成功回显后端确认值，失败由本页回滚（不留下假值）。
 *  - 模型选项来自统一注册表（listAsrModels），不在这里新建第二套 Key。
 *
 * 关键取舍：没有选择就是「未配置」，绝不自动回落到云端；打开本页不安装 / 不启动 / 不取麦克风。
 */
import { AlertTriangle, Cloud, HardDrive, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { getVoiceSource, listAsrModels, setVoiceSource, type AsrModelOption, type VoiceSource } from "../api";
import { useStore } from "../store";
import { Badge, Button, Help, Select, cx } from "./ui";
import { LocalSenseVoiceCard } from "./ModelServices";

const keyOf = (s: { provider: string; model: string }) => `${s.provider}::${s.model}`;

export function VoiceSettings() {
	const setSettings = useStore((s) => s.set);
	const [options, setOptions] = useState<AsrModelOption[]>([]);
	const [source, setSource] = useState<VoiceSource | null>(null);
	const [sourceUnavailable, setSourceUnavailable] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadErr, setLoadErr] = useState("");
	const [saveErr, setSaveErr] = useState("");
	const [saving, setSaving] = useState(false);
	const [tab, setTab] = useState<"cloud" | "local">("cloud");
	const [pick, setPick] = useState("");

	const reload = async () => {
		setLoading(true);
		const [opts, src] = await Promise.allSettled([listAsrModels(), getVoiceSource()]);
		const next = src.status === "fulfilled" ? src.value.source : null;
		setOptions(opts.status === "fulfilled" ? opts.value : []);
		setSource(next);
		setSourceUnavailable(src.status === "rejected");
		setLoadErr(src.status === "rejected" ? (src.reason instanceof Error ? src.reason.message : String(src.reason)) : "");
		setPick(next && next.location === "cloud" ? keyOf(next) : "");
		setTab(next?.location ?? "cloud");
		setLoading(false);
	};
	useEffect(() => {
		void reload();
	}, []);

	const cloud = options.filter((o) => o.location === "cloud");
	const local = options.filter((o) => o.location === "local");
	const picked = cloud.find((o) => keyOf(o) === pick);
	const localPick = local.find((o) => o.configured) ?? local[0];
	const nameOf = (s: VoiceSource) => options.find((o) => o.provider === s.provider && o.model === s.model)?.name ?? `${s.provider} · ${s.model}`;

	// 选择 + 保存：失败时回滚到上一次生效值，不留下假值。
	const choose = async (next: VoiceSource) => {
		const prev = source;
		setSaving(true);
		setSaveErr("");
		try {
			const r = await setVoiceSource(next);
			setSource(r.source);
			setPick(r.source && r.source.location === "cloud" ? keyOf(r.source) : "");
		} catch (e) {
			setSource(prev);
			setPick(prev && prev.location === "cloud" ? keyOf(prev) : "");
			setSaveErr(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	const statusLabel = sourceUnavailable ? "设置暂不可用（没读到当前来源）" : !source ? "未配置" : `${source.location === "cloud" ? "云端" : "本地"} · ${nameOf(source)}`;

	return (
		<div className="space-y-6">
			<section className="space-y-3">
				<div className="flex items-center gap-1.5 font-semibold">
					语音配置
					<Help>
						把麦克风录音转成文字草稿。<b>没选择就是未配置</b>：麦克风会提示你来这里选，不会自动改用云端、不会静默计费。云端模型来自「模型服务」里声明的 ASR，复用同一服务的地址与 Key，不在这里再填一遍。
					</Help>
				</div>
				<div className="flex flex-wrap items-center gap-2 text-sm" data-testid="voice-source-status">
					<span className="text-mut">当前来源：</span>
					<Badge tone={sourceUnavailable ? "red" : !source ? "zinc" : source.location === "cloud" ? "amber" : "green"}>{loading ? "读取中…" : statusLabel}</Badge>
					{sourceUnavailable && <Button size="sm" variant="outline" onClick={() => void reload()}>重试</Button>}
				</div>
				{loading ? (
					<div className="flex items-center gap-2 text-xs text-mut" data-testid="voice-loading"><Loader2 size={14} className="animate-spin" /> 正在读取语音设置…</div>
				) : sourceUnavailable ? (
					<div className="text-xs text-amber-600" data-testid="voice-source-error">无法读取语音来源设置（{loadErr || "接口暂不可用"}）。先按「未配置」处理，配置与本地安装仍可在下方进行。</div>
				) : null}

				{/* 来源显式切换；切换只改显示，不会自动改当前来源 */}
				<div className="inline-flex rounded-xl border border-line p-0.5" role="tablist" aria-label="语音来源">
					<button role="tab" aria-selected={tab === "cloud"} data-testid="voice-tab-cloud" onClick={() => setTab("cloud")} className={cx("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm", tab === "cloud" ? "bg-accent-soft font-medium text-accent" : "text-mut hover:bg-hover")}>
						<Cloud size={15} /> 云端
					</button>
					<button role="tab" aria-selected={tab === "local"} data-testid="voice-tab-local" onClick={() => setTab("local")} className={cx("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm", tab === "local" ? "bg-accent-soft font-medium text-accent" : "text-mut hover:bg-hover")}>
						<HardDrive size={15} /> 本地
					</button>
				</div>

				{tab === "cloud" && (
					<div className="space-y-3" data-testid="voice-cloud-section">
						{cloud.length === 0 ? (
							<div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line p-3 text-xs text-mut" data-testid="voice-cloud-empty">
								<AlertTriangle size={14} className="shrink-0 text-amber-500" />
								<span className="min-w-0 flex-1">还没有可用的云端语音模型。</span>
								<Button size="sm" variant="outline" onClick={() => setSettings({ settings: "models" })} data-testid="voice-cloud-go-models">添加在线服务</Button>
							</div>
						) : (
							<div className="space-y-2">
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-sm text-mut">使用哪个模型</span>
									<Select value={pick} options={cloud.map((o) => ({ value: keyOf(o), label: `${o.name}（${o.provider}）` }))} onChange={setPick} ariaLabel="云端语音模型" testId="voice-cloud-select" className="min-w-[220px]" placeholder="选择模型…" />
									<Button variant="primary" disabled={!picked || saving || pick === (source?.location === "cloud" ? keyOf(source) : "")} onClick={() => picked && void choose({ location: "cloud", provider: picked.provider, model: picked.model })} data-testid="voice-cloud-save">
										{saving && <Loader2 size={14} className="animate-spin" />} 使用这个
									</Button>
								</div>
								<p className="text-xs text-mut2">音频会先到本机服务，再转发给该服务（<b>会离开本机</b>，按量计费）。模型来自「模型服务」的 ASR 声明。</p>
							</div>
						)}
						{/* 已选择云端时，隐私 / 费用提醒常驻可见 */}
						{source?.location === "cloud" && !sourceUnavailable && (
							<div className="rounded-lg border border-amber-300/60 bg-amber-50/60 p-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200" data-testid="voice-cloud-privacy">
								当前使用云端语音识别：录音音频会离开本机发送给该服务，可能产生费用；不用时可以把来源改成「本地」或保持未配置。
							</div>
						)}
					</div>
				)}

				{tab === "local" && (
					<div className="space-y-3" data-testid="voice-local-section">
						<LocalSenseVoiceCard />
						{localPick && (
							<div className="flex flex-wrap items-center gap-2">
								<Button variant="primary" disabled={saving || (source?.location === "local" && source.provider === localPick.provider && source.model === localPick.model)} onClick={() => void choose({ location: "local", provider: localPick.provider, model: localPick.model })} data-testid="voice-local-use">
									{saving && <Loader2 size={14} className="animate-spin" />} 使用本地语音识别（SenseVoice）
								</Button>
								{source?.location === "local" && <Badge tone="green">当前使用</Badge>}
							</div>
						)}
					</div>
				)}

				{saveErr && <div className="text-xs text-red-600" data-testid="voice-save-error">保存失败，已回滚：{saveErr}</div>}
				<p className="text-xs text-mut2">没有选择就是「未配置」：麦克风按钮会提示来「语音配置」，<b>不会自动改用云端</b>。</p>
			</section>
		</div>
	);
}
