import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { approveDevice, claimPairCode, createPairCode, deviceForToken, isLocalRequest, pairStatus, revokeDevice } from "../src/auth.ts";

test("配对码一次性，批准后 token 只交付一次，可吊销", () => {
	const { code } = createPairCode();
	const r = claimPairCode(code, "iPhone", "ios");
	assert.ok(r.ok);
	assert.equal(claimPairCode(code, "x", "x").ok, false, "配对码不能重复使用");
	const id = (r as { deviceId: string }).deviceId;
	assert.equal(pairStatus(id).status, "pending");
	assert.ok(approveDevice(id));
	const s = pairStatus(id);
	assert.ok(s.token?.startsWith("hh_"));
	assert.equal(pairStatus(id).token, undefined, "token 只返回一次");
	assert.equal(deviceForToken(s.token), id);
	revokeDevice(id);
	assert.equal(deviceForToken(s.token), null);
});

test("只有不经隧道的回环请求算本机", () => {
	assert.ok(isLocalRequest("127.0.0.1", new Headers({ host: "127.0.0.1:8787" })));
	assert.ok(!isLocalRequest("127.0.0.1", new Headers({ host: "x.trycloudflare.com" })));
	assert.ok(!isLocalRequest("127.0.0.1", new Headers({ host: "127.0.0.1:8787", "cf-connecting-ip": "1.1.1.1" })));
	assert.ok(!isLocalRequest("10.0.0.5", new Headers({ host: "127.0.0.1:8787" })));
});

test("预先批准的配对码：认领即通过，无需电脑确认；仍然一次性", () => {
	const { code, preApproved } = createPairCode({ preApproved: true });
	assert.ok(preApproved);
	const r = claimPairCode(code, "iPhone", "ios");
	assert.ok(r.ok && r.preApproved);
	const s = pairStatus((r as { deviceId: string }).deviceId);
	assert.equal(s.status, "active");
	assert.ok(s.token?.startsWith("hh_"));
	assert.equal(claimPairCode(code, "x", "x").ok, false);
	// 默认仍需确认
	const r2 = claimPairCode(createPairCode().code, "Android", "android");
	assert.equal(pairStatus((r2 as { deviceId: string }).deviceId).status, "pending");
});
