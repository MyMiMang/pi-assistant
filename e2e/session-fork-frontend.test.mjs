/**
 * 「从消息另开会话分支」前端纯逻辑夹具测试（node:test，不启动服务、不碰 DOM / 真实数据）。
 * 运行：node --import tsx --test e2e/session-fork-frontend.test.mjs
 *
 * 要证：只有单聊里的 user 消息可分支（工具 / 卡片 / 系统 / 隐藏 / 群 / 子代理都排除）；
 * 错误码 → 明确中文提示（不静默从别的消息 fork）；输入框草稿按「助理 + 对话」分桶，
 * 切对话 / fork 切换各自保留、不串（这是「切新会话不丢已输入文字」的保证）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// fork-api 间接 import api.ts，它模块加载时会读 localStorage；Node 里先垫一个最小实现
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { canFork, forkErrorMessage, newForkClientId } = await import("../apps/web/src/fork-api.ts");
const { ApiError } = await import("../apps/web/src/api.ts");
const { getComposerDraft, setComposerDraft, clearComposerDraft } = await import("../apps/web/src/composerDrafts.ts");

const msg = (over = {}) => ({ id: "m1", agent_id: "a1", role: "user", content: "你好", meta: {}, status: "done", created_at: 1, updated_at: 1, ...over });

test("可分支锚点：只有单聊里的普通用户消息", () => {
	assert.equal(canFork(msg()), true);
	assert.equal(canFork(msg({ role: "assistant" })), false, "助理消息不能分支（官方 /fork 只支持 user）");
	assert.equal(canFork(msg({ role: "tool" })), false);
	assert.equal(canFork(msg({ role: "system" })), false);
	assert.equal(canFork(msg({ role: "card" })), false);
	assert.equal(canFork(msg({ meta: { hidden: true } })), false);
	assert.equal(canFork(msg({ meta: { visible: false } })), false);
	assert.equal(canFork(msg({ meta: { kind: "system" } })), false);
	assert.equal(canFork(msg({ room_id: "r1" })), false, "群消息不在本轮范围");
	assert.equal(canFork(msg({ subagent_id: "s1" })), false, "子代理消息不能分支");
	// fork 过来的只读副本仍是 user 消息，可以继续再分支
	assert.equal(canFork(msg({ meta: { readonly: true, forked: { conversationId: "c0", messageId: "m0" } } })), true);
});

test("错误码 → 明确中文提示：不静默从别的消息另开", () => {
	assert.match(forkErrorMessage(new ApiError(409, "busy", { code: "fork_busy" })), /正在这一轮里工作/);
	assert.match(forkErrorMessage(new ApiError(409, "x", { code: "fork_anchor_not_supported" })), /只有你发的消息/);
	assert.match(forkErrorMessage(new ApiError(409, "x", { code: "fork_anchor_unmapped" })), /还没写进 Pi 会话/);
	assert.match(forkErrorMessage(new ApiError(403, "x", { code: "fork_cross_scope" })), /不属于当前对话/);
	assert.match(forkErrorMessage(new Error("网络断了")), /网络断了/);
});

test("clientId 幂等键每次不同", () => {
	const a = newForkClientId();
	const b = newForkClientId();
	assert.match(a, /^fk_/);
	assert.notEqual(a, b);
});

test("输入框草稿按对话分桶：切对话各自保留、不串", () => {
	const c1 = "a:a1:c1";
	const c2 = "a:a1:c2";
	setComposerDraft(c1, "第一个对话没发出去的话");
	// 切到 c2（比如从消息另开的新对话）→ c1 的文字还在自己的桶里
	assert.equal(getComposerDraft(c2), "", "新对话是空草稿，不会带上原对话的字");
	setComposerDraft(c2, "第二轮问题"); // fork 返回的正文放进新对话草稿（不自动发送）
	assert.equal(getComposerDraft(c2), "第二轮问题");
	assert.equal(getComposerDraft(c1), "第一个对话没发出去的话", "切回来原文还在，没丢");
	// 发送后清空只清当前对话
	clearComposerDraft(c2);
	assert.equal(getComposerDraft(c2), "");
	assert.equal(getComposerDraft(c1), "第一个对话没发出去的话");
});
