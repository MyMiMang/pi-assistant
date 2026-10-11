/**
 * 访问控制：
 *  - 本机回环访问（127.0.0.1，且没有经过隧道的转发头）免配对；
 *  - 其他访问（经隧道）必须带设备 token；token 只存 SHA-256 哈希，可吊销；
 *  - 按 IP 限流；配对码一次性、5 分钟过期、失败过多锁定。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { bus } from "./bus.ts";
import { db, now, uid } from "./db.ts";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

export interface Caller {
	local: boolean;
	deviceId: string | null;
	ip: string;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
export function isLocalRequest(remoteAddr: string | undefined, headers: Headers): boolean {
	const loop = !!remoteAddr && (remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1");
	const host = headers.get("host") ?? "";
	const forwarded = headers.has("cf-connecting-ip") || headers.has("x-forwarded-for") || headers.has("cf-ray");
	return loop && LOCAL_HOST.test(host) && !forwarded;
}
export const clientIp = (remoteAddr: string | undefined, headers: Headers) => headers.get("cf-connecting-ip") ?? remoteAddr ?? "unknown";

export function deviceForToken(token: string | null | undefined): string | null {
	if (!token || !token.startsWith("hh_")) return null;
	const h = sha256(token);
	const row = db.prepare("SELECT id, token_hash FROM devices WHERE token_hash = ? AND status = 'active'").get(h) as { id: string; token_hash: string } | undefined;
	if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(h))) return null;
	return row.id;
}
export function touchDevice(id: string, ip: string) {
	db.prepare("UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?").run(now(), ip, id);
}

// ---------------------------------------------------------------- 限流（令牌桶）
const buckets = new Map<string, { tokens: number; at: number }>();
export function rateLimit(key: string, perMinute: number, burst = perMinute): boolean {
	const t = Date.now();
	const b = buckets.get(key) ?? { tokens: burst, at: t };
	b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 60_000) * perMinute);
	b.at = t;
	if (b.tokens < 1) {
		buckets.set(key, b);
		return false;
	}
	b.tokens -= 1;
	buckets.set(key, b);
	return true;
}
setInterval(() => {
	const cut = Date.now() - 10 * 60_000;
	for (const [k, v] of buckets) if (v.at < cut) buckets.delete(k);
}, 60_000).unref();

// ---------------------------------------------------------------- 配对
const CODE_TTL = 5 * 60_000;
const issuedTokens = new Map<string, string>(); // deviceId → 明文 token（只交付一次）
let failures: number[] = [];

/**
 * 生成一次性配对码。preApproved：主人在电脑上生成二维码时勾选“扫码后无需在电脑上确认”，
 * 适合人不在电脑旁的场景——认领即自动批准（码本身 5 分钟有效、只能用一次，等同一次性凭据）。
 */
export function createPairCode(opts: { preApproved?: boolean } = {}) {
	const code = b64url(randomBytes(24));
	const expiresAt = now() + CODE_TTL;
	db.prepare("DELETE FROM pair_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(now());
	db.prepare("INSERT INTO pair_codes(code_hash, expires_at, pre_approved) VALUES(?, ?, ?)").run(sha256(code), expiresAt, opts.preApproved ? 1 : 0);
	return { code, expiresAt, preApproved: !!opts.preApproved };
}

export function claimPairCode(code: string, name: string, platform: string): { ok: true; deviceId: string; preApproved?: boolean } | { ok: false; error: string } {
	failures = failures.filter((t) => t > now() - 15 * 60_000);
	if (failures.length >= 5) return { ok: false, error: "too_many_attempts" };
	const row = db.prepare("SELECT * FROM pair_codes WHERE code_hash = ?").get(sha256(code)) as { code_hash: string; expires_at: number; used_at: number | null; pre_approved: number } | undefined;
	if (!row || row.used_at || row.expires_at < now()) {
		failures.push(now());
		return { ok: false, error: "invalid_or_expired" };
	}
	db.prepare("UPDATE pair_codes SET used_at = ? WHERE code_hash = ?").run(now(), row.code_hash); // 立即作废
	const id = uid("dev");
	db.prepare("INSERT INTO devices(id, name, platform, status, created_at) VALUES(?,?,?,?,?)").run(id, name.slice(0, 60) || "新设备", platform.slice(0, 40), "pending", now());
	if (row.pre_approved) {
		approveDevice(id);
		return { ok: true, deviceId: id, preApproved: true };
	}
	bus.emit({ type: "device.pending", device: getDevice(id) });
	return { ok: true, deviceId: id };
}

export function approveDevice(id: string) {
	const d = getDevice(id);
	if (!d || d.status !== "pending") return false;
	const token = `hh_${b64url(randomBytes(32))}`;
	db.prepare("UPDATE devices SET status = 'active', token_hash = ? WHERE id = ?").run(sha256(token), id);
	issuedTokens.set(id, token);
	setTimeout(() => issuedTokens.delete(id), 10 * 60_000).unref();
	bus.emit({ type: "devices.changed" });
	return true;
}
export function rejectDevice(id: string) {
	db.prepare("UPDATE devices SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(id);
	bus.emit({ type: "devices.changed" });
}
export function revokeDevice(id: string) {
	db.prepare("UPDATE devices SET status = 'revoked', token_hash = NULL, revoked_at = ? WHERE id = ?").run(now(), id);
	db.prepare("DELETE FROM push_subs WHERE device_id = ?").run(id);
	bus.emit({ type: "devices.changed" });
	bus.emit({ type: "device.revoked", deviceId: id });
}
/** 手机轮询配对结果；批准后 token 只返回一次。 */
export function pairStatus(id: string): { status: string; token?: string } {
	const d = getDevice(id);
	if (!d) return { status: "unknown" };
	if (d.status === "active") {
		const token = issuedTokens.get(id);
		issuedTokens.delete(id);
		return token ? { status: "active", token } : { status: "active" };
	}
	return { status: d.status };
}
export const getDevice = (id: string) =>
	db.prepare("SELECT id, name, platform, status, created_at, last_seen_at, last_ip, revoked_at FROM devices WHERE id = ?").get(id) as
		| { id: string; name: string; platform: string; status: string; created_at: number; last_seen_at: number | null; last_ip: string | null }
		| undefined;
export const listDevices = () =>
	db.prepare("SELECT id, name, platform, status, created_at, last_seen_at, last_ip, revoked_at FROM devices WHERE status IN ('active','pending') ORDER BY created_at DESC").all();
