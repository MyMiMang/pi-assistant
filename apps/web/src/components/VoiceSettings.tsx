/**
 * 设置 › 语音配置：显式选择语音识别来源（云端 / 本地），并管理本地 SenseVoice。
 *
 * 契约（后端 `settings-functional-backend` 冻结，前端只消费）：
 *  - GET  /api/audio/asr/source → { source: null | { location, provider, model }, options: [{ location, provider, model, name, protocol, availability, reason, selected }] }
 *  - PUT  /api/audio/asr/source   同 DTO；`availability`：ready | not_configured | not_installed | not_running | deleted（只有 ready 表示当下可用）。
 *  - 候选（含 availability/reason）全部来自后端，不在这里新建第二套 Key，也不自动挑第一个云。
 *
 * 关键取舍：没有选择就是「未配置」，绝不自动回落到云端；打开本页不安装 / 不启动 / 不取麦克风 / 不连云。
 */
import { AlertTriangle, Cloud, HardDrive, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { getVoiceSource, setVoiceSource, type VoiceSource, type VoiceSourceOption, type VoiceSourceView } from "../api";
import { useStore } from "../store";
import { Badge, Button, Help, Select, cx } from "./ui";
import { LocalSenseVoiceCard } from "./ModelServices";

const keyOf = (o: { provider: string; model: string }) => `${o.provider}::${o.model}`;
const AVAIL_LABEL: Record<string, string> = { ready: "可用", not_configured: "未配置", not_installed: "未安装", not_running: "未运行", deleted: "已不可用" };

export function VoiceSettings() {
	const setSettings = useStore((s) => s.set);
	const [view, setView] = useState<VoiceSourceView | null>(null);
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
		try {
			const v = await getVoiceSource();
			setView(v);
			setSource(v.source);
			setPick(v.source && v.source.location === "cloud" ? keyOf(v.source) : "");
			setTab(v.source?.location ?? "cloud");
			setSourceUnavailable(false);
			setLoadErr("");
		} catch (e) {
			setView({ source: null, options: [] });
			setSource(null);
			setPick("");
			setSourceUnavailable(true);
			setLoadErr(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};
	useEffect(() => {
		void reload();
	}, []);

	const options = view?.options ?? [];
	const cloud = options.filter((o) => o.location === "cloud");
	const local = options.filter((o) => o.location === "local");
	const picked = cloud.find((o) => keyOf(o) === pick) ?? null;
	const selected = options.find((o) => o.selected) ?? null;
	const localPick = local.find((o) => o.selected) ?? local[0] ?? null;
	// 云端只有 ready 才能保存（未配置会被后端 400）；本地允许存「未安装 / 未运行」的意图，但 deleted / not_configured 不允许。
	const canSave = (o: VoiceSourceOption | null) => !!o && (o.availability === "ready" || (o.location === "local" && (o.availability === "not_installed" || o.availability === "not_running")));
	const statusLabel = () => {
		if (loading) return "读取中…";
		if (sourceUnavailable) return "设置暂不可用（没读到当前来源）";
		if (!source) return "未配置";
		if (!selected) return `${source.location === "cloud" ? "云端" : "本地"} · ${source.provider} · ${source.model}`;
		return `${source.location === "cloud" ? "云端" : "本地"} · ${selected.name}${selected.availability === "ready" ? "" : ` · ${AVAIL_LABEL[selected.availability] ?? selected.availability}`}`;
	};

	// 选择 + 保存：失败时回滚到上一次生效值（重新拉取），不留下假值。
	const choose = async (next: VoiceSource) => {
		setSaving(true);
		setSaveErr("");
		try {
			const v = await setVoiceSource(next);
			setView(v);
			setSource(v.source);
			setPick(v.source && v.source.location === "cloud" ? keyOf(v.source) : "");
		} catch (e) {
			// 保存失败：重新拉取仍生效的值，并把草稿恢复到它。
			setSaveErr(e instanceof Error ? e.message : String(e));
			try {
				const v = await getVoiceSource();
				setView(v);
				setSource(v.source);
				setPick(v.source && v.source.location === "cloud" ? keyOf(v.source) : "");
			} catch {
				/* 回滚也读不到：保持现状并显示错误 */
			}
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-6">
			<section className="space-y-3">
				<div className="flex items-center gap-1.5 font-semibold">
					语音配置
					<Help>
						把麦克风录音转成文字草稿。<b>没选择就是未配置</b>：麦克风会提示你来这里选，不会自动改用云端、不会静默计费。云端模型来自「模型服务」里声明的 ASR，复用同一服务的地址与 Key，不在这里再填一遍。
					</Help>
				</div>
				<div className="flex flex-wrap items-center gap-2 text-sm" data-testid="voice-source-status" data-availability={selected?.availability ?? (source ? "unknown" : "none")}>
					<span className="text-mut">当前来源：</span>
					<Badge tone={sourceUnavailable || (selected && selected.availability === "deleted") ? "red" : !source ? "zinc" : selected?.availability === "ready" ? "green" : "amber"}>{statusLabel()}</Badge>
					{source && selected && selected.availability !== "ready" && selected.reason && <span className="text-xs text-amber-600" data-testid="voice-source-reason">{selected.reason}</span>}
					{sourceUnavailable && (
						<Button size="sm" variant="outline" onClick={() => void reload()}>
							重试
						</Button>
					)}
				</div>
				{sourceUnavailable && <div className="text-xs text-amber-600" data-testid="voice-source-error">无法读取语音来源设置（{loadErr || "接口暂不可用"}）。先按「未配置」处理，本地安装仍可在下方进行。</div>}

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
								<Button size="sm" variant="outline" onClick={() => setSettings({ settings: "models" })} data-testid="voice-cloud-go-models">
									添加在线服务
								</Button>
							</div>
						) : (
							<div className="space-y-2">
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-sm text-mut">使用哪个模型</span>
									<Select value={pick} options={cloud.map((o) => ({ value: keyOf(o), label: `${o.name}${o.availability === "ready" ? "" : `（${AVAIL_LABEL[o.availability] ?? o.availability}）`}` }))} onChange={setPick} ariaLabel="云端语音模型" testId="voice-cloud-select" className="min-w-[220px]" placeholder="选择模型…" />
									<Button variant="primary" disabled={!picked || saving || !canSave(picked) || pick === (source?.location === "cloud" ? keyOf(source) : "")} onClick={() => picked && void choose({ location: "cloud", provider: picked.provider, model: picked.model })} data-testid="voice-cloud-save">
										{saving && <Loader2 size={14} className="animate-spin" />} 使用这个
									</Button>
								</div>
								{picked && picked.availability !== "ready" && picked.reason && <p className="text-xs text-amber-600" data-testid="voice-cloud-reason">{picked.reason}</p>}
								{source?.location !== "cloud" && <p className="text-xs text-mut2">音频会先到本机服务，再转发给该服务（<b>会离开本机</b>，按量计费）。模型来自「模型服务」的 ASR 声明。</p>}
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
							<div className="space-y-1">
								<div className="flex flex-wrap items-center gap-2">
									<Button
										variant="primary"
										disabled={saving || !canSave(localPick) || (source?.location === "local" && source.provider === localPick.provider && source.model === localPick.model)}
										onClick={() => void choose({ location: "local", provider: localPick.provider, model: localPick.model })}
										data-testid="voice-local-use"
									>
										{saving && <Loader2 size={14} className="animate-spin" />} 使用本地语音识别（SenseVoice）
									</Button>
									{source?.location === "local" && <Badge tone={localPick.availability === "ready" ? "green" : "amber"}>{localPick.availability === "ready" ? "当前使用" : `${AVAIL_LABEL[localPick.availability] ?? localPick.availability}（已选，点麦克风会尝试加载）`}</Badge>}
								</div>
								{localPick.availability === "not_installed" && <p className="text-xs text-mut2">可以先把本地语音识别设为来源；未安装前点麦克风不会录音，装好后会自动用上。</p>}
								{localPick.reason && localPick.availability !== "ready" && <p className="text-xs text-amber-600" data-testid="voice-local-reason">{localPick.reason}</p>}
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
