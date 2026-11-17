import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { inputChars, splitTurnMemory, withTurnMemory } from "../src/pi-adapter/cli-models/context-input.ts";
import { makeSyncEntry, planTurn } from "../src/pi-adapter/cli-models/sync-map.ts";
import { toolsPromptComposite } from "../src/pi-adapter/cli-models/convert.ts";
const user = (content: string, timestamp = 1): Message => ({ role: "user", content, timestamp });
const reply = { role: "assistant", content: [{ type: "text", text: "工具原来的回答" }], timestamp: 2 } as Message;
const entry = makeSyncEntry("original", "stable", [user("旧问题")], reply);

test("两轮记忆变化只影响本轮输入，不改变启动系统提示和组合键", () => {
 const a = splitTurnMemory("人设\n\n<memory>\n第一轮记忆\n</memory>");
 const b = splitTurnMemory("人设\n\n<memory>\n第二轮记忆\n</memory>");
 assert.equal(a.systemPrompt, "人设");
 assert.equal(a.systemPrompt, b.systemPrompt);
 assert.equal(toolsPromptComposite("model", [], a.systemPrompt), toolsPromptComposite("model", [], b.systemPrompt));
 assert.match(JSON.stringify(withTurnMemory([{ type: "text", text: "新消息" }], b.memory)), /本轮相关记忆.*第二轮记忆/s);
 assert.deepEqual(splitTurnMemory("规则 <other>不变</other>"), { systemPrompt: "规则 <other>不变</other>", memory: "" });
 assert.equal(splitTurnMemory(undefined).memory, "");
 assert.equal(splitTurnMemory("规则\n\n<memory>a</memory>\n\n<memory>b</memory>").systemPrompt, "规则");
});

test("锚点保留时不要求前缀一致，补发别的模型的回答、工具参数及结果", () => {
 const delta: Message[] = [user("中转问题", 3), { role: "assistant", content: [{ type: "toolCall", id: "t", name: "echo", arguments: { text: "参数" } }], timestamp: 4 } as unknown as Message,
 { role: "toolResult", toolCallId: "t", toolName: "echo", content: [{ type: "text", text: "结果" }], isError: false, timestamp: 5 }, user("切回", 6)];
 const plan = planTurn(entry, "stable", [user("前缀已变"), reply, ...delta]);
 assert.equal(plan.mode, "resume");
 const text = JSON.stringify(plan.input);
 assert.match(text, /你不在时的对话/);
 assert.match(text, /参数/); assert.match(text, /结果/); assert.match(text, /切回/);
 assert.doesNotMatch(text, /工具原来的回答|前缀已变|旧问题/);
});

test("锚点被整理进摘要后续用原对话，补摘要和摘要后的消息", () => {
 const summary = convertToLlm([{ role: "compactionSummary", summary: "期间的重要决定", tokensBefore: 1000, timestamp: 9 }])[0];
 const plan = planTurn(entry, "stable", [summary, user("摘要之后", 10)]);
 assert.equal(plan.mode, "resume");
 assert.match(JSON.stringify(plan.input), /期间的摘要/); assert.match(JSON.stringify(plan.input), /期间的重要决定/);
});

test("超限补发、模型工具人设变化、无摘要丢锚点均重开；时间戳区分同文消息", () => {
 const messages = [reply, user("新消息".repeat(100), 3)];
 assert.equal(planTurn(entry, "stable", messages, 100).mode, "fresh");
 assert.equal(planTurn(entry, "changed", messages).mode, "fresh");
 assert.equal(planTurn(entry, "stable", [{ ...reply, timestamp: 99 }, user("新消息")]).mode, "fresh");
 for (const composite of [toolsPromptComposite("m", [], "人设一"), toolsPromptComposite("m", [{ name: "echo", description: "echo", inputSchema: { type: "object" } }], "人设")]) {
  assert.notEqual(composite, toolsPromptComposite("m", [], "人设"));
 }
 assert.ok(inputChars(planTurn(entry, "stable", messages).input) > 100);
});
