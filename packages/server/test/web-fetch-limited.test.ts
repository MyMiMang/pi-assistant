/**
 * 文件预览 fetch 上限的纯逻辑单测（不碰服务端、不碰钥匙串、不读写用户数据）。
 *
 * 关键安全不变量：没有 content-length（分块传输 / 代理改写）时，1MB 文本上限必须
 * **真的中断流式读取**，不能 read-all 之后再判大小 —— 否则一个超大文件会先被整份读进内存。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const MB = 1024 * 1024;

/** api.ts 在模块加载时读 localStorage，先补上最小浏览器全局再动态 import。 */
async function withStubbedGlobals<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
	const g = globalThis as unknown as { localStorage?: unknown; fetch: typeof fetch };
	const prevLocal = g.localStorage;
	const prevFetch = g.fetch;
	g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
	g.fetch = fetchImpl;
	try {
		return await fn();
	} finally {
		g.localStorage = prevLocal;
		g.fetch = prevFetch;
	}
}

test("fetchBlobLimited：无 content-length 的超大响应按上限中断，不读完", async () => {
	let pulled = 0;
	const chunk = new Uint8Array(64 * 1024);
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled += chunk.byteLength;
			if (pulled > 16 * MB) {
				controller.close();
				return;
			}
			controller.enqueue(chunk);
		},
	});
	await withStubbedGlobals((async () => new Response(stream, { status: 200 })) as unknown as typeof fetch, async () => {
		const { fetchBlobLimited } = await import("../../../apps/web/src/api.ts");
		const { blob, oversized } = await fetchBlobLimited("/api/files/f-huge", MB);
		assert.equal(oversized, true);
		assert.equal(blob.size, 0);
		// 1MB 上限：最多再多读一个分片就必须停（远小于模拟的 16MB）
		assert.ok(pulled <= 2 * MB, `实际读取 ${pulled} 字节，应在上限附近中断`);
	});
});

test("fetchBlobLimited：带 content-length 且超限时直接不读 body", async () => {
	let pulled = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled += 64 * 1024;
			if (pulled > 16 * MB) {
				controller.close();
				return;
			}
			controller.enqueue(new Uint8Array(64 * 1024));
		},
	});
	await withStubbedGlobals(
		(async () => new Response(body, { status: 200, headers: { "content-length": String(5 * MB) } })) as unknown as typeof fetch,
		async () => {
			const { fetchBlobLimited } = await import("../../../apps/web/src/api.ts");
			const { blob, oversized } = await fetchBlobLimited("/api/files/f-huge", MB);
			assert.equal(oversized, true);
			assert.equal(blob.size, 0);
			// 最多只有 ReadableStream 自身的一次预取，绝不能持续读 body
			assert.ok(pulled <= 64 * 1024, `实际读取 ${pulled} 字节，带 content-length 时不应读 body`);
		},
	);
});

test("fetchBlobLimited：小文件正常返回", async () => {
	const body = new TextEncoder().encode("hello 文件预览");
	await withStubbedGlobals((async () => new Response(body, { status: 200 })) as unknown as typeof fetch, async () => {
		const { fetchBlobLimited } = await import("../../../apps/web/src/api.ts");
		const { blob, oversized } = await fetchBlobLimited("/api/files/small", MB);
		assert.equal(oversized, false);
		assert.equal(await blob.text(), "hello 文件预览");
	});
});
