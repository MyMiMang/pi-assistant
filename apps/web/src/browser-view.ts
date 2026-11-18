import { useEffect, useRef, useState } from "react";
import type { BrowserFrame, BrowserPageInfo, BrowserState } from "@pi-assistant/shared";
import { api, base } from "./api";

/** 查看连接生命周期与业务 Page 分离；断线不交还控制权，不重放输入。 */
export function useBrowserView(agentId: string, pageId: string | null, visible: boolean, canvas: React.RefObject<HTMLCanvasElement | null>, selectionRequest = 0) {
	const [connected, setConnected] = useState(false), [error, setError] = useState("");
	const [state, setState] = useState<BrowserState | null>(null), [drawn, setDrawn] = useState<BrowserFrame | null>(null);
	const socket = useRef<WebSocket | null>(null), frame = useRef<BrowserFrame | null>(null);
	const pending = useRef<{ id: string; resolve(): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> } | null>(null);
	const [attempt, retry] = useState(0);
	const selected = useRef(selectionRequest);
	useEffect(() => {
		if (!visible || !pageId) return;
		let live = true, ws: WebSocket | undefined, drawing = 0;
		setConnected(false); setError(""); setDrawn(null); frame.current = null;
		void api<{ ticket: string }>(`/api/agents/${agentId}/browser/ticket`, { method: "POST", json: { pageId } }).then(({ ticket }) => {
			if (!live) return;
			const url = new URL(`${base()}/browser/ws`, location.origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("ticket", ticket);
			ws = new WebSocket(url); socket.current = ws;
			ws.onmessage = (event) => {
				if (!live) return;
				const message = JSON.parse(event.data);
				if (message.type === "ready") { setConnected(true); if (selectionRequest !== selected.current) { selected.current = selectionRequest; ws?.send(JSON.stringify({ type: "select" })); } }
				else if (message.type === "state") setState(message);
				else if (message.type === "frame") {
					const version = ++drawing, incoming = message as BrowserFrame;
					const image = new Image();
					image.onload = () => {
						if (!live || version !== drawing || !canvas.current || image.naturalWidth !== incoming.width || image.naturalHeight !== incoming.height) return;
						canvas.current.width = incoming.width; canvas.current.height = incoming.height;
						canvas.current.getContext("2d")?.drawImage(image, 0, 0);
						frame.current = incoming; setDrawn(null);
						ws?.send(JSON.stringify({ ...incoming, data: undefined, type: "ack" }));
					};
					image.onerror = () => setError("网页画面解码失败，请重新连接");
					image.src = `data:image/jpeg;base64,${incoming.data}`;
				} else if (message.type === "drawn") { if (frame.current?.seq === message.seq) setDrawn(frame.current); }
				else if (message.type === "error") setError(message.error);
				else if (message.type === "result" && pending.current && pending.current.id === message.requestId) {
					const operation = pending.current; pending.current = null; clearTimeout(operation.timer);
					if (message.error) operation.reject(new Error(message.error)); else operation.resolve();
				}
			};
			ws.onclose = () => { if (live) { setConnected(false); setDrawn(null); setError("查看连接已断开，网页和控制权保持原状。请重新连接；未确认的操作不要重复提交。"); } };
			ws.onerror = () => { if (live) setError("网页连接失败，请重新连接"); };
		}).catch((e) => { if (live) setError(String(e.message ?? e)); });
		return () => {
			live = false; drawing++; socket.current = null; frame.current = null; ws?.close();
			const operation = pending.current; pending.current = null;
			if (operation) { clearTimeout(operation.timer); operation.reject(new Error("查看已关闭，操作结果未确认；请重新读取网页")); }
		};
	}, [agentId, pageId, visible, attempt, canvas, selectionRequest]);
	const send = (type: string, page: BrowserPageInfo, extra: Record<string, unknown> = {}) => new Promise<void>((resolve, reject) => {
		if (socket.current?.readyState !== WebSocket.OPEN || pending.current) return reject(new Error("连接未准备好或上一步仍在进行"));
		const id = crypto.randomUUID();
		pending.current = { id, resolve, reject, timer: setTimeout(() => { pending.current = null; socket.current?.close(); reject(new Error("操作结果尚未确认，连接已停止，请核实网页后再操作")); }, 40_000) };
		socket.current.send(JSON.stringify({ ...page, ...extra, type, seq: frame.current?.seq, requestId: id }));
	});
	return { connected: connected && visible, error, state, drawn, send, reconnect: () => retry(x => x + 1) };
}
