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

test("fetchWithProgress：两次 504 后成功，每次从零报告进度", async (t) => {
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => new Response(++requests < 3 ? "busy" : "content", {
		status: requests < 3 ? 504 : 200,
		headers: { "content-length": requests < 3 ? "4" : "7" },
	}));
	const seen: [number, number | null][] = [];
	const result = await dl.fetchWithProgress("https://download.test/file", {
		bytes: (a, b) => seen.push([a, b]), detail: () => {},
	}, {}, [1, 1]);
	assert.equal(result.toString(), "content");
	assert.equal(requests, 3);
	assert.deepEqual(seen, [[0, 4], [0, 4], [0, 7], [7, 7]]);
});

for (const [status, expectedRequests] of [[503, 3], [404, 1]] as const) {
	test(`fetchWithProgress：HTTP ${status} 请求 ${expectedRequests} 次后保留原错误`, async (t) => {
		let requests = 0;
		t.mock.method(globalThis, "fetch", async () => {
			requests++;
			return new Response("error", { status });
		});
		await assert.rejects(dl.fetchWithProgress("https://download.test/file", undefined, {}, [1, 1]), {
			message: `HTTP ${status}`,
		});
		assert.equal(requests, expectedRequests);
	});
}

test("fetchWithProgress：等待重试期间取消立即停止，不再请求", async (t) => {
	const controller = new AbortController();
	let requests = 0;
	let notifyRetry!: () => void;
	const retryStarted = new Promise<void>((resolve) => { notifyRetry = resolve; });
	t.mock.method(console, "warn", () => notifyRetry());
	t.mock.method(globalThis, "fetch", async () => {
		requests++;
		return new Response("busy", { status: 504 });
	});
	const pending = dl.fetchWithProgress("https://download.test/file", undefined, { signal: controller.signal });
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await retryStarted;
	controller.abort();
	await rejected;
	assert.equal(requests, 1);
});

test("shouldRetryDownload：只重试临时错误，调用方取消优先", () => {
	for (const status of [500, 503, 504, 599, 429]) assert.equal(dl.shouldRetryDownload({ status }), true);
	for (const status of [400, 401, 404, 499, 600, 200]) assert.equal(dl.shouldRetryDownload({ status }), false);
	assert.equal(dl.shouldRetryDownload({}), true, "网络错误");
	assert.equal(dl.shouldRetryDownload({ timedOut: true }), true, "单次超时");
	assert.equal(dl.shouldRetryDownload({ callerAborted: true }), false);
	assert.equal(dl.shouldRetryDownload({ callerAborted: true, timedOut: true, status: 503 }), false);
});

test("fetchWithProgress：响应体断开后丢弃部分内容，从零重新下载", async (t) => {
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => {
		if (++requests > 1) return new Response("complete");
		let reads = 0;
		return new Response(new ReadableStream({
			pull(controller) {
				if (reads++ === 0) controller.enqueue(new TextEncoder().encode("partial"));
				else controller.error(new TypeError("terminated"));
			},
		}));
	});
	const seen: number[] = [];
	const result = await dl.fetchWithProgress("https://download.test/file", {
		bytes: (received) => seen.push(received), detail: () => {},
	}, {}, [1, 1]);
	assert.equal(result.toString(), "complete");
	assert.equal(requests, 2);
	assert.deepEqual(seen, [0, 7, 0, 8]);
});

test("fetchWithProgress：每次单独超时，有调用方 signal 也会重试", async (t) => {
	const signals: AbortSignal[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		const signal = init.signal!;
		signals.push(signal);
		if (signals.length === 3) return new Response("ok");
		return new Promise<Response>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	});
	// timeout signal 自身不保持事件循环存活，用独立计时器保证假 fetch 等得到超时。
	const keepAlive = setInterval(() => {}, 1000);
	t.after(() => clearInterval(keepAlive));
	const caller = new AbortController();
	const result = await dl.fetchWithProgress("https://download.test/file", undefined, {
		signal: caller.signal, timeoutMs: 10,
	}, [1, 1]);
	assert.equal(result.toString(), "ok");
	assert.equal(signals.length, 3);
	assert.notEqual(signals[0], signals[1]);
	assert.equal(caller.signal.aborted, false);
});

test("fetchWithProgress：fetch 网络错误重试；已取消的调用方不发请求", async (t) => {
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => {
		if (++requests < 3) throw new TypeError("fetch failed");
		return new Response("ok");
	});
	assert.equal((await dl.fetchWithProgress("https://download.test/file", undefined, {}, [1, 1])).toString(), "ok");
	const caller = new AbortController();
	caller.abort();
	await assert.rejects(dl.fetchWithProgress("https://download.test/file", undefined, { signal: caller.signal }), { name: "AbortError" });
	assert.equal(requests, 3);
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

test("status 投影：组件自己的 phase/received/error 驱动下载状态；总量未知 → percent null + canCancel", () => {
	let phase: "installing" | "done" | "failed" = "installing";
	let received = 0;
	let total: number | null = null;
	dl.registerDownload({
		id: "proj1",
		name: "投影组件",
		group: "本地模型",
		size: 800,
		installed: () => phase === "done",
		start: () => Promise.resolve(),
		cancel: () => {
			phase = "failed";
		},
		status: () => ({ state: phase === "done" ? "ready" : phase === "installing" ? "downloading" : "error", received, total, detail: "下载模型权重", error: phase === "failed" ? "手动取消" : null }),
	});
	const a = dl.downloadInfo("proj1")!;
	assert.equal(a.state, "downloading");
	assert.equal(a.percent, null, "总量未知不得编百分比");
	assert.equal(a.detail, "下载模型权重");
	assert.equal(a.canCancel, true, "登记了 cancel 就允许取消");
	total = 800;
	received = 200;
	assert.equal(dl.downloadInfo("proj1")!.percent, 25);
	phase = "done";
	const c = dl.downloadInfo("proj1")!;
	assert.equal(c.state, "ready");
	assert.equal(c.percent, 100);
});

test("cancelDownload：调用 def.cancel；未登记 cancel 的报不支持", async () => {
	let cancelled = false;
	dl.registerDownload({ id: "cancel1", name: "可取消", group: "本地模型", installed: () => false, cancel: () => { cancelled = true; } });
	assert.equal(dl.downloadInfo("cancel1")!.canCancel, true);
	await dl.cancelDownload("cancel1");
	assert.ok(cancelled);
	dl.registerDownload({ id: "nocancel", name: "不可取消", group: "测试", installed: () => false });
	assert.equal(dl.downloadInfo("nocancel")!.canCancel, false);
	await assert.rejects(() => dl.cancelDownload("nocancel"), /不支持取消/);
});

test("followStatus：轮询组件状态驱动进度并自动结束；同一 id 只一个循环", async () => {
	const total = 100;
	let received = 0;
	let active = true;
	let polls = 0;
	dl.registerDownload({
		id: "follow1",
		name: "跟踪",
		group: "本地模型",
		installed: () => !active,
		status: () => ({ state: active ? "downloading" : "ready", received, total, detail: "阶段" }),
	});
	const states: string[] = [];
	const off = bus.on((e) => {
		const item = e.item as { id?: string; state?: string } | undefined;
		if (e.type === "downloads.changed" && item?.id === "follow1" && item.state) states.push(item.state);
	});
	const read = () => {
		polls++;
		received = 50;
		return { active, received, total };
	};
	dl.followStatus("follow1", read, 20);
	dl.followStatus("follow1", read, 20); // 第二次同 id 不叠加
	await new Promise((r) => setTimeout(r, 80));
	assert.ok(states.includes("downloading"), JSON.stringify(states));
	assert.equal(dl.downloadInfo("follow1")!.percent, 50);
	active = false;
	await new Promise((r) => setTimeout(r, 80));
	off();
	assert.ok(polls >= 1);
	assert.equal(dl.downloadInfo("follow1")!.state, "ready");
});
