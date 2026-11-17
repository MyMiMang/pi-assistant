import { MAX_UPLOAD_SIZE, UPLOAD_CHUNK_SIZE } from "@pi-assistant/shared";
import { api } from "./api.ts";
import type { Attachment } from "./types.ts";

/** 只报告服务端确认的字节数；不把网络已发送当成上传成功。 */
export type UploadProgress = (confirmedBytes: number, totalBytes: number) => void;
export type UploadFn = (file: File, onProgress?: UploadProgress, signal?: AbortSignal) => Promise<Attachment>;

export async function uploadChunks(path: string, file: File, onProgress?: UploadProgress, signal?: AbortSignal, chunkSize = UPLOAD_CHUNK_SIZE): Promise<Attachment> {
	if (file.size > MAX_UPLOAD_SIZE) throw new Error("单个文件不能超过 2GB。");
	if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > UPLOAD_CHUNK_SIZE) throw new Error("上传分块大小无效。");
	signal?.throwIfAborted();
	let uploadId: string | undefined;
	try {
		// 创建请求不随 signal 中断：即便用户此时取消，也先取回编号再清理，避免留下未知会话。
		const created = await api<{ uploadId: string }>(path, { method: "POST", json: { name: file.name, size: file.size } });
		uploadId = created.uploadId;
		if (!uploadId) throw new Error("创建上传失败，请重试。");
		signal?.throwIfAborted();
		onProgress?.(0, file.size);
		let offset = 0;
		let index = 0;
		do {
			signal?.throwIfAborted();
			const end = Math.min(offset + chunkSize, file.size);
			const result = await api<{ offset: number; file?: Attachment }>(`${path}/${encodeURIComponent(uploadId)}?offset=${offset}&index=${index}`, {
				method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file.slice(offset, end), signal,
			});
			if (result.offset !== end) throw new Error("上传进度校验失败，请重新上传。");
			if (end === file.size && !result.file) throw new Error("文件上传未完成，请重试。");
			if (end < file.size && result.file) throw new Error("文件上传结果异常，请重试。");
			offset = result.offset;
			onProgress?.(offset, file.size);
			if (result.file) return result.file;
			index++;
		} while (offset < file.size);
		throw new Error("文件上传未完成，请重试。");
	} catch (error) {
		if (uploadId) {
			try {
				await api(`${path}/${encodeURIComponent(uploadId)}`, { method: "DELETE" });
			} catch { /* 清理失败不覆盖原始错误，也不复用已取消的 signal。 */ }
		}
		throw error;
	}
}

export const upload = (agentId: string, file: File, onProgress?: UploadProgress, signal?: AbortSignal) => uploadChunks(`/api/agents/${agentId}/upload`, file, onProgress, signal);
export const uploadRoom = (roomId: string, file: File, onProgress?: UploadProgress, signal?: AbortSignal) => uploadChunks(`/api/rooms/${roomId}/upload`, file, onProgress, signal);
