/** 建群 / 加成员提议：规范化、选模型、确认创建；以及私聊里的 propose_room 工具。 */
import { THINKING_LEVEL_ORDER } from "@pi-assistant/shared";
import { Type } from "typebox";
import { bus } from "../bus.ts";
import { db, now } from "../db.ts";
import { insertMessage } from "../messages.ts";
import { models, defaultModel, defaultThinking, isThinkingLevel } from "../models.ts";
import { STRENGTHS, STRENGTH_LABEL, type Strength } from "../model-profile.ts";
import { getAgent, listAgents } from "../runtime.ts";
import { setAssignedSkillIds } from "../skill-assignments.ts";
import { listSkills } from "../skills.ts";
import { createRoom, updateRoom } from "./crud.ts";
import { cleanNeeds, configuredModels, modelProfiles, pickFor, roleNeeds } from "./model-pick.ts";
import { getRoom, membersOf } from "./store.ts";

export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** 可用的模型（只来自用户已配置的服务） */
export function availableModels() {
	return configuredModels();
}

export interface ProposalMember {
	/** 已有助理：只填 agentId */
	agentId?: string;
	name?: string;
	role?: string;
	persona?: string;
	skills?: string[];
	model?: { provider: string; id: string } | null;
	modelReason?: string;
	/**
	 * 用户在这个成员卡片上选的思考强度（Pi 的档位）。null / 缺省 / 不认识的值 = 跟默认（defaultThinking），
	 * 有值时由服务端按**这个成员实际用到的模型**收敛到合法档位（clampThinking），换模型同理。
	 * 已有助理（只填 agentId）忽略这个字段：不改用户原来那个助理的配置。
	 */
	thinking?: string | null;
	/** 这个角色需要的能力（建群时管理者填，服务端据此挑模型） */
	needs?: Strength[];
	avatar?: string;
	color?: string;
}
export interface RoomProposal {
	name: string;
	purpose: string;
	/** 管理者：成员下标 */
	manager: number;
	members: ProposalMember[];
}
const COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

/**
 * 提议里的思考强度 → 落库值：不认识的档位 / 缺省都回 null（新建成员走 defaultThinking）；
 * 有合法档位就按实际模型 clamp 成它支持的档位（与运行时 thinkingFor 同一份 Pi 元数据）。
 */
export function clampProposalThinking(thinking: unknown, model: { provider: string; id: string } | null): string | null {
	if (!isThinkingLevel(thinking)) return null;
	if (!model || !models?.getModel(model.provider, model.id)) return thinking;
	return models.clampThinking(model.provider, model.id, thinking);
}

/** 校验并补全提议（模型只能选已配置的；不认识的换成默认模型并说明） */
/**
 * 规范化提议。auto = 助理发起的提议：模型由服务端按角色需求打分挑（忽略助理自己点名的模型）；
 * 否则（用户在卡片上改过再确认）保留用户选的模型，没配置的退回默认模型。
 */
export function normalizeProposal(p: Partial<RoomProposal>, o: { auto?: boolean } = {}): RoomProposal {
	const avail = availableModels();
	const skills = new Set(listSkills().map((s) => s.name));
	const managerIdx = Number.isInteger(p.manager) ? p.manager! : 0;
	const profiles = o.auto ? modelProfiles() : [];
	const members = (Array.isArray(p.members) ? p.members : []).slice(0, 12).map((m, i): ProposalMember => {
		if (m.agentId && getAgent(m.agentId)) return { agentId: m.agentId };
		const want = m.model && typeof m.model === "object" ? m.model : typeof m.model === "string" ? { provider: String(m.model).split("/")[0], id: String(m.model).split("/").slice(1).join("/") } : null;
		const okModel = want && avail.some((x) => x.provider === want.provider && x.id === want.id) ? want : null;
		const def = models ? defaultModel() : null;
		const needs = cleanNeeds(m.needs);
		let model = okModel ?? def;
		let modelReason = okModel ? String(m.modelReason ?? "").slice(0, 200) : want ? `建议的模型 ${want.provider}/${want.id} 没有配置，先用默认模型` : String(m.modelReason ?? "默认模型").slice(0, 200);
		if (o.auto) {
			const pick = pickFor(roleNeeds({ needs, role: m.role, persona: m.persona }, i === managerIdx), profiles);
			model = pick.model;
			modelReason = pick.reason;
		}
		return {
			name: String(m.name ?? `成员${i + 1}`).trim().slice(0, 40) || `成员${i + 1}`,
			role: String(m.role ?? "").slice(0, 200),
			persona: String(m.persona ?? "").slice(0, 8000),
			skills: (m.skills ?? []).filter((s) => skills.has(s)),
			model,
			modelReason,
			thinking: clampProposalThinking(m.thinking, model),
			...(needs.length ? { needs } : {}),
			avatar: String(m.avatar ?? "").slice(0, 8) || undefined,
			color: m.color && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : COLORS[i % COLORS.length],
		};
	});
	const manager = Number.isInteger(p.manager) && p.manager! >= 0 && p.manager! < members.length ? p.manager! : 0;
	return { name: String(p.name ?? "").trim().slice(0, 40) || "新群聊", purpose: String(p.purpose ?? "").slice(0, 4000), manager, members };
}

/** 新建群专属助理（不出现在侧边栏，只在群成员里） */
export function createRoomAgent(roomId: string | null, m: ProposalMember, sort = 0) {
	const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
	const persona = [m.role ? `你在群里的角色：${m.role}` : "", m.persona ?? "", m.skills?.length ? `擅长使用这些技能：${m.skills.join("、")}` : ""].filter(Boolean).join("\n\n");
	const name = m.name ?? "成员";
	db.prepare("INSERT INTO agents(id, name, avatar, color, persona, description, model_provider, model_id, sort, created_at, scope, room_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
		id, name, [...(m.avatar || name)].slice(0, 2).join(""), m.color ?? COLORS[0], persona, (m.role ?? "").slice(0, 200), m.model?.provider ?? null, m.model?.id ?? null, 1000 + sort, now(), "room", roomId,
	);
	// 提议里给了合法档位就用它（已按这个成员的实际模型 clamp 过），否则保持原来的默认档行为
	db.prepare("UPDATE agents SET thinking = ? WHERE id = ?").run(m.thinking ?? defaultThinking(), id);
	// 群成员声明的 skills 落成真实的启用集合（canonical id），不只是写进 persona 说明
	const ids = [...new Set((m.skills ?? []).map((n) => listSkills().find((s) => s.name === n)?.id).filter((x): x is string => !!x))];
	if (ids.length) setAssignedSkillIds(id, ids);
	return id;
}

export async function confirmProposal(p: Partial<RoomProposal>) {
	const n = normalizeProposal(p);
	if (!n.members.length) throw new Error("至少要有一个成员");
	const { safeTier } = await import("./permissions.ts");
	const ids = n.members.map((m, i) => m.agentId ?? createRoomAgent(null, m, i));
	for (const id of ids) safeTier(id);
	const room = createRoom({ name: n.name, purpose: n.purpose, memberIds: ids, managerId: ids[n.manager] });
	db.prepare(`UPDATE agents SET room_id = ? WHERE scope = 'room' AND room_id IS NULL AND id IN (${ids.map(() => "?").join(",")})`).run(room.id, ...ids);
	bus.emit({ type: "agents.changed" });
	return room;
}

export async function confirmMemberProposal(roomId: string, m: ProposalMember) {
	const r = getRoom(roomId);
	if (!r) throw new Error("群不存在");
	const [n] = normalizeProposal({ name: r.name, members: [m] }).members;
	const id = n.agentId ?? createRoomAgent(roomId, n, membersOf(roomId, true).length);
	const { safeTier } = await import("./permissions.ts");
	safeTier(id);
	updateRoom(roomId, { memberIds: [...membersOf(roomId).map((x) => x.agent_id), id] });
	bus.emit({ type: "agents.changed" });
	return id;
}

export const memberSchema = Type.Object({
	name: Type.String({ description: "成员名字（简短，群里用 @名字 叫它）" }),
	role: Type.String({ description: "在群里负责什么（一句话）" }),
	persona: Type.String({ description: "这个成员的人设与工作方式（系统提示，几句话）" }),
	needs: Type.Optional(Type.Array(Type.Union(STRENGTHS.map((s) => Type.Literal(s))), { description: `这个角色最需要的能力（1~3 个）：${STRENGTHS.map((s) => `${s}=${STRENGTH_LABEL[s]}`).join("，")}。系统会据此从用户配置的模型里挑合适的` })),
	thinking: Type.Optional(Type.Union([...THINKING_LEVEL_ORDER.map((l) => Type.Literal(l)), Type.Null()], { description: "这个成员的思考强度；不填或 null = 跟默认。超出模型能力的档位会被服务端降到合法档位" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "适合用的技能名（只能是技能库里已有的）" })),
	avatar: Type.Optional(Type.String({ description: "一个 emoji" })),
});

export function modelsHint() {
	return availableModels().length ? "每个新成员用 needs 写清这个角色最需要的能力，系统会从用户已配置的模型里按能力和价格挑（不用你点名模型），用户还能在卡片上改。" : "用户还没有配置模型，不用填 needs 以外的模型信息。";
}

export function proposeRoomExt(agentId: string, conversationId: string | null) {
	return (pi: { registerTool: (t: unknown) => void }) => {
		pi.registerTool({
			name: "propose_room",
			label: "提议建群",
			description: `用户给你一个目标、希望几个助理一起完成时，分析需要哪些角色，提议建一个群聊：群名、群说明、管理者和成员（新建的群专属助理，也可以拉用户已有的助理）。会在聊天里出一张可编辑的提议卡片，用户确认后才会创建。${modelsHint()}`,
			parameters: Type.Object({
				name: Type.String({ description: "群名" }),
				purpose: Type.String({ description: "群说明：目标、分工、规则（所有成员都会看到）" }),
				manager: Type.Integer({ description: "管理者是 members 里的第几个（从 0 开始）" }),
				members: Type.Array(memberSchema),
				existingAgents: Type.Optional(Type.Array(Type.String(), { description: "要拉进群的已有助理名字" })),
			}),
			async execute(_id: string, p: { name: string; purpose: string; manager: number; members: ProposalMember[]; existingAgents?: string[] }) {
				const existing = (p.existingAgents ?? []).map((n) => listAgents().find((a) => a.name === n && (a as { scope?: string }).scope !== "room")).filter(Boolean).map((a) => ({ agentId: a!.id }));
				const proposal = normalizeProposal({ name: p.name, purpose: p.purpose, manager: p.manager, members: [...(p.members ?? []), ...existing] }, { auto: true });
				if (!proposal.members.length) return text("提议里至少要有一个成员。");
				insertMessage({ agentId, conversationId: conversationId ?? undefined, role: "card", meta: { kind: "room-proposal", proposal, status: "pending" } });
				return text("提议卡片已经发给用户。用户可以修改后点“确认创建”，确认前什么都不会创建。告诉用户你的思路，等他确认。");
			},
		});
	};
}
