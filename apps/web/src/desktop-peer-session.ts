/** State for a bundled desktop peer pane. The native boundary supplies only opaque device handles. */
export type PeerConversation = Readonly<{ peer: string; agent: string; conversation: string }>;
export type PeerMessage = Readonly<{ id: string; role: string; content: string }>;
export type PeerConnection = "offline" | "online" | "revoked";
export interface PeerTextPort {
	read(target: PeerConversation, signal: AbortSignal): Promise<readonly PeerMessage[]>;
	send(target: PeerConversation, text: string, id: string): Promise<void>;
}
const key = ({ peer, agent, conversation }: PeerConversation) => JSON.stringify([peer, agent, conversation]);

export function createDesktopPeerSession(port: PeerTextPort) {
	const states = new Map<string, PeerConnection>();
	const drafts = new Map<string, { text: string; revision: number }>();
	const sending = new Set<string>();
	let target: PeerConversation | null = null, revision = 0, request: AbortController | undefined;
	const abort = () => { request?.abort(); request = undefined; };
	return {
		select(next: PeerConversation | null) { abort(); target = next && Object.freeze({ ...next }); },
		setConnection(peer: string, state: PeerConnection) {
			if (states.get(peer) === "revoked") return;
			states.set(peer, state);
			if (state !== "online" && target?.peer === peer) abort();
			if (state === "revoked") for (const id of drafts.keys()) if ((JSON.parse(id) as string[])[0] === peer) drafts.delete(id);
		},
		draft() { return target ? drafts.get(key(target))?.text ?? "" : ""; },
		setDraft(text: string) { if (target && states.get(target.peer) !== "revoked") drafts.set(key(target), { text, revision: ++revision }); },
		async refresh(publish: (messages: readonly PeerMessage[]) => void) {
			const reading = target;
			if (!reading || states.get(reading.peer) !== "online") return;
			abort();
			const controller = new AbortController(); request = controller;
			try {
				const messages = await port.read(reading, controller.signal);
				if (request === controller && target === reading && !controller.signal.aborted && states.get(reading.peer) === "online") publish(messages);
			} catch (error) { if (!controller.signal.aborted) throw error; }
			finally { if (request === controller) request = undefined; }
		},
		async send(newId: () => string) {
			const sendingTo = target;
			if (!sendingTo || states.get(sendingTo.peer) !== "online") return false;
			const id = key(sendingTo), draft = drafts.get(id);
			if (!draft?.text.trim() || sending.has(id)) return false;
			sending.add(id);
			try {
				await port.send(sendingTo, draft.text, newId());
				if (states.get(sendingTo.peer) === "online" && drafts.get(id)?.revision === draft.revision) drafts.delete(id);
				return true;
			} finally { sending.delete(id); }
		},
	};
}
