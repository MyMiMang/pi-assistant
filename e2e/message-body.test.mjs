/**
 * 助手消息正文气泡的显示判定（纯函数，node:test；不启动浏览器 / 不构建 / 不连模型）。
 *
 * 事故背景：请求失败的那一轮，服务端落库 `content: ""` + `status: "error"`。
 * 旧实现只在「有正文」或「流式中且无思考」时渲染气泡，而错误文案写在气泡里 →
 * 失败轮什么都不显示，界面上只剩「引用」按钮，看起来像「助理回复了但正文空白」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantErrorText, botBodyView } from "../apps/web/src/message-body.ts";

const view = (p) => botBodyView({ body: "", thinking: false, status: "done", error: undefined, ...p });

test("有正文：照常渲染气泡", () => {
	const v = view({ body: "好，我先看一下。", status: "done" });
	assert.equal(v.showBubble, true);
	assert.equal(v.showError, false);
	assert.equal(v.showInterrupted, false);
});

test("失败且没有正文：仍然要渲染气泡并给出人话原因（旧实现这里什么都不显示）", () => {
	const v = view({ status: "error", error: "Request timed out." });
	assert.equal(v.showBubble, true, "失败轮必须有可见气泡，不能只剩「引用」");
	assert.equal(v.showError, true);
	assert.match(v.errorText, /超时/);
	assert.match(v.errorText, /重发|换模型/);
	assert.equal(v.errorRaw, "Request timed out.");
});

test("失败但有部分正文：正文照常显示，错误行在下面", () => {
	const v = view({ body: "我查到了这些：", status: "error", error: "Connection error." });
	assert.equal(v.showBubble, true);
	assert.equal(v.showError, true);
	assert.match(v.errorText, /连不上/);
});

test("中断且没有正文：也要说一句「已中断」，不是空白", () => {
	const v = view({ status: "interrupted" });
	assert.equal(v.showBubble, true);
	assert.equal(v.showInterrupted, true);
});

test("流式中且还没有正文、也没有思考：先占位（光标）", () => {
	assert.equal(view({ status: "streaming" }).showBubble, true);
});

test("流式中、正文为空但已有思考：思考折叠条占位，不额外空气泡", () => {
	assert.equal(view({ status: "streaming", thinking: true }).showBubble, false);
});

test("完成但正文为空（只有思考）：不摆空气泡", () => {
	assert.equal(view({ status: "done", thinking: true }).showBubble, false);
});

test("已知错误翻成人话，未知错误保留原文不吞掉", () => {
	assert.match(assistantErrorText("Request timed out."), /^模型服务超时/);
	assert.match(assistantErrorText("fetch failed"), /^连不上模型服务/);
	assert.match(assistantErrorText("401 Incorrect API key provided"), /^模型服务鉴权失败/);
	assert.match(assistantErrorText("429 rate limit reached"), /^模型服务限流/);
	assert.match(assistantErrorText("500 Internal Server Error"), /^模型服务出错了/);
	const other = assistantErrorText("some provider said no");
	assert.match(other, /^some provider said no/, "未知错误必须保留原文");
	assert.match(other, /重发|换模型/);
	assert.equal(assistantErrorText(""), "这次没收到回复，可以重发或换个模型");
	assert.ok(assistantErrorText("x".repeat(400)).length < 200, "超长错误要截断，不撑爆界面");
});

test("错误原因里不出现 undefined / [object Object]", () => {
	for (const e of [undefined, null, "", {}, 0]) {
		const t = assistantErrorText(e);
		assert.ok(!/undefined|\[object Object\]/.test(t), `错误文案不能露出技术占位：${t}`);
	}
});
