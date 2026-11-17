/** HTTP 测试共用新上传协议：声明大小 → 顺序发送分块 → 返回最终附件。 */
import "./setup.ts";
import assert from "node:assert/strict";
import { UPLOAD_CHUNK_SIZE } from "@pi-assistant/shared";
import type { fileInfo } from "../src/files.ts";

type UploadedFile = ReturnType<typeof fileInfo>;
export async function uploadFile(endpoint: string, name: string, data: Buffer | string): Promise<UploadedFile> {
	const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
	const begin = await fetch(endpoint, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, size: bytes.length }),
	});
	assert.equal(begin.status, 200, `开始上传 ${name}`);
	const { uploadId } = await begin.json() as { uploadId: string };
	assert.equal(typeof uploadId, "string");
	const url = `${endpoint}/${encodeURIComponent(uploadId)}`;
	let completed = false;
	try {
		let offset = 0;
		let index = 0;
		do {
			const chunk = bytes.subarray(offset, offset + UPLOAD_CHUNK_SIZE);
			const response = await fetch(`${url}?offset=${offset}&index=${index}`, {
				method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(chunk),
			});
			assert.equal(response.status, 200, `上传 ${name} 第 ${index + 1} 块`);
			const result = await response.json() as { offset: number; file?: UploadedFile };
			offset += chunk.length;
			index++;
			assert.equal(result.offset, offset);
			if (offset === bytes.length) {
				assert.ok(result.file, "最后一块返回附件");
				assert.equal(result.file.size, bytes.length);
				completed = true;
				return result.file;
			}
			assert.equal(result.file, undefined, "中间块不返回附件");
		} while (offset < bytes.length);
		throw new Error(`上传 ${name} 未完成`);
	} finally {
		if (!completed) await fetch(url, { method: "DELETE" });
	}
}
