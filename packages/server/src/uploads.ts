/** 单聊、群聊共用的顺序分块上传；每个请求直接流式追加到临时文件。 */
import { MAX_UPLOAD_SIZE, UPLOAD_CHUNK_SIZE } from "@pi-assistant/shared";
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.ts";
import { uid } from "./db.ts";
import { fileInfo, finishUpload, uploadDir, type UploadOwner } from "./files.ts";

type Session = { owner: UploadOwner; name: string; size: number; path: string; offset: number; index: number; busy: boolean; controller: AbortController };
const sessions = new Map<string, Session>();
const DAY = 86_400_000;
const sameOwner = (a: UploadOwner, b: UploadOwner) => a.agentId === b.agentId && a.roomId === b.roomId;
export class UploadError extends Error {
	constructor(message: string, public status: 400 | 404 | 413 = 400) { super(message); }
}
export function beginUpload(owner: UploadOwner, name: unknown, size: unknown) {
	if (typeof name !== "string" || !name.trim() || name.length > 255 || !Number.isSafeInteger(size) || (size as number) < 0) throw new UploadError("文件名称或大小不正确");
	if ((size as number) > MAX_UPLOAD_SIZE) throw new UploadError("文件超过 2GB", 413);
	const dir = uploadDir(owner);
	mkdirSync(dir, { recursive: true });
	const uploadId = uid("up");
	const path = join(dir, `.pia-upload-${uploadId}.part`);
	writeFileSync(path, "", { flag: "wx", mode: 0o600 });
	sessions.set(uploadId, { owner, name, size: size as number, path, offset: 0, index: 0, busy: false, controller: new AbortController() });
	return { uploadId };
}
export function abandonUpload(owner: UploadOwner, id: string) {
	const s = sessions.get(id);
	if (!s || !sameOwner(s.owner, owner)) return;
	sessions.delete(id);
	s.controller.abort();
	rmSync(s.path, { force: true });
}
export async function appendUpload(owner: UploadOwner, id: string, offset: number, index: number, body: ReadableStream<Uint8Array> | null) {
	const s = sessions.get(id);
	if (!s || !sameOwner(s.owner, owner)) throw new UploadError("上传已失效，请重新选择文件", 404);
	// 不允许并发请求破坏正在写入的文件；正在写的请求也会发现会话被取消并清理。
	try {
		if (s.busy || !Number.isSafeInteger(offset) || !Number.isSafeInteger(index) || offset !== s.offset || index !== s.index) throw new UploadError("上传顺序或位置不正确，请重新上传");
		s.busy = true;
		let received = 0;
		const limit = new Transform({ transform(chunk: Buffer, _encoding, cb) {
			received += chunk.length;
			if (received > UPLOAD_CHUNK_SIZE || s.offset + received > s.size || s.offset + received > MAX_UPLOAD_SIZE) cb(new UploadError("上传数据超过文件大小或分块上限", 413));
			else if (!sessions.has(id)) cb(new UploadError("上传已取消"));
			else cb(null, chunk);
		} });
		await pipeline(body ? Readable.fromWeb(body as import("node:stream/web").ReadableStream) : Readable.from([]), limit, createWriteStream(s.path, { flags: "a" }), { signal: s.controller.signal });
		if (!sessions.has(id)) throw new UploadError("上传已取消");
		if (!received && s.size !== 0) throw new UploadError("没有收到文件内容，请重新上传");
		s.offset += received;
		s.index++;
		s.busy = false;
		if (s.offset === s.size) {
			const file = fileInfo(finishUpload(s.owner, s.name, s.path));
			sessions.delete(id);
			return { offset: s.offset, file };
		}
		return { offset: s.offset };
	} catch (e) {
		abandonUpload(owner, id);
		rmSync(s.path, { force: true });
		throw e instanceof UploadError ? e : new UploadError("文件上传失败，请重新上传");
	}
}

/** 仅清理本模块命名的临时文件；不碰工作区里的其他 .part。服务重启后也有效。 */
export function cleanupUploads(now = Date.now(), workspaceRoot = config.workspaceRoot, filesDir = config.filesDir) {
	const removed: string[] = [];
	const children = (dir: string) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)); } catch { return []; } };
	const dirs = [...children(workspaceRoot).map((d) => join(d, "uploads")), ...children(join(filesDir, "rooms"))];
	for (const dir of dirs) {
		let names: string[];
		try { names = readdirSync(dir); } catch { continue; }
		for (const name of names) {
			if (!/^\.pia-upload-up_[a-zA-Z0-9_-]+\.part$/.test(name)) continue;
			const path = join(dir, name);
			try {
				if (now - statSync(path).mtimeMs <= DAY) continue;
				for (const [id, s] of sessions) if (s.path === path) { s.controller.abort(); sessions.delete(id); }
				rmSync(path, { force: true });
				removed.push(path);
			} catch { /* 已被完成/取消的上传移除 */ }
		}
	}
	return removed;
}
