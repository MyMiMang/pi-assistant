/**
 * 助手消息正文气泡的显示判定（纯函数，node:test；不启动浏览器 / 不构建 / 不连模型）。
 *
 * 事故背景：
 * 1) 请求失败的那一轮，服务端落库 `content: ""` + `status: "error"`。旧实现只在「有正文」或
 *    「流式中且无思考」时渲染气泡，而错误文案写在气泡里 → 失败轮什么都不显示，只剩「引用」。
 * 2) Codex 额度耗尽被说成「限流，可以重发」：重发不会成功，只能等额度恢复或换模型。
 * 3) 旧记录里 `status: "done"` + `content: ""` + 无 thinking / 无附件的空回合，界面上同样空白。
 * 这里覆盖：错误分类、对象 / 数组错误可读化、凭据过滤、旧空记录兜底，以及各种不能误插兜底的中间态。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantErrorDetail, assistantErrorKind, assistantErrorText, botBodyView } from "../apps/web/src/message-body.ts";

const view = (p) => botBodyView({ body: "", thinking: false, status: "done", error: undefined, ...p });

test("有正文：照常渲染气泡", () => {
	const v = view({ body: "好，我先看一下。", status: "done" });
	assert.equal(v.showBubble, true);
	assert.equal(v.showError, false);
	assert.equal(v.showEmpty, false);
	assert.equal(v.showInterrupted, false);
});

test("失败且没有正文：仍然要渲染气泡并给出人话原因（旧实现这里什么都不显示）", () => {
	const v = view({ status: "error", error: "Request timed out." });
	assert.equal(v.showBubble, true, "失败轮必须有可见气泡，不能只剩「引用」");
	assert.equal(v.showError, true);
	assert.equal(v.errorKind, "timeout");
	assert.match(v.errorText, /超时/);
	assert.match(v.errorText, /重发|换模型/);
	assert.equal(v.errorRaw, "Request timed out.");
	assert.equal(v.showEmpty, false, "错误轮不要同时插「空回复」兜底");
});

test("失败但有部分正文：正文照常显示，错误行在下面", () => {
	const v = view({ body: "我查到了这些：", status: "error", error: "Connection error." });
	assert.equal(v.showBubble, true);
	assert.equal(v.showError, true);
	assert.equal(v.errorKind, "network");
	assert.match(v.errorText, /连不上/);
});

test("Codex 额度耗尽：明确中文错误，不让用户重发，也不臆测恢复时间", () => {
	const cases = [
		'429 {"error":{"type":"usage_limit_reached","message":"You have hit your ChatGPT usage limit for gpt-5-codex"}}',
		'{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
		"You have hit your ChatGPT usage limit",
		"Your credit balance is exhausted",
		"billing hard limit reached",
	];
	for (const raw of cases) {
		assert.equal(assistantErrorKind(raw), "quota", `应识别为额度耗尽：${raw}`);
		const text = assistantErrorText(raw);
		assert.match(text, /额度/, `额度错误要说清是额度问题：${text}`);
		assert.doesNotMatch(text, /重发/, `额度耗尽不能只让用户重发：${text}`);
		assert.match(text, /额度恢复|换一个可用模型/, `要给出「等额度恢复 / 换模型」：${text}`);
		assert.doesNotMatch(text, /\d+\s*(秒|分钟|小时|天)后/, `不能臆测恢复时间：${text}`);
	}
});

test("普通 429 rate limit 不能被当成额度耗尽，也不能因为 429 就猜额度", () => {
	assert.equal(assistantErrorKind("429 Too Many Requests: rate_limit_exceeded"), "rate_limit");
	assert.equal(assistantErrorKind("429"), "rate_limit", "只有状态码时按限流，不猜额度");
	assert.match(assistantErrorText("429 rate limit reached"), /^模型服务限流/);
	assert.equal(assistantErrorKind("Request rate limit exceeded"), "rate_limit");
});

test("区分鉴权 / 超时 / 网络 / 上下文 / 服务端 / 未知", () => {
	assert.equal(assistantErrorKind("401 Unauthorized"), "auth");
	assert.equal(assistantErrorKind("403 Forbidden"), "auth");
	assert.equal(assistantErrorKind("Incorrect API key provided"), "auth");
	assert.equal(assistantErrorKind("Request timed out."), "timeout");
	assert.equal(assistantErrorKind("fetch failed"), "network");
	assert.equal(assistantErrorKind("This model's maximum context length is 128000 tokens"), "context");
	assert.equal(assistantErrorKind("503 Service Unavailable"), "server");
	assert.equal(assistantErrorKind("some provider said no"), "unknown");
	assert.equal(assistantErrorKind(""), "unknown");
});

test("对象 / 数组错误取受控可读字段，绝不出现 [object Object]", () => {
	assert.equal(assistantErrorKind({ message: "insufficient_quota" }), "quota");
	assert.equal(assistantErrorKind({ error: { message: "Request timed out." } }), "timeout");
	assert.equal(assistantErrorKind({ error: { code: "insufficient_quota", type: "usage_limit_reached" } }), "quota");
	assert.equal(assistantErrorKind([{ message: "Connection error." }]), "network");
	assert.equal(assistantErrorKind({ code: 429, type: "rate_limit" }), "rate_limit");
	const nested = view({ status: "error", error: { error: { message: "You have hit your ChatGPT usage limit" } } });
	assert.equal(nested.errorKind, "quota");
	assert.match(nested.errorText, /额度/);
	for (const e of [undefined, null, "", {}, [], { foo: "bar" }, 0, { nested: { deep: {} } }]) {
		const text = assistantErrorText(e);
		assert.ok(!/undefined|\[object Object\]/.test(text), `错误文案不能露出技术占位：${text}`);
		assert.ok(text.length > 0, "空错误也要说一句");
	}
	assert.match(assistantErrorText({ message: "请求超时" }), /超时/);
	assert.match(assistantErrorText({ foo: "bar" }), /具体原因/, "没有可读字段时说明服务没给原因");
});

test("错误详情：可读、截断、过滤 Key / Bearer / 查询串里的凭据", () => {
	const quota = view({ status: "error", error: { error: { code: "insufficient_quota", message: "You exceeded your current quota" } } });
	assert.match(quota.errorDetail, /insufficient_quota/);
	assert.ok(quota.errorDetail.length <= 401);

	const leaked = assistantErrorDetail("Request failed: Bearer sk-abcdef1234567890 api_key=supersecretvalue https://api.example.com?token=abc123secret");
	assert.ok(!leaked.includes("sk-abcdef1234567890"), `不能泄露 Key：${leaked}`);
	assert.ok(!leaked.includes("supersecretvalue"), `不能泄露查询串凭据：${leaked}`);
	assert.ok(!leaked.includes("abc123secret"), `不能泄露查询串凭据：${leaked}`);
	assert.ok(leaked.length > 0);
});

test("中断且没有正文：也要说一句「已中断」，不是空白", () => {
	const v = view({ status: "interrupted" });
	assert.equal(v.showBubble, true);
	assert.equal(v.showInterrupted, true);
	assert.equal(v.interruptedText, "（已中断）");
	assert.equal(v.showError, false);
	assert.equal(v.showEmpty, false);
});

test("用户主动停止：说「已停止」，不当错误、不当空回复", () => {
	for (const status of ["aborted", "stopped", "cancelled"]) {
		const v = view({ status, error: "aborted by user" });
		assert.equal(v.showBubble, true, `${status} 要有可见说明`);
		assert.equal(v.showInterrupted, true);
		assert.equal(v.interruptedText, "（已停止）");
		assert.equal(v.showError, false, `${status} 不是模型错误`);
		assert.equal(v.showEmpty, false);
	}
});

test("旧记录：done / error / failed 但没有正文、思考、附件 —— 兜底可见", () => {
	for (const status of ["done", "complete", "completed"]) {
		const v = view({ status });
		assert.equal(v.showBubble, true, `${status} 空回合必须有可见说明，不能只剩引用`);
		assert.equal(v.showEmpty, true);
		assert.match(v.emptyText, /未收到回复/);
		assert.match(v.emptyText, /具体原因/);
	}
	// failed / error 走错误行（原因同样是「服务没提供具体原因」），不重复插空回复兜底
	for (const status of ["failed", "error"]) {
		const v = view({ status });
		assert.equal(v.showBubble, true, `${status} 空回合必须有可见说明`);
		assert.equal(v.showError, true);
		assert.match(v.errorText, /具体原因/);
		assert.equal(v.showEmpty, false);
	}
});

test("旧空记录兜底不误插：thinking / 附件 / 工具占位 / 卡片 / 流式 / 正常回复", () => {
	assert.equal(view({ status: "done", thinking: true }).showBubble, false, "只有思考：折叠条占位，不摆空气泡");
	assert.equal(view({ status: "done", thinking: true }).showEmpty, false);
	assert.equal(view({ status: "done", hasAttachments: true }).showBubble, false, "有附件就不是空回复");
	assert.equal(view({ status: "done", hasAttachments: true }).showEmpty, false);
	assert.equal(view({ status: "done", toolOnly: true }).showBubble, false, "工具步骤占位不能冒充空回复");
	assert.equal(view({ status: "done", toolOnly: true }).showEmpty, false);
	assert.equal(view({ status: "streaming" }).showEmpty, false, "流式光标不是空回复");
	assert.equal(view({ status: "done", body: "正常回复" }).showEmpty, false);
});

test("旧记录 done 但带着额度错误：按额度错误显示，不退化成「空回复」", () => {
	const v = view({ status: "done", error: { error: { type: "usage_limit_reached", message: "You have hit your ChatGPT usage limit" } } });
	assert.equal(v.showBubble, true);
	assert.equal(v.showError, true);
	assert.equal(v.errorKind, "quota");
	assert.equal(v.showEmpty, false);
	assert.match(v.errorText, /额度/);
});

test("失败状态但没有可读原因：给「服务没提供具体原因」，而不是空白", () => {
	const v = view({ status: "error", error: {} });
	assert.equal(v.showBubble, true);
	assert.equal(v.showError, true);
	assert.match(v.errorText, /具体原因/);
	assert.equal(v.errorDetail, "");
	assert.equal(v.showEmpty, false);
});

test("streaming / done 的既有行为不变", () => {
	assert.equal(view({ status: "streaming" }).showBubble, true, "流式中且还没有正文、也没有思考：先占位（光标）");
	assert.equal(view({ status: "streaming", thinking: true }).showBubble, false, "流式中、正文为空但已有思考：思考占位，不额外空气泡");
	assert.equal(view({ status: "done", thinking: true }).showBubble, false, "完成但正文为空（只有思考）：不摆空气泡");
});

test("已知错误翻成人话，未知错误保留原文不吞掉", () => {
	assert.match(assistantErrorText("Request timed out."), /^模型服务超时/);
	assert.match(assistantErrorText("fetch failed"), /^连不上模型服务/);
	assert.match(assistantErrorText("401 Incorrect API key provided"), /^模型服务鉴权失败/);
	assert.match(assistantErrorText("429 rate limit reached"), /^模型服务限流/);
	assert.match(assistantErrorText("500 Internal Server Error"), /^模型服务出错了/);
	assert.match(assistantErrorText("maximum context length exceeded"), /^上下文超出模型上限/);
	const other = assistantErrorText("some provider said no");
	assert.match(other, /^some provider said no/, "未知错误必须保留原文");
	assert.match(other, /重发|换模型/);
	assert.match(assistantErrorText(""), /具体原因/);
	assert.ok(assistantErrorText("x".repeat(400)).length < 200, "超长错误要截断，不撑爆界面");
});

test("中转站频率限制 / 冷却：一句中文，带服务给出的恢复时间；原文留在详情", () => {
	const raw = '400 {"error":{"message":"频率限制：deepseek-v4.1-flash per-model cooldown，15:04:53 重置","type":"rate_limit"}}';
	assert.equal(assistantErrorKind(raw), "rate_limit");
	const text = assistantErrorText(raw);
	assert.match(text, /冷却/);
	assert.match(text, /约 15:04:53 恢复/);
	assert.match(assistantErrorDetail(raw), /per-model cooldown/);
	assert.match(assistantErrorText("429 Too Many Requests, please retry after 30 seconds"), /^模型服务限流（请求太频繁），约 30 秒后恢复/);
	assert.match(assistantErrorText("insufficient_quota: quota exceeded, reset at 2026-10-27T00:00:00Z"), /^模型服务的额度已用完，约 \d{1,2}:00:00 恢复/);
});

test("Pi 自动重试：重试中 / 已重试成功显示灰色一行，最终失败保持红色并补重试次数", () => {
	const err = { status: "error", error: "Connection error." };
	const retrying = view({ ...err, retry: { attempt: 2, max: 5 } });
	assert.equal(retrying.retryState, "retrying");
	assert.equal(retrying.retryNote, "网络断了一下，正在第 2 次重试…");
	const retried = view({ ...err, retried: true });
	assert.equal(retried.retryState, "retried");
	assert.equal(retried.retryNote, "网络断了一下，已自动重试");
	assert.equal(retried.showError, true, "错误原文仍在，可展开");
	assert.match(retried.errorDetail, /Connection error/);
	const failed = view({ ...err, retryFailed: 5 });
	assert.equal(failed.retryState, "failed");
	assert.equal(failed.retryNote, "已自动重试 5 次仍失败");
	assert.equal(view(err).retryState, null);
});
