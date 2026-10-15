/**
 * 识图扩展（Pi 扩展）：
 *  - look_at_image：看工作区里的图片。**只跟随当前对话/会话模型**：模型能看图就直接给它看；
 *    不能看图就明确说明并引导用户换一个支持图片的模型，绝不静默改用别的模型（避免额外云费用）。
 *  - 当前模型不支持图片时，read 读到的图片换成明确提示（否则模型只会收到“图片已省略”）。
 *
 * 事实来源是 Pi 公开模型元数据 `input` 含 `image`（见 vision.ts supportsVision）。
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import { loadImage, supportsVision, visionUnsupportedMessage, type ModelRef } from "./vision.ts";

type ImageBlock = { type: "image"; data: string; mimeType: string };
type Block = { type: "text"; text: string } | ImageBlock;

export function visionExtension(o: { workspace: string; model: () => ModelRef | null; hostAccess?: () => boolean }) {
	const hostAccess = () => o.hostAccess?.() ?? false;
	const inWs = (p: string) => {
		let abs = isAbsolute(p) ? p : resolve(o.workspace, p);
		// Docker 沙盒里的 /workspace/... 映射回本机工作区
		if (!existsSync(abs) && p.startsWith("/workspace/")) abs = resolve(o.workspace, p.slice("/workspace/".length));
		if (hostAccess()) return abs; // 完全权限：用户主机上的图片也能看
		const rel = relative(o.workspace, abs);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`只能看工作区里的图片：${p}`);
		return abs;
	};
	return (pi: { registerTool(t: unknown): void; on(ev: string, h: (e: unknown) => unknown): void }) => {
		pi.registerTool({
			name: "look_at_image",
			label: "看图片",
			description:
				`看${hostAccess() ? "工作区或用户电脑上的" : "工作区里的"}图片并回答问题（一次最多 8 张）。` +
				`只跟随当前对话模型：模型支持看图就直接看；不支持时明确提示用户换一个支持图片的模型，不会自动改用别的模型。` +
				`发图片给用户之前，用它确认每张图确实符合用户要的内容；不相关的不要发。`,
			promptSnippet: "look_at_image: 看图片（当前模型支持图片时可用）",
			parameters: Type.Object({
				paths: Type.Array(Type.String(), { description: hostAccess() ? "图片路径（工作区或用户电脑上的绝对路径）" : "工作区里的图片路径", minItems: 1, maxItems: 8 }),
				question: Type.Optional(Type.String({ description: "想确认什么，例如“是不是 2008 年穿越火线的游戏截图”" })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id: string, params: { paths: string[]; question?: string }) {
				try {
					const imgs = params.paths.slice(0, 8).map((p) => ({ ...loadImage(inWs(p)), label: p }));
					const model = o.model();
					if (!supportsVision(model))
						return { content: [{ type: "text", text: visionUnsupportedMessage(model) }], details: undefined, isError: true };
					return { content: [{ type: "text", text: `以下是 ${imgs.length} 张图片（按顺序：${params.paths.join("、")}）。${params.question ? `请据此判断：${params.question}` : ""}` }, ...imgs.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))], details: undefined };
				} catch (e) {
					return { content: [{ type: "text", text: `失败：${e instanceof Error ? e.message : String(e)}` }], details: undefined, isError: true };
				}
			},
		});
		pi.on("tool_result", async (ev) => {
			const e = ev as { toolName: string; input: Record<string, unknown>; content: Block[]; isError: boolean };
			if (e.toolName !== "read" || e.isError || supportsVision(o.model())) return;
			const imgs = (e.content ?? []).filter((c): c is ImageBlock => c.type === "image");
			if (!imgs.length) return;
			// 只提示、不调用别的模型：图片内容本身不进上下文。
			return { content: [...e.content.filter((c) => c.type !== "image"), { type: "text", text: visionUnsupportedMessage(o.model()) }] };
		});
	};
}
