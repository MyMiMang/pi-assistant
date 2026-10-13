/** Pi 扩展：generate_image 工具（只在助理有可用的图片模型时挂上） */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateForAgent, imageModelFor, labelOf, getProvider } from "./index.ts";
import { costNote, ImageGenError, supportsEdit } from "./providers.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function imageExtensions(agentId: string, conversationId: string | null, taskId: string | null) {
	const ref = imageModelFor(agentId);
	if (!ref) return [];
	const p = getProvider(ref.provider);
	const edit = p ? supportsEdit(p.kind, ref.model) : false;
	const cost = costNote(ref.model);
	return [
		{
			name: "pia-image",
			factory: (pi: ExtensionAPI) => {
				pi.registerTool({
					name: "generate_image",
					label: "生成图片",
					description:
						`用图片生成模型（${labelOf(ref)}）画图${edit ? "或按参考图修改图片" : ""}。` +
						"只在用户明确想要一张图片（画图、出图、做海报 / 头像 / 插画、改图、换背景等）时使用；用户只是聊天、问问题、要文字或代码时不要调用。" +
						"生成的图片会自动存进工作区 images/ 并直接显示在聊天里，不需要再调用 deliver_file。" +
						"prompt 写成具体的画面描述（主体、风格、构图、光线、文字内容），用户用什么语言就用什么语言。" +
						(edit ? "改图 / 参考图：把工作区里的图片路径（例如用户上传的 uploads/xxx.png）放进 input_images。" : "这个模型不支持输入图片，只能文生图。") +
						(cost ? ` 每张${cost}，没必要不要一次生成多张。` : ""),
					promptSnippet: "generate_image: 用户想要图片时画图 / 改图（图片自动发到聊天）",
					parameters: Type.Object({
						prompt: Type.String({ description: "画面描述；改图时写要怎么改" }),
						aspect_ratio: Type.Optional(Type.String({ description: "画面比例：1:1、16:9、9:16、4:3、3:4、3:2、2:3（默认 1:1 或模型默认）" })),
						size: Type.Optional(Type.String({ description: "精确尺寸，如 1024x1024；一般不填，用 aspect_ratio" })),
						count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "生成几张，默认 1" })),
						quality: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("auto")], { description: "质量（只有部分模型支持）" })),
						...(edit ? { input_images: Type.Optional(Type.Array(Type.String(), { description: "工作区里的输入 / 参考图片路径" })) } : {}),
						filename: Type.Optional(Type.String({ description: "文件名（不含扩展名），默认按描述生成" })),
					}),
					annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
					async execute(_id: string, args: Record<string, unknown>, signal?: AbortSignal) {
						try {
							const r = await generateForAgent(agentId, conversationId, taskId, args as never, signal);
							return text(
								[
									`已生成 ${r.saved.length} 张图片（${labelOf(r.ref)}，用时 ${Math.round(r.ms / 1000)} 秒），已显示在聊天里：`,
									...r.saved.map((s) => `- ${s}`),
									r.revisedPrompt ? `服务商改写后的描述：${r.revisedPrompt.slice(0, 400)}` : "",
									r.text ? `模型附言：${r.text.slice(0, 400)}` : "",
									r.cost ? `参考费用：${r.cost}（以服务商为准）` : "",
									"不用再发送文件，简短告诉用户图已经画好、可以怎么调整即可。",
								]
									.filter(Boolean)
									.join("\n"),
							);
						} catch (e) {
							const err = e instanceof ImageGenError ? e : new ImageGenError("server", e instanceof Error ? e.message : String(e));
							throw new Error(`生成图片失败：${err.message}\n详情：${err.detail}${err.code === "policy" ? "\n（安全策略拦截：换一种描述再试，不要原样重试）" : err.code === "auth" || err.code === "model" ? "\n（请用户到 设置 › 模型 › 图片生成 检查配置，不要重试）" : ""}`);
						}
					},
				} as never);
			},
		},
	];
}
