import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { db, now, uid } from "./db.ts";

const MIME: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
	".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
	".html": "text/html", ".py": "text/x-python", ".ts": "text/plain", ".js": "text/javascript", ".zip": "application/zip",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

export interface FileRow { id: string; agent_id: string; name: string; mime: string; size: number; stored_path: string; workspace_path: string | null; direction: string; created_at: number }
export const fileInfo = (f: FileRow) => ({ fileId: f.id, name: f.name, mime: f.mime, size: f.size, direction: f.direction, workspacePath: f.workspace_path, createdAt: f.created_at });

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

/** 助理交付文件：从工作区复制一份快照（之后工作区文件变化不影响已发送的附件）。 */
export function deliverFromWorkspace(agentId: string, p: string): FileRow {
	const abs = insideWorkspace(agentId, p);
	if (!abs) throw new Error("只能发送工作区内的文件");
	const st = statSync(abs);
	if (!st.isFile()) throw new Error("不是文件");
	if (st.size > 200 * 1024 * 1024) throw new Error("文件超过 200MB");
	return record(agentId, basename(abs), abs, relative(workspaceOf(agentId), abs), "out");
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
