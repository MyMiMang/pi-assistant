/** 本服务的身份：serverId + Ed25519 密钥对（用于向 Rendezvous 签名上报地址；手机配对时保存公钥用于校验）。 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { getSetting, setSetting } from "./db.ts";

let cache: { serverId: string; publicKey: string; privatePem: string } | null = null;
export function identity() {
	if (cache) return cache;
	let id = getSetting<{ serverId: string; publicKey: string; privatePem: string } | null>("identity", null);
	if (!id) {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const raw = publicKey.export({ format: "jwk" }).x as string; // base64url 原始公钥
		id = { serverId: randomUUID(), publicKey: raw, privatePem: privateKey.export({ format: "pem", type: "pkcs8" }) as string };
		setSetting("identity", id);
	}
	cache = id;
	return id;
}
export function signText(text: string): string {
	return sign(null, Buffer.from(text), createPrivateKey(identity().privatePem)).toString("base64url");
}
export const publicKeyObject = () => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: identity().publicKey }, format: "jwk" });
/** Rendezvous 记录的签名内容（Worker 与 PWA 用同样的格式校验）。 */
export const registrationMessage = (serverId: string, url: string, ts: number) => `pia-rendezvous-v1\n${serverId}\n${url}\n${ts}`;
