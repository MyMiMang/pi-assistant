import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { BRAND, LEGACY } from "@pi-assistant/shared";
import { EncryptedCredentialStore, MasterKeyUnreadable, macMasterKey, windowsMasterKey, type SecurityRun } from "../src/secrets.ts";

test("凭据加密落盘，可读回，可删除", async () => {
	const s = new EncryptedCredentialStore();
	await s.modify("openai", async () => ({ type: "api_key", key: "sk-secret-123" }));
	const raw = readFileSync(join(config.dataDir, "credentials.enc"));
	assert.ok(!raw.toString("latin1").includes("sk-secret-123"), "文件中不应出现明文");
	const s2 = new EncryptedCredentialStore();
	assert.deepEqual(await s2.read("openai"), { type: "api_key", key: "sk-secret-123" });
	assert.deepEqual(await s2.list(), [{ providerId: "openai", type: "api_key" }]);
	await s2.delete("openai");
	assert.equal(await s2.read("openai"), undefined);
});

// ---------------------------------------------------------------- 主密钥读不到时停下、不覆盖（决策 0015）
const KEY = "ab".repeat(32);
/** 假的 security：按服务名给结果（{ out } = 读到，数字 = 退出码），记下每次调用 */
function fakeSecurity(find: Record<string, { out: string } | number>, addOk = true) {
	const calls: string[][] = [];
	const run: SecurityRun = (args) => {
		calls.push(args);
		if (args[0] === "add-generic-password") return addOk ? { ok: true, out: "" } : { ok: false, status: 45 };
		const r = find[args[args.indexOf("-s") + 1]] ?? 44;
		return typeof r === "number" ? { ok: false, status: r } : { ok: true, out: r.out };
	};
	return { run, calls, adds: () => calls.filter((c) => c[0] === "add-generic-password") };
}
const tmpKeyFile = (content?: string) => {
	const f = join(mkdtempSync(join(tmpdir(), "pia-mk-")), "master.key");
	if (content !== undefined) writeFileSync(f, content);
	return f;
};

test("macOS 主密钥：读到就用，不写钥匙串", () => {
	const s = fakeSecurity({ [BRAND.name]: { out: KEY } });
	assert.equal(macMasterKey(s.run, tmpKeyFile())?.key.toString("hex"), KEY);
	assert.equal(s.adds().length, 0);
});

test("macOS 主密钥：有但读不到（拒绝 / 锁着）→ 停下报错，不新建、不覆盖", () => {
	for (const status of [51, 128, 36]) {
		const s = fakeSecurity({ [BRAND.name]: status });
		assert.throws(() => macMasterKey(s.run, tmpKeyFile()), (e) => e instanceof MasterKeyUnreadable && /没有新建密钥/.test(e.message) && new RegExp(`退出码 ${status}`).test(e.message));
		assert.equal(s.adds().length, 0, `退出码 ${status} 不能写钥匙串`);
	}
	// 旧服务名的条目读不到也一样停下
	const s = fakeSecurity({ [LEGACY.keychainService]: 51 });
	assert.throws(() => macMasterKey(s.run, tmpKeyFile()), MasterKeyUnreadable);
	assert.equal(s.adds().length, 0);
});

test("macOS 主密钥：只有旧服务名 → 复制到新服务名（不带 -U）并沿用旧密钥", () => {
	const s = fakeSecurity({ [LEGACY.keychainService]: { out: KEY } });
	assert.equal(macMasterKey(s.run, tmpKeyFile())?.key.toString("hex"), KEY);
	assert.equal(s.adds().length, 1);
	assert.ok(!s.adds()[0].includes("-U"));
});

test("macOS 主密钥：钥匙串里没有但有 master.key 文件 → 用文件那把，不新建", () => {
	const s = fakeSecurity({});
	assert.equal(macMasterKey(s.run, tmpKeyFile(KEY)), null);
	assert.equal(s.adds().length, 0);
});

test("macOS 主密钥：确实从没有过 → 新建（不带 -U）；写不进钥匙串 → 交给文件", () => {
	const s = fakeSecurity({});
	const m = macMasterKey(s.run, tmpKeyFile());
	assert.equal(m?.backend, "macos-keychain");
	assert.equal(s.adds().length, 1);
	assert.ok(!s.adds()[0].includes("-U"));
	assert.equal(s.adds()[0][s.adds()[0].indexOf("-w") + 1], m!.key.toString("hex"));
	assert.equal(macMasterKey(fakeSecurity({}, false).run, tmpKeyFile()), null);
});

test("Windows 主密钥：DPAPI 解不开 → 停下报错；明文 hex 文件 → 交给文件分支", () => {
	const fail = () => { throw new Error("拒绝访问"); };
	assert.throws(() => windowsMasterKey(fail, tmpKeyFile("AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA")), (e) => e instanceof MasterKeyUnreadable && /拒绝访问/.test(e.message));
	assert.equal(windowsMasterKey(fail, tmpKeyFile(KEY)), null);
	assert.equal(windowsMasterKey(() => KEY.toUpperCase(), tmpKeyFile("AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA"))?.key.toString("hex"), KEY);
});
