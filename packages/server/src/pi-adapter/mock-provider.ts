/**
 * 本地测试用 Mock 模型（仅在 PIA_MOCK=1 时注册，绝不在正式版默认启用）。
 * 根据用户消息里的关键词，脚本化地演示：流式回复、调用工具、审批、文件交付、选项提问、后台任务。
 */
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { PiModels } from "./index.ts";

export const MOCK_PROVIDER = "mock";
export const MOCK_MODEL = "echo";

type Msg = { role: string; content: unknown; toolName?: string };
const textOf = (m: Msg) =>
	typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "";

function respond(messages: Msg[], systemPrompt = "") {
	const last = messages[messages.length - 1];
	// Pi 的上下文整理（compaction）请求：返回一段结构化摘要
	if (/context summarization assistant/i.test(systemPrompt) || textOf(last).startsWith("<conversation>"))
		return fauxAssistantMessage("## Goal\n用户在测试 Pi Assistant 的各项功能。\n\n## Progress\n- 已演示流式回复、文件、审批、后台任务等。\n\n## Next Steps\n- 继续按用户要求操作。");
	const lastUser = [...messages].reverse().find((m) => m.role === "user" && !/^(后台|定时)任务「/.test(textOf(m)));
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
			case "memory_remember":
				return fauxAssistantMessage(/没有记住/.test(out) ? `没能记住：${out}` : "好的，我记住了 ✅");
			case "memory_recall":
				return fauxAssistantMessage(`我在记忆里找到了这些：\n\n${out}`);
			case "routine_create":
				return fauxAssistantMessage(/没有批准|有误/.test(out) ? `好的，没有创建定时任务。（${out}）` : `定时任务设好了 ⏰\n\n${out}`);
			case "skill_save":
				return fauxAssistantMessage(`已经存成技能了 🧩 ${out}`);
			case "read":
				return fauxAssistantMessage(`我读完了这个文件，前 200 个字是：\n\n\`\`\`\n${out.slice(0, 200)}\n\`\`\``);
			default:
				if (/blocked|拒绝|denied/i.test(out)) return fauxAssistantMessage(`这个操作没有获得批准，我不会执行。\n\n> ${out.slice(0, 200)}`);
				return fauxAssistantMessage(`命令执行完成，输出如下：\n\n\`\`\`\n${out.slice(0, 1200)}\n\`\`\``);
		}
	}
	if (/^这是定时任务「/.test(u)) return fauxAssistantMessage("简报：1. 今天有 2 个待办；2. 下午 3 点有个会；3. 没有紧急事项。");
	const remember = u.match(/^记住[:：，,\s]*(.+)$/s);
	if (remember) return fauxAssistantMessage([fauxToolCall("memory_remember", { content: remember[1].trim(), kind: "fact", scope: "user" })]);
	if (/我叫什么|还记得我/.test(u)) {
		const mem = systemPrompt.match(/<memory>([\s\S]*?)<\/memory>/);
		return fauxAssistantMessage(mem ? `我记得这些关于你的事：\n${mem[1].split("\n").filter((l) => l.startsWith("- ")).join("\n")}` : "我的记忆里还没有关于你的信息。");
	}
	if (/搜.*记忆|回忆/.test(u)) return fauxAssistantMessage([fauxToolCall("memory_recall", { query: u.replace(/.*(搜|回忆)[^：:]*[：:]?/, "").trim() || "用户" })]);
	if (/存成技能/.test(u))
		return fauxAssistantMessage([fauxToolCall("skill_save", { name: "daily-brief", description: "生成每日简报：汇总待办、日程和要闻。用户要“简报/今日概览”时使用。", body: "# 每日简报\n\n1. 列出今天的待办（最多 5 条）。\n2. 汇总日程。\n3. 用三句话总结。" })]);
	if (/每天|定时/.test(u))
		return fauxAssistantMessage([fauxText("好，我来设一个定时任务。"), fauxToolCall("routine_create", { name: "每日简报", prompt: "整理今天的待办和日程，给我一份三条以内的简短简报。", trigger: "cron", cron: "0 8 * * *" })]);
	if (/服务刚刚重启/.test(u)) return fauxAssistantMessage("我检查了一下进度：服务重启时上一轮命令被中断了。工作区里的文件都还在，需要的话再说一声我就重新执行。");
	if (/后台/.test(u) && !/统计工作区/.test(u))
		return fauxAssistantMessage([fauxToolCall("spawn_task", { title: "统计工作区文件", instructions: "统计工作区文件：列出工作区所有文件并统计数量，给出简短总结。" })]);
	if (/统计工作区/.test(u)) return fauxAssistantMessage([fauxText("好，我先统计一下工作区。"), fauxToolCall("bash", { command: "sleep 2; echo 文件数: $(find . -type f | wc -l); ls -la" })]);
	if (/删除|审批/.test(u)) return fauxAssistantMessage([fauxToolCall("bash", { command: "rm -f old-notes.txt && echo 已删除 old-notes.txt" })]);
	if (/报告|文件/.test(u) && !/附件|上传/.test(u))
		return fauxAssistantMessage([
			fauxText("好，我来写一份报告。"),
			fauxToolCall("write", {
				path: "report.md",
				content: `# 测试报告\n\n生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n| 项目 | 状态 |\n|---|---|\n| 流式回复 | ✅ |\n| 文件交付 | ✅ |\n`,
			}),
		]);
	if (/问我|选择|选项/.test(u))
		return fauxAssistantMessage([fauxToolCall("ask_user", { question: "你今天想先处理哪件事？", options: ["整理邮件", "写周报", "看看代码"], allowFreeText: true })]);
	const att = u.match(/\[附件: ([^\]]+)\]/);
	if (att) return fauxAssistantMessage([fauxText("收到文件，我先读一下。"), fauxToolCall("read", { path: att[1] })]);
	if (/命令|代码|python/i.test(u))
		return fauxAssistantMessage([fauxText("好，我在工作区里跑一下。"), fauxToolCall("bash", { command: "python3 -c \"print(sum(range(101)))\" 2>/dev/null || node -e \"console.log(5050)\"; uname -s; pwd" })]);
	return fauxAssistantMessage(
		`好的，收到！我是本地 **Mock 模型**，用于在没有 API Key 的情况下测试。\n\n你说的是：「${u}」\n\n可以试试这些关键词：\n- **报告**：生成文件并发给你\n- **删除**：触发审批卡片\n- **问我**：弹出选项按钮\n- **后台**：创建后台任务\n- **命令**：在工作区里跑代码\n\n\`\`\`ts\nconst hello = "世界";\nconsole.log(\`你好，\${hello}\`);\n\`\`\``,
	);
}

export async function registerMockProvider(models: PiModels) {
	const faux = registerFauxProvider({ provider: MOCK_PROVIDER, models: [{ id: MOCK_MODEL, name: "Mock 模型（本地测试）" }], tokensPerSecond: 60 });
	const step = (ctx: { messages: Msg[]; systemPrompt?: string }) => {
		faux.appendResponses([step as never]);
		return respond(ctx.messages, ctx.systemPrompt ?? "");
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
