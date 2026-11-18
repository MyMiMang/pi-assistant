import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserInputControl } from "../src/browser-control.ts";
import { sameBrowserIdentity } from "@pi-assistant/shared";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
test("浏览器输入权：在途结算后接管，立即拒绝新输入且取消排队", async () => {
	const control = new BrowserInputControl(() => false, 100), gate = deferred(), started = deferred();
	let queued = false;
	const running = control.run("agent", 1, () => {}, async () => { started.resolve(); await gate.promise; });
	await started.promise;
	const next = control.run("agent", 1, () => {}, async () => { queued = true; });
	const rejected = assert.rejects(next, /控制权/);
	const takeover = control.takeover();
	assert.equal(control.state, "draining");
	assert.throws(() => control.run("agent", 1, () => {}, async () => {}), /控制权/);
	gate.resolve(); await running; await rejected; await takeover;
	assert.equal(control.state, "user"); assert.equal(queued, false);
});
test("浏览器接管超时：晚结算不授予，显式恢复与交还均重读", async () => {
	const control = new BrowserInputControl(() => false, 20), gate = deferred(), started = deferred();
	const running = control.run("agent", 1, () => {}, async () => { started.resolve(); await gate.promise; });
	await started.promise;
	await assert.rejects(control.takeover(), /仍未获得控制权/);
	assert.equal(control.state, "draining");
	gate.resolve(); await running; await Promise.resolve();
	assert.equal(control.state, "draining");
	assert.throws(() => control.check("user", control.generation), /控制权/);
	let reads = 0;
	await control.takeover(true, async () => { reads++; });
	await control.giveBack(async () => { reads++; });
	assert.equal(reads, 2); assert.equal(control.state, "agent");
});
test("浏览器接管重读也有界：迟到读取不能自动授权", async () => {
	const control = new BrowserInputControl(() => false, 20), gate = deferred();
	await assert.rejects(control.takeover(false, () => gate.promise), /仍未获得控制权/);
	gate.resolve(); await Promise.resolve(); await Promise.resolve();
	assert.equal(control.state, "draining");
	await control.takeover(true); assert.equal(control.state, "user");
});
test("浏览器暂停：排队和异步间隙再检查；重读失败保持锁定", async () => {
	let paused = false;
	const control = new BrowserInputControl(() => paused);
	await assert.rejects(control.run("agent", 1, () => {}, async check => { paused = true; check(); }), /已暂停/);
	paused = false; await control.takeover();
	await assert.rejects(control.giveBack(async () => { throw new Error("读取失败"); }), /读取失败/);
	assert.equal(control.state, "draining");
});
test("页面身份：同网址不代表同页，运行环境/上下文/文档代际均不可复用", () => {
	const identity = { runtimeId: "r", contextId: "c", pageId: "p", generation: 1 };
	assert.ok(sameBrowserIdentity(identity, { ...identity }));
	for (const key of ["runtimeId", "contextId", "pageId"] as const) assert.ok(!sameBrowserIdentity(identity, { ...identity, [key]: "other" }));
	assert.ok(!sameBrowserIdentity(identity, { ...identity, generation: 2 }));
});
