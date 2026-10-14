import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { db, now, uid } from "./db.ts";

const MIME: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
	".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
	".html": "text/html", ".py": "text/x-python", ".ts": "text/plain", ".js": "text/javascript", ".zip": "application/zip",
	".heic": "image/heic", ".heif": "image/heif", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".tsv": "text/tab-separated-values", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

export interface FileRow { id: string; agent_id: string; room_id?: string | null; name: string; mime: string; size: number; stored_path: string; workspace_path: string | null; direction: string; created_at: number }
export const fileInfo = (f: FileRow) => ({ fileId: f.id, roomId: f.room_id ?? undefined, name: f.name, mime: f.mime, size: f.size, direction: f.direction, workspacePath: f.workspace_path, createdAt: f.created_at });

export function workspaceOf(agentId: string) {
	const ws = join(config.workspaceRoot, agentId);
	mkdirSync(ws, { recursive: true });
	return ws;
}

/** 解析工作区内路径；越界返回 null。 */
export function insideWorkspace(agentId: string, p: string): string | null {
	const ws = workspaceOf(agentId);
	const abs = isAbsolute(p) ? p : resolve(ws, p);
	const rel = relative(ws, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return abs;
}

function record(agentId: string, name: string, src: string | Buffer, workspacePath: string | null, direction: "in" | "out"): FileRow {
	const id = uid("f");
	const dir = join(config.filesDir, agentId);
	mkdirSync(dir, { recursive: true });
	const stored = join(dir, `${id}${extname(name)}`);
	if (typeof src === "string") copyFileSync(src, stored);
	else writeFileSync(stored, src);
	const row: FileRow = { id, agent_id: agentId, name, mime: mimeOf(name), size: statSync(stored).size, stored_path: stored, workspace_path: workspacePath, direction, created_at: now() };
	db.prepare("INSERT INTO files(id, agent_id, name, mime, size, stored_path, workspace_path, direction, created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(
		row.id, row.agent_id, row.name, row.mime, row.size, row.stored_path, row.workspace_path, row.direction, row.created_at,
	);
	bus.emit({ type: "file.created", agentId, file: fileInfo(row) });
	return row;
}

/** 助理交付文件：从工作区复制一份快照（之后工作区文件变化不影响已发送的附件）。hostAccess=true（完全权限）时也允许用户主机上的文件。 */
export function deliverFromWorkspace(agentId: string, p: string, hostAccess = false): FileRow {
	const ws = workspaceOf(agentId);
	const abs = insideWorkspace(agentId, p) ?? (hostAccess && isAbsolute(p) && !p.includes("\0") ? resolve(p) : null);
	if (!abs) throw new Error("只能发送工作区内的文件");
	const st = statSync(abs);
	if (!st.isFile()) throw new Error("不是文件");
	if (st.size > 200 * 1024 * 1024) throw new Error("文件超过 200MB");
	const rel = relative(ws, abs);
	return record(agentId, basename(abs), abs, rel.startsWith("..") || isAbsolute(rel) ? null : rel, "out");
}

/** 用户上传：保存到工作区 uploads/ 并登记。 */
export function saveUpload(agentId: string, name: string, data: Buffer): FileRow {
	const safe = basename(name).replace(/[\\/:*?"<>|]/g, "_") || "upload.bin";
	const dir = join(workspaceOf(agentId), "uploads");
	mkdirSync(dir, { recursive: true });
	let target = join(dir, safe);
	for (let i = 1; statSafe(target); i++) target = join(dir, `${basename(safe, extname(safe))}-${i}${extname(safe)}`);
	writeFileSync(target, data);
	return record(agentId, basename(target), target, relative(workspaceOf(agentId), target), "in");
}
const statSafe = (p: string) => { try { return statSync(p); } catch { return null; } };

export function getFile(id: string) {
	return db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow | undefined;
}
export function listFiles(agentId: string) {
	return (db.prepare("SELECT * FROM files WHERE agent_id = ? ORDER BY created_at DESC LIMIT 200").all(agentId) as unknown as FileRow[]).map(fileInfo);
}
export function listWorkspace(agentId: string, p: string) {
	const abs = insideWorkspace(agentId, p || ".");
	if (!abs) throw new Error("越界");
	return readdirSync(abs, { withFileTypes: true })
		.filter((d) => !d.name.startsWith(".pi"))
		.map((d) => {
			const st = statSafe(join(abs, d.name));
			return { name: d.name, dir: d.isDirectory(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
		})
		.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- 群聊附件
/** 群里用户上传的附件：每个群存一份（files 表 agent_id='' + room_id），轮到哪个助理就复制到它的工作区 */
export function saveRoomUpload(roomId: string, name: string, data: Buffer): FileRow {
	const safe = basename(name).replace(/[\\/:*?"<>|]/g, "_") || "upload.bin";
	const id = uid("f");
	const dir = roomFilesDir(roomId);
	mkdirSync(dir, { recursive: true });
	const stored = join(dir, `${id}${extname(safe)}`);
	writeFileSync(stored, data);
	const row: FileRow = { id, agent_id: "", room_id: roomId, name: safe, mime: mimeOf(safe), size: data.length, stored_path: stored, workspace_path: null, direction: "in", created_at: now() };
	db.prepare("INSERT INTO files(id, agent_id, name, mime, size, stored_path, workspace_path, direction, created_at, room_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
		row.id, row.agent_id, row.name, row.mime, row.size, row.stored_path, null, row.direction, row.created_at, roomId,
	);
	return row;
}
export const roomFilesDir = (roomId: string) => join(config.filesDir, "rooms", roomId.replace(/[^a-zA-Z0-9_-]/g, ""));
/** 删除群的全部附件（用户上传的；助理发的文件属于助理，跟助理一起清理） */
export function deleteRoomFiles(roomId: string) {
	db.prepare("DELETE FROM files WHERE room_id = ? AND agent_id = ''").run(roomId);
	rmSync(roomFilesDir(roomId), { recursive: true, force: true });
}

/**
 * 让某个助理能用到这个附件：
 *  - 就是它自己的文件（自己上传/自己工作区里的）→ 直接用原路径
 *  - 别人的文件（群里用户上传、其他成员发的）→ 复制到它工作区 room-files/<群>/ 下（只复制一次）
 * 返回工作区相对路径。
 */
export function materializeFor(agentId: string, f: FileRow, roomId?: string | null): string {
	if (f.agent_id === agentId && f.workspace_path && existsSync(join(workspaceOf(agentId), f.workspace_path))) return f.workspace_path;
	const sub = join("room-files", (roomId ?? f.room_id ?? "shared").replace(/[^a-zA-Z0-9_-]/g, ""));
	const dir = join(workspaceOf(agentId), sub);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, `${f.id.slice(-6)}-${f.name}`);
	if (!existsSync(target) && existsSync(f.stored_path)) copyFileSync(f.stored_path, target);
	return relative(workspaceOf(agentId), target);
}
/** 附件 → prepareAttachments 的输入（顺便放进该助理工作区） */
export function attachmentInputFor(agentId: string, f: FileRow, roomId?: string | null) {
	const rel = materializeFor(agentId, f, roomId);
	return { name: f.name, mime: f.mime, absPath: join(workspaceOf(agentId), rel), displayPath: rel };
}
