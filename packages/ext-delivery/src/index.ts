/**
 * @pi-assistant/ext-delivery —— 交付与协作工具（Pi 扩展）：
 *  deliver_file：把工作区文件作为附件发回聊天
 *  ask_user：在聊天里弹出带选项按钮的问题卡片，等待用户回答
 *  spawn_task：把耗时工作放到后台任务里执行
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface DeliveryHost {
	deliverFile(path: string, caption?: string): Promise<{ fileId: string; name: string }>;
	ask(question: string, options: string[], allowFreeText: boolean): Promise<string>;
	spawnTask?(title: string, instructions: string): Promise<{ taskId: string }>;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function deliveryExtension(host: DeliveryHost) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "deliver_file",
			label: "发送文件",
			description: "把工作区里的文件（报告、图片、表格、代码等）作为附件发给用户。生成文件后必须调用它，用户才能看到/下载。",
			promptSnippet: "deliver_file: 把工作区文件作为附件发给用户",
			parameters: Type.Object({
				path: Type.String({ description: "工作区内的文件路径" }),
				caption: Type.Optional(Type.String({ description: "附带的一句说明" })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const r = await host.deliverFile(p.path, p.caption);
				return text(`已把 ${r.name} 发送给用户（文件 ID ${r.fileId}）。`);
			},
		});
		pi.registerTool({
			name: "ask_user",
			label: "询问用户",
			description: "当需要用户做选择或确认信息时，用它在聊天里显示一个带选项按钮的问题卡片，并等待回答。不要用它请求执行危险操作的许可（那由系统自动审批）。",
			promptSnippet: "ask_user: 用选项按钮向用户提问并等待回答",
			parameters: Type.Object({
				question: Type.String(),
				options: Type.Array(Type.String(), { description: "2–5 个简短选项" }),
				allowFreeText: Type.Optional(Type.Boolean()),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const answer = await host.ask(p.question, p.options, p.allowFreeText ?? true);
				return text(`用户回答：${answer}`);
			},
		});
		if (host.spawnTask) {
			const spawn = host.spawnTask;
			pi.registerTool({
				name: "spawn_task",
				label: "后台任务",
				description: "把耗时较长的工作（超过一两分钟）放到后台执行，用户可以继续聊别的；完成后会通知用户并把结果告诉你。",
				promptSnippet: "spawn_task: 把耗时工作放到后台执行",
				parameters: Type.Object({
					title: Type.String({ description: "简短的任务标题" }),
					instructions: Type.String({ description: "完整、自包含的执行说明" }),
				}),
				annotations: { readOnlyHint: true },
				async execute(_id, p) {
					const r = await spawn(p.title, p.instructions);
					return text(`后台任务已创建（${r.taskId}）：${p.title}。完成后系统会通知。现在先简短告诉用户任务已经在后台进行。`);
				},
			});
		}
	};
}
