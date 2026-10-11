/**
 * 本地测试用 Mock 模型（仅在 PIA_MOCK=1 时注册，绝不在正式版默认启用）。
 * 根据用户消息里的关键词，脚本化地演示：流式回复、调用工具、审批、文件交付、选项提问、后台任务。
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { PiModels } from "./index.ts";

export const MOCK_PROVIDER = "mock";
export const MOCK_MODEL = "echo";

type Msg = { role: string; content: unknown; toolName?: string };
const textOf = (m: Msg) =>
	typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "";

function respond(messages: Msg[]) {
	const last = messages[messages.length - 1];
	const lastUser = [...messages].reverse().find((m) => m.role === "user" && !textOf(m).startsWith("后台任务「"));
	const u = lastUser ? textOf(lastUser) : "";
	if (last.role === "toolResult") {
		const out = textOf(last);
		switch (last.toolName) {
			case "write":
				return fauxAssistantMessage([fauxToolCall("deliver_file", { path: "report.md", caption: "这是你要的报告" })]);
			case "deliver_file":
				return fauxAssistantMessage("报告已经生成并发给你了 📄，点上面的附件就能下载。");
			case "ask_user":
				return fauxAssistantMessage(`好的，${out.replace("用户回答：", "你选了「")}」，我记下了。`);
			case "spawn_task":
				return fauxAssistantMessage("好的，这个任务已经放到后台执行了，你可以继续跟我聊别的，完成后我会通知你。");
			case "read":
				return fauxAssistantMessage(`我读完了这个文件，前 200 个字是：\n\n\`\`\`\n${out.slice(0, 200)}\n\`\`\``);
			default:
				if (/blocked|拒绝|denied/i.test(out)) return fauxAssistantMessage(`这个操作没有获得批准，我不会执行。\n\n> ${out.slice(0, 200)}`);
				return fauxAssistantMessage(`命令执行完成，输出如下：\n\n\`\`\`\n${out.slice(0, 1200)}\n\`\`\``);
		}
	}
	if (/服务刚刚重启/.test(u)) return fauxAssistantMessage("我检查了一下进度：服务重启时上一轮命令被中断了。工作区里的文件都还在，需要的话再说一声我就重新执行。");
	if (/后台/.test(u) && !/统计工作区/.test(u))
		return fauxAssistantMessage([fauxToolCall("spawn_task", { title: "统计工作区文件", instructions: "统计工作区文件：列出工作区所有文件并统计数量，给出简短总结。" })]);
	if (/统计工作区/.test(u)) return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2; echo 文件数: $(find . -type f | wc -l); ls -la" })]);
	if (/删除|审批/.test(u)) return fauxAssistantMessage([fauxToolCall("bash", { command: "rm -f old-notes.txt && echo 已删除 old-notes.txt" })]);
	if (/报告|文件/.test(u) && !/附件|上传/.test(u))
		return fauxAssistantMessage([
			fauxToolCall("write", {
				path: "report.md",
				content: `# 测试报告\n\n生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n| 项目 | 状态 |\n|---|---|\n| 流式回复 | ✅ |\n| 文件交付 | ✅ |\n`,
			}),
		]);
	if (/问我|选择|选项/.test(u))
		return fauxAssistantMessage([fauxToolCall("ask_user", { question: "你今天想先处理哪件事？", options: ["整理邮件", "写周报", "看看代码"], allowFreeText: true })]);
	const att = u.match(/\[附件: ([^\]]+)\]/);
	if (att) return fauxAssistantMessage([fauxToolCall("read", { path: att[1] })]);
	if (/命令|代码|python/i.test(u))
		return fauxAssistantMessage([fauxToolCall("bash", { command: "python3 -c \"print(sum(range(101)))\" 2>/dev/null || node -e \"console.log(5050)\"; uname -s; pwd" })]);
	return fauxAssistantMessage(
		`好的，收到！我是本地 **Mock 模型**，用于在没有 API Key 的情况下测试。\n\n你说的是：「${u}」\n\n可以试试这些关键词：\n- **报告**：生成文件并发给你\n- **删除**：触发审批卡片\n- **问我**：弹出选项按钮\n- **后台**：创建后台任务\n- **命令**：在工作区里跑代码\n\n\`\`\`ts\nconst hello = "世界";\nconsole.log(\`你好，\${hello}\`);\n\`\`\``,
	);
}

export async function registerMockProvider(models: PiModels) {
	const faux = registerFauxProvider({ provider: MOCK_PROVIDER, models: [{ id: MOCK_MODEL, name: "Mock 模型（本地测试）" }], tokensPerSecond: 60 });
	const step = (ctx: { messages: Msg[] }) => {
		faux.appendResponses([step as never]);
		return respond(ctx.messages);
	};
	faux.setResponses([step as never]);
	const m = faux.getModel();
	models.registerProvider(MOCK_PROVIDER, {
		baseUrl: m.baseUrl,
		api: m.api,
		models: [{ id: m.id, name: m.name, api: m.api, reasoning: false, input: ["text"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl }],
	});
	await models.setRuntimeApiKey(MOCK_PROVIDER, "mock");
}
