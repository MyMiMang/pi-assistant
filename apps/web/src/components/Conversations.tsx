import { Check, ChevronDown, Layers, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useStore } from "../store";
import { cx, fmtTime } from "./ui";

/** 聊天头部的“对话”菜单：切换 / 新对话 / 重命名 / 删除 / 整理上下文 */
export function ConversationMenu({ agentId }: { agentId: string }) {
	const conv = useStore((s) => s.convs[agentId]);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState({ top: 0, right: 0 });
	const [busy, setBusy] = useState("");
	const btn = useRef<HTMLButtonElement>(null);
	const cur = conv?.items.find((c) => c.id === conv.current);
	useEffect(() => {
		if (!open) return;
		const r = btn.current!.getBoundingClientRect();
		setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
		void useStore.getState().loadConversations(agentId);
		const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		addEventListener("keydown", close);
		return () => removeEventListener("keydown", close);
	}, [open, agentId]);
	const st = useStore.getState();
	const compact = async () => {
		if (!conv) return;
		setBusy("compact");
		try {
			await api(`/api/conversations/${conv.current}/compact`, { method: "POST" });
			setOpen(false);
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};
	return (
		<>
			<button ref={btn} className="pa-chip max-w-[14rem]" onClick={() => setOpen((v) => !v)} aria-label="对话" data-testid="conv-menu">
				<Layers className="pa-ic" />
				<span className="truncate">{cur?.title || "新对话"}</span>
				<ChevronDown className="pa-ic opacity-60" />
			</button>
			{open &&
				createPortal(
					<div className="fixed inset-0 z-50" onClick={() => setOpen(false)}>
						<div className="pa-card fixed w-80 max-w-[calc(100vw-16px)] !p-2 shadow-xl" style={{ top: pos.top, right: pos.right }} onClick={(e) => e.stopPropagation()} role="menu">
							<div className="flex gap-1.5 p-1">
								<button className="pa-btn primary flex-1 justify-center" onClick={async () => (setOpen(false), await st.newConversation(agentId))}>
									<MessageSquarePlus size={15} /> 新对话
								</button>
								<button className="pa-btn flex-1 justify-center" disabled={busy === "compact" || !cur?.message_count} onClick={compact} title="把较早的消息压缩成摘要，节省上下文（对话很长时也会自动进行）">
									<Layers size={15} /> {busy === "compact" ? "整理中…" : "整理上下文"}
								</button>
							</div>
							<div className="pa-sec-label px-2 pt-2 pb-1">对话</div>
							<ul className="scrollbar-thin max-h-80 overflow-y-auto">
								{conv?.items.map((c) => (
									<li key={c.id}>
										<div
											className={cx("group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-hover", c.id === conv.current && "bg-hover")}
											onClick={async () => (setOpen(false), c.id !== conv.current && (await st.switchConversation(agentId, c.id)))}
										>
											<span className="w-4 shrink-0">{c.id === conv.current && <Check size={14} className="text-accent" />}</span>
											<span className="min-w-0 flex-1">
												<span className="block truncate font-medium">{c.title || "新对话"}</span>
												<span className="block truncate text-xs text-mut">{c.last ? c.last.slice(0, 40) : "还没有消息"} · {fmtTime(c.updated_at)}</span>
											</span>
											<button
												className="pa-icon-btn ghost !h-7 !w-7 opacity-0 group-hover:opacity-100"
												aria-label="重命名"
												onClick={async (e) => {
													e.stopPropagation();
													const title = prompt("对话名称", c.title);
													if (title !== null) (await api(`/api/conversations/${c.id}`, { method: "PATCH", json: { title } }), void st.loadConversations(agentId));
												}}
											>
												<Pencil size={13} />
											</button>
											<button
												className="pa-icon-btn ghost !h-7 !w-7 opacity-0 group-hover:opacity-100"
												aria-label="删除对话"
												onClick={async (e) => {
													e.stopPropagation();
													if (!confirm(`删除对话「${c.title || "新对话"}」？聊天记录会被删除。`)) return;
													await api(`/api/conversations/${c.id}`, { method: "DELETE" });
												}}
											>
												<Trash2 size={13} />
											</button>
										</div>
									</li>
								))}
							</ul>
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}
