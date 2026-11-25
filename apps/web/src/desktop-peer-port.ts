import type { PeerConnection, PeerConversation, PeerMessage, PeerTextPort } from "./desktop-peer-session.ts";
import { tauriInvoke } from "./externalLinks.ts";

export interface DesktopPeerDevice { id: string; name: string; state: PeerConnection }
export interface DesktopPeerChat { agent: string; conversation: string; title: string }

export interface DesktopPeerPreview { id: string; origin: string; serverId: string; publicKey: string; targetName: string }
export interface DesktopPeerCollection { status: "pending" | "remembered"; device?: DesktopPeerDevice }
export interface DesktopPeerInvitationPort {
	preview(input: { invite: string }): Promise<DesktopPeerPreview>;
	claim(input: { id: string; name: string }): Promise<{ checkCode: string }>;
	collect(input: { id: string }): Promise<DesktopPeerCollection>;
	cancel(input: { id: string }): Promise<void>;
}

/** Supplied by the trusted desktop shell (or explicitly injected by the isolated test entry).
 * The browser displays the preview identity; after preview only opaque handles go back to the shell. */
export interface DesktopPeerPort extends PeerTextPort {
	list(signal: AbortSignal): Promise<readonly DesktopPeerDevice[]>;
	chats(peer: string, signal: AbortSignal): Promise<readonly DesktopPeerChat[]>;
	status(peer: string, signal: AbortSignal): Promise<PeerConnection>;
	invitation?: DesktopPeerInvitationPort;
	forget?(input: { id: string }): Promise<void>;
}

type DesktopPeerRequest =
	| { op: "available" | "list" }
	| { op: "status" | "chats"; id: string }
	| { op: "read"; target: PeerConversation }
	| { op: "send"; target: PeerConversation; text: string; clientId: string }
	| { op: "preview"; invite: string }
	| { op: "claim"; id: string; name: string }
	| { op: "collect" | "forget" | "cancel"; id: string };

/** Never fall back to browser fetch or storage if the shell lacks this capability. */
export async function openNativeDesktopPeerPort(): Promise<DesktopPeerPort | undefined> {
	const invoke = tauriInvoke();
	if (!invoke) return;
	const call = async <T>(request: DesktopPeerRequest, signal?: AbortSignal): Promise<T> => {
		signal?.throwIfAborted();
		const result = await invoke("desktop_peer", { request });
		// A WebView abort cannot cancel native work, but must suppress a stale reply.
		signal?.throwIfAborted();
		return result as T;
	};
	if (await call<boolean>({ op: "available" }).catch(() => false) !== true) return;
	return {
		list: signal => call<readonly DesktopPeerDevice[]>({ op: "list" }, signal),
		status: (id, signal) => call<PeerConnection>({ op: "status", id }, signal),
		chats: (id, signal) => call<readonly DesktopPeerChat[]>({ op: "chats", id }, signal),
		read: (target, signal) => call<readonly PeerMessage[]>({ op: "read", target }, signal),
		send: async (target, text, clientId) => { await call({ op: "send", target, text, clientId }); },
		invitation: {
			preview: input => call({ op: "preview", ...input }),
			claim: input => call({ op: "claim", ...input }),
			collect: input => call({ op: "collect", ...input }),
			cancel: async input => { await call({ op: "cancel", ...input }); },
		},
		forget: async input => { await call({ op: "forget", ...input }); },
	};
}
