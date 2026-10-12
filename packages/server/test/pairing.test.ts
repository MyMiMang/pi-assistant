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

test("短配对码：8 位、无易混字符、分组显示；大小写/空格/横线都能认；和二维码长码同一张票", async () => {
	const { _resetPairFailures, normalizeShortCode, SHORT_ALPHABET } = await import("../src/auth.ts");
	_resetPairFailures();
	for (const ch of "0O1IL") assert.ok(!SHORT_ALPHABET.includes(ch), `不应含 ${ch}`);
	const a = createPairCode();
	assert.match(a.shortCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
	assert.equal(normalizeShortCode(` ${a.shortCode.toLowerCase().replace("-", " - ")} `), a.shortCode.replace("-", ""));
	const r = claimPairCode(a.shortCode.toLowerCase().replace("-", " "), "iPhone 主屏", "ios");
	assert.ok(r.ok, "手输短码应能认领");
	assert.equal(pairStatus((r as { deviceId: string }).deviceId).status, "pending", "默认仍需电脑确认");
	assert.equal(claimPairCode(a.shortCode, "x", "x").ok, false, "短码只能用一次");
	assert.equal(claimPairCode(a.code, "x", "x").ok, false, "短码用掉后，二维码长码也作废");
	// 反过来：二维码用掉后短码也作废
	const b = createPairCode();
	assert.ok(claimPairCode(b.code, "Safari", "ios").ok);
	assert.equal(claimPairCode(b.shortCode, "x", "x").ok, false);
	// 免确认语义同样适用
	_resetPairFailures();
	const c = createPairCode({ preApproved: true });
	const rc = claimPairCode(c.shortCode, "iPhone", "ios");
	assert.ok(rc.ok && rc.preApproved);
	assert.ok(pairStatus((rc as { deviceId: string }).deviceId).token?.startsWith("hh_"));
});

test("短配对码过期失效", async () => {
	const { _resetPairFailures } = await import("../src/auth.ts");
	const { db } = await import("../src/db.ts");
	_resetPairFailures();
	const a = createPairCode();
	db.prepare("UPDATE pair_codes SET expires_at = ? WHERE expires_at = ?").run(Date.now() - 1, a.expiresAt);
	assert.deepEqual(claimPairCode(a.shortCode, "x", "x"), { ok: false, error: "invalid_or_expired" });
	_resetPairFailures();
});

test("防爆破：累计 5 次错误 → 锁定认领，并作废所有未用短码（二维码长码不受影响）", async () => {
	const { _resetPairFailures } = await import("../src/auth.ts");
	_resetPairFailures();
	const live = createPairCode();
	const wrong = live.shortCode.startsWith("A") ? "BBBB-BBBB" : "AAAA-AAAA";
	for (let i = 0; i < 5; i++) assert.equal((claimPairCode(wrong, "x", "x") as { error: string }).error, "invalid_or_expired");
	assert.equal((claimPairCode(live.shortCode, "x", "x") as { error: string }).error, "too_many_attempts", "锁定期内正确的码也不行");
	_resetPairFailures(); // 模拟锁定期过去
	assert.equal(claimPairCode(live.shortCode, "x", "x").ok, false, "被爆破过的短码已作废");
	_resetPairFailures();
	assert.ok(claimPairCode(live.code, "iPhone", "ios").ok, "二维码长码仍可用");
	_resetPairFailures();
});
