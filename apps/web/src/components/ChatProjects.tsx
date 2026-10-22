import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ChatProject } from "../types";
import { ProjectsPanel } from "./RoomWork";

/**
 * 单聊顶部的「项目」入口（docs/design/group-team.md §13）：和群聊同一个入口 + 面板（RoomWork 的 ProjectsPanel），
 * 数据来自 /api/conversations/:cid/projects。没有待确认 / 进行中的项目时不显示。
 * version 变了就重新取：聊天里每次方案卡 / 进度 / 交付都会多一条消息，调用方拿最后一条消息的标记当 version，不另开推送事件。
 */
export function ChatProjectsButton({ conversationId, version }: { conversationId: string | null; version: string }) {
	const [projects, setProjects] = useState<ChatProject[]>([]);
	// 连续几条消息会连着触发好几次取数：只认最后一次发出的请求，先发的后到也不能盖掉新结果
	const seq = useRef(0);
	const load = useCallback(async () => {
		const mine = ++seq.current;
		if (!conversationId) return setProjects([]);
		try {
			const r = await api<{ projects: ChatProject[] }>(`/api/conversations/${conversationId}/projects`);
			if (mine === seq.current) setProjects(Array.isArray(r?.projects) ? r.projects : []);
		} catch {
			/* 取不到就保持原样，下次消息变化再取 */
		}
	}, [conversationId]);
	useEffect(() => {
		setProjects([]);
	}, [conversationId]);
	useEffect(() => {
		void load();
	}, [load, version]);
	if (!conversationId) return null;
	return <ProjectsPanel solo base={`/api/conversations/${conversationId}`} projects={projects} refresh={load} />;
}
