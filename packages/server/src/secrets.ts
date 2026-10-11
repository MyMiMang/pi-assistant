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
import { config } from "./config.ts";

type Cred = Awaited<ReturnType<CredentialStore["read"]>>;

const SERVICE = "HuHao";
const ACCOUNT = "credential-master-key";

function loadMasterKey(): { key: Buffer; backend: string } {
	if (process.platform === "darwin") {
		try {
			const hex = execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
			if (hex) return { key: Buffer.from(hex, "hex"), backend: "macos-keychain" };
		} catch {
			/* not found */
		}
		try {
			const key = randomBytes(32);
			execFileSync("security", ["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", key.toString("hex"), "-U"], { stdio: "ignore" });
			return { key, backend: "macos-keychain" };
		} catch {
			/* fall through */
		}
	}
	const keyFile = join(config.dataDir, "master.key");
	if (process.platform === "win32") {
		const ps = (script: string) => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
		try {
			if (existsSync(keyFile)) {
				const b64 = readFileSync(keyFile, "utf8").trim();
				const hex = ps(`Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); [BitConverter]::ToString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')).Replace('-','')`);
				return { key: Buffer.from(hex, "hex"), backend: "windows-dpapi" };
			}
			const key = randomBytes(32);
			const b64 = ps(`Add-Type -AssemblyName System.Security; $k=[Convert]::FromBase64String('${key.toString("base64")}'); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($k,$null,'CurrentUser'))`);
			writeFileSync(keyFile, b64);
			return { key, backend: "windows-dpapi" };
		} catch {
			/* fall through */
		}
	}
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
