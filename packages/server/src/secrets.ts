/**
 * 本地凭据加密存储，实现 Pi 的 CredentialStore 接口（传给 ModelRuntime），
 * 因此 Pi 的所有登录方式（API Key、订阅 OAuth）写入的凭据都加密落盘。
 * 主密钥优先放系统钥匙串：macOS Keychain（security）/ Windows DPAPI；其他平台退回 0600 权限的密钥文件。
 * 凭据只保存在本机，绝不发往 Rendezvous 或任何第三方。
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStore } from "./pi-adapter/index.ts";
import { BRAND, LEGACY } from "@pi-assistant/shared";
import { config, env } from "./config.ts";

type Cred = Awaited<ReturnType<CredentialStore["read"]>>;

const SERVICE = BRAND.name;
const LEGACY_SERVICE = LEGACY.keychainService;
const ACCOUNT = "credential-master-key";

type MasterKey = { key: Buffer; backend: string };
/** 主密钥「有但读不到」：服务停下并把原因写进日志（App 启动失败页会显示），绝不另造一把覆盖（决策 0015）。 */
export class MasterKeyUnreadable extends Error {}
const KEEP = "为了不让已保存的 API Key 等凭据失效，没有新建密钥，服务先停下。";

/** 跑一次 security；失败时带回退出码（44 = errSecItemNotFound，确实没有这一项）。 */
export type SecurityRun = (args: string[]) => { ok: true; out: string } | { ok: false; status: number | null };
const runSecurity: SecurityRun = (args) => {
	try {
		return { ok: true, out: execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() };
	} catch (e) {
		return { ok: false, status: (e as { status?: number | null }).status ?? null };
	}
};
const NOT_FOUND = 44;

/**
 * macOS：主密钥在登录钥匙串（服务名 BRAND.name；更早的版本在 LEGACY.keychainService）。
 * 只有新旧两项都**确实不存在**、也没有 master.key 文件时才新建；任何一项「有但读不到」（点了拒绝、钥匙串锁着）都抛
 * MasterKeyUnreadable。写入一律不带 -U，永远不覆盖已有条目。返回 null = 交给 master.key 文件（已有就用，没有就建）。
 */
export function macMasterKey(sec: SecurityRun, keyFile: string): MasterKey | null {
	const read = (service: string) => {
		const r = sec(["find-generic-password", "-s", service, "-a", ACCOUNT, "-w"]);
		if (r.ok && r.out) return Buffer.from(r.out, "hex");
		if (!r.ok && r.status === NOT_FOUND) return null;
		throw new MasterKeyUnreadable(`读不到钥匙串里「${service}」的主密钥（${r.ok ? "内容为空" : `security 退出码 ${r.status}`}）。${KEEP}请打开「钥匙串访问」确认这一项还在、登录钥匙串已解锁；系统弹窗问是否允许访问时点「允许」，然后重启 ${BRAND.name}。`);
	};
	const cur = read(SERVICE);
	if (cur) return { key: cur, backend: "macos-keychain" };
	// 迁移：旧版本的主密钥复制到新服务名（旧条目保留）；复制失败也照用，下次仍从旧条目读
	const old = read(LEGACY_SERVICE);
	if (old) {
		sec(["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", old.toString("hex")]);
		return { key: old, backend: "macos-keychain" };
	}
	if (existsSync(keyFile)) return null; // 以前写钥匙串失败时退回过文件：继续用那把
	const key = randomBytes(32);
	return sec(["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", key.toString("hex")]).ok ? { key, backend: "macos-keychain" } : null;
}

/**
 * Windows：master.key 里是 DPAPI 保护过的主密钥（base64）。解不开就抛 MasterKeyUnreadable，不再掉到文件分支拿错的密钥；
 * 文件里是 64 位 hex（以前 DPAPI 不可用时退回的明文密钥）或 DPAPI 建不出来 → 返回 null 交给文件分支。
 */
export function windowsMasterKey(ps: (script: string) => string, keyFile: string): MasterKey | null {
	if (existsSync(keyFile)) {
		const b64 = readFileSync(keyFile, "utf8").trim();
		if (/^[0-9a-f]{64}$/i.test(b64)) return null;
		try {
			const hex = ps(`Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); [BitConverter]::ToString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')).Replace('-','')`);
			return { key: Buffer.from(hex, "hex"), backend: "windows-dpapi" };
		} catch (e) {
			throw new MasterKeyUnreadable(`解不开 Windows 保护的主密钥文件 ${keyFile}（${e instanceof Error ? e.message.split("\n")[0] : String(e)}）。${KEEP}请确认用的是安装时的同一个 Windows 账户，然后重启 ${BRAND.name}。`);
		}
	}
	try {
		const key = randomBytes(32);
		const b64 = ps(`Add-Type -AssemblyName System.Security; $k=[Convert]::FromBase64String('${key.toString("base64")}'); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($k,$null,'CurrentUser'))`);
		writeFileSync(keyFile, b64);
		return { key, backend: "windows-dpapi" };
	} catch {
		return null;
	}
}

function loadMasterKey(): MasterKey {
	const keyFile = join(config.dataDir, "master.key");
	// PIA_SECRETS=file：主密钥只放数据目录里的文件（开发实测环境用，不碰系统钥匙串、不和装好的 App 共用一把钥匙）
	const os = env("SECRETS") === "file" ? null : process.platform === "darwin" ? macMasterKey(runSecurity, keyFile)
		: process.platform === "win32" ? windowsMasterKey((s) => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", s], { encoding: "utf8" }).trim(), keyFile)
		: null;
	if (os) return os;
	if (existsSync(keyFile)) return { key: Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex"), backend: "file" };
	const key = randomBytes(32);
	writeFileSync(keyFile, key.toString("hex"), { mode: 0o600 });
	return { key, backend: "file" };
}

export class EncryptedCredentialStore implements CredentialStore {
	private key: Buffer;
	readonly backend: string;
	private file = join(config.dataDir, "credentials.enc");
	private chain: Promise<unknown> = Promise.resolve();

	constructor() {
		const m = loadMasterKey();
		this.key = m.key;
		this.backend = m.backend;
	}
	private load(): Record<string, NonNullable<Cred>> {
		if (!existsSync(this.file)) return {};
		const buf = readFileSync(this.file);
		const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
		const d = createDecipheriv("aes-256-gcm", this.key, iv);
		d.setAuthTag(tag);
		return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8"));
	}
	private save(all: Record<string, unknown>) {
		const iv = randomBytes(12);
		const c = createCipheriv("aes-256-gcm", this.key, iv);
		const data = Buffer.concat([c.update(JSON.stringify(all), "utf8"), c.final()]);
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), data]), { mode: 0o600 });
		renameSync(tmp, this.file);
	}
	async read(providerId: string) {
		return this.load()[providerId];
	}
	async list() {
		return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
	}
	modify(providerId: string, fn: (current: Cred) => Promise<Cred>) {
		const run = async () => {
			const all = this.load();
			const next = await fn(all[providerId]);
			if (next) all[providerId] = next;
			else delete all[providerId];
			this.save(all);
			return next;
		};
		const p = this.chain.then(run, run);
		this.chain = p.catch(() => {});
		return p;
	}
	async delete(providerId: string) {
		await this.modify(providerId, async () => undefined);
	}
}

// ---------------------------------------------------------------- 通用小块加密（例如自定义服务的请求头值）
let boxKey: Buffer | null = null;
const key = () => (boxKey ??= loadMasterKey().key);
export function sealJson(v: unknown): string {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key(), iv);
	const data = Buffer.concat([c.update(JSON.stringify(v), "utf8"), c.final()]);
	return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}
export function openJson<T>(s: string): T {
	const buf = Buffer.from(s, "base64");
	const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
	d.setAuthTag(buf.subarray(12, 28));
	return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}
