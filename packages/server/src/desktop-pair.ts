import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secretHash = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{43}$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value ? createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex") : null;
const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const ttl = 5 * 60_000;
export type DesktopPairTarget = { origin: string; serverId: string; publicKey: string };
type PairRow = { id: string; origin: string; server_id: string; public_key: string; expires: number; commitment: string; name: string; platform: string; state: string; issued_hash: string | null; device_id: string };

export function desktopPairStore(db: DatabaseSync, now = Date.now, transport: "direct" | "edge" = "direct") {
	const sql = (s: string) => transport === "direct" ? s : s.replaceAll("desktop_pair", "desktop_edge_pair").replaceAll("desktop_peer_devices", "desktop_edge_devices");
	const prepare = (s: string) => db.prepare(sql(s));
	db.exec(sql(`CREATE TABLE IF NOT EXISTS desktop_pair (
		id TEXT PRIMARY KEY, invite_hash TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, server_id TEXT NOT NULL,
		public_key TEXT NOT NULL, expires INTEGER NOT NULL, commitment TEXT, name TEXT, platform TEXT,
		state TEXT NOT NULL, issued_hash TEXT, device_id TEXT NOT NULL UNIQUE
	);
	CREATE TABLE IF NOT EXISTS desktop_peer_devices (device_id TEXT PRIMARY KEY, origin TEXT NOT NULL, server_id TEXT NOT NULL, public_key TEXT NOT NULL)`));
	const reap = () => prepare("DELETE FROM desktop_pair WHERE expires <= ?").run(now());
	const select = (id: string, target: DesktopPairTarget) => prepare("SELECT * FROM desktop_pair WHERE id = ? AND origin = ? AND server_id = ? AND public_key = ? AND expires > ?").get(id, target.origin, target.serverId, target.publicKey, now()) as PairRow | undefined;
	function atomic<T>(op: () => T) {
		db.exec("BEGIN IMMEDIATE");
		try { const result = op(); db.exec("COMMIT"); return result; }
		catch (error) { db.exec("ROLLBACK"); throw error; }
	}
	return {
		invite(target: DesktopPairTarget) {
			reap();
			const code = random(12), expires = now() + ttl;
			prepare("INSERT INTO desktop_pair (id,invite_hash,origin,server_id,public_key,expires,state,device_id) VALUES (?,?,?,?,?,?,'invited',?)").run(random(24), hash(code), target.origin, target.serverId, target.publicKey, expires, `dev_${random(24)}`);
			return { ...target, code, expires };
		},
		claim(target: DesktopPairTarget, code: string, commitment: string, name: string, platform: string) {
			if (!/^[A-Za-z0-9_-]{16}$/.test(code) || commitment.length !== 64 || /[^a-f0-9]/.test(commitment)) return null;
			reap();
			const row = prepare("UPDATE desktop_pair SET commitment=?,name=?,platform=?,state='pending' WHERE invite_hash=? AND origin=? AND server_id=? AND public_key=? AND expires>? AND state='invited' RETURNING id, expires").get(commitment, name, platform, hash(code), target.origin, target.serverId, target.publicKey, now());
			return row ?? null;
		},
		pending() {
			reap();
			return prepare("SELECT id, origin, server_id AS serverId, name, platform, expires, substr(commitment,1,12) AS checkCode, state FROM desktop_pair WHERE state IN ('pending','approved','issued') ORDER BY expires").all();
		},
		approve(id: string) {
			return prepare("UPDATE desktop_pair SET state='approved' WHERE id=? AND expires>? AND state='pending'").run(id, now()).changes === 1;
		},
		cancel(id: string) { return prepare("DELETE FROM desktop_pair WHERE id=?").run(id).changes === 1; },
		collect(target: DesktopPairTarget, id: string, secret: unknown) {
			const proof = secretHash(secret);
			if (!proof) return null;
			return atomic(() => {
				const row = select(id, target);
				if (!row?.commitment || !timingSafeEqual(Buffer.from(proof), Buffer.from(row.commitment))) return null;
				if (row.state === "pending") return { status: "pending" as const };
				if (row.state !== "approved") return null;
				const token = `hh_${random(32)}`;
				prepare("UPDATE desktop_pair SET state='issued',issued_hash=?,commitment=NULL WHERE id=?").run(hash(token), id);
				return { status: "issued" as const, deviceId: row.device_id, token };
			});
		},
		owns(deviceId: string) { return !!prepare("SELECT 1 FROM desktop_peer_devices WHERE device_id=?").get(deviceId); },
		bound(deviceId: string, target: DesktopPairTarget) {
			return !!prepare("SELECT 1 FROM desktop_peer_devices WHERE device_id=? AND origin=? AND server_id=? AND public_key=?").get(deviceId, target.origin, target.serverId, target.publicKey);
		},
		confirm(target: DesktopPairTarget, id: string, token: string) {
			return atomic(() => {
				const row = select(id, target);
				if (row?.state !== "issued" || !row.issued_hash || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(row.issued_hash))) return false;
				// Activation only after the claimant has received and retained its credential.
				db.prepare("INSERT INTO devices(id,name,platform,status,created_at,token_hash) VALUES (?,?,?,'active',?,?)").run(row.device_id, row.name, row.platform, now(), row.issued_hash);
				prepare("INSERT INTO desktop_peer_devices VALUES (?,?,?,?)").run(row.device_id, target.origin, target.serverId, target.publicKey);
				prepare("DELETE FROM desktop_pair WHERE id=?").run(id);
				return true;
			});
		},
	};
}
