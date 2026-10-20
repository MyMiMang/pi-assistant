import { useState } from "react";
import { Flag } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { Room } from "../types";
import { Modal, cx, useConfirm } from "./ui";
import { WorkItemsButton } from "./WorkItems";

/** 群聊顶部和任务相关的两个入口：任务看板、自主推进（RoomChat 只引这一个，换群时一起重挂）。 */
export function RoomWorkButtons({ room }: { room: Room }) {
	return <><WorkItemsButton room={room} /><AutonomyButton room={room} /></>;
}

/**
 * 群聊顶部的「自主推进」入口：没开时写目标 + 完成标准后开始；开着时显示目标并可结束。
 * 开启后成员可以 @ 彼此协作，管理者拆任务、卡住时自己想办法，只有需要用户拍板 / 提供东西的事才问用户。
 */
export function AutonomyButton({ room }: { room: Room }) {
	const [open, setOpen] = useState(false);
	const [goal, setGoal] = useState("");
	const [done, setDone] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [dlg, ask] = useConfirm();
	const a = room.autonomy;
	const save = async (method: "PUT" | "DELETE", json?: Record<string, string>) => {
		setBusy(true);
		setErr("");
		try {
			await api(`/api/rooms/${room.id}/autonomy`, { method, ...(json ? { json } : {}) });
			await useStore.getState().loadRooms();
			setOpen(false);
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<button className={cx("pa-chip", a && "pa-chip-on")} onClick={() => setOpen(true)} data-testid="room-autonomy-chip" aria-label="自主推进" title={a ? `自主推进中：${a.goal}` : "给群一个目标，成员自己协作推进，只有需要你拍板的事才问你"}>
				<Flag className="pa-ic" />
				<span className="max-sm:hidden">{a ? "推进中" : "自主推进"}</span>
			</button>
			<Modal open={open} onClose={() => setOpen(false)} title="自主推进" testId="room-autonomy-panel">
				<div className="space-y-3 p-4">
					<p className="text-xs text-mut2">写清目标和怎样算完成：管理者会拆任务派给成员，成员可以互相 @ 协作；卡住由管理者想办法，只有需要你才能给的东西或你要拍板的事才问你。</p>
					{a ? (
						<div className="pa-work-autonomy on" data-testid="work-autonomy">
							<Flag className="pa-ic accent" />
							<div className="min-w-0 flex-1">
								<b>自主推进中：{a.goal}</b>
								<small>完成标准：{a.doneCriteria}</small>
							</div>
						</div>
					) : (
						<>
							<label className="pa-work-field"><span>目标</span><input className="pa-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="例如：这周交一份竞品报告" data-testid="work-autonomy-goal" /></label>
							<label className="pa-work-field"><span>完成标准</span><textarea className="pa-input min-h-16" value={done} onChange={(e) => setDone(e.target.value)} placeholder="怎样检查算达成" data-testid="work-autonomy-done" /></label>
						</>
					)}
					{err ? <p className="pa-work-error" role="alert">{err}</p> : null}
					<div className="flex justify-end">
						{a ? (
							<button className="pa-btn sm" disabled={busy} data-testid="work-autonomy-end" onClick={async () => (await ask({ title: "结束自主推进？", body: "成员回到只在被 @ 时发言；已经在做的任务不受影响。", ok: "结束" })) && void save("DELETE")}>结束自主推进</button>
						) : (
							<button className="pa-btn sm primary" disabled={busy || !goal.trim() || !done.trim()} onClick={() => void save("PUT", { goal, doneCriteria: done })} data-testid="work-autonomy-start">开始自主推进</button>
						)}
					</div>
				</div>
			</Modal>
			{dlg}
		</>
	);
}
