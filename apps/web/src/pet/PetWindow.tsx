/**
 * 桌宠窗口（/pet）：托盘程序开的透明、无边框、置顶小窗。只有宠物和气泡能点，其余地方点击会穿透到下面的程序。
 * - 宠物动画跟着助理状态（GET /api/pet/state，每秒一次）
 * - 等你批准：气泡里直接批准 / 拒绝；提问：点选项回答
 * - 单击宠物：快速对话（发给当前助理）；双击：打开主窗口；按住拖动：移动位置（托盘记住位置）；右键：菜单
 */
import { Check, ExternalLink, EyeOff, Loader2, Send, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { cx } from "../components/ui";
import { type PetState, type Row, STATE_ROW } from "./atlas";
import { PetSprite } from "./PetSprite";
import { call, inTauri, openMain } from "./tauri";

export interface PetStatus {
	enabled: boolean;
	scale: number;
	agent: { id: string; name: string; avatar: string; color: string } | null;
	pet: { id: string; name: string; url: string };
	state: PetState;
	text: string;
	request: { id: string; kind: "approval" | "question"; agentName: string; summary: string; risk?: string; question?: string; options?: string[]; allowFreeText?: boolean; allowTask?: boolean } | null;
	queued: number;
	busyOthers: number;
}

const RISK: Record<string, string> = { high: "高风险", medium: "需留意", low: "" };

export default function PetWindow() {
	const [st, setSt] = useState<PetStatus | null>(null);
	const [chat, setChat] = useState(false);
	const [menu, setMenu] = useState(false);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("");
	const [greet, setGreet] = useState<Row | null>("waving");
	const [hidden, setHidden] = useState<string | null>(null); // 关掉的气泡（同一句话不再出现）
	const rootRef = useRef<HTMLDivElement>(null);

	const load = useCallback(() => api<PetStatus>("/api/pet/state").then(setSt).catch(() => {}), []);
	useEffect(() => {
		document.documentElement.classList.add("pa-pet-root");
		void load();
		const t = setInterval(load, 1000);
		return () => clearInterval(t);
	}, [load]);

	// 菜单：Esc 或 8 秒后自动收起（点到窗口外面会穿透到别的程序，收不到点击）
	useEffect(() => {
		if (!menu) return;
		const k = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
		addEventListener("keydown", k);
		addEventListener("blur", () => setMenu(false), { once: true });
		const t = setTimeout(() => setMenu(false), 8000);
		return () => (removeEventListener("keydown", k), clearTimeout(t));
	}, [menu]);

	// 空闲时偶尔挥挥手
	useEffect(() => {
		if (st?.state !== "idle" || chat) return;
		const t = setTimeout(() => setGreet("waving"), 40_000 + Math.random() * 40_000);
		return () => clearTimeout(t);
	}, [st?.state, chat, greet]);

	// 告诉托盘哪些区域能点（其余穿透）：所有 [data-hit] 元素的矩形（CSS 像素，相对窗口）
	const report = useCallback(() => {
		const rects = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-hit]") ?? [])].map((el) => {
			const r = el.getBoundingClientRect();
			return [r.left, r.top, r.width, r.height];
		});
		void call("pet_hitbox", { rects });
	}, []);
	useLayoutEffect(() => {
		report();
	});
	useEffect(() => {
		const ro = new ResizeObserver(report);
		if (rootRef.current) ro.observe(rootRef.current);
		return () => ro.disconnect();
	}, [report]);

	// 单击 / 双击 / 拖动
	const down = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
	const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const onPointerDown = (e: React.PointerEvent) => {
		if (e.button !== 0) return;
		down.current = { x: e.screenX, y: e.screenY, dragged: false };
	};
	const onPointerMove = (e: React.PointerEvent) => {
		const d = down.current;
		if (!d || d.dragged) return;
		if (Math.abs(e.screenX - d.x) + Math.abs(e.screenY - d.y) > 4) {
			d.dragged = true;
			setGreet(e.screenX >= d.x ? "running-right" : "running-left");
			void call("pet_drag");
		}
	};
	const onPointerUp = () => {
		const d = down.current;
		down.current = null;
		if (!d) return;
		if (d.dragged) return setTimeout(() => setGreet(null), 600);
		clearTimeout(clickTimer.current);
		clickTimer.current = setTimeout(() => {
			setMenu(false);
			setChat((v) => !v);
			setNote("");
		}, 230);
	};
	const onDouble = () => {
		clearTimeout(clickTimer.current);
		setChat(false);
		openMain(st?.agent ? `/?agent=${st.agent.id}` : "/");
	};

	const send = async () => {
		const text = draft.trim();
		if (!text || !st?.agent || busy) return;
		setBusy(true);
		try {
			await api(`/api/agents/${st.agent.id}/messages`, { method: "POST", json: { text } });
			setDraft("");
			setChat(false);
			setNote(`已发给${st.agent.name}`);
			setTimeout(() => setNote(""), 2500);
			void load();
		} catch (e) {
			setNote(e instanceof Error ? e.message : "发送失败");
		} finally {
			setBusy(false);
		}
	};
	const answer = async (body: Record<string, unknown>) => {
		if (!st?.request) return;
		setBusy(true);
		await api(`/api/requests/${st.request.id}`, { method: "POST", json: body }).catch(() => {});
		setBusy(false);
		void load();
	};
	const hide = async () => {
		setMenu(false);
		await api("/api/pet/settings", { method: "PUT", json: { enabled: false } }).catch(() => {});
	};

	if (!st) return null;
	const scale = st.scale || 0.8;
	const row: Row = greet ?? STATE_ROW[st.state];
	const req = st.request;
	const bubbleText = note || st.text;
	const showText = !req && !chat && !menu && !!bubbleText && hidden !== bubbleText;

	return (
		<div ref={rootRef} className="pa-pet" data-testid="pet-window" data-state={st.state}>
			<div className="pa-pet-stack">
				{req && (
					<div className="pa-pet-bubble wide" data-hit data-testid="pet-request">
						<div className="pa-pet-who">
							{req.agentName}
							{req.kind === "approval" && req.risk && RISK[req.risk] && <span className={cx("pa-pet-risk", req.risk)}>{RISK[req.risk]}</span>}
							{st.queued > 0 && <span className="pa-pet-queue">还有 {st.queued} 个</span>}
						</div>
						<div className="pa-pet-text">{req.kind === "approval" ? req.summary || "要执行一个需要你批准的操作" : req.question}</div>
						{req.kind === "approval" ? (
							<div className="pa-pet-actions">
								<button className="pa-pet-btn ok" disabled={busy} onClick={() => answer({ approved: true })} data-testid="pet-approve">
									<Check size={13} /> 批准
								</button>
								<button className="pa-pet-btn" disabled={busy} onClick={() => answer({ approved: false })} data-testid="pet-reject">
									<X size={13} /> 拒绝
								</button>
								<button className="pa-pet-btn ghost" title="在主窗口查看详情" onClick={() => openMain(st.agent ? `/?agent=${st.agent.id}` : "/")}>
									<ExternalLink size={13} />
								</button>
							</div>
						) : (
							<div className="pa-pet-actions wrap">
								{(req.options ?? []).slice(0, 4).map((o) => (
									<button key={o} className="pa-pet-btn" disabled={busy} onClick={() => answer({ answer: o })}>
										{o}
									</button>
								))}
								<button className="pa-pet-btn ghost" onClick={() => openMain(st.agent ? `/?agent=${st.agent.id}` : "/")}>
									<ExternalLink size={13} /> 去回答
								</button>
							</div>
						)}
					</div>
				)}
				{!req && chat && st.agent && (
					<form
						className="pa-pet-bubble wide"
						data-hit
						data-testid="pet-chat"
						onSubmit={(e) => {
							e.preventDefault();
							void send();
						}}
					>
						<div className="pa-pet-who">发给 {st.agent.name}</div>
						<div className="pa-pet-input">
							<input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setChat(false)} placeholder="说点什么…" maxLength={2000} data-testid="pet-input" />
							<button type="submit" className="pa-pet-send" disabled={!draft.trim() || busy} aria-label="发送">
								{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
							</button>
						</div>
					</form>
				)}
				{!req && chat && !st.agent && (
					<div className="pa-pet-bubble" data-hit>
						<div className="pa-pet-text">还没有助理，双击我去创建</div>
					</div>
				)}
				{menu && (
					<div className="pa-pet-menu" data-hit data-testid="pet-menu">
						<button onClick={() => (setMenu(false), openMain(st.agent ? `/?agent=${st.agent.id}` : "/"))}>
							<ExternalLink size={14} /> 打开 Pi Assistant
						</button>
						<button onClick={() => (setMenu(false), openMain("/?settings=pet"))}>
							<Settings2 size={14} /> 换宠物 / 设置
						</button>
						<button onClick={hide}>
							<EyeOff size={14} /> 隐藏桌宠
						</button>
					</div>
				)}
				{showText && (
					<div className={cx("pa-pet-bubble", st.state === "error" && "err")} data-hit data-testid="pet-bubble" onClick={() => (st.state === "error" || st.state === "done" ? openMain(st.agent ? `/?agent=${st.agent.id}` : "/") : setHidden(bubbleText))}>
						{st.agent && st.state !== "idle" && !note && <span className="pa-pet-who inline">{st.agent.name}</span>}
						<span className="pa-pet-text">{bubbleText}</span>
						{st.busyOthers > 0 && <span className="pa-pet-queue">另有 {st.busyOthers} 个助理在忙</span>}
					</div>
				)}
				<div
					className="pa-pet-body"
					data-hit
					title={st.agent ? `${st.pet.name} · ${st.agent.name}` : st.pet.name}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onDoubleClick={onDouble}
					onContextMenu={(e) => {
						e.preventDefault();
						setChat(false);
						setMenu((v) => !v);
					}}
					style={{ width: 192 * scale * 0.72, height: 208 * scale * 0.86 }}
				>
					<PetSprite url={st.pet.url} row={row} scale={scale} once={!!greet && greet === "waving"} onDone={() => setGreet(null)} testId="pet-sprite" />
				</div>
			</div>
			{!inTauri() && <div className="pa-pet-preview-tip">桌宠预览（在桌面版里是透明悬浮的）</div>}
		</div>
	);
}
