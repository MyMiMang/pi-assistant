/**
 * 本地测试用 Mock 模型（仅在 PIA_MOCK=1 时注册，绝不在正式版默认启用）。
 * 根据用户消息里的关键词，脚本化地演示：流式回复、调用工具、审批、文件交付、选项提问、后台任务。
 */
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { PiModels } from "./index.ts";

export const MOCK_PROVIDER = "mock";
export const MOCK_MODEL = "echo";
export const MOCK_REASONING_MODEL = "echo-think";

/** 集成测试用：每次 mock 模型步骤（一次真实模型调用）计数，用来证明等待期间零模型调用。 */
export const mockStats = { steps: 0, lastUserText: "" };
export const resetMockStats = () => { mockStats.steps = 0; mockStats.lastUserText = ""; };
/** 「网络断开测试」专用：第一次模型请求抛 ECONNRESET，之后恢复（验证有界退避重试后在同一会话续跑）。 */
let netFlaky = 0;

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

/** 外观 AI 创作的 Mock 产出：设计专用会话的系统提示里有「外观主题设计器」标记。 */
const themeTokens = (bg: string, fg: string, acc: string) => ({
	"--bg": bg,
	"--side": bg,
	"--panel": bg,
	"--card": bg,
	"--fg": fg,
	"--mut": fg,
	"--mut2": fg,
	"--line": bg,
	"--line-strong": bg,
	"--hover": bg,
	"--active": bg,
	"--user-bg": bg,
	"--user-fg": fg,
	"--acc": acc,
	"--acc-fg": bg,
	"--acc-soft": "rgba(0,0,0,.12)",
	"--ok": "#5f8a5a",
	"--warn": "#c08a2c",
	"--z-light": "#ffffff",
	"--z-dark": "#1b1b22",
});
function mockThemeManifest(said: string) {
	const warm = /奶油|紫|可爱|暖|粉/.test(said);
	return {
		manifestVersion: 1,
		name: warm ? "奶油紫" : "薄荷清爽",
		author: "AI 生成",
		basedOn: warm ? "pixel" : "noir",
		modes: warm
			? { light: themeTokens("#f7f3ea", "#2a251f", "#8fd3c1"), dark: themeTokens("#141218", "#f3eee6", "#c3b6f0") }
			: { light: themeTokens("#f2f7f5", "#1f2a27", "#4fb39a"), dark: themeTokens("#0f1614", "#e6f2ee", "#63d0b3") },
		decor: { texture: "none", corner: "round", shadow: "soft", background: warm ? "glow" : "flat" },
	};
}

function respond(messages: Msg[], systemPrompt = "", tools: MockTool[] = []) {
	const last = messages[messages.length - 1];
	// 外观 AI 创作：专用会话只挂 theme_draft 工具 → 用 theme_draft 提交一份合法 manifest
	if (tools.some((t) => t.name === "theme_draft")) {
		if (last?.role === "toolResult") return fauxAssistantMessage("已生成一套主题，正在预览；想调整就继续说。");
		const said = textOf([...messages].reverse().find((m) => m.role === "user") ?? { role: "user", content: "" });
		return fauxAssistantMessage([fauxToolCall("theme_draft", { manifest: mockThemeManifest(said), text: "奶油底 + 薄荷 / 淡紫点缀，圆角小一点。" })]);
	}
	// Pi 的上下文整理（compaction）请求：返回一段结构化摘要
	if (/context summarization assistant/i.test(systemPrompt) || textOf(last).startsWith("<conversation>"))
		return fauxAssistantMessage("## Goal\n用户在测试 Pi Assistant 的各项功能。\n\n## Progress\n- 已演示流式回复、文件、审批、后台任务等。\n\n## Next Steps\n- 继续按用户要求操作。");
	const lastUser = [...messages].reverse().find((m) => m.role === "user" && !/^(后台|定时)任务「/.test(textOf(m)));
	// 渠道消息前面的［渠道：…］说明不算用户说的话（否则里面的“文件 / 图片”会触发关键词）
	let u = lastUser ? textOf(lastUser).replace(/^［渠道：[^］]*］\n?/, "") : "";
	// 工作途中插话（Pi steer 送达）：打断的是多步任务（慢慢数）时先简短回应、按内容换方向 / 停下；
	// 否则（上一轮其实已经收尾，只是还在流式结束）当成普通的新请求处理，去掉前缀照常匹配
	if (u.startsWith("（你工作时用户发来的新消息）") && last.role === "user") {
		const said = u.replace(/^（你工作时用户发来的新消息）\n?/, "").replace(/^（用户在群里说）/, "");
		const prev = [...messages.slice(0, messages.lastIndexOf(lastUser!))].reverse().find((m) => m.role === "user");
		if (prev && /慢慢数/.test(textOf(prev))) return fauxAssistantMessage(/停|别做/.test(said) ? "收到，我停下了。" : `收到插话：${said.slice(0, 40)}。按新要求调整。`);
		u = u.replace(/^（你工作时用户发来的新消息）\n?/, "");
	}

	// 子代理测试：事件由主会话汇报，执行步骤只留在子会话。
	// 卡住处理 e2e：主会话按建议自己处理——带纠正 subagent_restart，不去问用户
	if (u.includes("（帮手事件 ") && /卡住了/.test(u) && /subagent_restart/.test(u) && last.role !== "toolResult") {
		const id = u.match(/帮手 ID：([\w-]+)/)?.[1];
		if (id) return fauxAssistantMessage([fauxText("帮手卡住了，我看一下再带着纠正让它从检查点继续。"), fauxToolCall("subagent_restart", { id, note: "上一步的请求一直没返回，别再等它；直接检查已有结果，按更小的步骤继续" })]);
	}
	if (u.includes("（帮手事件 ")) return fauxAssistantMessage(`子代理回报：${u.replace(/^.*?）/, "").slice(0, 300)}`);
	// 群里的帮手 e2e：第一层帮手把一块交给下一层（第二层没有 spawn_subagent），收到下一层结果后整合
	if (u.startsWith("（系统通知：你派的下一层帮手都结束了）")) return fauxAssistantMessage(`整合了下一层帮手的结果：${u.split("\n")[1]?.slice(0, 120) ?? ""}`);
	if (u.startsWith("（后台帮手任务）") && /分两块/.test(u) && last.role !== "toolResult" && tools.some((t) => t.name === "spawn_subagent")) return fauxAssistantMessage([fauxToolCall("spawn_subagent", { task: "第二块：核对台词格式", done_criteria: "三场台词格式统一" })]);
	if (u.startsWith("（后台帮手任务）第二块") && last.role !== "toolResult") return fauxAssistantMessage([fauxToolCall("bash", { command: "echo 第二块完成：台词格式统一" })]);
	if (u.startsWith("（后台帮手任务）")) {
		// 模拟“可恢复的模型故障”：首次派活时报 429，让子代理在候选池内自动 fallback（续跑时会成功）
		if (/限流测试/.test(u)) throw new Error("429 rate limit exceeded（模拟子代理模型限流）");
		if (/报错/.test(u)) throw new Error("模拟子代理模型报错");
		// 模拟断网：第一次请求 ECONNRESET，退避重试后在同一会话恢复正常
		if (/网络断开测试/.test(u) && last.role !== "toolResult") {
			if (netFlaky++ === 0) throw new Error("ECONNRESET socket hang up（模拟网络连接被重置）");
			return fauxAssistantMessage([fauxToolCall("bash", { command: "echo 断网后继续完成" })]);
		}
		if (last.role === "toolResult") return fauxAssistantMessage(`子代理结果：${textOf(last)}`);
		if (/审批/.test(u)) return fauxAssistantMessage([fauxToolCall("bash", { command: "rm -f subagent-old.txt; echo 子代理审批完成" })]);
		// 慢但在动：命令跑得比预计久，但一直在输出（卡住检测不该打断它）
		if (/长命令测试/.test(u)) return fauxAssistantMessage([fauxToolCall("bash", { command: "for i in 1 2 3 4 5 6 7 8 9 10; do echo 进度 $i; sleep 1; done" })]);
		return fauxAssistantMessage([fauxThinking("先确认子代理任务，再运行命令整理结果。"), fauxToolCall("bash", { command: "sleep 8; echo 子代理工作完成" })]);
	}
	if (messages.some((m) => m.role === "user" && textOf(m).startsWith("（后台帮手任务）"))) {
		const secret = messages.filter((m) => m.role === "user").map(textOf).join("\n").match(/子代理暗号：([^\n]+)/)?.[1];
		return fauxAssistantMessage([fauxThinking("结合这个子代理会话的上下文处理新消息。"), fauxText(/刚才暗号/.test(u) ? `刚才的暗号是：${secret ?? "不知道"}` : `子代理已按补充要求调整。收到：${u}`)]);
	}
	const subSaid = u.startsWith("（群聊「") ? ([...u.matchAll(/【用户】([^\n]*)/g)].pop()?.[1] ?? "") : u;
	if (/聊个无关问题/.test(subSaid)) return fauxAssistantMessage("我在，后台任务继续跑。");
	if (/派个子代理/.test(subSaid)) {
		if (last.role === "toolResult") return fauxAssistantMessage("子代理已在后台工作，我们可以继续聊。");
		return fauxAssistantMessage([fauxToolCall("spawn_subagent", { task: subSaid, context: "执行一次测试任务" })]);
	}
	if (/补充给子代理/.test(subSaid)) {
		if (last.role === "toolResult" && last.toolName === "subagent_message") return fauxAssistantMessage("补充已转交子代理。");
		if (last.role === "toolResult" && last.toolName === "subagent_list") {
			const rows = JSON.parse(textOf(last));
			return fauxAssistantMessage([fauxToolCall("subagent_message", { id: rows.find((r: { status: string }) => r.status === "running" || r.status === "stalled").id, text: subSaid })]);
		}
		return fauxAssistantMessage([fauxToolCall("subagent_list", {})]);
	}
	// 慢慢数：多步、每步都慢（测试工作途中插话 / 停止）
	// 群聊注入里带着整段群聊记录：只看这一轮用户最新说的话（【用户】…），免得之前的“慢慢数”让后面每一轮都去数数
	const roomSaid = u.startsWith("（群聊「") ? ([...u.matchAll(/【用户】([^\n]*)/g)].pop()?.[1] ?? "") : u;
	// 主动巡检的提示里会列出用户最近说过的话（可能含“慢慢数”）：那是巡检，不是让它数数
	if (/慢慢数/.test(roomSaid) && !/这是(一次主动巡检|你约好的跟进|每日简报)/.test(u)) {
		const since = messages.slice(messages.lastIndexOf(lastUser!) + 1).filter((m) => m.role === "toolResult").length;
		if (since < 3) return fauxAssistantMessage([...(since ? [] : [fauxText("好，我慢慢数。")]), fauxToolCall("bash", { command: `sleep 2; echo 第${since + 1}步` })]);
		return fauxAssistantMessage("数完了：1、2、3。");
	}
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
					{ name: "统筹", role: "拆分任务、汇总", persona: "你负责统筹。", needs: ["reasoning"] },
					{ name: "文案", role: "写发布文案", persona: "你负责写文案。", needs: ["writing_zh", "cheap"] },
				],
			}),
		]);
	}
	// 主动性：巡检时先看有没有用户明确交代、能直接推进的事——有就在相关对话里真的做（不是只提醒一句“要不要我帮忙”）。
	// 只靠 prompt 里的明确待办（带 [conv:...] 和具体动作）+ 工具存在才推进；否则仍然只是提醒，保持“宁缺毋滥”。
	if (/这是(一次主动巡检|你约好的跟进|每日简报)/.test(u)) {
		if (last.role === "toolResult") return fauxAssistantMessage(`巡检完成：${textOf(last)}`);
		const brief = /这是每日简报/.test(u);
		const target = !brief && tools.some((t) => t.name === "proactive_advance") ? mockAdvanceTarget(u) : null;
		if (target) {
			return fauxAssistantMessage([
				fauxToolCall("proactive_advance", {
					conversationId: target.conversationId,
					kind: /你约好的跟进/.test(u) ? "followup" : "reminder",
					title: target.what.slice(0, 40),
					body: `用户之前已经明确交代：“${target.what}”。在原授权内继续做完，并把结果留在对话里。`,
					importance: 3,
					dedupeKey: `adv:${target.conversationId}:${target.what.slice(0, 30)}`,
				}),
			]);
		}
		const said = u.split("## 用户最近 3 天说过的话")[1]?.split("\n").find((l) => l.startsWith("- "));
		if (!said && !brief) return fauxAssistantMessage("无");
		const what = brief ? "今天没有紧急事项。" : said!.replace(/^- \[conv:[^\]]+\] [^：]+：/, "");
		return fauxAssistantMessage([fauxToolCall("proactive_surface", { kind: brief ? "brief" : "reminder", title: brief ? "今日简报" : `别忘了：${what.slice(0, 20)}`, body: brief ? what : `你之前提到“${what}”，需要的话我可以接着做。`, importance: brief ? 2 : 3, ...(brief ? {} : { dedupeKey: `remind:${what.slice(0, 30)}` }) })]);
	}
	// 主动推进：在相关对话里真的做一件无害、可核验的事，结果就留在原会话（不再回头问“要不要我帮忙”）
	if (u.startsWith("（主动推进）")) {
		if (last.role === "toolResult" && last.toolName === "write") return fauxAssistantMessage(`已按原授权完成：${textOf(last).split("\n")[0]} 产物：proactive-advance.md`);
		const what = u.match(/要做的事：([^\n]*)/)?.[1] ?? "巡检发现的事";
		return fauxAssistantMessage([fauxToolCall("write", { path: "proactive-advance.md", content: `# 季度报告核验清单\n\n事项：${what}\n\n- 数据核对\n- 来源链接\n- 结论检查\n` })]);
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
		// 自动建议先提交具体用途，宿主展示卡片；同意后才查重/保存。
		if (u.startsWith("（技能建议的内部步骤")) {
			if (last.role === "toolResult" && last.toolName === "skill_propose") {
				if (!textOf(last).startsWith("用户同意")) return fauxAssistantMessage("");
				return fauxAssistantMessage([fauxToolCall("skill_search", { query: "月度汇总 按月统计" })]);
			}
			if (last.role !== "toolResult") {
				const suggestionId = u.match(/suggestionId 用 (sg_[a-z0-9]+)/)?.[1];
				if (!suggestionId) return fauxAssistantMessage("");
				return fauxAssistantMessage([fauxToolCall("skill_propose", { suggestionId, subject: "月度数据汇总", does: "汇总各月销售额，找出最高月份并统计记录数", when: "下次整理每月销售数据时", gives: "销售合计、最高月份和记录数的摘要" })]);
			}
		}
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
	// 任务等待（task_wait）：登记后结束这一轮，不空等——集成测试用
	if (/等构建完成/.test(u)) {
		if (last.role === "toolResult" && last.toolName === "task_wait") return fauxAssistantMessage("已登记等待（等后台构建完成），这一轮先结束，有结果我再继续。");
		return fauxAssistantMessage([fauxText("好，我登记一个等待，不在这一轮里空等。"), fauxToolCall("task_wait", { reason: "等后台构建完成后核对产物", due: "+30m" })]);
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
	if (/演示思考/.test(u)) return fauxAssistantMessage("<think>先想一想：用户想看思考过程怎么显示。\n第二步：给出简短回答。</think>这是回答：思考过程收在上面的「思考」里。");
	if (/服务刚刚重启/.test(u)) return fauxAssistantMessage("我检查了一下进度：服务重启时上一轮命令被中断了。工作区里的文件都还在，需要的话再说一声我就重新执行。");
	// 重启安全 e2e：一个会跑很久的后台任务（重启时 bash 已派发、结果未落库）
	if (/后台慢任务/.test(u)) return fauxAssistantMessage([fauxToolCall("spawn_task", { title: "慢慢核对工作区", instructions: "慢慢核对工作区：逐个检查文件，做完给出总结。" })]);
	if (/^慢慢核对工作区/.test(u)) return fauxAssistantMessage([fauxText("开始逐个核对，比较慢。"), fauxToolCall("bash", { command: "sleep 60; echo 核对完成" })]);
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
	if (att) {
		const imgs = imageCount(lastUser);
		const excerpt = /<<<文件内容/.test(u) ? "，已看到文档文字" : "";
		return fauxAssistantMessage([fauxText(`收到文件${imgs ? `，看到 ${imgs} 张图片` : ""}${excerpt}，我先读一下。`), fauxToolCall("read", { path: att[1] })]);
	}
	if (/命令|代码|python/i.test(u))
		return fauxAssistantMessage([fauxText("好，我在工作区里跑一下。"), fauxToolCall("bash", { command: "python3 -c \"print(sum(range(101)))\" 2>/dev/null || node -e \"console.log(5050)\"; uname -s; pwd" })]);
	return fauxAssistantMessage(
		`好的，收到！我是本地 **Mock 模型**，用于在没有 API Key 的情况下测试。\n\n你说的是：「${u}」\n\n可以试试这些关键词：\n- **报告**：生成文件并发给你\n- **删除**：触发审批卡片\n- **问我**：弹出选项按钮\n- **后台**：创建后台任务\n- **命令**：在工作区里跑代码\n\n\`\`\`ts\nconst hello = "世界";\nconsole.log(\`你好，\${hello}\`);\n\`\`\``,
	);
}

export async function registerMockProvider(models: PiModels) {
	const faux = registerFauxProvider({ provider: MOCK_PROVIDER, models: [{ id: MOCK_MODEL, name: "Mock 模型（本地测试）", input: ["text", "image"] } as never, { id: MOCK_REASONING_MODEL, name: "Mock 推理模型（本地测试）", reasoning: true } as never], tokensPerSecond: 60 });
	const step = (ctx: { messages: (Msg & { toolsAdded?: MockTool[] })[]; systemPrompt?: string }, opts?: { signal?: AbortSignal }) => {
		mockStats.steps++;
		faux.appendResponses([step as never]);
		// Pi 把系统提示词和工具声明放在 transcript 的 system 消息里
		const sys = ctx.messages.filter((m) => m.role === "system");
		const systemPrompt = [ctx.systemPrompt ?? "", ...sys.map(textOf)].filter(Boolean).join("\n");
		const tools = sys.flatMap((m) => m.toolsAdded ?? []);
		const msgs = ctx.messages.filter((m) => m.role !== "system");
		const lastUser = [...msgs].reverse().find((m) => m.role === "user");
		if (lastUser) mockStats.lastUserText = textOf(lastUser);
		// 卡住上报 e2e：子代理的模型请求一直不回（没有任何动静），直到被停止
		const lastMsg = msgs[msgs.length - 1];
		if (lastMsg?.role === "user" && /^（后台帮手任务）[\s\S]*卡住测试/.test(textOf(lastMsg)))
			return new Promise((resolve) => { const done = () => resolve(fauxAssistantMessage("（停下了）")); if (opts?.signal?.aborted) return done(); opts?.signal?.addEventListener("abort", done, { once: true }); setTimeout(done, 600_000).unref?.(); });
		const hs = hindsightReply(msgs, systemPrompt, tools);
		if (hs !== null) return typeof hs === "string" ? fauxAssistantMessage(hs) : fauxAssistantMessage([fauxToolCall(hs.tool, hs.args as never)]);
		return respond(msgs, systemPrompt, tools);
	};
	faux.setResponses([step as never]);
	const m = faux.getModel();
	models.registerProvider(MOCK_PROVIDER, {
		baseUrl: m.baseUrl,
		api: m.api,
		models: [
			{ id: m.id, name: m.name, api: m.api, reasoning: false, input: ["text", "image"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl },
			// 带推理档位的模型：用来测试“思考强度”选择器
			{ id: MOCK_REASONING_MODEL, name: "Mock 推理模型（本地测试）", api: m.api, reasoning: true, input: ["text"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl },
		],
	});
	await models.setRuntimeApiKey(MOCK_PROVIDER, "mock");
}

/** 巡检提示里有没有“用户明确交代、能直接做”的事：要求同时有可信对话 id 和具体动作（否则只提醒，不猜）。 */
function mockAdvanceTarget(prompt: string): { conversationId: string; what: string } | null {
	// 只看「明确待办」类的段落：未完成/失败的后台任务、到点的跟进、变化信号。
	// “用户最近说过的话”只当线索（可能需要澄清），不拿它当授权直接推进。
	const sections = prompt.split("\n## ").filter((sec) => /^(未完成或失败的后台任务|你约好的跟进|需要关注的信号)/.test(sec));
	for (const sec of sections) {
		for (const line of sec.split("\n")) {
			const conv = line.match(/\[conv:([^\]]+)\]/)?.[1];
			if (!conv) continue;
			if (!/导出|汇总|整理|报告|报表|周报|生成|准备|核对|整理好|写/.test(line)) continue;
			const what = line.replace(/^\s*-\s*/, "").replace(/^\[[^\]]+\]\s*/, "").split("（相关对话")[0].trim();
			if (what) return { conversationId: conv, what: what.slice(0, 80) };
		}
	}
	return null;
}

/** 群聊里的 Mock 行为（e2e 用）：管理者“派给X”就分配，“循环”时每次总结都再派一次；成员完成后回报 */
function imageCount(m: Msg | undefined) {
	return m && Array.isArray(m.content) ? (m.content as { type?: string }[]).filter((b) => b.type === "image").length : 0;
}
function roomReply(u: string, systemPrompt: string, last: Msg, messages: Msg[]) {
	void systemPrompt;
	const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
	const paths = [...textOf(lastUserMsg ?? last).matchAll(/ → (room-files\/\S+?)[、）\n]/g)].map((x) => x[1]);
	const imgs = imageCount(lastUserMsg);
	const seen = paths.length || imgs ? `（看到附件：${paths.join("、") || "无路径"}；图片 ${imgs} 张）` : "";
	const me = u.match(/· 你是 ([^（）\n]+)/)?.[1]?.trim() ?? "我";
	// 用户最近说的话：从整段会话里找（管理者总结时这一轮注入里可能没有用户的话）
	const users = messages.filter((m) => m.role === "user").flatMap((m) => [...textOf(m).matchAll(/【用户】([^\n]*)/g)].map((x) => x[1]));
	const said = users[users.length - 1] ?? "";
	const target = said.match(/派给([^\s，,。]+)/)?.[1];
	const isFollowup = /成员都已|任务看板有变化/.test(u);
	// 管理者跟进普通派活（没有待核验的长期任务）：「循环」再派一次，否则总结
	const plainFollowup = () =>
		/循环/.test(said) && target ? fauxAssistantMessage([fauxToolCall("room_assign", { assignments: [{ agent: target, task: "再做一遍" }] })]) : fauxAssistantMessage(`${me} 总结：大家都完成了。`);
	const lastUserIdx = messages.lastIndexOf(lastUserMsg ?? last);
	const since = messages.slice(lastUserIdx + 1);
	const tools = since.filter((m) => m.role === "toolResult").map((m) => String(m.toolName ?? ""));
	// 长期任务：群里指到具体任务（编号 / 任务名 / 引用结果卡）时，管理者接收纠正并更新原任务。
	const workCtx = isFollowup ? "" : (u.match(/【关于长期任务】[\s\S]*?(?=\n——|$)/)?.[0] ?? "");
	const workId = workCtx.match(/编号 (wi_[a-z0-9]+)/i)?.[1] ?? "";
	const workStatus = workCtx.match(/当前(待安排|进行中|受阻|待核验|已完成|已暂停|已取消)/)?.[1] ?? "";
	const feedback = /改|修改|调整|补充|修正|不对|有问题|错误|不符合|缺|漏|退回|重做|重来|不是这样/.test(said);
	if (workCtx && /可能指到多个任务/.test(workCtx)) return fauxAssistantMessage(`${me}：你指的是哪一项？说任务名字或编号就行，我不会猜。`);
	if (workCtx && workId && feedback && !isFollowup) {
		// 按“工具实际成功做了什么”推进，而不是按调用次数：工具被拒 / 状态不对时不能假装下一步成功。
		const results = since.filter((m) => m.role === "toolResult");
		const outText = results.map((m) => textOf(m)).join("\n");
		const failed = results.find((m) => /不能|没有明确|先不要|不存在|只有管理者|已暂停|已取消|已完成|失败/.test(textOf(m)) && !/已重开|已更新要求|已继续/.test(textOf(m)));
		if (failed) return fauxAssistantMessage(`${me}：${textOf(failed).slice(0, 160)}`);
		const did = (re: RegExp) => results.some((m) => ["work_update", "work_verify"].includes(String(m.toolName)) && re.test(textOf(m)));
		const edit = () => fauxAssistantMessage([fauxToolCall("work_update", { workItemId: workId, action: "edit", requirement: `按用户最新反馈改：${said.slice(0, 200)}`, doneCriteria: `修改后满足：${said.slice(0, 160)}` })]);
		const cont = () => fauxAssistantMessage([fauxToolCall("work_update", { workItemId: workId, action: "continue" })]);
		if (/已完成|已取消/.test(workStatus)) {
			if (!did(/已重开/)) return fauxAssistantMessage([fauxToolCall("work_update", { workItemId: workId, action: "reopen" })]);
			if (!did(/已更新要求/)) return edit();
			if (!did(/已继续/)) return cont();
		} else if (workStatus === "待核验") {
			if (!did(/已退回/)) return fauxAssistantMessage([fauxToolCall("work_verify", { workItemId: workId, verdict: "return", note: `用户指出问题：${said.slice(0, 160)}` })]);
			if (!did(/已更新要求/)) return edit();
			if (!did(/已继续/)) return cont();
		} else if (workStatus === "已暂停") {
			if (feedback && !did(/已更新要求/)) return edit();
			if (!did(/已继续/)) return cont();
		} else {
			if (!did(/已更新要求/)) return edit();
			if (!did(/已继续/)) return cont();
		}
		return fauxAssistantMessage(`${me}：已经按你指出的问题更新原任务，安排重新做，做完会先给你核验。`);
	}
	// 首次长期任务：管理者记录任务并派给成员（不是把每个临时问题都建成任务）
	if (last.role !== "toolResult" && !isFollowup && u.includes("（管理者）") && /长期任务/.test(said) && /派给/.test(said) && target) {
		// 目标 / 范围 / 完成标准不清时先问一个关键问题；不替用户编一个“按用户要求交付”的标准。
		const title = said.match(/长期任务[：:]\s*([^，,。；;派]+)/)?.[1]?.trim() || "";
		const requirement = said.match(/要求[：:]\s*([^；;。]*)/)?.[1]?.trim() ?? "";
		const done = said.match(/完成标准[：:]\s*([^；;。]*)/)?.[1]?.trim() ?? "";
		if (!title || !requirement || !done) return fauxAssistantMessage(`${me}：在记录任务前先确认一下：这件事的目标 / 范围和完成标准分别是什么？特别是怎样检查算做完。`);
		return fauxAssistantMessage([fauxToolCall("work_create", { title, requirement, doneCriteria: done, owner: target, start: true })]);
	}
	// 群协作验收：用户让管理者「定个目标」→ room_goal 直接开启自主推进；看板唤醒时只对「需拍板」的卡住任务 work_ask_user
	if (!isFollowup && u.includes("（管理者）") && /定个目标/.test(said) && last.role !== "toolResult") return fauxAssistantMessage([fauxToolCall("room_goal", { goal: said.replace(/^.*?定个目标[：:]?/, "").trim() || said, doneCriteria: "每项任务都有可核验的交付文件" })]);
	if (last.toolName === "room_goal") return fauxAssistantMessage(`${me}：目标定好了，开始推进。`);
	if (isFollowup && /任务看板有变化/.test(u) && /需拍板/.test(u)) {
		if (last.toolName === "work_ask_user") return fauxAssistantMessage(`${me}：有一件事需要你拍板，已放进「等你决定」。`);
		const line = u.split("\n").find((x) => x.includes("需拍板") && /wi_/.test(x) && !x.includes("等你决定"));
		const id = line?.match(/wi_[a-z0-9]+/i)?.[0];
		if (id && last.role !== "toolResult") return fauxAssistantMessage([fauxToolCall("work_ask_user", { workItemId: id, question: "报表账号拿不到，先用公开数据还是等你开账号？", options: ["先用公开数据", "等我开账号"], reason: "成员没有报表权限" })]);
	}
	// 边界验收专用：一次真实成员故障后，由管理者在原群查看状态、改派并继续；不增加产品runner。
	if (isFollowup && u.includes("失败协调探针")) {
		if (last.role !== "toolResult") return fauxAssistantMessage([fauxToolCall("work_list", {})]);
		const listMsg = last.toolName === "work_list" ? last : [...messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "work_list");
		const blocked = textOf(listMsg ?? last).split("\n").find((line) => line.includes("失败协调探针") && line.includes("受阻"));
		const id = blocked?.match(/wi_[a-z0-9]+/i)?.[0];
		if (id && last.toolName === "work_list") return fauxAssistantMessage([fauxToolCall("work_update", { workItemId: id, action: "assign", owner: "乙" })]);
		if (id && last.toolName === "work_update") {
			if (/已改派/.test(textOf(last))) return fauxAssistantMessage([fauxToolCall("work_update", { workItemId: id, action: "continue" })]);
			return fauxAssistantMessage(`${me}：已处理成员故障，改派乙继续原任务，交付后核验。`);
		}
	}
	// 管理者跟进：成员提交后先看任务状态，再核验（真实两轮工具调用，不是直接假装完成）
	if (isFollowup && (/已提交/.test(u) || /待核验/.test(u) || /长期任务/.test(said))) {
		// 一次跟进最多：work_list → read 实际产物 → work_verify。用当前这步的 last.toolName 推进，
		// 不复用上一轮 / 成员的旧列表，避免无限核验循环。经理核验必须读真实产物，不能只看自报。
		if (last.toolName === "work_verify") return fauxAssistantMessage(`${me}：${textOf(last).slice(0, 200)}`);
		if (last.toolName === "room_assign") return fauxAssistantMessage(`${me}：已安排 ${target ?? ""}。`);
		if (last.toolName !== "work_list" && last.toolName !== "read") return fauxAssistantMessage([fauxToolCall("work_list", {})]);
		const ctxId = u.match(/编号 (wi_[a-z0-9]+)/i)?.[1];
		if (last.toolName === "work_list") {
			const listed = textOf(last);
			const pending = listed.split("\n").find((line) => /待核验/.test(line) && (!ctxId || line.includes(ctxId)));
			const id = pending?.match(/wi_[a-z0-9]+/i)?.[0] ?? (pending ? ctxId : undefined);
			// 没有待核验的长期任务：按普通派活收尾（「循环」再派一次，用来演示群里的上限暂停）
			if (!id) return plainFollowup();
			const path = paths[0];
			if (!path) return fauxAssistantMessage([fauxToolCall("work_verify", { workItemId: id, verdict: "return", note: "没有拿到交付文件，无法核验；请成员把产物发到群里" })]);
			return fauxAssistantMessage([fauxToolCall("read", { path })]);
		}
		const readOut = textOf(last);
		const listMsg = [...messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "work_list");
		const id = ctxId ?? textOf(listMsg ?? last).match(/wi_[a-z0-9]+/i)?.[0] ?? "";
		if (!id) return plainFollowup();
		if (/第 3 行检查点/.test(readOut)) return fauxAssistantMessage([fauxToolCall("work_verify", { workItemId: id, verdict: "pass", note: `读了 ${paths[0] ?? "交付文件"}，第 3 行检查点存在，符合完成标准` })]);
		return fauxAssistantMessage([fauxToolCall("work_verify", { workItemId: id, verdict: "return", note: "读了交付文件，没有找到第 3 行检查点，退回补上" })]);
	}
	if (last.role === "toolResult") {
		const out = textOf(last);
		if (last.toolName === "room_assign") return fauxAssistantMessage(`${me}：已安排 ${target ?? ""}。`);
		if (last.toolName === "write" && /【长期任务】/.test(u)) return fauxAssistantMessage([fauxToolCall("deliver_file", { path: "out.txt", caption: `${me}：任务交付 out.txt` })]);
		if (last.toolName === "deliver_file" && /【长期任务】/.test(u)) {
			const id = u.match(/任务编号：(wi_[a-z0-9]+)/i)?.[1];
			return fauxAssistantMessage([fauxToolCall("work_submit", { result: "已交付 out.txt（群附件），第 3 行写着检查点；来源链接在文件末尾", ...(id ? { workItemId: id } : {}) })]);
		}
		if (last.toolName === "write") return fauxAssistantMessage([fauxToolCall("deliver_file", { path: "chart.svg", caption: `${me}：图表做好了` })]);
		if (last.toolName === "deliver_file") return fauxAssistantMessage(`${me}：文件已发到群里。`);
		if (last.toolName === "room_propose_member") return fauxAssistantMessage(`${me}：我提议加一个成员，请确认。`);
		if (last.toolName === "work_create") return fauxAssistantMessage(`${me}：长期任务已经记下，成员做完会提交，我到时候核验。`);
		if (last.toolName === "work_submit") return fauxAssistantMessage(`${me}：已提交结果：out.txt（第 3 行检查点），等待核验。`);
		if (last.toolName === "work_verify") return fauxAssistantMessage(`${me}：核验完成，${/退回/.test(out) ? "已退回修改并安排重做。" : "任务完成。"}`);
		if (last.toolName === "work_update") return fauxAssistantMessage(`${me}：任务已经按用户的新要求更新并重新安排。`);
		if (last.toolName === "work_list") return fauxAssistantMessage(`${me}：任务状态我看过了。`);
		return fauxAssistantMessage(/blocked|拒绝|denied|批准|停止/i.test(out) ? `${me}：没有获得批准，不执行。` : `${me}：已处理（${out.slice(0, 40)}）`);
	}
	if (/画一张/.test(said) && !isFollowup) return fauxAssistantMessage([fauxToolCall("generate_image", { prompt: said.replace(/^.*?画一张/, "").trim() || said })]);
	if (/给你分配了任务/.test(u)) {
		const task = u.match(/给你分配了任务：([^\n]*)/)?.[1] ?? "";
		// 只匹配当前指派：群转录可能含另一项已取消的探针，不能让乙也去跑甲的延迟命令。
		if (/【长期任务】/.test(u) && task.includes("取消隔离探针")) return fauxAssistantMessage([fauxText(`${me}：开始延迟写入，等待取消验证。`), fauxToolCall("bash", { command: "sleep 20; printf unwanted > cancellation-probe.txt" })]);
		if (/【长期任务】/.test(u) && task.includes("【卡点】") && last.toolName !== "work_submit") return fauxAssistantMessage([fauxToolCall("work_submit", { blocker: "缺少报表账号权限，拿不到数据" })]);
		if (/【长期任务】/.test(u) && task.includes("失败协调探针") && me === "甲") throw new Error("模拟成员执行失败（失败协调探针）");
		if (/【长期任务】/.test(u)) return fauxAssistantMessage([fauxToolCall("write", { path: "out.txt", content: "# 季度报告\n\n数据来源：Q3 内部表\n\n第 3 行检查点：每个结论都有来源链接\n" })]);

		if (/慢慢/.test(task + said)) return fauxAssistantMessage([fauxText(`${me}：开始做，比较慢。`), fauxToolCall("bash", { command: "sleep 20; echo done" })]);
		if (/做个图表/.test(task + said)) return fauxAssistantMessage([fauxToolCall("write", { path: "chart.svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#4a8"/></svg>' })]);
		return fauxAssistantMessage(`${me} 完成了：${task.slice(0, 40)}${seen}${/提醒C|@C/.test(said) ? "。建议 @C 也看看" : ""}`);
	}
	if (isFollowup) return plainFollowup();
	if (/由你（管理者）负责/.test(u)) {
		if (/加个成员/.test(said)) return fauxAssistantMessage([fauxToolCall("room_propose_member", { member: { name: "设计", role: "做海报", persona: "你负责设计。", needs: ["vision"] }, reason: "缺设计" })]);
		const names = [...textOf(lastUserMsg ?? last).matchAll(/([^\s：、（]+) → room-files\//g)].map((x) => x[1]);
		if (target) return fauxAssistantMessage([fauxText(`${me}：这件事交给 ${target}。`), fauxToolCall("room_assign", { assignments: [{ agent: target, task: said.slice(0, 60), ...(names.length ? { files: names } : {}) }] })]);
		return fauxAssistantMessage(`${me}（管理者）收到：${said.slice(0, 40)}`);
	}
	if (/审批/.test(said)) return fauxAssistantMessage([fauxToolCall("bash", { command: "rm -f old-notes.txt && echo 已删除 old-notes.txt" })]);
	if (/慢慢/.test(said)) return fauxAssistantMessage([fauxText(`${me}：开始做，比较慢。`), fauxToolCall("bash", { command: "sleep 20; echo done" })]);
	if (/做个图表/.test(said)) return fauxAssistantMessage([fauxToolCall("write", { path: "chart.svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#4a8"/></svg>' })]);
	return fauxAssistantMessage(`${me} 回复：${said.slice(0, 40)}${seen}`);
}
