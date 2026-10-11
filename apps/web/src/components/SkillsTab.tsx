import { ChevronLeft, Lock, Plus, Puzzle, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { SkillMeta } from "../types";
import { Badge, Button, Input } from "./ui";
import Markdown from "./Markdown";

type Full = SkillMeta & { body: string };

/** 设置 › 技能库：内置技能（只读）+ 我的技能（可编辑）。用的是 Pi 原生 Agent Skills（SKILL.md）。 */
export function SkillsTab() {
	const version = useStore((s) => s.skillsVersion);
	const [list, setList] = useState<SkillMeta[]>([]);
	const [open, setOpen] = useState<Full | null>(null);
	const [edit, setEdit] = useState<{ previousName?: string; name: string; description: string; body: string } | null>(null);
	const [err, setErr] = useState("");
	const load = () => api<SkillMeta[]>("/api/skills").then(setList);
	useEffect(() => {
		void load();
	}, [version]);
	const view = async (name: string) => setOpen(await api<Full>(`/api/skills/${name}`));
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
									onClick={async () => {
										if (!confirm(`删除技能「${open.name}」？`)) return;
										await api(`/api/skills/${open.name}`, { method: "DELETE" });
										setOpen(null);
										void load();
									}}
								>
									<Trash2 size={14} />
								</Button>
							</>
						)}
					</span>
				</div>
				<p className="text-sm text-mut">{open.description}</p>
				<div className="rounded-xl border border-line p-3 text-sm">
					<Markdown text={open.body} />
				</div>
			</div>
		);
	return (
		<div className="space-y-4" data-testid="skills-tab">
			<div className="flex items-start gap-3">
				<p className="flex-1 text-xs leading-relaxed text-mut">
					技能是可复用的做事方法（Agent Skills 标准的 SKILL.md）。所有助理共用这个技能库：模型只看到名称和描述，遇到相关任务时才读取完整内容。助理也可以自己把学到的流程存成技能。
				</p>
				<Button variant="outline" size="sm" onClick={() => setEdit({ name: "", description: "", body: "# 步骤\n\n1. \n" })}>
					<Plus size={14} /> 新建技能
				</Button>
			</div>
			{(["我的技能", "内置技能"] as const).map((title) => {
				const items = list.filter((s) => s.builtin === (title === "内置技能"));
				return (
					<section key={title}>
						<div className="pa-sec-label mb-1.5">{title}</div>
						{items.length === 0 && <div className="text-sm text-mut">还没有。可以新建，或在聊天里让助理“把刚才的流程存成技能”。</div>}
						<ul className="grid gap-2 sm:grid-cols-2">
							{items.map((s) => (
								<li key={s.name}>
									<button className="pa-card flex h-full w-full items-start gap-2 !p-3 text-left hover:border-accent" onClick={() => view(s.name)}>
										{s.builtin ? <Lock size={15} className="mt-0.5 shrink-0 text-mut" /> : <Puzzle size={15} className="mt-0.5 shrink-0 text-accent" />}
										<span className="min-w-0">
											<span className="block font-mono text-sm font-medium">{s.name}</span>
											<span className="line-clamp-2 text-xs text-mut">{s.description}</span>
										</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				);
			})}
		</div>
	);
}

/** 设置 › 记忆：选择全局记忆后端（以后会有 Hindsight 等高级后端） */
export function MemorySettings() {
	const [data, setData] = useState<{ global: string; providers: { id: string; name: string; capabilities: Record<string, boolean> }[] } | null>(null);
	const load = () => api("/api/memory/providers").then(setData);
	useEffect(() => {
		void load();
	}, []);
	const CAP: Record<string, string> = { reflect: "反思", mentalModels: "心智模型", temporal: "时间推理", graph: "实体图谱", exportImport: "导出/导入", mcpEndpoint: "MCP 端点" };
	return (
		<div className="space-y-4">
			<p className="text-xs leading-relaxed text-mut">
				记忆后端决定助理怎样保存和检索长期记忆。每个助理默认跟随这里的设置，也可以在助理的「记忆」页单独选择。记忆里有三种作用域：共享（关于你，所有助理可见）、仅此助理、仅当前对话。
			</p>
			<ul className="space-y-2">
				{data?.providers.map((p) => (
					<li key={p.id}>
						<label className="pa-card flex cursor-pointer items-start gap-3 !p-3">
							<input type="radio" name="memprov" className="mt-1" checked={data.global === p.id} onChange={async () => (await api("/api/memory/provider", { method: "PUT", json: { id: p.id } }), load())} />
							<span className="min-w-0 flex-1">
								<span className="block text-sm font-medium">{p.name}</span>
								<span className="mt-1 flex flex-wrap gap-1">
									{Object.entries(CAP).map(([k, v]) => (
										<Badge key={k} tone={p.capabilities[k] ? "green" : "zinc"}>
											{p.capabilities[k] ? "✓" : "–"} {v}
										</Badge>
									))}
								</span>
							</span>
						</label>
					</li>
				))}
				<li className="pa-card !p-3 text-sm opacity-60">
					<b>高级记忆（Hindsight）</b> · 即将推出
					<div className="mt-1 text-xs text-mut">本机独立运行（自带运行环境与数据目录），自动整理事实、反思与长期学习；可分别选择记忆用模型、向量模型（默认本地多语言 ONNX）和重排序（本地 / 在线 / 关闭）。</div>
				</li>
			</ul>
		</div>
	);
}
