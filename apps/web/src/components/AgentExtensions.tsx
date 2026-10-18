import { Loader2, Plug, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Button, ErrorBox } from "./ui";

type Item = { id: string; name: string; enabled: boolean; agents: string[] | null; kind: "mcp" | "pkg" };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 助理设置里的“扩展”：这个助理能用哪些 MCP 服务 / Pi 扩展包 */
export function AgentExtensions({ agentId }: { agentId: string }) {
	const version = useStore((s) => s.extVersion);
	const agents = useStore((s) => s.agents);
	const local = useStore((s) => s.system?.local ?? true);
	// null = 还没成功读到过（不是“没有扩展”）；读失败时保留上一次成功的数据
	const [items, setItems] = useState<Item[] | null>(null);
	// 读失败和保存失败分开存：保存失败后的自动回滚读取不能把真正的保存错误抹掉
	const [loadErr, setLoadErr] = useState("");
	const [saveErr, setSaveErr] = useState("");
	const [loading, setLoading] = useState(true);
	// 只让最后一次请求落地：切助理 / 版本刷新后，旧的慢请求不能覆盖新状态
	const seq = useRef(0);
	const load = useCallback(async (opts?: { manual?: boolean }) => {
		const my = ++seq.current;
		setLoading(true);
		// 只有用户手动重试（= 重新读服务端真实状态）才顺手清掉“保存失败”；失败后自动回滚不清
		if (opts?.manual) setSaveErr("");
		try {
			const [m, p] = await Promise.all([
				api<{ id: string; name: string; enabled: boolean; agents: string[] | null }[]>("/api/mcp"),
				api<{ id: string; source: string; enabled: boolean; agents: string[] | null; resources: { name: string } | null }[]>("/api/pi-packages"),
			]);
			if (my !== seq.current) return;
			setItems([...m.map((x) => ({ ...x, kind: "mcp" as const })), ...p.map((x) => ({ id: x.id, name: x.resources?.name || x.source, enabled: x.enabled, agents: x.agents, kind: "pkg" as const }))]);
			setLoadErr("");
		} catch (e) {
			// 读失败不当成空列表：显示错误（有旧数据就继续显示旧数据）
			if (my !== seq.current) return;
			setLoadErr(`加载失败：${msg(e)}`);
		} finally {
			if (my === seq.current) setLoading(false);
		}
	}, []);
	useEffect(() => {
		void load();
		return () => {
			seq.current++;
		};
	}, [load, version, agentId]);
	const on = (i: Item) => i.enabled && (i.agents?.includes(agentId) ?? true);
	const toggle = async (i: Item, v: boolean) => {
		const all = agents.map((a) => a.id);
		let next = i.agents ?? all;
		next = v ? [...new Set([...next, agentId])] : next.filter((x) => x !== agentId);
		const agentsVal = next.length === all.length ? null : next;
		setSaveErr("");
		try {
			await api(i.kind === "mcp" ? `/api/mcp/${i.id}` : `/api/pi-packages/${i.id}`, { method: "PATCH", json: { enabled: i.enabled || v, agents: agentsVal } });
			void load();
		} catch (e) {
			setSaveErr(`保存失败：${msg(e)}`);
			// 自动回滚：只重新读服务端数据，不清掉刚显示的保存错误
			void load();
		}
	};
	return (
		<section className="space-y-2" data-testid="agent-extensions">
			<div className="pa-sec-label flex flex-wrap items-center gap-1">
				<Plug size={13} /> 扩展
				{loading && <Loader2 size={12} className="animate-spin text-mut" aria-hidden />}
			</div>
			{loadErr && (
				<div className="flex flex-wrap items-center gap-2">
					<ErrorBox text={loadErr} className="min-w-0 flex-1" />
					<Button size="sm" variant="outline" onClick={() => void load({ manual: true })} disabled={loading} data-testid="agent-extensions-retry">
						<RefreshCw size={12} /> 重试
					</Button>
				</div>
			)}
			{saveErr && <ErrorBox text={saveErr} className="min-w-0" />}
			{items === null ? (
				loading ? (
					<div className="text-sm text-mut" data-testid="agent-extensions-loading">
						正在加载扩展…
					</div>
				) : null
			) : items.length === 0 ? (
				<div className="space-y-2" data-testid="agent-extensions-empty">
					<div className="text-sm text-mut">无扩展</div>
					<Button size="sm" variant="outline" onClick={() => useStore.getState().set({ settings: "extensions" })} data-testid="agent-extensions-open-settings">
						<Settings2 size={13} /> 打开扩展设置
					</Button>
				</div>
			) : (
				<ul className="space-y-1">
					{items.map((i) => (
						<li key={i.id}>
							<label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-hover">
								<input type="checkbox" disabled={!local} checked={on(i)} onChange={(e) => void toggle(i, e.target.checked)} />
								<span className="min-w-0 break-all font-mono">{i.name}</span>
								<span className="ml-auto shrink-0 text-xs text-mut">
									{i.kind === "mcp" ? "MCP" : "扩展包"}
									{!i.enabled && " · 已全局停用"}
								</span>
							</label>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
