/**
 * 把模型写的「文件引用」解析成文件（群聊的关键点 / 交付卡、单聊的项目交付卡共用）：
 * 先在已知的附件里按名字找（findRoomFile，不重复登记），找不到再当成助理工作区里的路径用 deliverFromWorkspace 登记；都不行就列入 missing。
 */
import { deliverFromWorkspace, type FileRow } from "../files.ts";

/**
 * 按名字在附件里找一个文件：文件名精确匹配；只给了路径（deliverables/x.md、room-files/群/abc123-x.md）就取最后一段再匹配；同名多个取最新。
 */
export function findRoomFile(files: FileRow[], ref: string): FileRow | undefined {
	const raw = String(ref ?? "").trim();
	const last = raw.split(/[\\/]/).filter(Boolean).pop() ?? "";
	const newest = (xs: FileRow[]) => xs.sort((a, b) => b.created_at - a.created_at)[0];
	return (raw && newest(files.filter((f) => f.name === raw))) || (last && (newest(files.filter((f) => f.name === last)) || newest(files.filter((f) => `${f.id.slice(-6)}-${f.name}` === last)))) || undefined;
}

export function resolveFileRefs(agentId: string, refs: unknown, known: FileRow[], hostAccess = false): { files: FileRow[]; missing: string[] } {
	const list = (Array.isArray(refs) ? refs : []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 20);
	const files: FileRow[] = [];
	const missing: string[] = [];
	for (const ref of list) {
		let f: FileRow | undefined = findRoomFile(known, ref);
		if (!f) {
			try {
				f = deliverFromWorkspace(agentId, ref, hostAccess);
			} catch {
				missing.push(ref);
				continue;
			}
		}
		if (!files.some((x) => x.id === f!.id)) files.push(f);
	}
	return { files, missing };
}
