import { useEffect, useMemo, useRef, useState } from "react";
import { Laptop } from "lucide-react";
import { createDesktopPeerSession, type PeerMessage } from "../desktop-peer-session";
import type { DesktopPeerChat, DesktopPeerDevice, DesktopPeerPort } from "../desktop-peer-port";
import { Button, Modal, useConfirm } from "./ui";
import { DesktopPeerInvitation } from "./DesktopPeerInvitation";

const labels = { online: "在线", offline: "已断线", revoked: "访问已撤销" } as const;
const initial = { chats: [] as readonly DesktopPeerChat[], messages: [] as readonly PeerMessage[], state: "offline" as DesktopPeerDevice["state"], error: "" };

export function DesktopPeerSwitch({ port, onOpen }: { port: DesktopPeerPort; onOpen?: (open: boolean) => void }) {
	const [menu, setMenu] = useState(false);
	const [devices, setDevices] = useState<readonly DesktopPeerDevice[]>([]);
	const [listError, setListError] = useState(false);
	const [listTick, setListTick] = useState(0);
	const [invitationOpen, setInvitationOpen] = useState(false);
	const [forgetError, setForgetError] = useState(false);
	const [forgetting, setForgetting] = useState(false);
	const [forgetDialog, confirmForget] = useConfirm();
	const [peer, setPeer] = useState<DesktopPeerDevice | null>(null);
	const session = useMemo(() => createDesktopPeerSession(port), [port]);
	const trigger = useRef<HTMLButtonElement>(null);
	const dialogContent = useRef<HTMLDivElement>(null);
	const active = useRef<DesktopPeerDevice | null>(null);
	const [chat, setChat] = useState<DesktopPeerChat | null>(null);
	const [view, setView] = useState(initial);
	const [draft, setDraft] = useState("");
	const [tick, setTick] = useState(0);
	const [pending, setPending] = useState(false);
	const scope = useRef(0);
	useEffect(() => {
		if (!menu || forgetting) return;
		const c = new AbortController();
		setListError(false);
		void port.list(c.signal).then(rows => { if (!c.signal.aborted) setDevices(rows); }, () => { if (!c.signal.aborted) setListError(true); });
		return () => c.abort();
	}, [menu, port, listTick, forgetting]);

	const isOpen = peer !== null || invitationOpen;
	useEffect(() => {
		onOpen?.(isOpen);
		if (isOpen) dialogContent.current?.focus();
		return () => onOpen?.(false);
	}, [isOpen, onOpen]);

	function select(next: DesktopPeerDevice | null) {
		if (!next && active.current) requestAnimationFrame(() => trigger.current?.focus());
		scope.current++;
		active.current = next;
		session.select(null);
		setChat(null); setDraft(""); setPending(false); setView(initial);
		setPeer(next); setMenu(false);
	}
	function selectChat(next: DesktopPeerChat) {
		if (!active.current) return;
		scope.current++;
		session.select({ peer: active.current.id, agent: next.agent, conversation: next.conversation });
		setChat(next); setDraft(session.draft()); setPending(false);
		setView(v => ({ ...v, messages: [], error: "" }));
	}

	useEffect(() => {
		if (!peer) return;
		const c = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const generation = scope.current;
		const live = () => !c.signal.aborted && generation === scope.current && active.current === peer;
		const update = (fn: (v: typeof initial) => typeof initial) => { if (live()) setView(fn); };
		async function sync() {
			if (!peer || !live()) return;
			try {
				const state = await port.status(peer.id, c.signal);
				if (!live()) return;
				session.setConnection(peer.id, state);
				update(v => state === "revoked" ? { ...initial, state } : { ...v, state });
				if (state === "revoked") { setDraft(""); return; }
				if (state === "online") {
					const chats = await port.chats(peer.id, c.signal);
					update(v => ({ ...v, chats }));
					if (live() && chat) await session.refresh(messages => update(v => ({ ...v, messages })));
				}
			} catch {
				if (live()) { session.setConnection(peer.id, "offline"); update(v => ({ ...v, state: "offline" })); }
			}
			if (live()) timer = setTimeout(() => void sync(), 1800);
		}
		void sync();
		return () => { c.abort(); clearTimeout(timer); };
	}, [peer, chat, port, session, tick]);

	async function send() {
		if (!peer || view.state !== "online" || pending) return;
		const generation = scope.current;
		setPending(true);
		setView(v => ({ ...v, error: "" }));
		try {
			await session.send(() => crypto.randomUUID());
			if (generation === scope.current) { setDraft(session.draft()); setTick(t => t + 1); }
		} catch {
			if (generation === scope.current) {
				session.setConnection(peer.id, "offline");
				setView(v => ({ ...v, state: "offline", error: "未确认是否送达，不会自动重发。重连后请先查看远端聊天。" }));
				setTick(t => t + 1);
			}
		} finally { if (generation === scope.current) setPending(false); }
	}

	async function forget(device: DesktopPeerDevice) {
		if (!port.forget || forgetting) return;
		setForgetting(true);
		setForgetError(false);
		try {
			if (!await confirmForget({ title: `忘记「${device.name}」？`, body: "仅从这台电脑移除连接。要撤销访问权限，请到远端电脑上操作。", ok: "忘记电脑", danger: true })) return;
			await port.forget({ id: device.id });
			setDevices(rows => rows.filter(d => d.id !== device.id));
		} catch { setForgetError(true); }
		finally { setForgetting(false); }
	}

	return <>
		<div className="relative">
			<button ref={trigger} className="pa-icon-btn ghost" aria-label="切换电脑" aria-expanded={menu} title="切换电脑" onClick={() => { setForgetError(false); setDevices([]); setMenu(!menu); }}><Laptop className="pa-ic" /></button>
			{menu && <div className="absolute left-0 top-full z-30 mt-1 grid min-w-40 gap-1 rounded-lg border border-line bg-panel p-2 shadow-lg" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setMenu(false); } }}>
				<Button variant="ghost" onClick={() => select(null)}>本机</Button>
				<div className="grid max-h-56 gap-1 overflow-auto">{devices.map(d => <div key={d.id} className="flex items-center gap-1">
					<Button variant="ghost" className="min-w-0 flex-1" disabled={forgetting} onClick={() => select(d)}><span className="truncate">{d.name} · {labels[d.state]}</span></Button>
					{port.forget && <Button size="sm" variant="ghost" aria-label={`忘记 ${d.name}`} disabled={forgetting} onClick={() => void forget(d)}>忘记</Button>}
				</div>)}</div>
				{listError && <Button size="sm" variant="ghost" onClick={() => setListTick(t => t + 1)}>电脑列表读取失败，重试</Button>}
				{forgetError && <p role="alert" className="text-xs text-mut">暂时无法忘记这台电脑</p>}
				{port.invitation && <Button variant="outline" onClick={() => { setMenu(false); setInvitationOpen(true); }}>添加远端电脑</Button>}
			</div>}
		</div>
		{forgetDialog}
		{port.invitation && <DesktopPeerInvitation port={port.invitation} open={invitationOpen} onClose={() => {
			setInvitationOpen(false);
			requestAnimationFrame(() => trigger.current?.focus());
		}} />}
		{peer && <Modal open wide title={peer.name} ariaLabel={peer.name} onClose={() => select(null)}>
			<div ref={dialogContent} tabIndex={-1} className="grid gap-3 p-4" data-testid="desktop-peer-chat">
				<div className="flex flex-wrap items-center gap-2"><span role="status">{labels[view.state]}</span><Button size="sm" variant="outline" onClick={() => setTick(t => t + 1)}>刷新连接</Button><Button size="sm" variant="ghost" onClick={() => select(null)}>本机</Button></div>
				{view.state !== "revoked" && <>
					<nav aria-label="远端聊天" className="flex max-h-40 flex-wrap gap-2 overflow-auto">{view.chats.map(c => <Button key={JSON.stringify([c.agent, c.conversation])} variant={chat?.agent === c.agent && chat.conversation === c.conversation ? "primary" : "outline"} onClick={() => selectChat(c)}>{c.title}</Button>)}</nav>
					{chat && <><ol aria-label="远端消息记录" className="max-h-64 space-y-2 overflow-auto">{view.messages.map(m => <li key={m.id} className="whitespace-pre-wrap break-words rounded border border-line p-2"><span className="text-xs text-mut">{m.role === "user" ? "你" : chat.title}</span><p>{m.content}</p></li>)}</ol>
					<form className="grid gap-2" onSubmit={e => { e.preventDefault(); void send(); }}>
						<textarea aria-label="远端消息" className="rounded border border-line bg-transparent p-2" value={draft} maxLength={100000} onChange={e => { session.setDraft(e.target.value); setDraft(session.draft()); }} />
						<Button type="submit" variant="primary" disabled={pending || view.state !== "online" || !draft.trim()}>发送到{peer.name}</Button>
					</form></>}
				</>}
				{view.error && <p role="alert" className="text-sm">{view.error}</p>}
				<p className="text-xs text-mut">仅支持远端文本。附件和工具批准不可用，不会转到本机。</p>
			</div>
		</Modal>}
	</>;
}
