/**
 * 主题参考图：把用户上传的**附件 id** 解析成服务端可信的图片引用。
 *
 * 安全边界（与 packages/shared/theme-manifest.ts 的图片规则一致）：
 *  - 只认附件表里的 opaque id：先按 id 查 `files` 行，**校验 canonical owner（agent_id）**，
 *    再读服务端登记过的 stored_path。绝不接受客户端给的任意 attachmentId / remote URL / 绝对路径，
 *    因此读不到别人的文件、也读不到用户凭据。
 *  - **sniff 真实 magic bytes** 决定 MIME / 尺寸，不信任客户端声明的 mime；拒 SVG / 非图片 / 伪装文件。
 *  - 张数、字节数、像素总量都有上限（MANIFEST_LIMITS）。
 *  - 返回的是**引用 + 元数据**（无 base64）；只有发给模型时才另生成 image block。
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { MANIFEST_LIMITS, type ThemeError, type ThemeImageRef } from "@pi-assistant/shared";
import { toImagePart, type ImagePart } from "../attachments.ts";
import { getFile, type FileRow } from "../files.ts";

export interface ResolvedThemeImages {
	/** 通过校验、写进 manifest 的规范引用（mime / 尺寸 / 字节数 / sha256 都由服务端算）。 */
	refs: ThemeImageRef[];
	/** 发给支持视觉的模型的图片块。 */
	parts: ImagePart[];
	errors: ThemeError[];
}

const imgErr = (path: string, message: string, actual?: string): ThemeError => ({ path, code: "value", message, actual });

/** PNG：89 50 4E 47 0D 0A 1A 0A，IHDR 宽高在 16 / 20（大端）。 */
function sniffPng(b: Buffer): { mime: string; width: number; height: number } | null {
	if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
	return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** JPEG：FF D8 FF，扫 SOFn 段（C0..CF，跳过 C4/C8/CC）拿高 / 宽。 */
function sniffJpeg(b: Buffer): { mime: string; width: number; height: number } | null {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) {
			i++;
			continue;
		}
		const marker = b[i + 1];
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		const len = b.readUInt16BE(i + 2);
		if (len < 2) return null;
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { mime: "image/jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
		}
		i += 2 + len;
	}
	return null;
}

/** GIF：GIF87a / GIF89a，宽高在 6 / 8（小端）。 */
function sniffGif(b: Buffer): { mime: string; width: number; height: number } | null {
	if (b.length < 10) return null;
	const sig = b.toString("ascii", 0, 6);
	if (sig !== "GIF87a" && sig !== "GIF89a") return null;
	return { mime: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

/** WebP：RIFF....WEBP，支持 VP8X / VP8 / VP8L 三种帧头。 */
function sniffWebp(b: Buffer): { mime: string; width: number; height: number } | null {
	if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
	const fourcc = b.toString("ascii", 12, 16);
	if (fourcc === "VP8X") {
		const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
		const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
		return { mime: "image/webp", width: w, height: h };
	}
	if (fourcc === "VP8 ") {
		if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
		return { mime: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
	}
	if (fourcc === "VP8L") {
		if (b[20] !== 0x2f) return null;
		const bits = b.readUInt32LE(21);
		return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	return null;
}

/** 按 magic bytes 判定图片类型与真实尺寸；非图片 / SVG / 伪装一律返回 null。 */
export function sniffImage(bytes: Buffer): { mime: string; width: number; height: number } | null {
	return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffGif(bytes) ?? sniffWebp(bytes);
}

/**
 * 解析并校验用户这轮附带的参考图。任何一张不合格都 fail-closed（整批拒绝），
 * 因为「悄悄少一张图」会让模型看到与用户预期不同的输入。
 * 同时给出缩小后的图片块（复用聊天附件的同一实现）。
 */
export async function resolveThemeImages(agentId: string, input: ThemeImageRef[] | undefined): Promise<ResolvedThemeImages> {
	const refs: ThemeImageRef[] = [];
	const parts: ImagePart[] = [];
	const errors: ThemeError[] = [];
	if (!input?.length) return { refs, parts, errors };
	if (input.length > MANIFEST_LIMITS.imagesMax) {
		errors.push(imgErr("images", `参考图最多 ${MANIFEST_LIMITS.imagesMax} 张`, String(input.length)));
		return { refs, parts, errors };
	}
	const seen = new Set<string>();
	for (let i = 0; i < input.length; i++) {
		const p = `images[${i}]`;
		const raw = input[i];
		const id = typeof raw?.attachmentId === "string" ? raw.attachmentId.trim() : "";
		if (!id) {
			errors.push(imgErr(`${p}.attachmentId`, "缺少附件 id"));
			continue;
		}
		if (seen.has(id)) {
			errors.push(imgErr(`${p}.attachmentId`, "重复的附件引用", id));
			continue;
		}
		seen.add(id);
		const f: FileRow | undefined = getFile(id);
		if (!f) {
			errors.push(imgErr(`${p}.attachmentId`, "附件不存在", id));
			continue;
		}
		// canonical owner：主题属于某个助理，参考图必须是它自己的上传（跨助理 / 群附件一律拒绝）
		if (f.agent_id !== agentId) {
			errors.push(imgErr(`${p}.attachmentId`, "这个附件不属于当前助理，已拒绝（不能借别人的附件读文件）", id));
			continue;
		}
		let bytes: Buffer;
		let size: number;
		try {
			size = statSync(f.stored_path).size;
			if (size > MANIFEST_LIMITS.imageBytesMax) {
				errors.push(imgErr(`${p}.bytes`, `图片超过 ${Math.round(MANIFEST_LIMITS.imageBytesMax / 1024 / 1024)}MB`, String(size)));
				continue;
			}
			bytes = readFileSync(f.stored_path);
		} catch {
			errors.push(imgErr(p, "图片文件读不到", id));
			continue;
		}
		const sniffed = sniffImage(bytes);
		if (!sniffed) {
			errors.push(imgErr(p, "不是受支持的图片（png / jpeg / gif / webp；不接受 SVG）", f.mime));
			continue;
		}
		if (sniffed.width * sniffed.height > MANIFEST_LIMITS.imagePixelsMax) {
			errors.push(imgErr(p, `图片像素总量超限（≤ ${MANIFEST_LIMITS.imagePixelsMax}）`, `${sniffed.width}x${sniffed.height}`));
			continue;
		}
		const usage = raw.usage === "background" || raw.usage === "decor" ? raw.usage : "reference";
		const ref: ThemeImageRef = {
			attachmentId: id,
			usage,
			mime: sniffed.mime,
			width: sniffed.width,
			height: sniffed.height,
			bytes: size,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
		if (typeof raw.alt === "string" && raw.alt.trim() && raw.alt.length <= MANIFEST_LIMITS.altMax) ref.alt = raw.alt.trim();
		refs.push(ref);
		const part = await toImagePart(bytes, sniffed.mime);
		if (part) parts.push(part);
	}
	return { refs, parts, errors };
}
