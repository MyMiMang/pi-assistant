/** 统一下载状态：登记、进度（字节 / 百分比）、出错可重试、fetchWithProgress、目录大小进度 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
const dl = await import("../src/downloads.ts");
const { bus } = await import("../src/bus.ts");

test("登记 → 未下载；下载中报告字节与百分比；完成 → 已下载；出错 → 可重试", async () => {
	let have = false;
	let fail = true;
	const events: unknown[] = [];
	const off = bus.on((e) => e.type === "downloads.changed" && events.push(e));
	dl.registerDownload({ id: "t1", name: "测试组件", group: "测试", size: 1000, installed: () => have, start: () => run() });
	const run = () =>
		dl.trackDownload("t1", async (p) => {
			p.bytes(250, 1000);
			const mid = dl.downloadInfo("t1")!;
			assert.equal(mid.state, "downloading");
			assert.equal(mid.percent, 25);
			assert.equal(mid.received, 250);
			if (fail) throw new Error("网络断了");
			have = true;
		});
	assert.equal(dl.downloadInfo("t1")!.state, "missing");
	await assert.rejects(run(), /网络断了/);
	const e = dl.downloadInfo("t1")!;
	assert.equal(e.state, "error");
	assert.equal(e.error, "网络断了");
	assert.ok(e.canStart);
	fail = false;
	await dl.startDownload("t1");
	await new Promise((r) => setTimeout(r, 20));
	const ok = dl.listDownloads().find((x) => x.id === "t1")!;
	assert.equal(ok.state, "ready");
	assert.equal(ok.percent, 100);
	assert.ok(events.length >= 3, "状态变化要推送");
	off();
});

test("hidden 的不出现在列表里；unregister 后消失", () => {
	dl.registerDownload({ id: "t2", name: "隐藏", group: "测试", installed: () => false, hidden: () => true });
	assert.ok(!dl.listDownloads().some((x) => x.id === "t2"));
	dl.registerDownload({ id: "t3", name: "临时", group: "测试", installed: () => false });
	assert.ok(dl.listDownloads().some((x) => x.id === "t3"));
	dl.unregisterDownload("t3");
	assert.ok(!dl.listDownloads().some((x) => x.id === "t3"));
});

test("fetchWithProgress：按 content-length 报告进度，返回完整内容", async () => {
	const body = Buffer.alloc(200_000, 7);
	const srv = createServer((_q, r) => {
		r.writeHead(200, { "content-length": String(body.length) });
		r.end(body);
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	const seen: [number, number | null][] = [];
	const buf = await dl.fetchWithProgress(`http://127.0.0.1:${port}/x`, { bytes: (a, b) => seen.push([a, b]), detail: () => {} });
	srv.close();
	assert.equal(buf.length, body.length);
	assert.deepEqual(seen.at(-1), [body.length, body.length]);
	assert.ok(seen.length >= 2);
});

test("watchDir：别的进程往目录里写时，用目录大小当进度", async () => {
	const dir = join(tmpdir(), `pia-dl-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	const seen: number[] = [];
	await dl.watchDir([dir], { bytes: (a) => seen.push(a), detail: () => {} }, 10_000, async () => {
		writeFileSync(join(dir, "a.bin"), Buffer.alloc(4096));
		await new Promise((r) => setTimeout(r, 1300));
	});
	assert.ok(seen.includes(4096), JSON.stringify(seen));
});
