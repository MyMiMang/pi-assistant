import { useEffect, useState } from "react";
import { Archive, Flag } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { Room, RoomProject } from "../types";
import { PROJECT_STATUS, PlanBody } from "./RoomCards";
import { Fold, Help, Modal, cx, fmtTime, useConfirm } from "./ui";
import { WorkItemsButton } from "./WorkItems";

/** 群聊顶部和干活相关的入口：任务看板、项目（RoomChat 只引这一个，换群时一起重挂）。 */
export function RoomWorkButtons({ room }: { room: Room }) {
	return <><WorkItemsButton room={room} /><ProjectsButton room={room} /></>;
}

/**
 * 群聊顶部的「项目」入口：没有待确认 / 进行中的项目时不显示。
 * 一个项目显示名称 + 状态，多个显示「项目 N」；点开看方案、停下项目、翻已结束的项目。
 * 立项不在这里：用户在群里跟管理者说要做的事，管理者出方案卡，用户确认后项目开始。
 */
export function ProjectsButton({ room }: { room: Room }) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [ended, setEnded] = useState<RoomProject[] | null>(null);
	const [showEnded, setShowEnded] = useState(false);
	const [dlg, ask] = useConfirm();
	const projects = room.projects ?? [];
	// 项目都结束后入口隐藏，面板也要关掉：否则下次出新方案时会带着旧的打开状态自己弹出来
	useEffect(() => { if (!projects.length) setOpen(false); }, [projects.length]);
	if (!projects.length) return null;
	const one = projects.length === 1 ? projects[0] : null;
	const active = projects.some((p) => p.status === "active");
	const loadEnded = async () => {
		setErr("");
		try {
			const r = await api<{ projects: RoomProject[] }>(`/api/rooms/${room.id}/projects?all=1`);
			setEnded(r.projects.filter((p) => p.status !== "proposed" && p.status !== "active"));
		} catch (e) {
			setErr((e as Error).message);
		}
	};
	const stop = async (p: RoomProject) => {
		if (!(await ask({ title: `停下项目「${p.title}」？`, body: "这个项目下正在做的任务会暂停，进度保留；想继续就在群里跟管理者说。", ok: "停下", danger: true }))) return;
		setBusy(true);
		setErr("");
		try {
			await api(`/api/rooms/${room.id}/projects/${p.id}/stop`, { method: "POST" });
			await useStore.getState().loadRooms();
			if (ended) void loadEnded();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<button className={cx("pa-chip", active && "pa-chip-on")} onClick={() => setOpen(true)} data-testid="room-projects-chip" aria-label="项目" title={projects.map((p) => `${p.title}（${PROJECT_STATUS[p.status]}）`).join("\n")}>
				<Flag className="pa-ic" />
				{one ? (
					<span className="flex min-w-0 items-center gap-1 max-sm:hidden">
						<span className="max-w-[10rem] truncate">{one.title}</span>
						<small className="shrink-0 text-[11px] opacity-80">· {PROJECT_STATUS[one.status]}</small>
					</span>
				) : (
					<span className="max-sm:hidden">项目 {projects.length}</span>
				)}
			</button>
			<Modal open={open} onClose={() => setOpen(false)} title="项目" testId="room-projects-panel">
				<div className="space-y-3 p-4">
					<p className="flex items-center gap-1 text-xs text-mut2">
						管理者按方案分工推进，只有需要你看一眼或拍板的事才找你。
						<Help>想做一件新事，直接在群里跟管理者说；管理者会先出一份方案卡，你确认后项目才开始。想改方案也直接在群里说。</Help>
					</p>
					{projects.map((p) => (
						<div key={p.id} className="pa-project" data-testid="room-project-item" data-status={p.status}>
							<div className="pa-project-head">
								<b>{p.title}</b>
								<span className="pa-tag">{PROJECT_STATUS[p.status]}</span>
							</div>
							<PlanBody plan={p.plan} />
							{p.status === "proposed" && <p className="text-xs text-mut2">方案卡在群里，确认后开始。</p>}
							{p.draft && <p className="text-xs text-mut2">有一份改过的方案在群里等你确认；确认前按原方案继续。</p>}
							{p.status === "active" && (
								<div className="flex justify-end">
									<button className="pa-btn sm" disabled={busy} onClick={() => void stop(p)} data-testid="room-project-stop">停下这个项目</button>
								</div>
							)}
						</div>
					))}
					{err ? <p className="pa-work-error" role="alert">{err}</p> : null}
					<Fold icon={Archive} title="已结束的项目" count={ended?.length} open={showEnded} onToggle={() => { if (!showEnded && !ended) void loadEnded(); setShowEnded(!showEnded); }} testId="room-projects-ended">
						{!ended ? (
							<p className="text-xs text-mut2">加载中…</p>
						) : !ended.length ? (
							<p className="text-xs text-mut2">还没有结束的项目。</p>
						) : (
							<div className="max-h-64 overflow-y-auto">
								{ended.map((p) => (
									<div key={p.id} className="pa-project-ended">
										<b>{p.title}<small className="ml-1.5 font-normal">{PROJECT_STATUS[p.status]}{p.endedAt ? ` · ${fmtTime(p.endedAt)}` : ""}</small></b>
										{p.summary && <span className="text-mut">{p.summary}</span>}
									</div>
								))}
							</div>
						)}
					</Fold>
				</div>
			</Modal>
			{dlg}
		</>
	);
}
