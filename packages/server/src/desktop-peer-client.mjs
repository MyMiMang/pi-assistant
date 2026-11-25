// Bundled Node sidecar used by the native command. Never imported by the web UI.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const pair = "/api/desktop-edge-pair/";
const idPart = s => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const secret = s => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s) && Buffer.from(s, "base64url").toString("base64url") === s;
export function parseInvite(raw) {
	if (typeof raw !== "string" || raw.length > 2048) throw Error("invalid_invite");
	const v = JSON.parse(raw);
	const u = new URL(v.origin);
	if (u.protocol !== "https:" || u.origin !== v.origin || !u.hostname.includes(".") || !idPart(v.serverId) || !secret(v.publicKey) || !/^[A-Za-z0-9_-]{16}$/.test(v.code) || !Number.isSafeInteger(v.expires) || v.expires <= Date.now()) throw Error("invalid_invite");
	return { origin: v.origin, serverId: v.serverId, publicKey: v.publicKey, code: v.code, expires: v.expires };
}
const publicTarget = ({ origin, serverId, publicKey }) => ({ origin, serverId, publicKey });
export function createDesktopPeerClient(fetcher = fetch) {
	async function http(target, path, { body, token } = {}) {
		const response = await fetcher(target.origin + path, { redirect: "error", signal: AbortSignal.timeout(6000), method: body === undefined ? "GET" : "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
		if (!response.ok) throw Error(response.status === 401 && token ? "revoked" : "peer_request_failed");
		const reader = response.body?.getReader();
		const chunks = []; let count = 0;
		if (!reader) throw Error("invalid_response");
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			count += value.length;
			if (count > 12_000_000) { await reader.cancel(); throw Error("invalid_response"); }
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	}
	async function authenticate(target) {
		const nonce = randomBytes(32).toString("base64url");
		const reply = await http(target, `${pair}identity?nonce=${nonce}`);
		const { origin, serverId, publicKey } = target;
		const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
		const message = Buffer.from(JSON.stringify(["pia-desktop-edge-v1", origin, serverId, publicKey, nonce]));
		if (reply.origin !== origin || reply.serverId !== serverId || reply.publicKey !== publicKey || typeof reply.signature !== "string" || !verify(null, message, key, Buffer.from(reply.signature, "base64url"))) throw Error("identity_mismatch");
	}
	return async function run(v) {
		const { op, peer } = v;
		if (op === "preview") { const invite = parseInvite(v.invite); await authenticate(invite); return { ...invite, targetName: new URL(invite.origin).hostname, handle: randomBytes(24).toString("base64url") }; }
		await authenticate(peer);
		if (op === "claim") {
			if (peer.expires <= Date.now()) throw Error("expired_invite");
			const proof = randomBytes(32).toString("base64url");
			const commitment = createHash("sha256").update(Buffer.from(proof, "base64url")).digest("hex");
			const response = await http(peer, `${pair}claim`, { body: { ...publicTarget(peer), code: peer.code, name: v.name, platform: process.platform, commitment } });
			if (!idPart(response.id)) throw Error("invalid_response");
			return { claimId: response.id, proof, checkCode: commitment.slice(0, 12) };
		}
		if (op === "collect") {
			const r = await http(peer, `${pair}collect`, { body: { ...publicTarget(peer), id: peer.claimId, proof: peer.proof } });
			if (r.status === "pending") return { status: "pending" };
			if (r.status !== "issued" || !idPart(r.deviceId) || typeof r.token !== "string" || !/^hh_[A-Za-z0-9_-]{43}$/.test(r.token)) throw Error("invalid_response");
			return { status: "issued", deviceId: r.deviceId, token: r.token };
		}
		if (op === "confirm") {
			const r = await http(peer, `${pair}confirm`, { body: { ...publicTarget(peer), id: peer.claimId, receipt: peer.token } });
			if (r.ok !== true) throw Error("peer_request_failed");
			return null;
		}
		const auth = { token: peer.token };
		if (op === "status") { await http(peer, "/api/agents", auth); return "online"; }
		if (op === "chats") {
			const agents = await http(peer, "/api/agents", auth);
			const out = [];
			const rows = agents.filter(x => idPart(x.id) && x.scope !== "room");
			for (let i = 0; i < rows.length; i += 8) {
				const batch = await Promise.all(rows.slice(i, i + 8).map(async a => {
					const r = await http(peer, `/api/agents/${a.id}/conversations`, auth);
					return r.items.filter(x => idPart(x.id)).map(c => ({ agent: a.id, conversation: c.id, title: String(c.title ?? a.name ?? "聊天").slice(0, 200) }));
				}));
				out.push(...batch.flat());
			}
			return out;
		}
		if (!idPart(v.agent) || !idPart(v.conversation)) throw Error("invalid_conversation");
		const messages = `/api/agents/${v.agent}/messages`;
		if (op === "read") return (await http(peer, `${messages}?conversation=${encodeURIComponent(v.conversation)}`, auth)).map(m => ({ id: m.id, role: m.role, content: String(m.content ?? "") }));
		if (op === "send" && typeof v.text === "string" && v.text.length <= 100_000 && idPart(v.clientId)) {
			const receipt = await http(peer, messages, { ...auth, body: { conversationId: v.conversation, text: v.text, clientId: v.clientId } });
			if (!idPart(receipt.id) || receipt.conversation_id !== v.conversation || receipt.agent_id !== v.agent || receipt.role !== "user") throw Error("invalid_response");
			return { id: receipt.id, agent: v.agent, conversation: v.conversation };
		}
		throw Error("desktop_operation_unavailable");
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const timeout = setTimeout(() => process.exit(1), 20_000);
	const rl = createInterface({ input: process.stdin });
	rl.once("line", async line => {
		rl.close(); process.stdin.pause();
		try { console.log(JSON.stringify({ value: await createDesktopPeerClient()(JSON.parse(line)) })); }
		catch (e) { console.log(JSON.stringify({ error: e?.message === "revoked" ? "revoked" : "peer_request_failed" })); }
		finally { clearTimeout(timeout); }
	});
}
