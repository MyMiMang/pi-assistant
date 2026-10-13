/**
 * 本地测试用 Mock 模型（仅在 PIA_MOCK=1 时注册，绝不在正式版默认启用）。
 * 根据用户消息里的关键词，脚本化地演示：流式回复、调用工具、审批、文件交付、选项提问、后台任务。
 */
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { PiModels } from "./index.ts";

export const MOCK_PROVIDER = "mock";
export const MOCK_MODEL = "echo";
export const MOCK_REASONING_MODEL = "echo-think";

type Msg = { role: string; content: unknown; toolName?: string };
const textOf = (m: Msg) =>
	typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "";

const getSkillDesc = (_u: string) => "按月汇总表格数据（先按周分组）。用户说“月度汇总/按月统计”时使用。";

/** 模拟 Hindsight 需要的几类模型调用；不是 Hindsight 的请求返回 null */
type MockTool = { name: string; parameters?: { properties?: Record<string, { type?: string }>; required?: string[] } };
/** 按 JSON Schema 填一份最小参数 */
function fillArgs(t: MockTool, text: string) {
	const out: Record<string, unknown> = {};
	const props = t.parameters?.properties ?? {};
	for (const k of t.parameters?.required ?? []) {
		const ty = props[k]?.type;
		out[k] = ty === "array" ? [] : ty === "integer" || ty === "number" ? 0 : ty === "boolean" ? false : ty === "object" ? {} : text;
	}
	return out;
}
export function hindsightReply(messages: Msg[], systemPrompt: string, tools: MockTool[] = []): string | { tool: string; args: Record<string, unknown> } | null {
	const last = messages[messages.length - 1];
	// 反思（reflect）是带工具的多轮：先按要求调检索工具，拿到结果后调 done 给出回答
	if (/You MUST ONLY use information from retrieved tool results/.test(systemPrompt) && tools.length) {
		const q = textOf([...messages].reverse().find((m) => m.role === "user") ?? { role: "user", content: "" }).slice(0, 200);
		const done = tools.find((t) => t.name === "done");
		const searched = messages.filter((m) => m.role === "toolResult").length;
		if (done && searched >= 1) return { tool: "done", args: { ...fillArgs(done, "根据记忆：用户喜欢简洁的回答。"), answer: "根据记忆：用户喜欢简洁的回答。" } };
		const pick = tools.find((t) => t.name !== "done") ?? tools[0];
		return { tool: pick.name, args: { ...fillArgs(pick, q), query: q } };
	}
	const u = last ? textOf(last) : "";
	if (/^Say 'ok'/.test(u)) return "ok";
	// 事实抽取：把 Content 段按句子拆成事实
	if (/Extract SIGNIFICANT facts|Extract facts from the following chunk/.test(systemPrompt + u)) {
		const content = (u.split(/\nContent:\n/)[1] ?? u).trim();
		const facts = content
			.split(/[。！？!?\n]+/)
			.map((x) => x.trim())
			.filter((x) => x.length >= 2)
			.slice(0, 5)
			.map((what) => ({ what, when: "N/A", where: "N/A", who: "N/A", why: "N/A", fact_kind: "conversation", fact_type: "world", entities: [] }));
		return JSON.stringify({ facts });
	}
	// 网关在要求 JSON 输出时会加这句提示（见 llm-proxy.ts）
	if (/只输出一个(合法的|符合下面) JSON/.test(systemPrompt)) return "{}";
	return null;
}

function respond(messages: Msg[], systemPrompt = "") {
	const last = messages[messages.length - 1];
	// Pi 的上下文整理（compaction）请求：返回一段结构化摘要
	if (/context summarization assistant/i.test(systemPrompt) || textOf(last).startsWith("<conversation>"))
		return fauxAssistantMessage("## Goal\n用户在测试 Pi Assistant 的各项功能。\n\n## Progress\n- 已演示流式回复、文件、审批、后台任务等。\n\n## Next Steps\n- 继续按用户要求操作。");
	const lastUser = [...messages].reverse().find((m) => m.role === "user" && !/^(后台|定时)任务「/.test(textOf(m)));
	// 渠道消息前面的［渠道：…］说明不算用户说的话（否则里面的“文件 / 图片”会触发关键词）
	const u = lastUser ? textOf(lastUser).replace(/^［渠道：[^］]*］\n?/, "") : "";
	// 群聊（rooms）：按群消息里的提示脚本化地扮演管理者 / 成员
	if (u.startsWith("（群聊「")) return roomReply(u, systemPrompt, last, messages);
	// 提议建群：用户说“组个团队/建个群…”
	if (/组个团队|建个群/.test(u)) {
		if (last.role === "toolResult") return fauxAssistantMessage("我按你的目标设计了一个小团队，看看卡片，改好了点“确认创建”。");
		return fauxAssistantMessage([
			fauxToolCall("propose_room", {
				name: "新品发布小组",
				purpose: "目标：完成新品发布的文案和海报。管理者拆分任务，成员各自交付。",
				manager: 0,
				members: [
					{ name: "统筹", role: "拆分任务、汇总", persona: "你负责统筹。", model: "mock/echo-think", modelReason: "需要推理" },
					{ name: "文案", role: "写发布文案", persona: "你负责写文案。", model: "mock/echo", modelReason: "简单任务用便宜的" },
				],
			}),
		]);
	}
	// 主动性：巡检时看“用户最近说过的话”，有就提醒一件；用户说“晚点再看”就约跟进
	if (/这是(一次主动巡检|你约好的跟进|每日简报)/.test(u)) {
		if (last.role === "toolResult") return fauxAssistantMessage(`巡检完成：${textOf(last)}`);
		const said = u.split("## 用户最近 3 天说过的话")[1]?.split("\n").find((l) => l.startsWith("- "));
		const brief = /这是每日简报/.test(u);
		if (!said && !brief) return fauxAssistantMessage("无");
		const what = brief ? "今天没有紧急事项。" : said!.replace(/^- [^：]+：/, "");
		return fauxAssistantMessage([fauxToolCall("proactive_surface", { kind: brief ? "brief" : "reminder", title: brief ? "今日简报" : `别忘了：${what.slice(0, 20)}`, body: brief ? what : `你之前提到“${what}”，需要我帮忙准备吗？`, importance: brief ? 2 : 3, ...(brief ? {} : { dedupeKey: `remind:${what.slice(0, 30)}` }) })]);
	}
	// 多步流程（用于“要不要做成技能？”建议）：月度汇总 = 5 步工具调用
	if (/月度汇总/.test(u) && !/^（技能建议/.test(u)) {
		const since = messages.slice(messages.lastIndexOf(lastUser!) + 1).filter((m) => m.role === "toolResult").length;
		const steps = [
			fauxToolCall("ls", { path: "." }),
			fauxToolCall("bash", { command: "echo '一月,120\n二月,98\n三月,143' > sales.csv" }),
			fauxToolCall("bash", { command: "awk -F, '{s+=$2} END {print s}' sales.csv" }),
			fauxToolCall("bash", { command: "sort -t, -k2 -n -r sales.csv | head -1" }),
			fauxToolCall("bash", { command: "wc -l sales.csv" }),
		];
		if (since < steps.length) return fauxAssistantMessage(since === 0 ? [fauxText("好，我按月汇总一下数据。"), steps[0]] : [steps[since]]);
		return fauxAssistantMessage("月度汇总做好了：三个月合计 361，三月最高（143）。");
	}
	if (/^（技能建议/.test(u)) {
		const update = u.match(/技能「([a-z0-9-]+)」/);
		if (last.role === "toolResult" && last.toolName === "skill_save") return fauxAssistantMessage(/没有|不要/.test(textOf(last)) ? "好的，这次就不存了。" : `存好了 🧩 ${textOf(last)}`);
		if (last.role === "toolResult" && last.toolName === "skill_search" && !update)
			return fauxAssistantMessage([fauxToolCall("skill_save", { name: "monthly-summary", description: "按月汇总表格数据：合计、最高月份、行数。用户说“月度汇总/按月统计”时使用。", body: "# 月度汇总\n\n1. 列出工作区文件，找到数据表。\n2. 用 awk 求合计。\n3. 排序找出最高的月份。\n4. 统计行数。\n5. 用一句话汇报。" })]);
		if (update) return fauxAssistantMessage([fauxToolCall("skill_save", { name: update[1], description: getSkillDesc(u), body: "# 更新后的流程\n\n1. 先按周分组。\n2. 再按月汇总。\n3. 用一句话汇报。" })]);
		return fauxAssistantMessage([fauxToolCall("skill_search", { query: "月度汇总 按月统计" })]);
	}
	const edit = u.match(/把技能\s*([a-z0-9-]+)\s*改成(.+)/);
	if (edit) {
		if (last.role === "toolResult" && last.toolName === "skill_save") return fauxAssistantMessage(/没有批准/.test(textOf(last)) ? "好的，技能保持不变。" : `技能更新好了 ✏️ ${textOf(last)}`);
		return fauxAssistantMessage([fauxToolCall("skill_save", { name: edit[1], description: "生成每日简报：汇总待办、日程和要闻。用户要“简报/今日概览”时使用。", body: `# 每日简报\n\n1. 列出今天的待办（最多 5 条）。\n2. 汇总日程。\n3. ${edit[2].trim()}。` })]);
	}
	if (/查一下.*天气/.test(u)) {
		if (last.role === "toolResult") return fauxAssistantMessage(`MCP 工具返回：${textOf(last)}`);
		return fauxAssistantMessage([fauxToolCall("mcp__demo__get_weather", { city: "上海" })]);
	}
	if (/发一条便签/.test(u)) {
		if (last.role === "toolResult") return fauxAssistantMessage(/blocked|拒绝|denied|批准/i.test(textOf(last)) ? "没有获得批准，便签没有发送。" : `便签发好了：${textOf(last)}`);
		return fauxAssistantMessage([fauxToolCall("mcp__demo__send_note", { to: "小王", text: "明天十点开会" })]);
	}
	// 助理电脑：关机时先开机（computer_open），同一轮里直接用电脑工具（不需要用户再说话）
	if (/打开你的电脑看看屏幕/.test(u)) {
		if (last.role !== "toolResult") return fauxAssistantMessage([fauxText("我先把我的电脑打开。"), fauxToolCall("computer_open", {})]);
		if (last.toolName === "computer_open") return fauxAssistantMessage([fauxToolCall("mcp__computer__get_screen_size", {})]);
		if (last.toolName === "mcp__computer__get_screen_size") return fauxAssistantMessage([fauxToolCall("computer_screenshot", {})]);
		const size = [...messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "mcp__computer__get_screen_size");
		return fauxAssistantMessage(`电脑开好了，屏幕信息：${size ? textOf(size).slice(0, 120) : "未知"}。截图已看过。`);
	}
	// Phase 3：浏览器（打开网页 → 看大纲 → 点提交按钮触发审批）
	const openUrl = u.match(/用浏览器打开\s*(\S+)/);
	if (openUrl) {
		if (last.role !== "toolResult") return fauxAssistantMessage([fauxText("好，我在我的电脑上打开这个网页。"), fauxToolCall("browser_navigate", { url: openUrl[1] })]);
		const out = textOf(last);
		if (last.toolName === "browser_navigate" && /下单|提交/.test(u)) {
			const ref = out.split("\n").find((l) => l.includes("(提交表单)"))?.match(/\[ref=([^\]]+)\]/)?.[1];
			if (ref) return fauxAssistantMessage([fauxText("页面打开了，我来点提交按钮。"), fauxToolCall("browser_click", { ref })]);
		}
		if (last.toolName === "browser_click") return fauxAssistantMessage(/没有批准|拒绝/.test(out) ? "好的，没有提交。" : `已提交 ✅\n\n${out.slice(0, 300)}`);
		return fauxAssistantMessage(`网页打开了：\n\n${out.slice(0, 600)}`);
	}
	if (/晚点再看|再帮我看看/.test(u)) {
		if (last.role !== "toolResult") return fauxAssistantMessage([fauxToolCall("followup_schedule", { when: "+2h", note: `跟进：${u.slice(0, 80)}` })]);
		return fauxAssistantMessage(`好的，${textOf(last)}到时我再看看。`);
	}
	// Phase 3：邮件（写草稿 → 请求批准发送）
	if (/写邮件/.test(u)) {
		if (last.role !== "toolResult")
			return fauxAssistantMessage([fauxText("好，我先写一份草稿。"), fauxToolCall("email_draft", { to: ["wang@school.cn"], subject: "周五家长会", body: "王老师您好：\n\n周五下午三点的家长会我会准时参加。\n\n谢谢！" })]);
		const out = textOf(last);
		if (last.toolName === "email_draft") {
			const id = out.match(/draftId=(\S+)/)?.[1];
			if (id) return fauxAssistantMessage([fauxText(`草稿写好了：\n\n${out.split("\n\n把草稿")[0]}\n\n我请你确认后发送。`), fauxToolCall("email_send", { draftId: id })]);
			return fauxAssistantMessage(`草稿没写成：${out}`);
		}
		return fauxAssistantMessage(/没有批准/.test(out) ? "好的，先不发，草稿留着。" : `邮件发出去了 📮 ${out}`);
	}
	if (last.role === "toolResult") {
		const out = textOf(last);
		switch (last.toolName) {
			case "write":
				return fauxAssistantMessage([fauxToolCall("deliver_file", { path: "report.md", caption: "这是你要的报告" })]);
			case "generate_image":
				return fauxAssistantMessage(/失败/.test(out) ? `没画成：${out.slice(0, 300)}` : "画好了 🎨，就在上面。想换风格或比例跟我说。");
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
	if (/画一张/.test(u)) return fauxAssistantMessage([fauxText("好，我来画。"), fauxToolCall("generate_image", { prompt: u.replace(/^.*?画一张/, "").trim() || u, aspect_ratio: "1:1" })]);
	if (/很宽的表格/.test(u))
		return fauxAssistantMessage(
			`给你：\n\n| ${Array.from({ length: 12 }, (_, i) => `第${i + 1}列标题`).join(" | ")} |\n|${" --- |".repeat(12)}\n| ${Array.from({ length: 12 }, (_, i) => `数据${i + 1}-内容比较长`).join(" | ")} |\n\n\`\`\`\n${"const veryLongLine = ".padEnd(300, "x")}\n\`\`\`\n\n长链接：https://example.com/${"a".repeat(200)}`,
		);
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
	const faux = registerFauxProvider({ provider: MOCK_PROVIDER, models: [{ id: MOCK_MODEL, name: "Mock 模型（本地测试）" }, { id: MOCK_REASONING_MODEL, name: "Mock 推理模型（本地测试）", reasoning: true } as never], tokensPerSecond: 60 });
	const step = (ctx: { messages: (Msg & { toolsAdded?: MockTool[] })[]; systemPrompt?: string }) => {
		faux.appendResponses([step as never]);
		// Pi 把系统提示词和工具声明放在 transcript 的 system 消息里
		const sys = ctx.messages.filter((m) => m.role === "system");
		const systemPrompt = [ctx.systemPrompt ?? "", ...sys.map(textOf)].filter(Boolean).join("\n");
		const tools = sys.flatMap((m) => m.toolsAdded ?? []);
		const msgs = ctx.messages.filter((m) => m.role !== "system");
		const hs = hindsightReply(msgs, systemPrompt, tools);
		if (hs !== null) return typeof hs === "string" ? fauxAssistantMessage(hs) : fauxAssistantMessage([fauxToolCall(hs.tool, hs.args as never)]);
		return respond(msgs, systemPrompt);
	};
	faux.setResponses([step as never]);
	const m = faux.getModel();
	models.registerProvider(MOCK_PROVIDER, {
		baseUrl: m.baseUrl,
		api: m.api,
		models: [
			{ id: m.id, name: m.name, api: m.api, reasoning: false, input: ["text"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl },
			// 带推理档位的模型：用来测试“思考强度”选择器
			{ id: MOCK_REASONING_MODEL, name: "Mock 推理模型（本地测试）", api: m.api, reasoning: true, input: ["text"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl },
		],
	});
	await models.setRuntimeApiKey(MOCK_PROVIDER, "mock");
}

/** 群聊里的 Mock 行为（e2e 用）：管理者“派给X”就分配，“循环”时每次总结都再派一次；成员完成后回报 */
function roomReply(u: string, systemPrompt: string, last: Msg, messages: Msg[]) {
	void systemPrompt;
	const me = u.match(/· 你是 ([^（）\n]+)/)?.[1]?.trim() ?? "我";
	// 用户最近说的话：从整段会话里找（管理者总结时这一轮注入里可能没有用户的话）
	const users = messages.filter((m) => m.role === "user").flatMap((m) => [...textOf(m).matchAll(/【用户】([^\n]*)/g)].map((x) => x[1]));
	const said = users[users.length - 1] ?? "";
	const target = said.match(/派给([^\s，,。]+)/)?.[1];
	if (last.role === "toolResult") {
		const out = textOf(last);
		if (last.toolName === "room_assign") return fauxAssistantMessage(`${me}：已安排 ${target ?? ""}。`);
		if (last.toolName === "room_propose_member") return fauxAssistantMessage(`${me}：我提议加一个成员，请确认。`);
		return fauxAssistantMessage(/blocked|拒绝|denied|批准|停止/i.test(out) ? `${me}：没有获得批准，不执行。` : `${me}：已处理（${out.slice(0, 40)}）`);
	}
	if (/画一张/.test(said) && !/成员都已回复/.test(u)) return fauxAssistantMessage([fauxToolCall("generate_image", { prompt: said.replace(/^.*?画一张/, "").trim() || said })]);
	if (/给你分配了任务/.test(u)) {
		const task = u.match(/给你分配了任务：([^\n]*)/)?.[1] ?? "";
		if (/慢慢/.test(task + said)) return fauxAssistantMessage([fauxText(`${me}：开始做，比较慢。`), fauxToolCall("bash", { command: "sleep 20; echo done" })]);
		return fauxAssistantMessage(`${me} 完成了：${task.slice(0, 40)}${/提醒C|@C/.test(said) ? "。建议 @C 也看看" : ""}`);
	}
	if (/成员都已回复/.test(u)) {
		if (/循环/.test(said) && target) return fauxAssistantMessage([fauxToolCall("room_assign", { assignments: [{ agent: target, task: "再做一遍" }] })]);
		return fauxAssistantMessage(`${me} 总结：大家都完成了。`);
	}
	if (/由你（管理者）负责/.test(u)) {
		if (/加个成员/.test(said)) return fauxAssistantMessage([fauxToolCall("room_propose_member", { member: { name: "设计", role: "做海报", persona: "你负责设计。" }, reason: "缺设计" })]);
		if (target) return fauxAssistantMessage([fauxText(`${me}：这件事交给 ${target}。`), fauxToolCall("room_assign", { assignments: [{ agent: target, task: said.slice(0, 60) }] })]);
		return fauxAssistantMessage(`${me}（管理者）收到：${said.slice(0, 40)}`);
	}
	if (/审批/.test(said)) return fauxAssistantMessage([fauxToolCall("bash", { command: "rm -f old-notes.txt && echo 已删除 old-notes.txt" })]);
	if (/慢慢/.test(said)) return fauxAssistantMessage([fauxText(`${me}：开始做，比较慢。`), fauxToolCall("bash", { command: "sleep 20; echo done" })]);
	return fauxAssistantMessage(`${me} 回复：${said.slice(0, 40)}`);
}
