/** 出方案卡的工具参数（群聊 room_plan 和单聊 chat_plan 共用；字段和 plan.ts 的 ProjectPlan 对应）。 */
import { Type } from "typebox";

export const PLAN_FIELDS = {
	goal: Type.String({ description: "要做成什么（一两句）" }),
	doneCriteria: Type.String({ description: "做到什么程度算完成（可检查）" }),
	assumptions: Type.Optional(Type.Array(Type.String(), { description: "我们的理解 / 假设，最关键的放前面" })),
	roles: Type.Array(Type.Object({ member: Type.String({ description: "群成员名字（含你自己）" }), does: Type.String({ description: "负责什么" }) }), { description: "分工（含管理者自己）" }),
	stages: Type.Array(Type.Object({ name: Type.String(), output: Type.String({ description: "这个阶段交出什么" }) }), { description: "分几个阶段" }),
	checkpoints: Type.Optional(Type.Array(Type.String(), { description: "哪几个关键点会请用户看一眼" })),
	deliverables: Type.String({ description: "最后交给用户什么" }),
	needs: Type.Optional(Type.String({ description: "需要用户提供什么，没有就不写" })),
	scale: Type.Optional(Type.String({ description: "规模感：大概多久、工作量的量级，不写精确数字" })),
};
