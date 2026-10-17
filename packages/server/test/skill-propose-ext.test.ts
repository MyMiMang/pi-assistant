/**
 * ext-skills：本轮证据（不再从 toolCall 猜产出、不把正常回复当“做完了”）+ skill_propose 工具接线。
 * 只测扩展本身（fake ExtensionAPI），不起 Pi 会话。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { NUDGE_TYPE, readTurnEvidence, skillsExtension, type SkillsHost } from "@pi-assistant/ext-skills";

test("本轮证据：只认用户原话轮次；工具调用参数不算产出；正常回复/stopReason done 不等于完成", () => {
	const msgs = [
		{ role: "user", content: [{ type: "text", text: "把会议录音转成纪要" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "我先看一下录音。" },
				{ type: "toolCall", name: "write", arguments: { path: "/tmp/纪要.md" } },
				{ type: "toolCall", name: "read", arguments: { path: "/skills/weekly-sales/SKILL.md" } },
			],
			stopReason: "toolUse",
		},
		{ role: "toolResult", isError: false },
		{ role: "assistant", content: [{ type: "text", text: "整理好了，纪要在这里。" }], stopReason: "done" },
	];
	const ev = readTurnEvidence(msgs as never);
	assert.deepEqual(ev.tools, ["write", "read"]);
	assert.deepEqual(ev.usedSkills, ["weekly-sales"]);
	assert.equal(ev.reply, "整理好了，纪要在这里。");
	assert.equal(ev.ok, true); // 只表示没有明显失败
	assert.ok(!("artifacts" in ev));
	assert.ok(!("done" in ev));
	// 报错/中断 → ok=false
	assert.equal(readTurnEvidence([...msgs, { role: "assistant", content: [{ type: "text", text: "出错了" }], stopReason: "error" }] as never).ok, false);
	assert.equal(readTurnEvidence([msgs[0], msgs[1], { role: "toolResult", isError: true }] as never).ok, false);
});

function fakePi() {
	const tools: { name: string; execute: (id: string, p: Record<string, string>) => Promise<unknown> }[] = [];
	const handlers: Record<string, (e: Record<string, unknown>) => void> = {};
	return {
		tools,
		handlers,
		pi: { on: (ev: string, fn: (e: Record<string, unknown>) => void) => (handlers[ev] = fn), registerTool: (t: never) => tools.push(t) } as never,
	};
}
const baseHost = (): SkillsHost => ({
	list: () => [],
	get: () => undefined,
	search: () => [],
	dupThreshold: 0.45,
	save: (i) => ({ name: i.name, path: "/tmp", version: 1 }),
	remove: () => true,
	confirmCreate: async () => true,
	confirmUpdate: async () => true,
	confirm: async () => true,
});
const txt = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

test("只有给了 propose 才注册 skill_propose；字段原样交给宿主，按用户决定回话", async () => {
	const noPropose = fakePi();
	skillsExtension(baseHost())(noPropose.pi);
	assert.ok(!noPropose.tools.some((t) => t.name === "skill_propose"));

	const seen: unknown[] = [];
	let status = "accepted";
	const host: SkillsHost = {
		...baseHost(),
		propose: async (i) => {
			seen.push(i);
			return { status: status as "accepted" };
		},
	};
	const p = fakePi();
	skillsExtension(host)(p.pi);
	const tool = p.tools.find((t) => t.name === "skill_propose")!;
	const out = await tool.execute("x", { suggestionId: "sg1", subject: "会议纪要整理", does: "从录音整理议题、决定和负责人", when: "下次整理会议录音", gives: "带待办清单的纪要" });
	assert.deepEqual(seen[0], {
		suggestionId: "sg1",
		purpose: { subject: "会议纪要整理", does: "从录音整理议题、决定和负责人", when: "下次整理会议录音", gives: "带待办清单的纪要" },
	});
	assert.match(txt(out), /skill_search/);
	assert.match(txt(out), /skill_save/);
	status = "declined";
	assert.match(txt(await tool.execute("x", { suggestionId: "sg1", subject: "a", does: "bbbb", when: "cccc", gives: "dd" })), /不要保存/);
	status = "muted";
	assert.match(txt(await tool.execute("x", { suggestionId: "sg1", subject: "a", does: "bbbb", when: "cccc", gives: "dd" })), /已经关闭/);
	status = "rejected";
	assert.match(txt(await tool.execute("x", { suggestionId: "sg1", subject: "a", does: "bbbb", when: "cccc", gives: "dd" })), /不能提这个建议/);
});

test("agent_end 只把用户原话轮次交给建议（nudge/custom 轮不触发）", () => {
	const turns: unknown[] = [];
	const p = fakePi();
	skillsExtension({ ...baseHost(), observe: (t) => turns.push(t) })(p.pi);
	// 用户轮
	p.handlers.before_agent_start({ messageType: "user", prompt: "把会议录音转成纪要" });
	p.handlers.agent_end({ messages: [{ role: "assistant", content: [{ type: "text", text: "好了" }], stopReason: "done" }] });
	assert.equal(turns.length, 1);
	assert.equal((turns[0] as { userText: string }).userText, "把会议录音转成纪要");
	// 扩展触发的隐藏轮（nudge）没有用户 prompt
	p.handlers.before_agent_start({ messageType: "custom", prompt: "" });
	p.handlers.agent_end({ messages: [{ role: "assistant", content: [{ type: "text", text: "好了" }], stopReason: "done" }] });
	assert.equal(turns.length, 1);
	// 即使是 nudge 消息，也不当用户轮
	p.handlers.before_agent_start({ messageType: "user", prompt: "把会议录音转成纪要" });
	p.handlers.agent_end({ messages: [{ role: "user", customType: NUDGE_TYPE, content: [] }, { role: "assistant", content: [{ type: "text", text: "好了" }] }] });
	assert.equal(turns.length, 1);
});
