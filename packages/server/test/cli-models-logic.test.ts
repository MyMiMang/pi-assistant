import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { matchContinuation, renderFreshInput, renderTranscript, thinkingToEffort, toolResultToMcp, userContentToClaude, userMessagesToClaude } from "../src/pi-adapter/cli-models/convert.ts";
import { makeSyncEntry, planTurn, prefixFingerprint, SyncStore } from "../src/pi-adapter/cli-models/sync-map.ts";

const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const asst = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content, api: "x", provider: "claude-code", model: "sonnet", usage, stopReason: "stop", timestamp: 1 });
const result = (id: string, text: string, isError = false): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "echo", content: [{ type: "text", text }], isError, timestamp: 1 });
const call = (id: string, name = "echo", args: Record<string, never> | Record<string, string> = {}) => ({ type: "toolCall" as const, id, name, arguments: args });
const system = { role: "system", content: "你是小微", timestamp: 0 } as const;

test("用户内容转 claude 内容块：文字和图片都带上，空文字块去掉", () => {
	assert.deepEqual(userContentToClaude("你好"), [{ type: "text", text: "你好" }]);
	assert.deepEqual(userContentToClaude(""), []);
	assert.deepEqual(userContentToClaude([{ type: "text", text: "看图" }, { type: "image", data: "QUJD", mimeType: "image/png" }, { type: "text", text: "" }]), [
		{ type: "text", text: "看图" },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
	]);
	assert.equal(userMessagesToClaude([user("a"), user([{ type: "image", data: "x", mimeType: "image/jpeg" }])]).length, 2);
});

test("工具结果转 MCP：文字、图片、出错标记；空结果给一句说明", () => {
	assert.deepEqual(toolResultToMcp({ content: [{ type: "text", text: "ok" }, { type: "image", data: "QUJD", mimeType: "image/png" }], isError: false }), {
		content: [{ type: "text", text: "ok" }, { type: "image", data: "QUJD", mimeType: "image/png" }],
	});
	assert.deepEqual(toolResultToMcp({ content: [{ type: "text", text: "坏了" }], isError: true }), { content: [{ type: "text", text: "坏了" }], isError: true });
	const empty = toolResultToMcp({ content: [], isError: true });
	assert.equal(empty.isError, true);
	assert.equal(empty.content.length, 1);
});

test("思考强度映射到 --effort", () => {
	assert.equal(thinkingToEffort(undefined), undefined);
	assert.equal(thinkingToEffort("off"), undefined);
	assert.equal(thinkingToEffort("minimal"), "low");
	for (const l of ["low", "medium", "high", "xhigh", "max"]) assert.equal(thinkingToEffort(l), l);
	assert.equal(thinkingToEffort("乱写"), undefined);
});

test("历史渲染成文字：新开会话的第一条消息 = 前文 + 这次的用户输入（图片原样保留）", () => {
	const msgs: Message[] = [system, user("第一句"), asst([{ type: "thinking", thinking: "想" }, { type: "text", text: "回答一" }, call("t1", "echo", { text: "x" })]), result("t1", "结果一"), asst([{ type: "text", text: "回答二" }]), user([{ type: "text", text: "再看这张" }, { type: "image", data: "QUJD", mimeType: "image/png" }])];
	const input = renderFreshInput(msgs);
	assert.equal(input.length, 3);
	const head = String(input[0].text);
	assert.match(head, /用户：第一句/);
	assert.match(head, /助理：回答一\n\[调用工具 echo\(\{"text":"x"\}\)\]/);
	assert.match(head, /\[工具 echo 的结果：结果一\]/);
	assert.match(head, /助理：回答二/);
	assert.ok(!head.includes("想"), "思考不进前文");
	assert.deepEqual(input.slice(1), [{ type: "text", text: "再看这张" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }]);
	// 只有一条用户消息：没有前文
	assert.deepEqual(renderFreshInput([system, user("你好")]), [{ type: "text", text: "你好" }]);
	// 以工具结果结尾：前文 + 让它接着做
	const tail = renderFreshInput([system, user("q"), asst([call("t1")]), result("t1", "r")]);
	assert.match(String(tail[0].text), /接着完成任务/);
	assert.match(renderTranscript([result("t", "炸了", true)]), /出错/);
});

test("重开历史工具结果只留头尾，短结果与实时回填保持原文", () => {
	const text = "头".repeat(1600) + "中".repeat(7000) + "尾".repeat(300);
	const rendered = renderTranscript([result("t", text)]);
	assert.ok(rendered.length < 2100);
	assert.ok(rendered.includes("头".repeat(1600)));
	assert.ok(rendered.includes("尾".repeat(300)));
	assert.match(rendered, /中间省略 7000 字，需要时重新调用工具查看/);
	assert.equal(renderTranscript([result("t", "短结果")]), "[工具 echo 的结果：短结果]");
	assert.deepEqual(toolResultToMcp(result("t", text)).content, [{ type: "text", text }]);
});

test("仅省略历史用户技能正文，保留多个技能头、周围原话及当前完整技能", () => {
	const skill = '<skill name="示例" location="/tmp/SKILL.md">技能正文\n' + "规则".repeat(10000) + "</skill>";
	const old = `原话开始${skill}中间原话${skill}原话结束`;
	const latest = `请使用${skill}`;
	const messages = [user(old), asst([{ type: "text", text: "助理原话" }]), user(latest)];
	const input = renderFreshInput(messages);
	const head = String(input[0].text);
	assert.equal(head.match(/技能正文已省略/g)?.length, 2);
	assert.equal(head.match(/<skill name="示例" location="\/tmp\/SKILL.md">/g)?.length, 2);
	assert.ok(head.includes("原话开始") && head.includes("中间原话") && head.includes("原话结束"));
	assert.ok(head.includes("助理原话"));
	assert.ok(!head.includes("规则"));
	assert.deepEqual(input.at(-1), { type: "text", text: latest });
	assert.equal(messages[0].content, old);
});

test("输入超预算从最早历史丢弃，最近历史及当前输入完整在最后", () => {
	const latest = "当前消息".repeat(50);
	const messages = [user("最早历史".repeat(1000)), asst([{ type: "text", text: "最近回答" }]), user(latest), user("最后一句")];
	const input = renderFreshInput(messages, 500);
	const text = input.map((b) => b.text).join("\n\n");
	assert.ok(text.length <= 500);
	assert.match(String(input[0].text), /更早的 1 条对话已省略/);
	assert.ok(!text.includes("最早历史"));
	assert.ok(text.includes("最近回答"));
	assert.deepEqual(input.slice(-2), [{ type: "text", text: latest }, { type: "text", text: "最后一句" }]);
	const huge = "当前输入".repeat(20000);
	assert.deepEqual(renderFreshInput([...messages.slice(0, 2), user(huge)], 500).at(-1), { type: "text", text: huge });
	assert.deepEqual(renderFreshInput([user(huge)], 500), [{ type: "text", text: huge }]);
	const planned = planTurn(undefined, "model", messages, 500);
	assert.deepEqual(planned.input, input);
});

test("未超预算时与无上限输入完全相同，续用路径不压缩新增技能", () => {
	const messages = [user("原始问题"), asst([{ type: "text", text: "原始回答" }]), user("新问题")];
	assert.deepEqual(renderFreshInput(messages, 60000), renderFreshInput(messages));
	const entry = makeSyncEntry("S", "model", [messages[0]], messages[1]);
	const latest = '<skill name="x" location="/tmp/x">完整正文</skill>';
	const plan = planTurn(entry, "model", [...messages.slice(0, 2), user(latest)], 1);
	assert.equal(plan.mode, "resume");
	assert.deepEqual(plan.input, [{ type: "text", text: latest }]);
});

test("换模型历史直接带原生操作的一行结果标题，不创建Pi工具调用或摘要", () => {
	const native = { ...asst([{ type: "text", text: "文件处理完毕" }]), nativeToolTitles: ["成功：读取 a.txt", "失败：写入 b.txt", "未确认：执行命令\n仍需检查"] };
	const rendered = renderTranscript([user("处理文件"), native]);
	assert.equal(rendered, "用户：处理文件\n\n助理：文件处理完毕\n成功：读取 a.txt\n失败：写入 b.txt\n未确认：执行命令 仍需检查");
	assert.doesNotMatch(rendered, /调用工具|工具 .* 的结果|摘要/);
	const fresh = String(renderFreshInput([user("处理文件"), native, user("换个模型继续")])[0].text);
	assert.match(fresh, /成功：读取 a.txt/);
	assert.match(fresh, /失败：写入 b.txt/);
	assert.equal(native.content.filter((b) => b.type === "toolCall").length, 0);
});

test("同一轮续接的判断：toolCall 和等待中的 id 一致、都有结果；多出的用户消息是插话", () => {
	const pending = new Set(["a", "b"]);
	const base: Message[] = [system, user("干活"), asst([call("a"), call("b")])];
	assert.equal(matchContinuation(base, pending), null, "还没有结果");
	assert.equal(matchContinuation([...base, result("a", "1")], pending), null, "缺一个结果");
	const ok = matchContinuation([...base, result("a", "1"), result("b", "2")], pending);
	assert.deepEqual([...ok!.results.keys()].sort(), ["a", "b"]);
	assert.equal(ok!.extras.length, 0);
	const withExtra = matchContinuation([...base, result("b", "2"), result("a", "1"), user("等等")], pending);
	assert.equal(withExtra!.extras.length, 1);
	assert.equal(matchContinuation([...base, result("a", "1"), result("b", "2")], new Set(["a"])), null, "toolCall 和等待的不一致");
	assert.equal(matchContinuation([...base, result("a", "1"), result("b", "2"), asst([{ type: "text", text: "x" }])], pending), null, "后面又有助理消息");
	assert.equal(matchContinuation([system, user("x")], pending), null);
	assert.equal(matchContinuation(base, new Set()), null);
});

const chat1: Message[] = [system, user("你好")];
const reply1 = asst([{ type: "text", text: "你好呀" }]);

test("对照表：前缀对得上且只多了用户消息 → 续用，只发新增内容", () => {
	const entry = makeSyncEntry("S1", "sonnet", chat1, reply1);
	assert.equal(entry.count, 2);
	const next: Message[] = [system, user("你好"), reply1, user("第二句"), user([{ type: "image", data: "QUJD", mimeType: "image/png" }])];
	const plan = planTurn(entry, "sonnet", next);
	assert.equal(plan.mode, "resume");
	if (plan.mode === "resume") {
		assert.equal(plan.claudeSessionId, "S1");
		assert.equal(plan.input.length, 2);
		assert.deepEqual(plan.input[0], { type: "text", text: "第二句" });
	}
});

test("对照表：对不上就新开（没有表项、换过模型、整理过上下文、分支、新增里有助理消息、上下文变短）", () => {
	const entry = makeSyncEntry("S1", "sonnet", chat1, reply1);
	const next: Message[] = [system, user("你好"), reply1, user("第二句")];
	const fresh = (e: typeof entry | undefined, model: string, msgs: Message[]) => {
		const p = planTurn(e, model, msgs);
		assert.equal(p.mode, "fresh");
		return p.mode === "fresh" ? p.reason : "";
	};
	assert.match(fresh(undefined, "sonnet", next), /对照表/);
	assert.match(fresh(entry, "opus", next), /模型/);
	assert.match(fresh(entry, "sonnet", [system, user("[摘要] 前面聊了你好"), user("第二句")]), /前缀|变短/);
	assert.match(fresh(entry, "sonnet", [system, user("你好"), asst([{ type: "text", text: "别的回答" }]), user("第二句")]), /前缀/);
	assert.match(fresh(entry, "sonnet", [system, user("你好"), reply1, asst([{ type: "text", text: "多出来" }]), user("再来")]), /助理/);
	assert.match(fresh(entry, "sonnet", chat1), /没有新消息/);
	assert.notEqual(prefixFingerprint(next, 2), prefixFingerprint([system, user("你好"), asst([{ type: "text", text: "别的回答" }])], 2));
	// 新开会话时送的是整个前文
	const p = planTurn(entry, "opus", next);
	assert.match(String(p.input[0].text), /用户：你好/);
});

test("对照表文件：写入后新实例能读到；坏文件当空表；过期项被清掉", () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-sync-"));
	try {
		const file = join(dir, "sub", "s.json");
		const a = new SyncStore(file);
		const entry = makeSyncEntry("S1", "sonnet", chat1, reply1);
		a.set("k1", entry);
		a.set("old", { ...entry, updatedAt: Date.now() - 40 * 24 * 3600 * 1000 });
		assert.equal(new SyncStore(file).get("k1")?.claudeSessionId, "S1");
		assert.equal(new SyncStore(file).get("old"), undefined, "超过 30 天的项不留");
		a.delete("k1");
		assert.equal(new SyncStore(file).get("k1"), undefined);
		writeFileSync(file, "{坏的");
		assert.equal(new SyncStore(file).get("k1"), undefined);
		assert.ok(readFileSync(file, "utf8").length > 0);
		assert.equal(new SyncStore(null).get("x"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
