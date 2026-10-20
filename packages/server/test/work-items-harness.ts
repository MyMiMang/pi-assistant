import "./setup.ts";
import assert from "node:assert/strict";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

/**
 * 长期任务测试共用的环境（work-items.test.ts、work-items-ladder.test.ts 共用）：
 * 长期任务（任务责任）与单次执行分离的定向测试。
 *
 * 边界：只读写本进程临时数据目录（test/setup.ts 强制），不起模型 / 浏览器 / 付费调用。
 * 执行是负责人在自己的隐藏任务会话上派的帮手（work-items/exec.ts → spawnSubagent kind=work）：这里装一个可控的帮手 driver——
 * 帮手的执行挂起等测试决定怎么结束（完成 / 出错 / 被停）；群会话的回合（管理者被唤醒）用假的 AgentRuntime.turn 立即结束并记下来。
 */
process.env.PIA_MOCK = "1";
export const { db, now } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore()); // 只用内存凭据：帮手按 mock 模型登记，不调用任何真实模型
export const R = await import("../src/runtime.ts");
export const S = await import("../src/subagents.ts");
export const rooms = await import("../src/rooms/index.ts");
export const W = await import("../src/work-items.ts");
export const { requests } = await import("../src/requests.ts");
export const { roomOfConversation } = await import("../src/messages.ts");

export type Res = { ok: boolean; aborted: boolean; error?: string; text: string; tokens: number };
export type Call = { agentId: string; conv: string; prompt: string; helperId?: string; finish: (r?: Partial<Res>) => void; done: boolean };
export const calls: Call[] = [];
const proto = Object.getPrototypeOf(R.runtime("wm", "conv_probe")) as Record<string, unknown>;
proto.turn = function (this: { id: string; conversationId: string }, prompt: string) {
	calls.push({ agentId: this.id, conv: this.conversationId, prompt, done: true, finish: () => {} });
	return Promise.resolve<Res>({ ok: true, aborted: false, text: "", tokens: 0 }); // 群会话：管理者被唤醒的回合直接结束
};
proto.modelFor = () => ({ provider: "mock", id: "echo" });
S.setSubagentDriver({
	run: (r, connect, input) => new Promise<string>((resolve, reject) => {
		const c: Call = { agentId: r.agent_id, conv: r.conversation_id, prompt: input?.text ?? r.task, helperId: r.id, done: false, finish: (x = {}) => {
			if (c.done) return;
			c.done = true;
			if (x.error) reject(new Error(x.error));
			else resolve(x.text ?? "");
		} };
		calls.push(c);
		connect(async () => c.finish({ aborted: true }), async () => {});
	}),
	notify: async () => {},
});

export const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const mkAgent = (id: string, name: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#111", now());
mkAgent("wm", "经理");
mkAgent("wa", "甲");
mkAgent("wb", "乙");
mkAgent("wc", "丙");

export const room = rooms.createRoom({ name: "长期任务群", memberIds: ["wm", "wa", "wb"], managerId: "wm" });
export const otherRoom = rooms.createRoom({ name: "另一个群", memberIds: ["wm", "wc"], managerId: "wm" });
export type Actor = { kind: "user" } | { kind: "agent"; agentId: string; roomId?: string };
export const user: Actor = { kind: "user" };
export const mgr: Actor = { kind: "agent", agentId: "wm", roomId: room.id };
export const a: Actor = { kind: "agent", agentId: "wa" };
export const b: Actor = { kind: "agent", agentId: "wb" };

export function makeItem(owner = "wa", start = false, roomId = room.id) {
	return W.createWorkItem({ roomId, title: `任务${Math.random().toString(36).slice(2, 6)}`, requirement: "写一份可检查的结果", doneCriteria: "结果里能看到检查点", ownerAgentId: owner, start }, user).item.id;
}
export const row = (id: string) => W.getWorkItemDetail(id).item;
export const runRows = (itemId: string) => db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ? ORDER BY created_at, rowid").all(itemId) as unknown as { id: string; revision: number; status: string; result: string | null; submitted_at: number | null; exec_kind: string }[];
export const lastExec = (itemId: string) => [...calls].reverse().find((c) => W.execOf(c.conv)?.work_item_id === itemId);
export const wakes = (roomId: string) => (db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ? AND reason = 'check'").get(roomId) as { n: number }).n;
export const checkPrompts = () => calls.filter((c) => /任务看板有变化/.test(c.prompt)).map((c) => c.prompt);
export async function started(itemId: string) {
	await settle();
	const c = lastExec(itemId);
	assert.ok(c && !c.done, "执行已经在负责人的任务会话里开始");
	return c!;
}
export const submit = (c: Call, p: { result?: string; blocker?: string }, actor: Actor = { kind: "agent", agentId: c.agentId }) => W.submitWorkItem({ workItemId: W.execOf(c.conv)!.work_item_id, conversationId: c.conv, actor, ...p });
