/**
 * 「整理上下文」小弹窗：可选填「希望保留什么」，默认空 = 原行为（直接整理）。
 *
 * 只影响摘要请求（Pi `session.compact(instructions)`），不进主会话 system prompt、
 * 不改变权限 / 安全策略；取消不发任何请求，也不触发模型调用。
 * 以 hook 形式返回 [弹窗节点, 打开函数]，供对话菜单与上下文圆环共用。
 */
import { useState, type ReactNode } from "react";
import { api } from "../api";
import { Button, Modal } from "./ui";

export function useCompactDialog(conversationId: string | null): readonly [ReactNode, (onDone?: () => void) => void] {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [done, setDone] = useState<(() => void) | null>(null);
	const show = (onDone?: () => void) => {
		setText("");
		setErr("");
		setDone(() => onDone ?? null);
		setOpen(true);
	};
	const close = () => {
		if (!busy) setOpen(false);
	};
	const submit = async (instructions: string) => {
		if (!conversationId || busy) return;
		setBusy(true);
		setErr("");
		try {
			await api(`/api/conversations/${conversationId}/compact`, { method: "POST", json: instructions ? { instructions } : {} });
			setOpen(false);
			done?.();
		} catch (e) {
			setErr(`整理失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	};
	const focus = text.trim();
	const node = (
		<Modal open={open} onClose={close} title="整理上下文" testId="compact-dialog">
			<div className="space-y-3 p-5">
				<p className="text-sm text-mut">把较早的消息压缩成摘要，腾出上下文。可以指定这次摘要重点保留什么（只用于这次摘要，不影响助理的安全设置）。</p>
				<textarea
					className="pa-input min-h-[76px] w-full resize-none py-2"
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder="希望保留什么？（可不填）例如：保留需求、决策和待办"
					maxLength={2000}
					autoFocus
					data-testid="compact-instructions"
				/>
				{err && (
					<div className="text-sm text-red-500" data-testid="compact-error">
						{err}
					</div>
				)}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={close} disabled={busy} data-testid="compact-cancel">
						取消
					</Button>
					<Button variant="outline" disabled={busy || !conversationId} onClick={() => void submit("")} title="不指定重点，按原行为整理" data-testid="compact-direct">
						直接整理
					</Button>
					<Button variant="primary" disabled={busy || !conversationId || !focus} onClick={() => void submit(focus)} data-testid="compact-focus">
						{busy ? "整理中…" : "按重点整理"}
					</Button>
				</div>
			</div>
		</Modal>
	);
	return [node, show] as const;
}
