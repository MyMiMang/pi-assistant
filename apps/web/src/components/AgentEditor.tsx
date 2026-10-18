import { ImagePlus, Trash2 } from "lucide-react";
import { DraftModelSettings, useModelDefaults } from "./DraftModelSettings";
import { useConfiguredModels } from "./ModelPicker";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Agent } from "../types";
import { Avatar, Button, cx, Input } from "./ui";

export const AGENT_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#64748b"];
const EMOJIS = ["🤖", "🦊", "🐼", "🐱", "🦉", "🐙", "🚀", "⚡️", "🌟", "🧠", "🛠️", "📚", "✍️", "🎨", "💼", "🔍"];
/** 名字建议：通用、能干活的定位 */
export const NAME_SUGGESTIONS = ["小派", "阿博", "Nova", "Atlas", "Juno", "小助", "Max", "Echo"];
const PRESETS: { label: string; description: string; persona: string }[] = [
	{ label: "全能助理", description: "什么都能做：写代码、处理文件、上网、操作电脑", persona: "" },
	{ label: "程序员", description: "写代码、调试、搭项目、读文档", persona: "你是资深全栈工程师。先读懂现有代码再修改；改动要小而完整；完成后说明改了什么、怎么验证。" },
	{ label: "研究员", description: "查资料、读网页和文档、整理成报告", persona: "你擅长检索和整理信息。结论先行，注明来源链接，区分事实和推测，最后给出可行动的建议。" },
	{ label: "写作助手", description: "写文章、润色、翻译、做 PPT 大纲", persona: "你擅长中文写作与翻译。行文简洁自然，避免空话套话；先给提纲再成文。" },
	{ label: "办公助手", description: "表格、文档、邮件、日程这些日常事务", persona: "你擅长处理 Excel/Word/PDF 和日常办公事务。产出直接可用的文件，并用一句话说明内容。" },
];

type Draft = { name: string; avatar: string; color: string; description: string; persona: string; model: string; thinking: string | null };

/** 创建 / 编辑助理（首次向导、侧边栏“新建助理”、右侧“资料”页共用）。
 *  layout="profile"：助理设置里的资料页——正文独立滚动 + 固定底部「保存资料」，只 PATCH 资料字段（不碰 model / thinking / fast）。
 */
export function AgentEditor({ agent, onDone, onCancel, submitLabel, showModel = true, layout = "default" }: { agent?: Agent; onDone?: (a: Agent) => void; onCancel?: () => void; submitLabel?: string; showModel?: boolean; layout?: "default" | "profile" }) {
	const init = (a?: Agent): Draft => ({
		name: a?.name ?? "",
		avatar: a?.avatar ?? EMOJIS[0],
		color: a?.color ?? AGENT_COLORS[0],
		description: a?.description ?? PRESETS[0].description,
		persona: a?.persona ?? "",
		model: a?.model_provider && a?.model_id ? `${a.model_provider}/${a.model_id}` : "",
		thinking: a && "thinkingSetting" in a ? a.thinkingSetting ?? null : a?.thinking ?? null,
	});
	const [d, setD] = useState<Draft>(() => init(agent));
	const [file, setFile] = useState<File | null>(null);
	const [preview, setPreview] = useState<string | null>(null);
	const [modelDirty, setModelDirty] = useState(false);
	const [thinkingDirty, setThinkingDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [picker, setPicker] = useState(false);
	const [confirmDel, setConfirmDel] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);
	const editVersion = useRef(0);
	const avatarVersion = useRef(0);
	const alive = useRef(true);
	useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
	const set = (p: Partial<Draft>) => {
		if ("avatar" in p) avatarVersion.current++;
		editVersion.current++;
		setSaved(false);
		setDirty(true);
		setD((x) => ({ ...x, ...p }));
	};
	useEffect(() => { setD(init(agent)); setFile(null); setPreview(null); setModelDirty(false); setThinkingDirty(false); setDirty(false); setPicker(false); setSaved(false); }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
	// 其他入口/设备改了模型设置时，未编辑的字段跟进真值；保留用户正在改的草稿。
	useEffect(() => {
		const next = init(agent);
		setD((d) => ({ ...d, ...(!modelDirty ? { model: next.model } : {}), ...(!thinkingDirty ? { thinking: next.thinking } : {}) }));
	}, [agent?.model_provider, agent?.model_id, agent?.thinkingSetting, agent?.thinking, modelDirty, thinkingDirty]);
	const pickFile = (f: File | undefined) => {
		if (!f) return;
		if (f.size > 2 * 1024 * 1024) return setError("头像图片不能超过 2MB");
		avatarVersion.current++;
		editVersion.current++;
		setSaved(false);
		setFile(f);
		setPreview(URL.createObjectURL(f));
		setDirty(true);
		setError("");
	};
	const submit = async () => {
		if (busy) return;
		if (!d.name.trim()) return setError("请给助理起个名字");
		const savingVersion = editVersion.current;
		const savingAvatarVersion = avatarVersion.current;
		setBusy(true);
		setError("");
		try {
			const [provider, ...rest] = d.model.split("/");
			const body = {
				name: d.name.trim(),
				avatar: file ? undefined : d.avatar.startsWith("img:") && !agent ? EMOJIS[0] : d.avatar,
				color: d.color,
				description: d.description,
				persona: d.persona,
				...(showModel && (!agent || modelDirty) ? { model: d.model ? { provider, id: rest.join("/") } : null } : {}),
				...(showModel && (!agent || thinkingDirty) ? { thinking: d.thinking } : {}),
			};
			let a = await api<Agent>(agent ? `/api/agents/${agent.id}` : "/api/agents", { method: agent ? "PATCH" : "POST", json: body });
			if (file) {
				const fd = new FormData();
				fd.append("file", file);
				a = await api<Agent>(`/api/agents/${a.id}/avatar`, { method: "POST", body: fd });
				// 文字可在上传期间继续编辑；只回填这次已确认的头像，不覆盖后来另选的图片或表情。
				if (alive.current && savingAvatarVersion === avatarVersion.current) {
					const avatar = a.avatar;
					setD((d) => ({ ...d, avatar }));
					setFile(null);
					setPreview(null);
				}
			}
			await useStore.getState().loadAgents();
			if (!alive.current) return;
			if (savingVersion === editVersion.current) {
				setD((d) => ({ ...d, avatar: a.avatar, model: a.model_provider && a.model_id ? `${a.model_provider}/${a.model_id}` : "", thinking: a.thinkingSetting ?? null }));
				setModelDirty(false);
				setThinkingDirty(false);
				setDirty(false);
				setSaved(true);
				setTimeout(() => { if (alive.current) setSaved(false); }, 1500);
			}
			onDone?.(a);
		} catch (e) {
			if (alive.current) setError((e as Error).message);
		} finally {
			if (alive.current) setBusy(false);
		}
	};
	const remove = async () => {
		if (!agent) return;
		await api(`/api/agents/${agent.id}`, { method: "DELETE" });
		const s = useStore.getState();
		await s.loadAgents();
		const next = useStore.getState().agents[0];
		if (next) s.selectAgent(next.id);
		else s.set({ current: null });
	};
	const avatarText = d.avatar.startsWith("img:") ? d.avatar : d.avatar || d.name.slice(0, 1) || "?";
	const profile = layout === "profile";
	const swatches = (
		<div className="min-w-0 flex-1 space-y-2">
			<div className="flex flex-wrap gap-1.5">
				{EMOJIS.map((e) => (
					<button
						key={e}
						type="button"
						onClick={() => (set({ avatar: e }), setFile(null), setPreview(null))}
						className={cx("flex h-8 w-8 items-center justify-center rounded-full text-lg transition hover:bg-zinc-100 dark:hover:bg-zinc-800", !preview && d.avatar === e && "bg-zinc-100 ring-2 ring-accent dark:bg-zinc-800")}
					>
						{e}
					</button>
				))}
				<button
					type="button"
					title="用名字首字"
					onClick={() => (set({ avatar: d.name.slice(0, 1) || "A" }), setFile(null), setPreview(null))}
					className={cx("flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold dark:bg-zinc-800", !preview && d.avatar === (d.name.slice(0, 1) || "A") && "ring-2 ring-accent")}
				>
					{d.name.slice(0, 1) || "A"}
				</button>
			</div>
			<div className="flex flex-wrap gap-2">
				{AGENT_COLORS.map((c) => (
					<button key={c} type="button" aria-label={c} onClick={() => set({ color: c })} className={cx("h-6 w-6 rounded-full ring-offset-2 ring-offset-white transition dark:ring-offset-zinc-900", c === d.color && "ring-2 ring-zinc-400")} style={{ background: c }} />
				))}
			</div>
		</div>
	);
	const footer = (
		<footer className="pa-info-footer" data-testid="agent-profile-footer">
			{error ? (
				<span className="pa-info-footer-note text-red-600 dark:text-red-400" role="alert">{error}</span>
			) : (
				<span className="pa-info-footer-note" data-testid="agent-profile-state">{dirty ? "有未保存修改" : saved ? "已保存" : "资料已保存"}</span>
			)}
			<Button variant="primary" size="sm" disabled={busy} onClick={submit} data-testid="agent-profile-save">
				{busy ? "保存中…" : "保存资料"}
			</Button>
		</footer>
	);
	const body = (
		<>
			{profile && <h2 className="pa-info-h2 !mt-0">基本信息</h2>}
			{profile ? (
				<div className="pa-profile-avatar">
					<Avatar agentId={agent?.id} text={avatarText} color={d.color} size={44} src={preview ?? undefined} />
					<div className="pa-profile-avatar-txt">
						助理头像
						<small>{preview || file ? "已选择新图片，保存后生效" : d.avatar.startsWith("img:") ? "当前使用上传的图片" : "表情或名字首字"}</small>
					</div>
					<Button size="sm" variant="outline" onClick={() => setPicker(!picker)} aria-expanded={picker} data-testid="agent-avatar-change">更换</Button>
				</div>
			) : (
				<div className="flex items-center gap-4">
					<button type="button" className="group relative" title="上传图片" onClick={() => fileRef.current?.click()}>
						<Avatar agentId={agent?.id} text={avatarText} color={d.color} size={64} src={preview ?? undefined} />
						<span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition group-hover:opacity-100">
							<ImagePlus size={20} />
						</span>
					</button>
					{swatches}
				</div>
			)}
			{profile && picker && (
				<div className="mt-3 space-y-3">
					{swatches}
					<Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
						<ImagePlus size={14} /> 上传图片（不超过 2MB）
					</Button>
				</div>
			)}
			<input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-testid="avatar-file" onChange={(e) => pickFile(e.target.files?.[0])} />
			{/* 名字 */}
			<label className={cx("block space-y-1.5", profile && "mt-4")}>
				<span className="text-xs font-medium text-zinc-500">名字</span>
				<Input placeholder="给助理起个名字" value={d.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} autoFocus={!agent} />
				{!agent && (
					<div className="flex flex-wrap gap-1.5 pt-1">
						{NAME_SUGGESTIONS.map((n) => (
							<button key={n} type="button" onClick={() => set({ name: n })} className={cx("rounded-full bg-zinc-100 px-3 py-1 text-xs transition hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700", d.name === n && "bg-accent/15 text-accent")}>
								{n}
							</button>
						))}
					</div>
				)}
			</label>
			{/* 定位 / 简介 */}
			<div className="space-y-1.5">
				{!profile && <span className="text-xs font-medium text-zinc-500">擅长什么</span>}
				{!profile && (
					<div className="flex flex-wrap gap-1.5">
						{PRESETS.map((p) => (
							<button
								key={p.label}
								type="button"
								onClick={() => set({ description: p.description, persona: p.persona })}
								className={cx("rounded-full px-3 py-1 text-xs transition", d.description === p.description ? "bg-accent text-white" : "bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700")}
							>
								{p.label}
							</button>
						))}
					</div>
				)}
				{profile ? (
					<label className="block space-y-1.5">
						<span className="text-xs font-medium text-zinc-500">简介</span>
						<textarea
							value={d.description}
							onChange={(e) => set({ description: e.target.value })}
							maxLength={200}
							rows={3}
							placeholder="一句话介绍（显示在侧边栏和概览里）"
							className="w-full resize-y rounded-xl border border-line bg-card px-3 py-2 text-sm outline-none transition focus:border-accent"
						/>
					</label>
				) : (
					<Input placeholder="一句话介绍（显示在侧边栏和概览里）" value={d.description} maxLength={200} onChange={(e) => set({ description: e.target.value })} />
				)}
			</div>
			{profile ? (
				<details className="pa-info-details" open data-testid="agent-persona-details">
					<summary>
						人设与偏好
						<small>回答方式、专长与协作习惯</small>
					</summary>
					<div className="pa-info-details-body">
						<div className="flex flex-wrap gap-1.5">
							{PRESETS.map((p) => (
								<button
									key={p.label}
									type="button"
									onClick={() => set({ description: p.description, persona: p.persona })}
									className={cx("pa-chip sm", d.persona === p.persona && "!border-accent !text-accent")}
								>
									{p.label}
								</button>
							))}
						</div>
						<textarea
							value={d.persona}
							onChange={(e) => set({ persona: e.target.value })}
							className="h-44 w-full resize-y rounded-xl border border-line bg-card px-3 py-2 text-sm outline-none transition focus:border-accent"
							placeholder="例如：回答要简洁；称呼我 deng；改代码前先说明计划"
						/>
					</div>
				</details>
			) : (
				<label className="block space-y-1.5">
					<span className="text-xs font-medium text-zinc-500">人设与偏好（可选）</span>
					<textarea
						value={d.persona}
						onChange={(e) => set({ persona: e.target.value })}
						className="h-24 w-full resize-none rounded-xl bg-zinc-100 p-3 outline-none transition focus:bg-white focus:ring-2 focus:ring-accent/40 dark:bg-zinc-800/80 dark:focus:bg-zinc-900"
						placeholder="例如：回答要简洁；称呼我 deng；改代码前先说明计划"
					/>
				</label>
			)}
			{showModel && (
				<div className="space-y-1.5">
					<div className="text-xs font-medium text-mut">模型与思考强度</div>
					<AgentModelDraft model={d.model} thinking={d.thinking} disabled={busy} onModel={(model) => { set({ model }); setModelDirty(true); }} onThinking={(thinking) => { set({ thinking }); setThinkingDirty(true); }} />
				</div>
			)}
			{!profile && error && <div className="rounded-xl bg-red-50 px-3 py-2 text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</div>}
			{profile ? (
				<details className="pa-info-details" data-testid="agent-danger-details">
					<summary>更多操作</summary>
					<div className="pa-info-details-body">
						{agent &&
							(confirmDel ? (
								<div className="flex flex-wrap items-center gap-2">
									<Button variant="danger" size="sm" onClick={remove}>
										确认删除
									</Button>
									<Button variant="ghost" size="sm" onClick={() => setConfirmDel(false)}>
										取消
									</Button>
								</div>
							) : (
								<Button variant="ghost" size="sm" className="text-red-600 dark:text-red-400" onClick={() => setConfirmDel(true)}>
									<Trash2 size={14} /> 删除助理
								</Button>
							))}
						{confirmDel && <p className="text-xs text-zinc-500">聊天记录会清除，文件移进回收站。</p>}
					</div>
				</details>
			) : null}
			{!profile && (
				<>
					<div className="flex items-center gap-2">
						{agent &&
							(confirmDel ? (
								<>
									<Button variant="danger" size="sm" onClick={remove}>
										确认删除
									</Button>
									<Button variant="ghost" size="sm" onClick={() => setConfirmDel(false)}>
										取消
									</Button>
								</>
							) : (
								<Button variant="ghost" size="sm" className="text-red-600 dark:text-red-400" onClick={() => setConfirmDel(true)}>
									<Trash2 size={14} /> 删除助理
								</Button>
							))}
						<div className="flex-1" />
						{onCancel && (
							<Button variant="ghost" onClick={onCancel}>
								取消
							</Button>
						)}
						<Button variant="primary" disabled={busy} onClick={submit}>
							{saved ? "已保存" : (submitLabel ?? (agent ? "保存" : "创建"))}
						</Button>
					</div>
					{confirmDel && <p className="text-xs text-zinc-500">聊天记录会清除，文件移进回收站。</p>}
				</>
			)}
		</>
	);
	if (profile)
		return (
			<div className="pa-profile" data-testid="agent-profile">
				<div className="pa-profile-body space-y-4">{body}</div>
				{footer}
			</div>
		);
	return (
		<div className="space-y-5 text-sm" data-testid={agent ? "agent-profile" : "agent-create"}>
			{body}
		</div>
	);
}

function AgentModelDraft({ model, thinking, disabled, onModel, onThinking }: { model: string; thinking: string | null; disabled: boolean; onModel: (model: string) => void; onThinking: (level: string | null) => void }) {
	const catalog = useConfiguredModels();
	const defaults = useModelDefaults();
	const [provider, ...rest] = model.split("/");
	return <DraftModelSettings id="agent-draft" models={catalog.models} providers={catalog.providers} value={model ? { provider, id: rest.join("/") } : null} thinking={thinking} defaults={defaults} loading={catalog.loading} error={catalog.error} disabled={disabled} reload={catalog.reload} onModel={(m) => onModel(m ? `${m.provider}/${m.id}` : "")} onThinking={onThinking} />;
}
