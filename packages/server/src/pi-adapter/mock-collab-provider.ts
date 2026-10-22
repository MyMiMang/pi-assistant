/**
 * 成员直接协作的 Mock 行为（决策 0019 第 4 步，e2e 用，从 mock-room-provider.ts 拆出来控制单文件行数）：
 *  - 任务要求里含「先问一下」：成员在任务会话里先 ask_colleague 问另一位成员（管理者以外的第一个其他成员，没有就问管理者），
 *    等到回答（插话送进来的文字里有「回答了你的提问」）后再按原流程交付提交；做别的事期间用 sleep 等，最多等约 1 分钟。
 *  - 任务要求里含「上游有问题」：下游成员先 report_upstream（前置任务编号取自执行说明里的「前置任务「X」（编号 wi_…」），
 *    等到「出了新版本」的插话后再按原流程交付提交。
 *  - 被问的人（任务会话插话、群里被叫醒、管理者被叫醒都算）看到「提问编号 ask_…」：upstream 提问 → work_rework 重做，否则 → answer_colleague 回答一句固定文字。
 * 不含这些词的会话返回 null，走原有 Mock 行为。
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { Msg } from "./mock-provider.ts";

export const MOCK_ANSWER = "按第一版口径来，数据以内部表为准";
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "");
const MAX_WAITS = 60;

export function collabReply(messages: Msg[], u: string, last: Msg, systemPrompt: string) {
	const users = messages.filter((m) => m.role === "user").map(textOf);
	const results = messages.filter((m) => m.role === "toolResult");
	const did = (tool: string) => results.some((m) => m.toolName === tool);
	// 被问的人：看到提问编号（回答送回提问者的那条插话也带编号，要排除）
	const askId = u.match(/提问编号 (ask_[a-z0-9]+)/)?.[1];
	if (askId && !/回答了你的提问|出了新版本/.test(u) && !/^（群聊「[^」]*」的长期任务 · /.test(users[0] ?? "")) {
		if (last.role === "toolResult") return fauxAssistantMessage(last.toolName === "work_rework" ? "已重开任务，马上重做。" : "已回答。");
		const target = u.match(/任务「[^」]*」（编号 (wi_[a-z0-9]+)）的成果有问题/)?.[1];
		if (target) return fauxAssistantMessage([fauxToolCall("work_rework", { workItemId: target, why: "同事指出的问题成立：第 3 行检查点缺来源链接，补上后重新提交" })]);
		return fauxAssistantMessage([fauxToolCall("answer_colleague", { askId, answer: MOCK_ANSWER })]);
	}
	// 提问 / 举报的人：在任务会话里执行
	const execMsg = users.find((t) => /^（群聊「[^」]*」的长期任务 · 你是 /.test(t));
	if (!execMsg || !/先问一下|上游有问题/.test(execMsg)) return null;
	const me = execMsg.match(/· 你是 ([^）\n]+)）/)?.[1]?.trim() ?? "我";
	const id = execMsg.match(/任务编号：(wi_[a-z0-9]+)/)?.[1];
	const askMode = /先问一下/.test(execMsg);
	const asked = did(askMode ? "ask_colleague" : "report_upstream");
	// 回答 / 新版本是插话送进来的；提问者没在跑时带着回答重新开始，回答写在这次执行说明里
	const answered = askMode ? users.slice(1).some((t) => /回答了你的提问/.test(t)) || /回答了你的提问/.test(execMsg) : users.slice(1).some((t) => /出了新版本/.test(t));
	if (!asked && !answered) {
		if (askMode) {
			// 名单在任务执行说明里（帮手的系统提示没有群规则），群会话里在系统提示里
			const block = `${execMsg}\n${systemPrompt}`.match(/这些助理：\n([\s\S]*?)\n成员的名字一律以这份名单为准/)?.[1] ?? "";
			const roster = [...block.split("\n")].map((l) => ({ name: l.match(/^- ([^（：\n]+)/)?.[1]?.trim() ?? "", mgr: l.includes("（管理者）") })).filter((x) => x.name && x.name !== me);
			const other = roster.find((x) => !x.mgr) ?? roster[0];
			return fauxAssistantMessage([fauxToolCall("ask_colleague", { to: other?.name ?? "管理者", question: "先问一下：这份交付的数据口径按哪个版本来？" })]);
		}
		const up = execMsg.match(/前置任务「[^」]*」（编号 (wi_[a-z0-9]+)/)?.[1];
		return fauxAssistantMessage([fauxToolCall("report_upstream", { workItemId: up ?? "", issue: "上游成果的第 3 行检查点没有来源链接，请补上后重新提交" })]);
	}
	const waits = results.filter((m) => m.toolName === "bash").length;
	if (!answered && waits < MAX_WAITS) return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1; echo 等同事回复，先做不依赖它的部分" })]);
	// 收到回答（或等够了）：按原流程交付提交
	if (last.role === "toolResult" && last.toolName === "work_submit") return fauxAssistantMessage(`${me}：已提交结果：out.txt（第 3 行检查点），等待核验。`);
	if (last.role === "toolResult" && last.toolName === "deliver_file") {
		const said = askMode ? ([...users].map((t) => t.match(/回答了你的提问「[^」]*」（提问编号 ask_[a-z0-9]+）：([^\n]*)/)?.[1]).filter(Boolean).pop() ?? "") : "";
		const result = `已交付 out.txt（群附件），第 3 行写着检查点；来源链接在文件末尾${said ? `；按同事的回答「${said.slice(0, 60)}」处理` : ""}${askMode ? "" : "；已按上游的新版本更新"}`;
		return fauxAssistantMessage([fauxToolCall("work_submit", { result, handoff: "产物是 out.txt，第 3 行是检查点；接手的人直接看这份文件就行，没有遗留问题。", files: ["out.txt"], ...(id ? { workItemId: id } : {}) })]);
	}
	if (last.role === "toolResult" && last.toolName === "write") return fauxAssistantMessage([fauxToolCall("deliver_file", { path: "out.txt", caption: `${me}：任务交付 out.txt` })]);
	return fauxAssistantMessage([fauxToolCall("write", { path: "out.txt", content: "# 季度报告\n\n数据来源：Q3 内部表\n\n第 3 行检查点：每个结论都有来源链接\n" })]);
}
