/**
 * @pi-assistant/ext-routines —— 让助理创建/管理定时任务（Pi 扩展）。
 * 创建与修改都会先在聊天里弹出审批卡片，用户批准后才生效。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface RoutineSpec {
	name: string;
	prompt: string;
	trigger: "cron" | "webhook";
	cron?: string;
	quietHours?: boolean;
}
export interface RoutinesHost {
	list(): { id: string; name: string; trigger: string; cron: string | null; status: string; nextRunAt: number | null }[];
	/** 校验参数，返回给用户看的说明（如“每天 08:00（Asia/Shanghai），下次：…”）；不合法时抛错 */
	describe(spec: RoutineSpec): string;
	/** 请求批准；返回是否批准 */
	confirm(summary: string, spec: Record<string, unknown>): Promise<boolean>;
	create(spec: RoutineSpec): { id: string; webhookUrl?: string | null };
	update(id: string, spec: Partial<RoutineSpec>): { id: string };
	setStatus(id: string, status: "active" | "paused"): boolean;
	remove(id: string): boolean;
}
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
const SPEC = {
	name: Type.String({ description: "简短名称，如“每日新闻摘要”" }),
	prompt: Type.String({ description: "到点时要执行的完整、自包含的指令（执行时看不到当前对话）" }),
	trigger: Type.Union([Type.Literal("cron"), Type.Literal("webhook")]),
	cron: Type.Optional(Type.String({ description: "5 段 cron（分 时 日 月 周），按用户时区 Asia/Shanghai，例如 每天 8 点 = \"0 8 * * *\"；间隔不得小于 5 分钟" })),
	quietHours: Type.Optional(Type.Boolean({ description: "是否遵守这个助理的免打扰时段（时段内的执行顺延到结束；时段由用户在助理设置里统一设置），默认 true" })),
};

export function routinesExtension(host: RoutinesHost) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "routine_create",
			label: "创建定时任务",
			description: "创建定时任务（cron）或 Webhook 触发的任务：到点/收到请求时，系统会用保存的指令唤醒你在后台执行，结果发到聊天并推送给用户。会先请用户批准。",
			promptSnippet: "routine_create: 创建定时/Webhook 任务（需批准）",
			parameters: Type.Object(SPEC),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async execute(_id, p) {
				let desc: string;
				try {
					desc = host.describe(p);
				} catch (e) {
					return text(`参数有误：${e instanceof Error ? e.message : String(e)}`);
				}
				if (!(await host.confirm(`创建定时任务「${p.name}」：${desc}`, { ...p, 说明: desc }))) return text("用户没有批准创建这个定时任务。");
				const r = host.create(p);
				return text(`已创建定时任务（${r.id}）：${desc}${r.webhookUrl ? `\nWebhook 地址：${r.webhookUrl}` : ""}`);
			},
		});
		pi.registerTool({
			name: "routine_update",
			label: "修改定时任务",
			description: "修改已有定时任务的名称、指令或时间。会先请用户批准。",
			parameters: Type.Object({ id: Type.String(), ...Object.fromEntries(Object.entries(SPEC).map(([k, v]) => [k, Type.Optional(v as never)])) } as never),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async execute(_id, raw) {
				const { id, ...patch } = raw as unknown as { id: string } & Partial<RoutineSpec>;
				const cur = host.list().find((r) => r.id === id);
				if (!cur) return text(`没有找到定时任务 ${id}`);
				let desc = "";
				try {
					desc = host.describe({ name: cur.name, prompt: "-", trigger: (patch.trigger ?? cur.trigger) as "cron", cron: patch.cron ?? cur.cron ?? undefined, ...patch } as RoutineSpec);
				} catch (e) {
					return text(`参数有误：${e instanceof Error ? e.message : String(e)}`);
				}
				if (!(await host.confirm(`修改定时任务「${cur.name}」：${desc}`, patch as Record<string, unknown>))) return text("用户没有批准修改。");
				host.update(id, patch);
				return text(`已修改定时任务 ${id}：${desc}`);
			},
		});
		pi.registerTool({
			name: "routine_list",
			label: "查看定时任务",
			description: "列出你的定时任务（id、名称、触发方式、状态、下次执行时间）。",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			async execute() {
				const l = host.list();
				return text(l.length ? l.map((r) => `- ${r.id} ${r.name} [${r.trigger}${r.cron ? ` ${r.cron}` : ""}] ${r.status}${r.nextRunAt ? ` 下次 ${new Date(r.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : ""}`).join("\n") : "还没有定时任务。");
			},
		});
		pi.registerTool({
			name: "routine_control",
			label: "暂停/恢复/删除定时任务",
			description: "暂停、恢复或删除一个定时任务。删除会先请用户批准。",
			parameters: Type.Object({ id: Type.String(), action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("delete")]) }),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async execute(_id, p) {
				const cur = host.list().find((r) => r.id === p.id);
				if (!cur) return text(`没有找到定时任务 ${p.id}`);
				if (p.action === "delete") {
					if (!(await host.confirm(`删除定时任务「${cur.name}」`, { id: p.id }))) return text("用户没有批准删除。");
					host.remove(p.id);
					return text(`已删除定时任务「${cur.name}」`);
				}
				host.setStatus(p.id, p.action === "pause" ? "paused" : "active");
				return text(`已${p.action === "pause" ? "暂停" : "恢复"}定时任务「${cur.name}」`);
			},
		});
	};
}
