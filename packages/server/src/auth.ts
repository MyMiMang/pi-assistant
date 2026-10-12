/**
 * 访问控制：
 *  - 本机回环访问（127.0.0.1，且没有经过隧道的转发头）免配对；
 *  - 其他访问（经隧道）必须带设备 token；token 只存 SHA-256 哈希，可吊销；
 *  - 按 IP 限流；配对码一次性、5 分钟过期、失败过多锁定。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { db, now, uid } from "./db.ts";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

export interface Caller {
	local: boolean;
	deviceId: string | null;
	ip: string;
	/** 主人设备（服务器版第一次用设置码登录的设备）：和本机一样可以改所有设置、批准新设备 */
	owner?: boolean;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
export function isLocalRequest(remoteAddr: string | undefined, headers: Headers): boolean {
	if (!config.trustLoopback) return false; // 服务器模式：本机回环也要登录（见 config.headless）
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

/** 短配对码字母表：去掉容易看错的 0/O、1/I/L（31 个字符，8 位 ≈ 39.6 bit；配合全局失败上限，5 次内猜中概率约 6×10⁻¹²）。 */
export const SHORT_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SHORT_LEN = 8;
const MAX_FAILURES = 5; // 15 分钟内累计失败 5 次：锁定认领，并作废所有还没用的短码
/** 用户手输的短码规范化：去掉空格/横线、转大写；不是 8 位或含表外字符则不是短码。 */
export function normalizeShortCode(input: string): string | null {
	const s = input.toUpperCase().replace(/[\s\-_.]/g, "");
	if (s.length !== SHORT_LEN) return null;
	for (const ch of s) if (!SHORT_ALPHABET.includes(ch)) return null;
	return s;
}
function newShortCode() {
	const bytes = randomBytes(SHORT_LEN * 2);
	let out = "";
	// 拒绝采样，避免取模偏差（31 个字符）
	for (let i = 0; out.length < SHORT_LEN; i++) {
		const b = i < bytes.length ? bytes[i] : randomBytes(1)[0];
		if (b < 248) out += SHORT_ALPHABET[b % SHORT_ALPHABET.length];
	}
	return out;
}
export const formatShortCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

/**
 * 生成一次性配对码。preApproved：主人在电脑上生成二维码时勾选“扫码后无需在电脑上确认”，
 * 适合人不在电脑旁的场景——认领即自动批准（码本身 5 分钟有效、只能用一次，等同一次性凭据）。
 * 同时生成一个好输入的短码（ABCD-EFGH），和二维码里的长码是同一张“票”：任一个用掉，另一个也作废。
 * 用途：iOS「添加到主屏幕」的 App 和 Safari 不共享存储，需要在 App 里手动输一次。
 */
export function createPairCode(opts: { preApproved?: boolean } = {}) {
	const code = b64url(randomBytes(24));
	let short = newShortCode();
	const expiresAt = now() + CODE_TTL;
	db.prepare("DELETE FROM pair_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(now());
	while (db.prepare("SELECT 1 FROM pair_codes WHERE short_hash = ?").get(sha256(short))) short = newShortCode();
	db.prepare("INSERT INTO pair_codes(code_hash, expires_at, pre_approved, short_hash) VALUES(?, ?, ?, ?)").run(sha256(code), expiresAt, opts.preApproved ? 1 : 0, sha256(short));
	return { code, shortCode: formatShortCode(short), expiresAt, preApproved: !!opts.preApproved };
}

/** code 可以是二维码里的长码，也可以是手输的短码（大小写、空格、横线都行）。 */
export function claimPairCode(code: string, name: string, platform: string): { ok: true; deviceId: string; preApproved?: boolean } | { ok: false; error: string } {
	failures = failures.filter((t) => t > now() - 15 * 60_000);
	if (failures.length >= MAX_FAILURES) return { ok: false, error: "too_many_attempts" };
	const short = normalizeShortCode(code);
	type Row = { code_hash: string; expires_at: number; used_at: number | null; pre_approved: number; owner: number };
	const row = (short ? db.prepare("SELECT * FROM pair_codes WHERE short_hash = ?").get(sha256(short)) : db.prepare("SELECT * FROM pair_codes WHERE code_hash = ?").get(sha256(code))) as Row | undefined;
	if (!row || row.used_at || row.expires_at < now()) {
		failures.push(now());
		// 被猜到上限：所有还没用的短码立即作废（二维码长码 192 bit 猜不到，保留）
		if (failures.length >= MAX_FAILURES) db.prepare("UPDATE pair_codes SET short_hash = NULL WHERE used_at IS NULL").run();
		return { ok: false, error: "invalid_or_expired" };
	}
	db.prepare("UPDATE pair_codes SET used_at = ?, short_hash = NULL WHERE code_hash = ?").run(now(), row.code_hash); // 立即作废（长码短码一起）
	const id = uid("dev");
	db.prepare("INSERT INTO devices(id, name, platform, status, created_at) VALUES(?,?,?,?,?)").run(id, name.slice(0, 60) || "新设备", platform.slice(0, 40), "pending", now());
	if (row.owner) {
		// 服务器版一次性设置码：认领即批准，并成为主人设备
		db.prepare("UPDATE devices SET owner = 1 WHERE id = ?").run(id);
		approveDevice(id);
		bus.emit({ type: "setup.claimed", deviceId: id } as never);
		return { ok: true, deviceId: id, preApproved: true };
	}
	if (row.pre_approved) {
		approveDevice(id);
		return { ok: true, deviceId: id, preApproved: true };
	}
	bus.emit({ type: "device.pending", device: getDevice(id) });
	return { ok: true, deviceId: id };
}
/** 测试用：清空失败计数。 */
export const _resetPairFailures = () => void (failures = []);

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
	db.prepare("SELECT id, name, platform, status, created_at, last_seen_at, last_ip, revoked_at, owner FROM devices WHERE id = ?").get(id) as
		| { id: string; name: string; platform: string; status: string; created_at: number; last_seen_at: number | null; last_ip: string | null; owner: number }
		| undefined;
export const listDevices = () =>
	db.prepare("SELECT id, name, platform, status, created_at, last_seen_at, last_ip, revoked_at, owner FROM devices WHERE status IN ('active','pending') ORDER BY created_at DESC").all();

// ---------------------------------------------------------------- 主人设备 + 一次性设置码（服务器版，DESIGN §15.3）
export const isOwnerDevice = (id: string | null | undefined) => !!id && !!(db.prepare("SELECT 1 FROM devices WHERE id = ? AND status = 'active' AND owner = 1").get(id));
export const hasOwner = () => !!db.prepare("SELECT 1 FROM devices WHERE status = 'active' AND owner = 1").get();
/** 主人可以把别的已配对设备设为 / 取消主人；不能取消最后一个主人（否则就没人能管理了） */
export function setOwner(id: string, owner: boolean) {
	const d = getDevice(id);
	if (!d || d.status !== "active") return false;
	if (!owner && d.owner && (db.prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'active' AND owner = 1").get() as { n: number }).n <= 1) throw new Error("至少要保留一台主人设备");
	db.prepare("UPDATE devices SET owner = ? WHERE id = ?").run(owner ? 1 : 0, id);
	bus.emit({ type: "devices.changed" });
	return true;
}
const SETUP_TTL = 24 * 60 * 60_000;
/** 当前还有效的设置码（只存哈希；明文只在生成时打印 / 写进数据目录里只有服务账号能读的文件） */
export const setupCodeValid = () => !!db.prepare("SELECT 1 FROM pair_codes WHERE owner = 1 AND used_at IS NULL AND expires_at > ? AND short_hash IS NOT NULL").get(now());
/** 生成一次性设置码：8 位（同配对短码字母表），24 小时有效，只能用一次；作废之前的设置码 */
export function createSetupCode() {
	db.prepare("DELETE FROM pair_codes WHERE owner = 1").run();
	const code = b64url(randomBytes(24));
	let short = newShortCode();
	while (db.prepare("SELECT 1 FROM pair_codes WHERE short_hash = ?").get(sha256(short))) short = newShortCode();
	const expiresAt = now() + SETUP_TTL;
	db.prepare("INSERT INTO pair_codes(code_hash, expires_at, pre_approved, short_hash, owner) VALUES(?, ?, 1, ?, 1)").run(sha256(code), expiresAt, sha256(short));
	return { shortCode: formatShortCode(short), expiresAt };
}
/** 取消所有主人（命令行 reset-owner 用）：主人设备一并吊销，服务会重新生成设置码 */
export function resetOwners() {
	const ids = (db.prepare("SELECT id FROM devices WHERE owner = 1 AND status = 'active'").all() as { id: string }[]).map((r) => r.id);
	for (const id of ids) revokeDevice(id);
	db.prepare("UPDATE devices SET owner = 0").run();
	db.prepare("DELETE FROM pair_codes WHERE owner = 1").run();
	return ids.length;
}
