/**
 * 把管理者写的文件引用解析成文件（关键点要用户看的文件、项目交付卡里的交付文件共用）：
 * 先在群里已有的附件里按名字找（findRoomFile，不重复登记），找不到再当成管理者工作区里的路径用 deliverFromWorkspace 登记；都不行就列入 missing。
 */
import { deliverFromWorkspace, fileInfo, type FileRow } from "../files.ts";
import { insertMessage } from "../messages.ts";
import { roomFiles } from "./scheduler.ts";
import { memberConversation } from "./store.ts";
import { findRoomFile } from "./tools.ts";

export function resolveFiles(roomId: string, agentId: string, refs: unknown): { files: FileRow[]; missing: string[] } {
	const list = (Array.isArray(refs) ? refs : []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 20);
	const inRoom = roomFiles(roomId);
	const files: FileRow[] = [];
	const missing: string[] = [];
	for (const ref of list) {
		let f: FileRow | undefined = findRoomFile(inRoom, ref);
		if (!f) {
			try {
				f = deliverFromWorkspace(agentId, ref);
			} catch {
				missing.push(ref);
				continue;
			}
		}
		if (!files.some((x) => x.id === f!.id)) files.push(f);
	}
	return { files, missing };
}

export const MISSING_HINT = (missing: string[]) => `找不到这些文件：${missing.join("、")}（先用 deliver_file 把文件发到群里，或写你工作区里的路径）`;

/** 以管理者的身份把文件作为附件发到群里（用户看得到、能预览下载）。 */
export function postFiles(roomId: string, agentId: string, files: FileRow[], content: string, meta: Record<string, unknown> = {}) {
	if (!files.length) return;
	insertMessage({ agentId, conversationId: memberConversation(roomId, agentId), roomId, role: "assistant", content, meta: { attachments: files.map(fileInfo), ...meta } });
}
