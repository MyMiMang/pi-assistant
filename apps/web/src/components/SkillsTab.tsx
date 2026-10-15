import { HindsightSettings } from "./HindsightSettings";
import { ChevronLeft, History, Lock, Plus, Puzzle, RotateCcw, Trash2, Upload, UserCog } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useStore } from "../store";
import type { SkillMeta } from "../types";
import { Badge, Button, Help, Input, Modal, Select, useConfirm } from "./ui";
import Markdown from "./Markdown";
import { DiffView } from "./Cards";

type Version = { version: number; source: string; note: string | null; created_at: number; diff: string };
const SRC: Record<string, string> = { user: "你修改", agent: "助理修改", rollback: "回滚", initial: "初始版本" };

type Full = SkillMeta & { body: string };

/** 设置 › 技能库：内置技能（只读）+ 我的技能（可编辑）。用的是 Pi 原生 Agent Skills（SKILL.md）。 */
export function SkillsTab() {
	const version = useStore((s) => s.skillsVersion);
	const agents = useStore((s) => s.agents);
	const [list, setList] = useState<SkillMeta[]>([]);
	const [open, setOpen] = useState<Full | null>(null);
	const [assign, setAssign] = useState<SkillMeta | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [edit, setEdit] = useState<{ previousName?: string; name: string; description: string; body: string } | null>(null);
	const [err, setErr] = useState("");
	const [versions, setVersions] = useState<Version[] | null>(null);
	const [openV, setOpenV] = useState<number | null>(null);
	const [suggest, setSuggest] = useState<{ enabled: boolean } | null>(null);
	const [confirmDlg, askConfirm] = useConfirm();
	const [delBusy, setDelBusy] = useState("");
	const delRef = useRef(false);
	const load = () => api<SkillMeta[]>("/api/skills").then(setList);
	useEffect(() => {
		void api("/api/skill-suggest").then(setSuggest);
	}, []);
	useEffect(() => {
		void load();
	}, [version]);
	const view = async (name: string) => {
		setOpen(await api<Full>(`/api/skills/${name}`));
		setVersions(await api<Version[]>(`/api/skills/${name}/versions`));
		setOpenV(null);
	};
	useEffect(() => {
		if (open) void view(open.name);
	}, [version]);
	const save = async () => {
		if (!edit) return;
		setErr("");
		try {
			const s = await api<Full>("/api/skills", { method: "POST", json: edit });
			setEdit(null);
			await load();
			await view(s.name);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	};
	const del = async () => {
		if (!open || delRef.current) return;
		const affected = open.enabledAgents ?? [];
		const names = affected.map((id) => agents.find((a) => a.id === id)?.name ?? id);
		const ok = await askConfirm({
			title: `删除技能「${open.name}」？`,
			body: affected.length ? `有 ${affected.length} 个助理正在启用它（${names.join("、")}），删除后它们将不再有该技能，无法恢复。` : "删除后无法恢复。",
			ok: "删除",
			danger: true,
		});
		if (!ok || delRef.current) return;
		delRef.current = true;
		setDelBusy("del");
		setErr("");
		try {
			await api(`/api/skills/${open.name}${affected.length ? "?force=1" : ""}`, { method: "DELETE" });
			setOpen(null);
			void load();
		} catch (e) {
			setErr(`删除失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			delRef.current = false;
			setDelBusy("");
		}
	};
	const rollback = async (version: number) => {
		if (!open || delRef.current) return;
		const ok = await askConfirm({ title: `把「${open.name}」回滚到 v${version}？`, body: "会生成一个新版本，历史都保留。", ok: "回滚", danger: true });
		if (!ok || delRef.current) return;
		delRef.current = true;
		setDelBusy(`rollback:${version}`);
		setErr("");
		try {
			await api(`/api/skills/${open.name}/rollback`, { method: "POST", json: { version } });
			await view(open.name);
		} catch (e) {
			setErr(`回滚失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			delRef.current = false;
			setDelBusy("");
		}
	};
	if (edit)
		return (
			<div className="space-y-3" data-testid="skill-form">
				<button className="flex items-center gap-1 text-sm text-mut hover:text-fg" onClick={() => setEdit(null)}>
					<ChevronLeft size={15} /> 返回
				</button>
				<label className="block space-y-1">
					<span className="text-xs font-medium text-mut">名称（小写字母、数字、连字符）</span>
					<Input className="font-mono" placeholder="weekly-report" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
				</label>
				<label className="block space-y-1">
					<span className="text-xs font-medium text-mut">描述：做什么 + 什么时候用（助理据此判断何时加载）</span>
					<Input placeholder="根据要点写中文周报。用户提到“周报/本周总结”时使用。" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
				</label>
				<label className="block space-y-1">
					<span className="text-xs font-medium text-mut">内容（Markdown：步骤、注意事项）</span>
					<textarea className="h-64 w-full rounded-lg border border-line bg-card p-2 font-mono text-[13px] outline-none focus:border-accent" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
				</label>
				{err && <div className="text-sm text-red-500">{err}</div>}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={() => setEdit(null)}>
						取消
					</Button>
					<Button variant="primary" onClick={save}>
						保存技能
					</Button>
				</div>
			</div>
		);
	if (open)
		return (
			<div className="space-y-3">
				{confirmDlg}
				<button className="flex items-center gap-1 text-sm text-mut hover:text-fg" onClick={() => setOpen(null)}>
					<ChevronLeft size={15} /> 全部技能
				</button>
				<div className="flex items-center gap-2">
					<h3 className="font-mono text-base font-semibold">{open.name}</h3>
					{open.builtin && <Badge>内置</Badge>}
					<span className="ml-auto flex gap-1">
						{open.builtin ? (
							<Button size="sm" variant="outline" onClick={() => setEdit({ name: `${open.name}-copy`, description: open.description, body: open.body })}>
								复制为我的技能
							</Button>
						) : (
							<>
								<Button size="sm" variant="outline" onClick={() => setEdit({ previousName: open.name, name: open.name, description: open.description, body: open.body })}>
									编辑
								</Button>
								<Button
									size="sm"
									variant="ghost"
									aria-label="删除技能"
									disabled={delBusy === "del"}
									onClick={() => void del()}
									data-testid="skill-delete"
								>
									<Trash2 size={14} />
								</Button>
							</>
						)}
					</span>
				</div>
				<p className="text-sm text-mut">{open.description}</p>
				{err && <div className="text-sm text-red-500" data-testid="skill-error">{err}</div>}
				<div className="rounded-xl border border-line p-3 text-sm">
					<Markdown text={open.body} />
				</div>
				{!open.builtin && versions && versions.length > 0 && (
					<section data-testid="skill-versions">
						<div className="pa-sec-label mb-1.5 flex items-center gap-1">
							<History size={13} /> 版本历史
						</div>
						<ul className="space-y-1">
							{versions.map((v, i) => (
								<li key={v.version} className="rounded-lg bg-hover/60 px-3 py-1.5 text-xs">
									<div className="flex items-center gap-2">
										<button className="flex flex-1 items-center gap-2 text-left" onClick={() => setOpenV(openV === v.version ? null : v.version)}>
											<b className="font-mono">v{v.version}</b>
											{i === 0 && <Badge tone="green">当前</Badge>}
											<span className="text-mut">{SRC[v.source] ?? v.source}{v.note ? ` · ${v.note}` : ""} · {new Date(v.created_at).toLocaleString("zh-CN", { hour12: false })}</span>
										</button>
										{i > 0 && (
											<Button
												size="sm"
												variant="ghost"
												disabled={delBusy === `rollback:${v.version}`}
												onClick={() => void rollback(v.version)}
												data-testid={`skill-rollback-${v.version}`}
											>
												<RotateCcw size={12} /> 回滚到此版本
											</Button>
										)}
									</div>
									{openV === v.version && <div className="mt-1.5"><DiffView diff={v.diff} /></div>}
								</li>
							))}
						</ul>
					</section>
				)}
			</div>
		);
	return (
		<div className="space-y-4" data-testid="skills-tab">
			<div className="flex items-start gap-3">
				<p className="flex-1 text-xs text-mut">
					所有技能的统一库存（内置 / 我的 / 导入）。 <Help>技能是可复用的做事方法（Agent Skills 标准的 SKILL.md）。默认所有助理都不启用任何技能（内置也不例外），在「助理 › 设置 › 技能」里按需勾选。助理只看到已启用技能的名称和描述，遇到相关任务时才读取完整内容。</Help>
				</p>
				<Button variant="outline" size="sm" onClick={() => setImportOpen(true)} data-testid="skill-import-open">
					<Upload size={14} /> 导入
				</Button>
				<Button variant="outline" size="sm" onClick={() => setEdit({ name: "", description: "", body: "# 步骤\n\n1. \n" })}>
					<Plus size={14} /> 新建技能
				</Button>
			</div>
			{suggest && (
				<label className="pa-card flex cursor-pointer items-start gap-3 !p-3 text-sm">
					<input type="checkbox" className="mt-1" checked={suggest.enabled} onChange={async (e) => setSuggest(await api("/api/skill-suggest", { method: "PUT", json: { enabled: e.target.checked } }))} />
					<span>
						<b>主动建议做成技能</b>
						<span className="block text-xs text-mut">
							重复的做法，提议存成技能。
							<Help className="ml-1">发现你重复做同类任务、或刚完成一个多步流程时，问一句“要不要做成技能？”；你的做法和已有技能不一样时，提议更新并给你看改动。同一对话一天最多一次，拒绝过的不再提。</Help>
						</span>
					</span>
				</label>
			)}
			{(() => {
				const unassigned = list.filter((s) => (s.enabledAgents ?? []).length === 0).length;
				return unassigned > 0 ? (
					<div className="rounded-lg bg-hover/60 px-3 py-2 text-xs text-mut" data-testid="skills-unassigned-hint">
						{unassigned} 个技能未分配给任何助理（升级不会删除技能，需要时在助理设置里勾选）。
					</div>
				) : null;
			})()}
			{(["我的技能", "内置技能"] as const).map((title) => {
				const items = list.filter((s) => s.builtin === (title === "内置技能"));
				return (
					<section key={title}>
						<div className="pa-sec-label mb-1.5">{title}</div>
						{items.length === 0 && <div className="text-sm text-mut">还没有技能。 <Help>可以新建，或在聊天里让助理“把刚才的流程存成技能”。</Help></div>}
						<ul className="grid gap-2 sm:grid-cols-2">
							{items.map((s) => (
								<li key={s.id}>
									<div className="pa-card flex h-full w-full items-start gap-2 !p-3 hover:border-accent">
										<button className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => view(s.name)} data-testid={`skill-item-${s.name}`}>
											{s.builtin ? <Lock size={15} className="mt-0.5 shrink-0 text-mut" /> : <Puzzle size={15} className="mt-0.5 shrink-0 text-accent" />}
											<span className="min-w-0">
												<span className="flex items-center gap-1.5">
													<span className="font-mono text-sm font-medium">{s.name}</span>
													{s.source !== "user" && <Badge tone={s.builtin ? "zinc" : "accent"}>{s.source === "external" ? "导入" : "内置"}</Badge>}
												</span>
												<span className="line-clamp-2 text-xs text-mut">{s.description}</span>
												<span className="mt-0.5 block text-[11px] text-mut" data-testid={`skill-enabled-${s.name}`}>{(s.enabledAgents ?? []).length} 个助理已启用</span>
											</span>
										</button>
										<Button size="sm" variant="ghost" aria-label={`分配「${s.name}」给助理`} title="按助理配置" onClick={() => setAssign(s)} data-testid={`skill-assign-${s.name}`}>
											<UserCog size={14} />
										</Button>
									</div>
								</li>
							))}
						</ul>
					</section>
				);
			})}
			{assign && <AssignModal skill={assign} agents={agents} onClose={() => setAssign(null)} onChanged={() => void load()} />}
			{importOpen && <ImportSkillModal agents={agents} onClose={() => setImportOpen(false)} onChanged={() => void load()} />}
		</div>
	);
}

/** 导入技能：zip 文件或本机路径（目录 / 单个 SKILL.md）；同名内容不同让用户选更新 / 换名。 */
function ImportSkillModal({ agents, onClose, onChanged }: { agents: { id: string; name: string }[]; onClose: () => void; onChanged: () => void }) {
	const [path, setPath] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [agentId, setAgentId] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [conflict, setConflict] = useState<{ existing: { id: string; name: string; description: string }; incoming: { name: string; description: string } } | null>(null);
	const [newName, setNewName] = useState("");
	const doImport = async (mode: "conflict" | "update" | "rename", nn?: string) => {
		setBusy(true);
		setErr("");
		try {
			const fd = new FormData();
			if (file) fd.append("file", file);
			else if (path.trim()) fd.append("path", path.trim());
			else {
				setErr("请选择 zip 文件，或填写本机目录 / SKILL.md 路径");
				return;
			}
			fd.append("mode", mode);
			if (nn) fd.append("newName", nn);
			if (agentId) fd.append("agentId", agentId);
			await api("/api/skills/import", { method: "POST", body: fd });
			onChanged();
			onClose();
		} catch (e) {
			if (e instanceof ApiError && e.status === 409 && e.data) setConflict(e.data as typeof conflict);
			else setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal open onClose={onClose} title="导入技能" testId="skill-import-modal">
			<div className="space-y-3">
				<p className="text-xs text-mut">从 zip 压缩包或本机目录 / SKILL.md 导入。导入后进入技能库（导入来源），默认不启用；可在下面选一个助理立即启用。只读取 SKILL.md 与附带文件，不会执行技能里的任何脚本。</p>
				<label className="block space-y-1">
					<span className="text-xs font-medium text-mut">zip 文件</span>
					<input type="file" accept=".zip" className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="skill-import-file" />
				</label>
				<label className="block space-y-1">
					<span className="text-xs font-medium text-mut">或本机路径（目录 / SKILL.md）</span>
					<Input placeholder="/Users/me/my-skill" value={path} onChange={(e) => setPath(e.target.value)} data-testid="skill-import-path" />
				</label>
				{agents.length > 0 && (
					<label className="block space-y-1">
						<span className="text-xs font-medium text-mut">导入后立即启用给（可选）</span>
						<Select value={agentId} options={[{ value: "", label: "不启用给任何助理" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} onChange={setAgentId} testId="skill-import-agent" />
					</label>
				)}
				{err && <div className="text-sm text-red-500" data-testid="skill-import-error">{err}</div>}
				{conflict && (
					<div className="space-y-2 rounded-lg border border-line p-3" data-testid="skill-import-conflict">
						<div className="text-sm">
							<b>已有同名技能「{conflict.existing.name}」</b>
							<p className="text-xs text-mut">现有：{conflict.existing.description}</p>
							<p className="text-xs text-mut">导入：{conflict.incoming.description}</p>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" variant="outline" disabled={busy} onClick={() => void doImport("update")} data-testid="skill-import-update">
								覆盖同名（更新）
							</Button>
							<Input className="w-40" placeholder="新名称" value={newName} onChange={(e) => setNewName(e.target.value)} />
							<Button size="sm" variant="primary" disabled={busy || !newName.trim()} onClick={() => void doImport("rename", newName.trim())} data-testid="skill-import-rename">
								换名另存
							</Button>
						</div>
					</div>
				)}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>取消</Button>
					<Button variant="primary" disabled={busy} onClick={() => void doImport("conflict")} data-testid="skill-import-submit">导入</Button>
				</div>
			</div>
		</Modal>
	);
}

/** 按助理配置：勾选哪些助理启用这个技能（写 /api/agents/:id/skills）。 */
function AssignModal({ skill, agents, onClose, onChanged }: { skill: SkillMeta; agents: { id: string; name: string }[]; onClose: () => void; onChanged: () => void }) {
	const [enabled, setEnabled] = useState<Set<string>>(new Set(skill.enabledAgents ?? []));
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const apply = async (agentId: string, v: boolean) => {
		setBusy(true);
		setErr("");
		try {
			const mine = await api<{ enabled: string[] }>(`/api/agents/${agentId}/skills`);
			const next = v ? [...new Set([...mine.enabled, skill.id])] : mine.enabled.filter((x) => x !== skill.id);
			await api(`/api/agents/${agentId}/skills`, { method: "PUT", json: { ids: next } });
			setEnabled((s) => {
				const n = new Set(s);
				v ? n.add(agentId) : n.delete(agentId);
				return n;
			});
			onChanged();
		} catch (e) {
			setErr(`保存失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal open onClose={onClose} title={`「${skill.name}」分配给谁`} testId="skill-assign-modal">
			<div className="space-y-2">
				<p className="text-xs text-mut">勾选启用这个技能的助理。默认谁都不启用。</p>
				{err && <div className="text-xs text-red-500">{err}</div>}
				<ul className="space-y-1">
					{agents.map((a) => (
						<li key={a.id}>
							<label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-hover">
								<input type="checkbox" disabled={busy} checked={enabled.has(a.id)} onChange={(e) => void apply(a.id, e.target.checked)} data-testid={`skill-assign-${skill.name}-${a.id}`} />
								<span className="truncate">{a.name}</span>
							</label>
						</li>
					))}
					{agents.length === 0 && <li className="text-sm text-mut">还没有助理。</li>}
				</ul>
			</div>
		</Modal>
	);
}

/** 设置 › 记忆：选择全局记忆后端（以后会有 Hindsight 等高级后端） */
export function MemorySettings() {
	const [data, setData] = useState<{ global: string; providers: { id: string; name: string; capabilities: Record<string, boolean> }[] } | null>(null);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState("");
	const load = () => api("/api/memory/providers").then(setData);
	useEffect(() => {
		void load();
	}, []);
	const setGlobal = async (id: string) => {
		setErr("");
		setSaving(true);
		try {
			await api("/api/memory/provider", { method: "PUT", json: { id } });
			await load();
		} catch (e) {
			// 不重新加载：Select 的值来自 data.global，保存失败时自然回到原值
			setErr(`切换失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setSaving(false);
		}
	};
	const CAP: Record<string, string> = { reflect: "反思", mentalModels: "心智模型", temporal: "时间推理", graph: "实体图谱", exportImport: "导出/导入", mcpEndpoint: "MCP 端点" };
	return (
		<div className="space-y-4">
			<p className="text-xs text-mut">
				助理怎样保存和检索长期记忆。 <Help>每个助理默认跟随这里的设置，也可以在助理的「记忆」页单独选择。记忆里有三种作用域：共享（关于你，所有助理可见）、仅此助理、仅当前对话。</Help>
			</p>
			<div className="flex items-center gap-2">
				<Select
					value={data?.global ?? ""}
					ariaLabel="全局记忆后端"
					testId="memory-global-provider"
					placeholder="选择记忆后端…"
					menuMinWidth={240}
					disabled={saving || !data}
					options={(data?.providers ?? []).map((p) => ({ value: p.id, label: p.name }))}
					onChange={(v) => void setGlobal(v)}
				/>
				{saving && <span className="text-xs text-mut">保存中…</span>}
			</div>
			{err && <p className="text-xs text-red-600" data-testid="memory-global-provider-error">{err}</p>}
			<ul className="space-y-2">
				{data?.providers.map((p) => (
					<li key={p.id} className="pa-card !p-3">
						<span className="flex items-center gap-2 text-sm font-medium">
							{p.name}
							{data.global === p.id && <Badge tone="accent">当前</Badge>}
						</span>
						<span className="mt-1 flex flex-wrap gap-1">
							{Object.entries(CAP).map(([k, v]) => (
								<Badge key={k} tone={p.capabilities[k] ? "green" : "zinc"}>
									{p.capabilities[k] ? "✓" : "–"} {v}
								</Badge>
							))}
						</span>
					</li>
				))}
			</ul>
			{data?.providers.some((p) => p.id === "hindsight") && <HindsightSettings />}
		</div>
	);
}
