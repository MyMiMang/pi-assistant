/**
 * handoff 控制面纯逻辑测试（不起 Chrome / driver / Laya / 模型，不花钱）。
 *   node --test scripts/laya-benchmark-handoff.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HANDOFF_TASK_IDS, createHandoffControl, describeRefs, isFixtureUrl, parseHandoffCommand, statusEvidence } from "./laya-benchmark-handoff.mjs";

const els = [
	{ element_token: "p1:1", role: "button", label: "提交", actions: ["click"] },
	{ element_token: "p1:2", role: "button", label: "取消", actions: ["click"] },
	{ element_token: "p1:3", role: "status", label: "等待操作", actions: [] },
	{ role: "statictext", label: "没有 ref 的节点" },
];

test("命令白名单：只认 observe / click / pointer / next / finish", () => {
	assert.deepEqual(parseHandoffCommand({ op: "observe" }), { op: "observe" });
	assert.deepEqual(parseHandoffCommand({ op: "click", ref: "p1:1" }), { op: "click", ref: "p1:1" });
	assert.equal(parseHandoffCommand({ op: "click" }).error, "click 需要 ref");
	assert.equal(parseHandoffCommand({ op: "pointer", ref: "p1:1", action: "click" }).error, "pointer 不支持的动作：click");
	assert.equal(parseHandoffCommand({ op: "pointer", ref: "p1:1", action: "scroll" }).error, "scroll 需要非零 delta_x / delta_y");
	assert.deepEqual(parseHandoffCommand({ op: "pointer", ref: "p1:1", action: "scroll", delta_y: 200 }), { op: "pointer", ref: "p1:1", action: "scroll", deltaY: 200, deltaX: 0 });
	assert.equal(parseHandoffCommand({ op: "next", task: "scroll-target" }).error, `next 只接受固定任务：${HANDOFF_TASK_IDS.join(" / ")}`);
	assert.deepEqual(parseHandoffCommand({ op: "next", task: "pick-city" }), { op: "next", task: "pick-city", fast: false });
	assert.equal(parseHandoffCommand({ op: "click", ref: "p1:1", x: 10, y: 10 }).x, undefined, "不把坐标 / 未知字段透传");
	assert.equal(parseHandoffCommand({ op: "executeJS" }).error, "未知命令：executeJS");
	assert.equal(parseHandoffCommand(null).error, "命令必须是 JSON 对象");
});

test("refs 只读描述：没有 element_token 的节点不进列表，clickable 只描述能力", () => {
	const refs = describeRefs(els);
	assert.deepEqual(refs.map((r) => r.ref), ["p1:1", "p1:2", "p1:3"]);
	assert.equal(refs[0].clickable, true);
	assert.equal(refs[2].clickable, false, "actions 为空的内容节点不是可点击候选");
	assert.deepEqual(statusEvidence(els), [{ role: "status", label: "等待操作" }]);
});

test("fixture URL 白名单：忽略 hash，其它页面一律拒绝", () => {
	const url = "http://127.0.0.1:5555/api/fast-computer/benchmark/fixture/bench-x?nonce=abc";
	assert.equal(isFixtureUrl(url, url), true);
	assert.equal(isFixtureUrl(`${url}#frag`, url), true);
	assert.equal(isFixtureUrl("http://127.0.0.1:5555/api/fast-computer/benchmark/fixture/other?nonce=abc", url), false);
	assert.equal(isFixtureUrl("https://example.com/", url), false);
	assert.equal(isFixtureUrl(undefined, url), false);
});

function harness(overrides = {}) {
	const calls = [];
	const state = { refs: new Map(), token: 0, clicks: 0, next: [], finish: 0 };
	const fixtureUrl = "http://127.0.0.1:5555/api/fast-computer/benchmark/fixture/bench-x?nonce=abc";
	const control = createHandoffControl({
		fixtureUrl,
		fixtureId: "bench-x",
		nonce: "nonce-1",
		handle: { targetId: "t1", tabId: "tab1", pid: 11, windowId: 22, session: "web" },
		invoke: async (prefix, tool, args) => {
			calls.push({ prefix, tool, args });
			if (tool === "get_browser_state") {
				state.token++;
				return { isError: false, structuredContent: { status: "ok", snapshot: { id: `p${state.token}` }, target_id: "t1", tab_id: "tab1", page: { url: fixtureUrl }, refs: [{ ref: "p:1", role: "button", label: "提交", actions: ["click"] }] } };
			}
			if (tool === "browser_click") {
				state.clicks++;
				if (overrides.trustFails && args.input_route !== "dom_event") return { isError: true, contentText: "browser_input_trust_unavailable" };
				return { isError: false, contentText: "ok" };
			}
			return { isError: false, contentText: "ok" };
		},
		readSnapshot: async () => ({ elements: els, url: fixtureUrl, token: "p9" }),
		readMachine: async () => ({ state: { clicked: "submit" }, updatedAt: 1 }),
		taskOf: () => ({ id: "pick-submit", title: "多按钮里选对「提交」", goal: "点提交", expect: { machine: { clicked: "submit" } } }),
		onNext: async (task, fast) => state.next.push({ task, fast }),
		onCommand: () => {},
		onFinish: () => state.finish++,
		...overrides.control,
	});
	return { control, calls, state };
}

async function call(control, body, headers = {}) {
	const { origin, server } = await control.listen();
	try {
		const res = await fetch(`${origin}/command`, { method: "POST", headers: { "content-type": "application/json", "x-pia-bench-nonce": "nonce-1", ...headers }, body: JSON.stringify(body) });
		return { status: res.status, body: await res.json(), origin };
	} finally {
		server.close();
	}
}

test("控制面：非 loopback 之外的路径 / 缺 nonce / 非 JSON / 非 POST 一律拒绝", async () => {
	const { control } = harness();
	const { origin, server } = await control.listen();
	try {
		const bad = await fetch(`${origin}/other`, { method: "POST", headers: { "content-type": "application/json", "x-pia-bench-nonce": "nonce-1" }, body: "{}" });
		assert.equal(bad.status, 404);
		const noNonce = await fetch(`${origin}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		assert.equal(noNonce.status, 403);
		const text = await fetch(`${origin}/command`, { method: "POST", headers: { "content-type": "text/plain", "x-pia-bench-nonce": "nonce-1" }, body: "{}" });
		assert.equal(text.status, 415);
		const get = await fetch(`${origin}/command`, { headers: { "x-pia-bench-nonce": "nonce-1" } });
		assert.equal(get.status, 405);
		const big = await fetch(`${origin}/command`, { method: "POST", headers: { "content-type": "application/json", "x-pia-bench-nonce": "nonce-1" }, body: JSON.stringify({ op: "observe", pad: "x".repeat(5000) }) });
		assert.equal(big.status, 413);
	} finally {
		server.close();
	}
});

test("observe 返回 refs + UI + machine + expected，不自动点击", async () => {
	const { control, state } = harness();
	const r = await call(control, { op: "observe" });
	assert.equal(r.status, 200);
	assert.equal(r.body.ok, true);
	assert.deepEqual(r.body.refs.map((x) => x.ref), ["p1:1", "p1:2", "p1:3"]);
	assert.deepEqual(r.body.ui, [{ role: "status", label: "等待操作" }]);
	assert.equal(r.body.machine.state.clicked, "submit");
	assert.equal(r.body.task, "pick-submit");
	assert.equal(r.body.expected.machine.clicked, "submit");
	assert.equal(state.clicks, 0, "observe 不得触发任何点击");
});

test("click 只接受最近一次 observe 的 ref；旧 ref 作废；不传坐标 / target", async () => {
	const { control, calls, state } = harness();
	const stale = await call(control, { op: "click", ref: "p1:1" });
	assert.equal(stale.status, 200);
	assert.equal(stale.body.ok, false);
	assert.equal(stale.body.stale, true, "没 observe 过就没有有效 ref");
	await call(control, { op: "observe" });
	const ok = await call(control, { op: "click", ref: "p1:2" });
	assert.equal(ok.body.ok, true);
	const click = calls.filter((c) => c.tool === "browser_click").at(-1);
	assert.deepEqual(Object.keys(click.args).sort(), ["ref", "session", "tab_id", "target_id"]);
	assert.equal(click.args.ref, "p1:2");
	assert.equal(state.clicks, 1);
	// 快照更新 → 旧 ref 作废
	await call(control, { op: "observe" });
	control.state.refs = new Map();
	const after = await call(control, { op: "click", ref: "p1:2" });
	assert.equal(after.body.stale, true);
});

test("trusted 失败按规范一回合：重新 observe 后 dom_event 才派发", async () => {
	const { control, calls } = harness({ trustFails: true });
	await call(control, { op: "observe" });
	const r = await call(control, { op: "click", ref: "p1:2" });
	assert.equal(r.body.ok, true);
	assert.equal(r.body.route, "dom_event");
	const clicks = calls.filter((c) => c.tool === "browser_click");
	assert.equal(clicks.length, 2);
	assert.equal(clicks[1].args.input_route, "dom_event");
});

test("next 只透传固定任务给 harness（不自己 navigate），pointer 后 ref 作废", async () => {
	const { control, state, calls } = harness();
	await call(control, { op: "observe" });
	const p = await call(control, { op: "pointer", ref: "p1:1", action: "hover" });
	assert.equal(p.body.ok, true);
	assert.equal(calls.at(-1).tool, "browser_pointer");
	const bad = await call(control, { op: "next", task: "scroll-target" });
	assert.equal(bad.status, 400);
	const ok = await call(control, { op: "next", task: "dynamic-2step", fast: true });
	assert.equal(ok.body.ok, true);
	assert.deepEqual(state.next, [{ task: "dynamic-2step", fast: true }]);
});

test("finish 触发清理回调", async () => {
	const { control, state } = harness();
	const r = await call(control, { op: "finish" });
	assert.equal(r.body.ok, true);
	await new Promise((res) => setTimeout(res, 10));
	assert.equal(state.finish, 1);
});
