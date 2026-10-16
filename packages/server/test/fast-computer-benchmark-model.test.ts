/**
 * 基准测试「点哪条测哪条」的模型可用性纯逻辑（不连真实模型 / 不碰用户数据）。
 *
 * 覆盖：已注册且凭据可用 → ok；已注册但缺凭据 → blocked；本地 Laya 安装中 / 未装 / 已装未运行
 * （后者明确 startable 但**不** ready）；其它未注册 → blocked。全程只看真实状态，不看全局设置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBenchmarkModel } from "../src/fast-computer/benchmark-model.ts";

test("已注册且凭据可用 → ok", () => {
	assert.deepEqual(resolveBenchmarkModel({ classifiers: [{ id: "jev", configured: true }], isLocalLaya: false, laya: null }, "acme", "jev"), { ok: true });
});

test("已注册但缺凭据 → blocked，明确原因", () => {
	const r = resolveBenchmarkModel({ classifiers: [{ id: "jev", configured: false }], isLocalLaya: false, laya: null }, "acme", "jev");
	assert.equal(r.ok, false);
	assert.match(r.reason ?? "", /可用凭据/);
	assert.equal(r.startable, undefined);
});

test("本地 Laya 安装中 / 未装 → blocked，不伪 ready", () => {
	const installing = resolveBenchmarkModel({ classifiers: [], isLocalLaya: true, laya: { installed: false, installing: true, running: false } }, "local-laya", "multilingual");
	assert.equal(installing.ok, false);
	assert.match(installing.reason ?? "", /正在安装/);
	assert.equal(installing.startable, undefined);
	const missing = resolveBenchmarkModel({ classifiers: [], isLocalLaya: true, laya: { installed: false, installing: false, running: false } }, "local-laya", "multilingual");
	assert.equal(missing.ok, false);
	assert.match(missing.reason ?? "", /还没安装/);
});

test("本地 Laya 已装未运行 → blocked + startable（不等于就绪）", () => {
	const r = resolveBenchmarkModel({ classifiers: [], isLocalLaya: true, laya: { installed: true, installing: false, running: false } }, "local-laya", "multilingual");
	assert.equal(r.ok, false);
	assert.equal(r.startable, true);
	assert.match(r.reason ?? "", /已安装但未运行/);
});

test("本地 Laya 已运行并注册 → ok（按注册目录，不再看运行态）", () => {
	const r = resolveBenchmarkModel({ classifiers: [{ id: "multilingual", configured: true }], isLocalLaya: true, laya: { installed: true, installing: false, running: true } }, "local-laya", "multilingual");
	assert.deepEqual(r, { ok: true });
});

test("其它未注册 provider/model → blocked", () => {
	const r = resolveBenchmarkModel({ classifiers: [{ id: "other", configured: true }], isLocalLaya: false, laya: null }, "acme", "nope");
	assert.equal(r.ok, false);
	assert.match(r.reason ?? "", /找不到快速模型 acme\/nope/);
});
