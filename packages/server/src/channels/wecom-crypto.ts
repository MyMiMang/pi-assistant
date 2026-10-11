/**
 * 企业微信回调加解密（官方文档“加解密方案说明”）：
 *  msg_signature = sha1(sort([token, timestamp, nonce, encrypt]).join(""))
 *  AESKey = base64(EncodingAESKey + "=")（32 字节），IV = AESKey 前 16 字节，AES-256-CBC，PKCS#7（块大小 32）
 *  明文 = 16 字节随机串 + 4 字节网络序长度 + 消息 + ReceiveId（企业 ID）
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string) {
	return createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
}
const keyOf = (aesKey: string) => {
	const k = Buffer.from(`${aesKey}=`, "base64");
	if (k.length !== 32) throw new Error("EncodingAESKey 应为 43 位");
	return k;
};
export function wecomDecrypt(aesKey: string, encrypt: string): { message: string; receiveId: string } {
	const key = keyOf(aesKey);
	const d = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
	d.setAutoPadding(false);
	let buf = Buffer.concat([d.update(encrypt, "base64"), d.final()]);
	const pad = buf[buf.length - 1];
	if (pad < 1 || pad > 32) throw new Error("解密失败（填充错误）");
	buf = buf.subarray(0, buf.length - pad);
	const len = buf.readUInt32BE(16);
	return { message: buf.subarray(20, 20 + len).toString("utf8"), receiveId: buf.subarray(20 + len).toString("utf8") };
}
export function wecomEncrypt(aesKey: string, message: string, receiveId: string): string {
	const key = keyOf(aesKey);
	const msg = Buffer.from(message, "utf8");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(msg.length);
	let buf = Buffer.concat([randomBytes(16), len, msg, Buffer.from(receiveId, "utf8")]);
	const pad = 32 - (buf.length % 32);
	buf = Buffer.concat([buf, Buffer.alloc(pad, pad)]);
	const c = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
	c.setAutoPadding(false);
	return Buffer.concat([c.update(buf), c.final()]).toString("base64");
}
/** 极简 XML 取值（企业微信回调是扁平 XML，值多用 CDATA） */
export function xmlValue(xml: string, tag: string): string | undefined {
	const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`).exec(xml);
	return m ? (m[1] ?? m[2]) : undefined;
}
