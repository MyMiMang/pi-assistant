/**
 * 出站媒体：按渠道能力决定一份文件怎么发——
 *  图片（格式/大小合适）→ 原生图片消息；格式不支持或太大 → 尝试转成 JPEG（macOS 用 sips，其它用 ffmpeg）；
 *  GIF 平台不支持 → 改发文件保留动画（不能发文件就取第一帧转 JPEG）；
 *  其它文件 → 文件消息；平台不支持 / 超限 → 下载链接（配置了固定地址时）或明确提示“请在 App 里查看”。
 */
import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.ts";
import type { ChannelCaps } from "./caps.ts";

const run = promisify(execFile);
export interface Prepared {
	as: "image" | "file" | "none";
	path: string;
	name: string;
	/** 改了发送方式时给用户的说明（例如“图片太大，已压缩”） */
	note?: string;
	cleanup(): void;
}
const ext = (n: string) => extname(n).slice(1).toLowerCase();
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "heic", "heif", "svg", "ico", "avif"]);
export const isImageName = (n: string) => IMAGE_EXT.has(ext(n));

/** 转成 JPEG（长边 ≤ maxSide）；可替换（测试用） */
export let toJpeg = async (src: string, out: string, maxSide = 2560): Promise<boolean> => {
	try {
		if (process.platform === "darwin") await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", String(maxSide), src, "--out", out], { timeout: 60_000 });
		else await run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-frames:v", "1", "-vf", `scale='min(${maxSide},iw)':-2`, "-q:v", "4", out], { timeout: 60_000 });
		return existsSync(out) && statSync(out).size > 0;
	} catch {
		return false;
	}
};
export function setJpegConverter(f: typeof toJpeg) {
	toJpeg = f;
}

export async function prepareMedia(path: string, name: string, caps: ChannelCaps): Promise<Prepared> {
	const size = statSync(path).size;
	const e = ext(name);
	const noop = () => {};
	const asFile = (note?: string): Prepared => (caps.file && size <= caps.file.maxBytes ? { as: "file", path, name, note, cleanup: noop } : { as: "none", path, name, note, cleanup: noop });
	if (!isImageName(name) || !caps.image) return asFile();
	const img = caps.image;
	if (img.exts.includes(e) && size <= img.maxBytes) return { as: "image", path, name, cleanup: noop };
	// GIF：保留动画优先（发文件），否则取第一帧
	if (e === "gif" && caps.file && size <= caps.file.maxBytes) return asFile("（动图以文件形式发送）");
	const dir = mkdtempSync(join(tmpdir(), "pia-img-"));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	const outName = `${basename(name, extname(name)) || "image"}.jpg`;
	const out = join(dir, outName);
	for (const side of [2560, 1600, 1024]) {
		if ((await toJpeg(path, out, side)) && statSync(out).size <= img.maxBytes) return { as: "image", path: out, name: outName, note: img.exts.includes(e) ? "（图片较大，已压缩）" : undefined, cleanup };
	}
	cleanup();
	return asFile();
}

// ---------------------------------------------------------------- 下载链接（固定地址）
let key: Buffer | null = null;
function dlKey() {
	if (key) return key;
	const f = join(config.dataDir, "download-link.key");
	if (!existsSync(f)) (mkdirSync(config.dataDir, { recursive: true }), writeFileSync(f, randomBytes(32), { mode: 0o600 }));
	key = readFileSync(f);
	return key;
}
const sig = (id: string, exp: number) => createHmac("sha256", dlKey()).update(`${id}.${exp}`).digest("base64url").slice(0, 32);
/** 签名的公开下载路径（默认 7 天有效） */
export function signedPath(fileId: string, ttlMs = 7 * 86400_000, t = Date.now()) {
	const exp = Math.floor((t + ttlMs) / 1000);
	return `/hooks/dl/${encodeURIComponent(fileId)}/${exp}/${sig(fileId, exp)}`;
}
export function verifySigned(fileId: string, exp: string, s: string, t = Date.now()) {
	const n = Number(exp);
	if (!Number.isFinite(n) || n * 1000 < t) return false;
	const want = sig(fileId, n);
	return want.length === s.length && createHmac("sha256", "x").update(want).digest().equals(createHmac("sha256", "x").update(s).digest());
}
