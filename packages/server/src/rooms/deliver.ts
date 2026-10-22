/**
 * 把管理者写的文件引用解析成文件（关键点要用户看的文件、项目交付卡里的交付文件共用）：
 * 先在群里已有的附件里按名字找，找不到再当成管理者工作区里的路径登记（通用实现在 file-refs.ts，单聊项目交付卡也用它）；都不行就列入 missing。
 */
import { type FileRow, fileInfo } from "../files.ts";
import { insertMessage } from "../messages.ts";
import { resolveFileRefs } from "./file-refs.ts";
import { roomFiles } from "./scheduler.ts";
import { memberConversation } from "./store.ts";

export const resolveFiles = (roomId: string, agentId: string, refs: unknown) => resolveFileRefs(agentId, refs, roomFiles(roomId));

export const MISSING_HINT = (missing: string[]) => `找不到这些文件：${missing.join("、")}（先用 deliver_file 把文件发到群里，或写你工作区里的路径）`;

/** 以管理者的身份把文件作为附件发到群里（用户看得到、能预览下载）。 */
export function postFiles(roomId: string, agentId: string, files: FileRow[], content: string, meta: Record<string, unknown> = {}) {
	if (!files.length) return;
	insertMessage({ agentId, conversationId: memberConversation(roomId, agentId), roomId, role: "assistant", content, meta: { attachments: files.map(fileInfo), ...meta } });
}
