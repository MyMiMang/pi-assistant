/**
 * 群聊里的 Mock 行为（e2e 用，从 mock-provider.ts 拆出来控制单文件行数）：
 * 管理者“派给X”就分配，“循环”时每次总结都再派一次；成员完成后回报；立项 / 确认方案见 room_plan / room_project_start。
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { Msg } from "./mock-provider.ts";

const textOf = (m: Msg) =>
	typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "";

export function imageCount(m: Msg | undefined) {
	return m && Array.isArray(m.content) ? (m.content as { type?: string }[]).filter((b) => b.type === "image").length : 0;
}
/** 管理者最近一次 room_plan 调用里填的阶段（历史里的 toolCall）。 */
function planStagesFromHistory(messages: Msg[]) {
	for (const m of [...messages].reverse()) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of [...(m.content as { type?: string; name?: string; arguments?: { stages?: { name?: string; output?: string }[] } }[])].reverse()) {
			if (b.type === "toolCall" && b.name === "room_plan") return (b.arguments?.stages ?? []).map((x) => ({ name: String(x.name ?? "").trim(), output: String(x.output ?? "").trim() })).filter((x) => x.name);
		}
	}
	return [];
}
/**
 * 管理者正忙时用户在群里说的话会以「（用户在群里说）…」插话进来（scheduler 的 steer），不带群消息的抬头。
 * 群会话（系统提示的名单里有「（你）」）里把它换成「上一条群消息的抬头 + 【用户】…」交给 roomReply；不是群会话返回 null。
 */
export function roomSteerPrompt(u: string, systemPrompt: string, messages: Msg[]) {
	const body = u.match(/^(?:（你工作时用户发来的新消息）\n?)?（用户在群里说）([^\n]*)/)?.[1];
	if (body === undefined || !/^- [^\n]*（你）/m.test(systemPrompt)) return null;
	const head = messages.map(textOf).reverse().find((t) => t.startsWith("（群聊「"))?.split("\n")[0];
	return head ? `${head}\n【用户】${body}` : null;
}
export function roomReply(u: string, systemPrompt: string, last: Msg, messages: Msg[]) {
	const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
	const paths = [...textOf(lastUserMsg ?? last).matchAll(/ → (room-files\/\S+?)[、）\n]/g)].map((x) => x[1]);
	const imgs = imageCount(lastUserMsg);
	const seen = paths.length || imgs ? `（看到附件：${paths.join("、") || "无路径"}；图片 ${imgs} 张）` : "";
	const me = u.match(/· 你是 ([^（）\n]+)/)?.[1]?.trim() ?? "我";
	// 用户最近说的话：从整段会话里找（管理者总结时这一轮注入里可能没有用户的话）
	const users = messages.filter((m) => m.role === "user").flatMap((m) => {
		const steer = textOf(m).match(/^(?:（你工作时用户发来的新消息）\n?)?（用户在群里说）([^\n]*)/);
		return steer ? [steer[1]] : [...textOf(m).matchAll(/【用户】([^\n]*)/g)].map((x) => x[1]);
	});
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
	// 群协作验收：用户说「定个目标」或「立项」→ room_plan 出一份通用方案卡；用户说「可以」/「就这么干」且有待确认的方案 → room_project_start；
	// 看板唤醒时只对「需拍板」的卡住任务 work_ask_user
	if (!isFollowup && u.includes("（管理者）") && /定个目标|立项/.test(said) && last.role !== "toolResult") {
		const goal = said.replace(/^.*?(定个目标|立项)[：:]?/, "").trim() || said;
		// 只在「这些助理：」这段名单里找名字，别被 systemPrompt 里 Pi 自带的工具列表（也是「- xxx: ...」的格式）混进来。
		const rosterBlock = systemPrompt.match(/这些助理：\n([\s\S]*?)\n成员的名字一律以这份名单为准/)?.[1] ?? "";
		const roster = [...rosterBlock.matchAll(/^- ([^（：\n]+)/gm)].map((x) => x[1].trim());
		const other = roster.find((n) => n !== me) ?? "成员";
		return fauxAssistantMessage([
			fauxToolCall("room_plan", {
				title: goal.slice(0, 40) || "新项目",
				goal,
				doneCriteria: "交付物都经过核验，用户确认满意",
				assumptions: ["按常见做法推进，没写清楚的细节按经验补上", "交付前会请你确认一次"],
				roles: [{ member: me, does: "拆解任务、协调与核验，向你汇总" }, { member: other, does: "具体执行并产出交付物" }],
				stages: [{ name: "准备", output: "明确范围和草稿" }, { name: "完成", output: "最终交付物" }],
				checkpoints: ["草稿出来后请你看一眼方向对不对"],
				deliverables: goal,
				needs: "",
				scale: "大概几天内完成",
			}),
		]);
	}
	if (!isFollowup && u.includes("（管理者）") && /可以|就这么干/.test(said) && last.role !== "toolResult") {
		const planResult = [...messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "room_plan");
		const pid = planResult && textOf(planResult).match(/项目编号 (pj_[a-z0-9]+)/)?.[1];
		if (pid) return fauxAssistantMessage([fauxToolCall("room_project_start", { projectId: pid })]);
	}
	if (last.toolName === "room_plan") return fauxAssistantMessage(`${me}：好的。`);
	// 项目确认后的那次唤醒（决策 0019 第 3 步）：按方案阶段建任务，一个阶段一个任务，stage 填阶段名，第二个起 after 前一个；
	// 建完就不再重复（createdIds.length >= stages.length），兼容「可以」确认同一轮直接继续、也兼容用户点按钮确认后另一次唤醒。
	// 这一回合里项目是刚被管理者确认开始的（用户在群里说「可以」，工具返回「开始了」）也要把阶段都建完：不能只看 last 是不是 room_project_start，
	// 否则建出第一个任务后条件就不成立了；工具报错（项目早就在进行，比如用户答复关键点时说的「可以，继续」）不算，免得重复建任务。
	// 阶段取自这一轮用的方案（系统提示里的阶段行只在项目已开始的会话里才有，会话没重建时读不到，所以回头看管理者自己出方案时填的阶段）。
	const startedNow = since.some((m) => m.role === "toolResult" && m.toolName === "room_project_start" && /开始了/.test(textOf(m)));
	if (startedNow || /把第一批任务派给对口成员|按新方案调整任务/.test(u)) {
		const stageLine = systemPrompt.match(/阶段：([^\n]+)/)?.[1] ?? "";
		const fromPrompt = [...stageLine.matchAll(/\d+\.\s*([^→；]+?)(?:\s*→\s*([^；]+))?(?=；|$)/g)].map((m) => ({ name: m[1].trim(), output: (m[2] ?? "").trim() }));
		const stages = fromPrompt.length ? fromPrompt : planStagesFromHistory(messages);
		if (stages.length) {
			const rosterBlock = systemPrompt.match(/这些助理：\n([\s\S]*?)\n成员的名字一律以这份名单为准/)?.[1] ?? "";
			const roster = [...rosterBlock.matchAll(/^- ([^（：\n]+)/gm)].map((x) => x[1].trim());
			const other = roster.find((n) => n !== me) ?? "成员";
			const planResult = [...messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "room_plan");
			const pid = planResult && textOf(planResult).match(/项目编号 (pj_[a-z0-9]+)/)?.[1];
			const createdIds = since
				.filter((m) => m.role === "toolResult" && m.toolName === "work_create")
				.map((m) => textOf(m).match(/编号 (wi_[a-z0-9]+)/i)?.[1])
				.filter((x): x is string => !!x);
			if (createdIds.length < stages.length) {
				const stage = stages[createdIds.length];
				const prev = createdIds[createdIds.length - 1];
				return fauxAssistantMessage([
					fauxToolCall("work_create", {
						title: stage.name,
						requirement: stage.output || stage.name,
						doneCriteria: stage.output ? `完成：${stage.output}` : `完成「${stage.name}」`,
						owner: other,
						stage: stage.name,
						...(prev ? { after: [prev] } : {}),
						...(pid ? { projectId: pid } : {}),
					}),
				]);
			}
			return fauxAssistantMessage(`${me}：已经按方案把 ${stages.length} 个阶段的任务都派下去了。`);
		}
		if (last.toolName === "room_project_start") return fauxAssistantMessage(`${me}：好的。`);
	}
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
			return fauxAssistantMessage([
				fauxToolCall("work_submit", {
					result: "已交付 out.txt（群附件），第 3 行写着检查点；来源链接在文件末尾",
					handoff: "产物是 out.txt，第 3 行是检查点；接手的人直接看这份文件就行，没有遗留问题。",
					files: ["out.txt"],
					...(id ? { workItemId: id } : {}),
				}),
			]);
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
