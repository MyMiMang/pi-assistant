/**
 * 识图扩展（Pi 扩展）：
 *  - look_at_image：看工作区里的图片（当前模型能看图就直接给它看，不能就交给识图模型，返回文字描述）
 *  - 当前模型不支持图片时，read 读到的图片自动换成识图模型的文字描述（否则模型只会收到“图片已省略”）
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import { describeImages, loadImage, supportsVision, type ModelRef } from "./vision.ts";

type ImageBlock = { type: "image"; data: string; mimeType: string };
type Block = { type: "text"; text: string } | ImageBlock;

export function visionExtension(o: { workspace: string; model: () => ModelRef | null; hostAccess?: () => boolean; onUsage?: (u: { provider: string; model: string; input: number; output: number }) => void }) {
	const hostAccess = () => o.hostAccess?.() ?? false;
	/** 识图模型也是一次真实调用：有公开 usage 就记进用量（不碰凭据）。 */
	const reportUsage = (r: { ok: boolean; model?: ModelRef; usage?: { input: number; output: number } }) => {
		if (r.ok && r.usage && r.model) o.onUsage?.({ provider: r.model.provider, model: r.model.id, ...r.usage });
	};
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
				`看${hostAccess() ? "工作区或用户电脑上的" : "工作区里的"}图片并回答问题（一次最多 8 张）。当前模型不支持看图时，会自动交给设置里的识图模型，返回文字描述。发图片给用户之前，用它确认每张图确实符合用户要的内容；不相关的不要发。`,
			promptSnippet: "look_at_image: 看图片（不支持识图的模型也能用）",
			parameters: Type.Object({
				paths: Type.Array(Type.String(), { description: hostAccess() ? "图片路径（工作区或用户电脑上的绝对路径）" : "工作区里的图片路径", minItems: 1, maxItems: 8 }),
				question: Type.Optional(Type.String({ description: "想确认什么，例如“是不是 2008 年穿越火线的游戏截图”" })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id: string, params: { paths: string[]; question?: string }, signal?: AbortSignal) {
				try {
					const imgs = params.paths.slice(0, 8).map((p) => ({ ...loadImage(inWs(p)), label: p }));
					if (supportsVision(o.model()))
						return { content: [{ type: "text", text: `以下是 ${imgs.length} 张图片（按顺序：${params.paths.join("、")}）。${params.question ? `请据此判断：${params.question}` : ""}` }, ...imgs.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))], details: undefined };
					const r = await describeImages(imgs, params.question, signal);
					reportUsage(r);
					return { content: [{ type: "text", text: r.ok ? `识图模型（${r.model?.provider}/${r.model?.id}）的描述：\n${r.text}` : r.text }], details: undefined, isError: !r.ok };
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
			const r = await describeImages(imgs.map((x) => ({ data: x.data, mimeType: x.mimeType, label: String(e.input?.path ?? "") })));
			reportUsage(r);
			const note = r.ok ? `（当前模型不能直接看图，以下是识图模型 ${r.model?.provider}/${r.model?.id} 对这张图片的描述）\n${r.text}` : r.text;
			return { content: [...e.content.filter((c) => c.type !== "image"), { type: "text", text: note }] };
		});
	};
}
