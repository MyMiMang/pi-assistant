import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopPeerInvitationPort, DesktopPeerPreview } from "../desktop-peer-port";
import { Button, Input, Modal } from "./ui";

type Step =
	| { stage: "invite" }
	| { stage: "preview"; identity: DesktopPeerPreview }
	| { stage: "pending"; id: string; checkCode: string }
	| { stage: "remembered"; name?: string };

export function DesktopPeerInvitation({ port, open, onClose }: { port: DesktopPeerInvitationPort; open: boolean; onClose: () => void }) {
	const [step, setStep] = useState<Step>({ stage: "invite" });
	const [invite, setInvite] = useState("");
	const [name, setName] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const [pollTick, setPollTick] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const working = useRef(false);
	const content = useRef<HTMLDivElement>(null);
	useEffect(() => { if (open) content.current?.focus(); }, [open]);

	const run = useCallback(async (action: () => Promise<void>, failure: string) => {
		if (working.current) return;
		working.current = true;
		setBusy(true);
		setError("");
		try { await action(); }
		catch { setError(failure); }
		finally { working.current = false; setBusy(false); }
	}, []);

	const pendingId = step.stage === "pending" ? step.id : null;
	const collect = useCallback(() => {
		if (!pendingId) return;
		void run(async () => {
			const result = await port.collect({ id: pendingId });
			if (result.status === "remembered") setStep({ stage: "remembered", name: result.device?.name });
			else setPollTick(t => t + 1);
		}, "暂时无法确认是否已添加。请查看电脑列表，或手动重试。若邀请已过期，请换一份新邀请。");
	}, [pendingId, port, run]);
	useEffect(() => {
		if (!open || !pendingId || busy || error) return;
		const timer = setTimeout(collect, 2500);
		return () => clearTimeout(timer);
	}, [open, pendingId, busy, error, collect, pollTick]);

	function close() {
		setInvite("");
		setConfirmed(false);
		if (step.stage === "remembered") setStep({ stage: "invite" });
		onClose();
	}
	function cancel(id: string) {
		void run(async () => {
			await port.cancel({ id });
			setName("");
			setConfirmed(false);
			setStep({ stage: "invite" });
		}, "暂时无法取消，请重试。");
	}

	return <Modal open={open} title="添加远端电脑" ariaLabel="添加远端电脑" onClose={close}>
		<div ref={content} tabIndex={-1} aria-busy={busy} className="grid gap-3 p-4">
			{step.stage === "invite" && <form className="grid gap-3" onSubmit={e => {
				e.preventDefault();
				const value = invite.trim();
				if (!value) return;
				void run(async () => {
					const identity = await port.preview({ invite: value });
					setInvite("");
					setStep({ stage: "preview", identity });
				}, "无法预览邀请，请检查内容或向对方要一份新邀请。");
			}}>
				<label className="grid gap-1 text-sm">桌面邀请
					<textarea className="rounded border border-line bg-transparent p-2" rows={3} value={invite} autoComplete="off" spellCheck={false} disabled={busy} onChange={e => setInvite(e.target.value)} />
				</label>
				<Button type="submit" variant="primary" disabled={busy || !invite.trim()}>预览电脑身份</Button>
			</form>}
			{step.stage === "preview" && <form className="grid gap-3" onSubmit={e => {
				e.preventDefault();
				const value = name.trim();
				if (!confirmed || !value || [...value].length > 60) return;
				const { id } = step.identity;
				void run(async () => {
					const { checkCode } = await port.claim({ id, name: value });
					setName("");
					setStep({ stage: "pending", id, checkCode });
				}, "未能确认申请已发出，请核对邀请后再试。");
			}}>
				<p className="text-sm text-mut">请向对方核对下面的地址和身份；有一项不符就不要申请。</p>
				<dl className="grid gap-1 rounded border border-line p-2 text-sm">
					{([["远端显示名称", step.identity.targetName], ["访问地址", step.identity.origin], ["服务器标识", step.identity.serverId], ["公钥", step.identity.publicKey]] as const).map(([label, value]) => <div key={label}>
						<dt className="text-mut">{label}</dt><dd className="break-all font-mono" dir="ltr">{value}</dd>
					</div>)}
				</dl>
				<label className="grid gap-1 text-sm">这台申请电脑的名称（供对方审核）<Input autoComplete="off" value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
				<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />我已与对方核对地址和身份</label>
				<div className="flex flex-wrap gap-2">
					<Button type="button" variant="ghost" disabled={busy} onClick={() => cancel(step.identity.id)}>取消</Button>
					<Button type="submit" variant="primary" disabled={busy || !confirmed || !name.trim() || [...name.trim()].length > 60}>发送配对申请</Button>
				</div>
			</form>}
			{step.stage === "pending" && <>
				<p className="text-sm text-mut">请让对方在远端电脑上核对这个编号，再批准申请。批准后，此电脑会自动领取。</p>
				<p className="break-all font-mono">核对编号：{step.checkCode}</p>
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" disabled={busy} onClick={collect}>立即检查并领取</Button>
					<Button variant="ghost" disabled={busy} onClick={() => cancel(step.id)}>停止在此电脑领取</Button>
				</div>
			</>}
			{step.stage === "remembered" && <>
				<p role="status">{step.name ? `已添加「${step.name}」` : "已添加远端电脑"}，可从「切换电脑」打开。</p>
				<Button variant="primary" onClick={close}>完成</Button>
			</>}
			{error && <p role="alert" className="text-sm text-mut">{error}</p>}
		</div>
	</Modal>;
}
