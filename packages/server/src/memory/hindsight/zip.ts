/** 极简 ZIP 读取（只解 stored / deflate），用于 uv wheel、flashrank 模型包；不引第三方依赖 */
import { inflateRawSync } from "node:zlib";

export function readZip(buf: Buffer): { name: string; data: () => Buffer }[] {
	// 找中央目录结束记录（EOCD）
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) throw new Error("不是有效的 zip 文件");
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const out: { name: string; data: () => Buffer }[] = [];
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 中央目录损坏");
		const method = buf.readUInt16LE(p + 10);
		const csize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const local = buf.readUInt32LE(p + 42);
		const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
		p += 46 + nameLen + extraLen + commentLen;
		out.push({
			name,
			data: () => {
				const ln = buf.readUInt16LE(local + 26);
				const le = buf.readUInt16LE(local + 28);
				const start = local + 30 + ln + le;
				const raw = buf.subarray(start, start + csize);
				if (method === 0) return Buffer.from(raw);
				if (method === 8) return inflateRawSync(raw);
				throw new Error(`不支持的 zip 压缩方式 ${method}`);
			},
		});
	}
	return out;
}
