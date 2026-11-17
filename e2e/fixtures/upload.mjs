import assert from "node:assert/strict";

/** 真实 HTTP 附件上传；和前端共用创建 / 顺序分块 / 失败清理协议。 */
export async function uploadFixture(base, path, name, bytes, { chunkSize = 32 * 1024 ** 2, onProgress, signal } = {}) {
	assert.ok(Number.isSafeInteger(chunkSize) && chunkSize > 0 && chunkSize <= 32 * 1024 ** 2);
	const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
	let uploadId;
	const request = async (url, init) => {
		const response = await fetch(base + url, init);
		assert.ok(response.ok, `${init.method} ${url} → ${response.status} ${response.ok ? "" : await response.text()}`);
		return response.json();
	};
	try {
		signal?.throwIfAborted();
		({ uploadId } = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, size: blob.size }) }));
		assert.ok(uploadId, "创建上传必须返回 uploadId");
		onProgress?.(0, blob.size);
		let offset = 0;
		let index = 0;
		do {
			signal?.throwIfAborted();
			const end = Math.min(offset + chunkSize, blob.size);
			const result = await request(`${path}/${encodeURIComponent(uploadId)}?offset=${offset}&index=${index}`, {
				method: "PUT", headers: { "content-type": "application/octet-stream" }, body: blob.slice(offset, end), signal,
			});
			assert.equal(result.offset, end, "确认字节必须与此块结束位置一致");
			offset = result.offset;
			onProgress?.(offset, blob.size);
			if (end === blob.size) {
				assert.ok(result.file?.fileId, "最后一块必须返回附件登记信息");
				return result.file;
			}
			assert.equal(result.file, undefined, "中间块不能提前登记附件");
			index++;
		} while (offset < blob.size);
	} catch (error) {
		if (uploadId) await fetch(`${base}${path}/${encodeURIComponent(uploadId)}`, { method: "DELETE" }).catch(() => {});
		throw error;
	}
}
