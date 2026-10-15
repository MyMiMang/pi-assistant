import { Check, ChevronDown, Layers, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useStore } from "../store";
import { Button, cx, fmtTime, Input, Modal, useConfirm } from "./ui";

/** 聊天头部的“对话”菜单：切换 / 新对话 / 重命名 / 删除 / 整理上下文 */
export function ConversationMenu({ agentId }: { agentId: string }) {
	const conv = useStore((s) => s.convs[agentId]);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState({ top: 0, right: 0 });
	const [busy, setBusy] = useState("");
	const [err, setErr] = useState("");
	const [confirmDlg, askConfirm] = useConfirm();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
	const [renameErr, setRenameErr] = useState("");
	const delRef = useRef(false);
	const btn = useRef<HTMLButtonElement>(null);
	const cur = conv?.items.find((c) => c.id === conv.current);
	useEffect(() => {
		if (!open) return;
		const r = btn.current!.getBoundingClientRect();
		setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
		void useStore.getState().loadConversations(agentId);
	}, [open, agentId]);
	// Esc 只关当前这层：重命名 / 确认框开着时不要连带把下面的对话菜单也关掉
	useEffect(() => {
		if (!open || renaming || confirmOpen) return;
		const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		addEventListener("keydown", close);
		return () => removeEventListener("keydown", close);
	}, [open, renaming, confirmOpen]);
	const st = useStore.getState();
	const compact = async () => {
		if (!conv) return;
		setBusy("compact");
		setErr("");
		try {
			await api(`/api/conversations/${conv.current}/compact`, { method: "POST" });
			setOpen(false);
		} catch (e) {
			setErr(`整理失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy("");
		}
	};
	const remove = async (c: { id: string; title: string | null }) => {
		if (delRef.current) return;
		setConfirmOpen(true);
		const ok = await askConfirm({ title: `删除对话「${c.title || "新对话"}」？`, body: "聊天记录会被删除，无法恢复。", ok: "删除", danger: true });
		setConfirmOpen(false);
		if (!ok || delRef.current) return;
		delRef.current = true;
		setBusy(`del:${c.id}`);
		setErr("");
		try {
			await api(`/api/conversations/${c.id}`, { method: "DELETE" });
			await st.loadConversations(agentId);
		} catch (e) {
			setErr(`删除失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			delRef.current = false;
			setBusy("");
		}
	};
	const submitRename = async () => {
		if (!renaming) return;
		const title = renaming.value.trim();
		if (!title) return setRenameErr("名称不能为空");
		setBusy("rename");
		setRenameErr("");
		try {
			await api(`/api/conversations/${renaming.id}`, { method: "PATCH", json: { title } });
			setRenaming(null);
			void st.loadConversations(agentId);
		} catch (e) {
			setRenameErr(`重命名失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy("");
		}
	};
	const closeRename = () => (setRenaming(null), setRenameErr(""));
	return (
		<>
			{confirmDlg}
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
							{err && <div className="px-2 pb-1 text-xs text-red-600" data-testid="conv-menu-error">{err}</div>}
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
												onClick={(e) => {
													e.stopPropagation();
													setRenameErr("");
													setRenaming({ id: c.id, value: c.title || "" });
												}}
												data-testid={`conv-rename-${c.id}`}
											>
												<Pencil size={13} />
											</button>
											<button
												className="pa-icon-btn ghost !h-7 !w-7 opacity-0 group-hover:opacity-100"
												aria-label="删除对话"
												disabled={busy === `del:${c.id}`}
												onClick={(e) => {
													e.stopPropagation();
													void remove(c);
												}}
												data-testid={`conv-delete-${c.id}`}
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
			<Modal open={!!renaming} onClose={closeRename} title="重命名对话" testId="conv-rename-dialog">
				<div className="space-y-3 p-5">
					<Input
						autoFocus
						value={renaming?.value ?? ""}
						onChange={(e) => setRenaming((r) => (r ? { ...r, value: e.target.value } : r))}
						onKeyDown={(e) => e.key === "Enter" && void submitRename()}
						placeholder="对话名称"
						data-testid="conv-rename-input"
					/>
					{renameErr && <div className="text-sm text-red-500" data-testid="conv-rename-error">{renameErr}</div>}
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={closeRename} data-testid="conv-rename-cancel">
							取消
						</Button>
						<Button variant="primary" disabled={busy === "rename"} onClick={submitRename} data-testid="conv-rename-ok">
							保存
						</Button>
					</div>
				</div>
			</Modal>
		</>
	);
}
