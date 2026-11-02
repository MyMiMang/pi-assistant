/**
 * @pi-assistant/ext-proactive —— 主动性（Pi 扩展）。
 *  - followup_schedule / followup_list / followup_cancel：助理自己约定“下午 5 点再看看”，到点系统唤醒它（遵守免打扰）。
 *  - proactive_surface（只在主动巡检里有）：把值得告诉用户的事放进“提醒”收件箱；是否推送由系统按主动等级、每日预算、免打扰、去重决定。
 * 主动 ≠ 自主对外发送：这些工具只会联系用户本人；任何对外发送仍需用户批准。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SurfaceKind = "followup" | "reminder" | "email" | "suggest_routine" | "suggest_skill" | "brief" | "other";
export interface SurfaceInput {
	kind: SurfaceKind;
	title: string;
	body: string;
	importance: 1 | 2 | 3;
	dedupeKey?: string;
	/** 写进哪个相关对话（不填 = 系统按最近的对话 / 渠道选）；只能填当前助理自己的非隐藏对话 */
	conversationId?: string;
}
export interface ProactiveHost {
	/** 只有主动巡检任务里才有 */
	surface?(i: SurfaceInput): { status: "delivered" | "inbox" | "held" | "rejected"; reason?: string };
	/** 主动推进：在相关对话的主会话里继续做事（走正常权限，心跳本身没有额外权限）。只有主动巡检里才有。 */
	advance?(i: {
		kind: SurfaceKind;
		title: string;
		body: string;
		importance: 1 | 2 | 3;
		dedupeKey?: string;
		/** 单聊里推进 / 群里推进（二选一） */
		conversationId?: string;
		roomId?: string;
		/** 用户明确交代过的事 + 依据原话；其余要靠命中「可以放心做的事」规则才放行 */
		explicit?: boolean;
		helpful?: boolean;
		evidence?: string;
		ruleAssessments?: { ruleId: string; matched: boolean; reason: string }[];
	}): Promise<{ status: "started" | "steered" | "queued" | "inbox" | "held" | "rejected" | "cancelled"; reason?: string }>;
	schedule(i: { dueAt: number; note: string }): { id: string; dueAt: number };
	list(): { id: string; dueAt: number; note: string }[];
	cancel(id: string): boolean;
	/** 解析时间：ISO / "17:00" / "+2h" / "明天 9:00" 等 → 时间戳；不合法抛错 */
	parseWhen(s: string): number;
	fmt(t: number): string;
}
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function proactiveExtension(host: ProactiveHost) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "followup_schedule",
			label: "约定稍后跟进",
			description:
				"约定稍后回来跟进一件事（例如你说了“我下午 5 点再帮你看看”）。到点时系统会在后台唤醒你，带上这条备注（在群里约的，到点会在群里叫醒你，直接在群里发言）。核实原对话：需求明确且仍在原授权内就实际推进并交付，不只发提醒；需求不清或新增有后果的范围先问，用户停止/权限/预算限制仍有效。不需要用户批准，但要在回复里告诉用户你约了什么时间。不要用它代替定时任务（重复执行的用 routine_create）。",
			promptSnippet: "followup_schedule: 约定稍后跟进（说了“我晚点再看”就要真的约上）",
			parameters: Type.Object({
				when: Type.String({ description: "什么时候：ISO 时间，或 \"17:00\"（今天，已过则明天）、\"+90m\"、\"+2h\"、\"+1d\"、\"明天 9:00\"；用户时区 Asia/Shanghai；5 分钟到 30 天之内" }),
				note: Type.String({ description: "到点时要做什么、为什么（到点时你看不到当前对话，写清楚上下文）" }),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async execute(_id, p) {
				try {
					const r = host.schedule({ dueAt: host.parseWhen(p.when), note: p.note });
					return text(`已约定 ${host.fmt(r.dueAt)} 跟进（${r.id}）。`);
				} catch (e) {
					return text(`没能约上：${e instanceof Error ? e.message : String(e)}`);
				}
			},
		});
		pi.registerTool({
			name: "followup_list",
			label: "查看约定的跟进",
			description: "列出你约定好、还没到点的跟进。",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			async execute() {
				const l = host.list();
				return text(l.length ? l.map((f) => `- ${f.id} · ${host.fmt(f.dueAt)} · ${f.note}`).join("\n") : "没有待跟进的事。");
			},
		});
		pi.registerTool({
			name: "followup_cancel",
			label: "取消跟进",
			description: "取消一个约定的跟进（事情已经解决或用户说不用了）。",
			parameters: Type.Object({ id: Type.String() }),
			annotations: { readOnlyHint: false, destructiveHint: false },
			async execute(_id, p) {
				return text(host.cancel(p.id) ? "已取消。" : `没有找到 ${p.id}`);
			},
		});
		const surface = host.surface;
		if (!surface) return;
		pi.registerTool({
			name: "proactive_surface",
			label: "告诉用户",
			description:
				"把一件真正值得用户知道的事放进“提醒”（App 里的收件箱），必要时推送给用户。系统会按主动等级、每日条数预算、免打扰时段、去重和用户以前的忽略来决定是否真的推送。宁缺毋滥：没有值得说的就不要调用。",
			parameters: Type.Object({
				kind: Type.Union(["followup", "reminder", "email", "suggest_routine", "suggest_skill", "brief", "other"].map((k) => Type.Literal(k)) as never, { description: "followup 未完成事项跟进 / reminder 用户提过的事 / email 重要新邮件 / suggest_routine 建议定时任务 / suggest_skill 建议技能 / brief 每日简报 / other" }),
				title: Type.String({ description: "一句话标题（≤40 字）" }),
				body: Type.String({ description: "简短正文：发生了什么、为什么现在告诉用户、建议怎么做（≤300 字，像朋友发消息一样自然）" }),
				importance: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)], { description: "1 可有可无（只进收件箱）/ 2 值得知道 / 3 重要且有时效" }),
				dedupeKey: Type.Optional(Type.String({ description: "去重键：同一件事用同一个键（例如 email:<Message-ID>、task:<id>、remind:<事>）" })),
				conversationId: Type.Optional(Type.String({ description: "写进哪个相关对话（不填由系统选）；只能填这个助理自己的非隐藏对话" })),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async execute(_id, p) {
				const r = surface(p as unknown as SurfaceInput);
				const msg = { delivered: "已告诉用户。", inbox: "已放进收件箱（没有推送）。", held: "已放进收件箱，免打扰结束后再推送。", rejected: "没有发出。" }[r.status];
				return text(`${msg}${r.reason ? `（${r.reason}）` : ""}`);
			},
		});
		const advance = host.advance;
		if (!advance) return;
		pi.registerTool({
			name: "proactive_advance",
			label: "在对话里推进",
			description:
				"主动去做事时用它（做事不算打扰）：用户已经明确交代、属于原授权范围的事（explicit=true + evidence 写原话），用户已经开始的事情里看得出能帮上的一步（卡住的任务、快到期的事、明显的下一步，helpful=true + evidence 写事实），或对上了巡检提示里用户写的「可以放心做的事」规则的事（ruleAssessments 对每条规则写 matched + reason）。单聊用 conversationId，让主会话继续把事做完；群里的事用 roomId，在群里叫醒你自己发言（不要只发提醒、也不要再问「要不要我做」）。用户没提过的全新的事、又没对上规则的，系统会自动转成提醒；试运行模式下只记成「本来会做」的卡片。会走用户平时的权限规则（完全权限免审批，其他档位审批），心跳任务本身没有额外权限；对话正忙时同一件事合并、不同的事排队，不把巡检摘要当用户插话。需求含糊、涉及新的对外承诺/支出/破坏性改动/权限变更时先问用户，不要猜；用户停止/取消或预算受限时不要继续。主动开关、去重/静音、停止和原有巡检调度仍有效；推进与推送条数分开，每助理每天最多12次自主推进、每对话最多3条排队。排队不等于已执行，执行一轮结束也不证明目标完成。",
			parameters: Type.Object({
				conversationId: Type.Optional(Type.String({ description: "在哪个单聊里推进（这个助理自己的非隐藏对话 id）；群里的事不填，填 roomId" })),
				roomId: Type.Optional(Type.String({ description: "在哪个群里推进（你在的群的 id，见「你在的群」）；填了会在群里叫醒你发言，群已停止则只记一条" })),
				explicit: Type.Optional(Type.Boolean({ description: "这件事是用户明确交代过的（目标清楚、在原授权内）。不是的话不要填 true" })),
				helpful: Type.Optional(Type.Boolean({ description: "用户已经开始的事情里看得出能帮上的一步（卡住的任务、快到期的事、明显的下一步）。全新的事不要填 true" })),
				evidence: Type.Optional(Type.String({ description: "依据的原话：用户说过的话，或规则对上的事实（explicit / helpful=true 或命中规则时必填）" })),
				ruleAssessments: Type.Optional(Type.Array(Type.Object({ ruleId: Type.String({ description: "规则编号（巡检提示里 [rule:xxx] 的 xxx）" }), matched: Type.Boolean(), reason: Type.String({ description: "为什么对上 / 没对上" }) }), { description: "对每条启用的规则写一条研判（没有规则时传空数组）；编号必须真实存在、不能重复" })),
				kind: Type.Union(["followup", "reminder", "email", "suggest_routine", "suggest_skill", "brief", "other"].map((k) => Type.Literal(k)) as never, { description: "同 proactive_surface" }),
				title: Type.String({ description: "一句话标题（≤40 字）" }),
				body: Type.String({ description: "要推进什么、为什么（≤300 字，写清楚上下文）" }),
				importance: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
				dedupeKey: Type.Optional(Type.String({ description: "去重键：同一件事用同一个键" })),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async execute(_id, p) {
				const r = await advance(p as never);
				const msg = { started: "已开始推进。", steered: "同一件事正在推进，已合并。", queued: "对话正忙，已排队。", inbox: "已放进收件箱（没有推进）。", held: "已放进收件箱，免打扰结束后再推送。", rejected: "没有推进。", cancelled: "已取消，没有再推进。" }[r.status];
				return text(`${msg}${r.reason ? `（${r.reason}）` : ""}`);
			},
		});
	};
}
