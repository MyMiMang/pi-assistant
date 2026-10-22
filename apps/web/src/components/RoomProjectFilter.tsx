import { type ReactNode, useMemo } from "react";
import { create } from "zustand";
import { useStore } from "../store";
import type { Message, Room, RoomProject } from "../types";
import { Select, cx } from "./ui";

/**
 * 群里同时有多个进行中项目时的「按项目看」：顶部筛选 + 气泡上的项目名小标签。
 * 筛选只在前端：按群记住（localStorage，读写失败就当没记）；项目不在了或只剩一个就自动回到「全部」。
 */
const KEY = "pia:room-project-filter";
const load = (): Record<string, string> => {
	try {
		return JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, string>;
	} catch {
		return {};
	}
};
const useFilterStore = create<{ by: Record<string, string>; pick: (roomId: string, id: string) => void }>((set, get) => ({
	by: load(),
	pick: (roomId, id) => {
		const by = { ...get().by, [roomId]: id };
		set({ by });
		try {
			localStorage.setItem(KEY, JSON.stringify(by));
		} catch {}
	},
}));

/** 进行中的项目；至少 2 个时才需要筛选和标签。 */
const runningProjects = (room: Room | undefined): RoomProject[] => (room?.projects ?? []).filter((p) => p.status === "active");

/** 纯逻辑：只留下属于该项目的消息，加上用户自己的消息（避免上下文断掉）。没选项目原样返回。 */
export function filterByProject(list: Message[], projectId: string): Message[] {
	return projectId ? list.filter((m) => m.role === "user" || m.meta.projectId === projectId) : list;
}

/** 当前生效的筛选（项目不在进行中的列表里就是 ""，即全部）。 */
function useActiveFilter(roomId: string): string {
	const picked = useFilterStore((s) => s.by[roomId] ?? "");
	const projects = useStore((s) => s.rooms.find((r) => r.id === roomId)?.projects);
	const running = (projects ?? []).filter((p) => p.status === "active");
	return running.length >= 2 && running.some((p) => p.id === picked) ? picked : "";
}

/** RoomChat 用：按筛选过滤后分组（group 是 RoomChat 自己的分组函数）。 */
export function useProjectRows<T>(roomId: string, list: Message[], group: (l: Message[]) => T): T {
	const f = useActiveFilter(roomId);
	return useMemo(() => group(filterByProject(list, f)), [list, f]);
}

/** 群顶部的筛选：「全部」+ 每个进行中的项目；少于 2 个进行中项目时不显示。 */
export function ProjectFilter({ room }: { room: Room }) {
	const value = useActiveFilter(room.id);
	const running = runningProjects(room);
	if (running.length < 2) return null;
	return (
		<Select
			value={value}
			options={[{ value: "", label: "全部项目" }, ...running.map((p) => ({ value: p.id, label: p.title }))]}
			onChange={(id) => useFilterStore.getState().pick(room.id, id)}
			ariaLabel="按项目筛选"
			testId="room-project-filter"
			className={cx("!h-8 max-w-[5rem] text-xs sm:max-w-[11rem]", value && "!border-accent")}
			menuMinWidth={200}
		/>
	);
}

/** 带项目的消息：有 ≥2 个进行中项目时，在上面加一个小项目名标签；否则原样输出。center 给居中的系统通知用。 */
export function ProjectTagged({ m, room, center, children }: { m: Message; room: Room; center?: boolean; children: ReactNode }) {
	const id = m.meta.projectId ? String(m.meta.projectId) : "";
	const running = runningProjects(room);
	const project = id && running.length >= 2 ? running.find((p) => p.id === id) : undefined;
	if (!project) return <>{children}</>;
	return (
		<div className={cx("flex min-w-0 max-w-full flex-col gap-1", center && "items-center")} data-testid="project-tagged" data-project={id}>
			<span className="pa-room-badge muted max-w-full self-start truncate" data-testid="project-tag" title={`项目：${project.title}`} style={center ? { alignSelf: "center" } : undefined}>项目 · {project.title}</span>
			{children}
		</div>
	);
}
