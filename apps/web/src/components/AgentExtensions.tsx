import { Plug } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

type Item = { id: string; name: string; enabled: boolean; agents: string[] | null; kind: "mcp" | "pkg" };

/** 助理设置里的“扩展”：这个助理能用哪些 MCP 服务 / Pi 扩展包 */
export function AgentExtensions({ agentId }: { agentId: string }) {
	const version = useStore((s) => s.extVersion);
	const agents = useStore((s) => s.agents);
	const local = useStore((s) => s.system?.local ?? true);
	const [items, setItems] = useState<Item[]>([]);
	const load = async () => {
		const [m, p] = await Promise.all([api<{ id: string; name: string; enabled: boolean; agents: string[] | null }[]>("/api/mcp"), api<{ id: string; source: string; enabled: boolean; agents: string[] | null; resources: { name: string } | null }[]>("/api/pi-packages")]);
		setItems([...m.map((x) => ({ ...x, kind: "mcp" as const })), ...p.map((x) => ({ id: x.id, name: x.resources?.name || x.source, enabled: x.enabled, agents: x.agents, kind: "pkg" as const }))]);
	};
	useEffect(() => {
		void load();
	}, [version]);
	if (!items.length) return null;
	const on = (i: Item) => i.enabled && (i.agents?.includes(agentId) ?? true);
	const toggle = async (i: Item, v: boolean) => {
		const all = agents.map((a) => a.id);
		let next = i.agents ?? all;
		next = v ? [...new Set([...next, agentId])] : next.filter((x) => x !== agentId);
		const agentsVal = next.length === all.length ? null : next;
		await api(i.kind === "mcp" ? `/api/mcp/${i.id}` : `/api/pi-packages/${i.id}`, { method: "PATCH", json: { enabled: i.enabled || v, agents: agentsVal } });
		void load();
	};
	return (
		<section data-testid="agent-extensions">
			<div className="pa-sec-label mb-1.5 flex items-center gap-1">
				<Plug size={13} /> 扩展
			</div>
			<ul className="space-y-1">
				{items.map((i) => (
					<li key={i.id}>
						<label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-hover">
							<input type="checkbox" disabled={!local} checked={on(i)} onChange={(e) => toggle(i, e.target.checked)} />
							<span className="font-mono">{i.name}</span>
							<span className="ml-auto text-xs text-mut">{i.kind === "mcp" ? "MCP" : "扩展包"}{!i.enabled && " · 已全局停用"}</span>
						</label>
					</li>
				))}
			</ul>
		</section>
	);
}
