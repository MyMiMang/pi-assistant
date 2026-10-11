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
}
export interface ProactiveHost {
	/** 只有主动巡检任务里才有 */
	surface?(i: SurfaceInput): { status: "delivered" | "inbox" | "held" | "rejected"; reason?: string };
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
				"约定稍后回来跟进一件事（例如你说了“我下午 5 点再帮你看看”）。到点时系统会在后台唤醒你，带上这条备注；你再判断要不要告诉用户。不需要用户批准，但要在回复里告诉用户你约了什么时间。不要用它代替定时任务（重复执行的用 routine_create）。",
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
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async execute(_id, p) {
				const r = surface(p as unknown as SurfaceInput);
				const msg = { delivered: "已告诉用户。", inbox: "已放进收件箱（没有推送）。", held: "已放进收件箱，免打扰结束后再推送。", rejected: "没有发出。" }[r.status];
				return text(`${msg}${r.reason ? `（${r.reason}）` : ""}`);
			},
		});
	};
}
