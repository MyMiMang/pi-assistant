/** 极简 zip 读取（只为导入宠物包）：支持“存储”和“deflate”两种压缩方式，用浏览器自带的 DecompressionStream 解压 */
export async function readZip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
	const v = new DataView(buf);
	const u8 = new Uint8Array(buf);
	let eocd = -1;
	for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_557); i--)
		if (v.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) throw new Error("不是有效的 zip 文件");
	const count = v.getUint16(eocd + 10, true);
	let p = v.getUint32(eocd + 16, true);
	const out = new Map<string, Uint8Array>();
	const dec = new TextDecoder();
	for (let n = 0; n < count; n++) {
		if (v.getUint32(p, true) !== 0x02014b50) throw new Error("zip 目录损坏");
		const method = v.getUint16(p + 10, true);
		const csize = v.getUint32(p + 20, true);
		const nameLen = v.getUint16(p + 28, true);
		const extraLen = v.getUint16(p + 30, true);
		const commentLen = v.getUint16(p + 32, true);
		const local = v.getUint32(p + 42, true);
		const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
		p += 46 + nameLen + extraLen + commentLen;
		if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
		const lnl = v.getUint16(local + 26, true);
		const lel = v.getUint16(local + 28, true);
		const start = local + 30 + lnl + lel;
		const raw = u8.subarray(start, start + csize);
		if (method === 0) out.set(name, raw.slice());
		else if (method === 8) out.set(name, new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()));
	}
	return out;
}
