import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BrowserPageInfo, BrowserState } from "@pi-assistant/shared";
import { api } from "../api";
import { useBrowserView } from "../browser-view";
import { useStore } from "../store";
import { useWorkspace } from "../workspace";
import { Button, ErrorBox, Input, Select, useConfirm } from "./ui";

export function BrowserWorkspace({ agentIds, workspaceKey }: { agentIds: string[]; workspaceKey: string }) {
	const visible = useWorkspace(s => s.active === workspaceKey && !s.collapsed);
	const [agentId, setAgentId] = useState(agentIds[0] ?? ""), [state, setState] = useState<BrowserState | null>(null);
	const [pageId, setPageId] = useState<string | null>(null), [address, setAddress] = useState("");
	const [error, setError] = useState(""), [busy, setBusy] = useState(false), [text, setText] = useState("");
	const canvas = useRef<HTMLCanvasElement>(null), [confirmDialog, confirm] = useConfirm();
	const [selectionRequest, requestSelection] = useState(0);
	const view = useBrowserView(agentId, pageId, visible, canvas, selectionRequest);
	const agents = useStore(s => s.agents);
	useEffect(() => {
		if (!visible || !agentId) return;
		let live = true;
		const load = async () => {
			try {
				const result = await api<BrowserState>(`/api/agents/${agentId}/browser/state`);
				if (!live) return;
				setState(result);
				setPageId(previous => previous && result.pages.some(p => p.pageId === previous) ? previous : result.current);
			} catch (e) { if (live) setError(String((e as Error).message)); }
		};
		void load(); const timer = setInterval(load, 1500);
		return () => { live = false; clearInterval(timer); };
	}, [visible, agentId]);
	useEffect(() => { if (view.state) setState(view.state); }, [view.state]);
	const page = state?.pages.find(p => p.pageId === pageId);
	useEffect(() => { setAddress(page?.url ?? ""); }, [page?.url]);
	const operation = async (action: () => Promise<void>) => {
		setBusy(true); setError("");
		try { await action(); } catch (e) { setError(String((e as Error).message)); } finally { setBusy(false); }
	};
	const send = (type: string, extra: Record<string, unknown> = {}) => page ? view.send(type, page, extra) : Promise.reject(new Error("请先选择已打开的网页"));
	const enabled = !!page && page.control === "user" && !state?.paused && view.connected && !!view.drawn && !busy;
	const input = (extra: Record<string, unknown>) => { if (enabled) void operation(() => send("input", extra)); };
	const choose = (id: string) => { setPageId(id); requestSelection(x => x + 1); setError(""); };
	const controlText = state?.paused ? "操作已暂停" : page?.control === "user" ? "由你操作" : page?.control === "draining" ? "未获得控制权，网页保持锁定" : page?.control === "reading" ? "正在重读网页" : "由助理操作";
	return <div className="pa-browser-workspace" data-testid="workspace-browser-content">
		<div className="pa-browser-toolbar">
			{agentIds.length > 1 && <Select value={agentId} onChange={id => { setAgentId(id); setPageId(null); setState(null); }} options={agentIds.map(id => ({ value: id, label: agents.find(a => a.id === id)?.name ?? "群成员" }))} />}
			{state && state.pages.length > 0 && <Select testId="browser-page-select" value={pageId ?? ""} onChange={choose} options={state.pages.map(p => ({ value: p.pageId, label: `${p.isolated ? "独立环境 · " : ""}${p.title || p.url || "空白页"}` }))} />}
			<span className="text-xs text-mut" role="status" data-testid="browser-control-status">{page ? `${view.connected ? "已连接" : "未连接"} · ${controlText}` : "尚未打开网页"}</span>
		</div>
		{page && <>
			<form className="pa-browser-toolbar" onSubmit={event => { event.preventDefault(); input({ kind: "navigate", url: address }); }}>
				<button type="button" className="pa-icon-btn ghost" aria-label="网页后退" disabled={!enabled} onClick={() => input({ kind: "navigate", url: "back" })}><ArrowLeft size={16} /></button>
				<button type="button" className="pa-icon-btn ghost" aria-label="网页前进" disabled={!enabled} onClick={() => input({ kind: "navigate", url: "forward" })}><ArrowRight size={16} /></button>
				<button type="button" className="pa-icon-btn ghost" aria-label="刷新网页" disabled={!enabled} onClick={() => input({ kind: "navigate", url: "reload" })}><RefreshCw size={16} /></button>
				<Input aria-label="网页地址" value={address} disabled={!enabled} onChange={e => setAddress(e.target.value)} className="min-w-0 flex-1" />
				<Button type="submit" disabled={!enabled}>打开</Button>
			</form>
			<div className="pa-browser-toolbar">
				{page.control === "agent" && <Button data-testid="browser-takeover" disabled={!view.connected || busy} onClick={() => void operation(() => send("takeover"))}>接管网页</Button>}
				{page.control === "draining" && <Button disabled={!view.connected || busy} onClick={() => void operation(() => send("recover"))}>核实后恢复接管</Button>}
				{page.control === "user" && <Button data-testid="browser-give-back" disabled={!view.connected || busy} onClick={() => void operation(() => send("give-back"))}>交还助理</Button>}
				<Button disabled={busy} onClick={() => view.reconnect()}>重新连接</Button>
				<Button disabled={!enabled} onClick={async () => { if (await confirm({ title: "关闭这个网页？", body: "未保存的网页内容可能丢失；关闭工作区标签则只停止查看。", danger: true })) void operation(() => send("close-page")); }}>关闭网页</Button>
			</div>
		</>}
		{(error || view.error || page?.error) && <div className="p-2"><ErrorBox text={error || view.error || page?.error || ""} /></div>}
		{!page && <div className="p-6 text-sm text-mut" data-testid="workspace-browser-empty"><p className="mb-2 font-medium text-fg">还没有打开网页</p><p>请让助理打开需要的网页，再来这里查看和接管。查看工作区不会启动电脑或另开浏览器。</p></div>}
		<div className="pa-browser-screen" hidden={!page} onWheel={event => { if (enabled) { event.preventDefault(); input({ kind: "wheel", deltaY: Math.max(-3000, Math.min(3000, event.deltaY)) }); } }}>
			<canvas ref={canvas} data-testid="browser-canvas" tabIndex={enabled ? 0 : -1} aria-label="当前网页画面" aria-disabled={!enabled}
				onClick={event => { const box = event.currentTarget.getBoundingClientRect(); event.currentTarget.focus(); input({ kind: "click", x: (event.clientX - box.left) * event.currentTarget.width / box.width, y: (event.clientY - box.top) * event.currentTarget.height / box.height }); }}
				onKeyDown={event => {
					if (!enabled || event.nativeEvent.isComposing) return;
					event.preventDefault(); event.stopPropagation();
					const key = event.key === " " ? "Space" : event.key;
					input({ kind: "key", key: `${event.ctrlKey ? "Control+" : ""}${event.metaKey ? "Meta+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${key}` });
				}} />
		</div>
		{page && <form className="pa-browser-toolbar" onSubmit={event => { event.preventDefault(); if (text && enabled) void operation(async () => { await send("input", { kind: "text", text }); setText(""); }); }}>
			<Input aria-label="输入到网页当前光标处" placeholder="中文或长文字：先点击网页输入框，再在这里输入" value={text} disabled={!enabled} onChange={e => setText(e.target.value)} className="min-w-0 flex-1" />
			<Button type="submit" disabled={!enabled || !text}>输入</Button>
		</form>}
		{page && <p className="px-3 py-2 text-xs text-mut">接管会等待已发出的操作结束；网站已经提交的请求可能继续。收起或断线保留网页和控制权，完成后请明确交还。上传和下载请让助理使用现有文件工具。</p>}
		{confirmDialog}
	</div>;
}
