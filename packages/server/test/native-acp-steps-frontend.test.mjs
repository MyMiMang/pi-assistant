/** 原生步骤的现有聊天分组和静态DOM；不启动服务 / 浏览器 / CLI。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
globalThis.React = React;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.location = new URL("http://127.0.0.1/");
const { BotPart, group, Activity } = await import("../../../apps/web/src/components/ChatMessages.tsx");
const message = (id, role, content = "", status = "done", meta = {}) => ({ id, role, content, status, meta, agent_id: "test", conversation_id: "test", task_id: null, created_at: 1, updated_at: 2 });
const native = (id, status = "done", title = "写入文件") => message(id, "tool", "", status, { executionSource: "native-acp", title, toolName: "工具操作" });
const view = (items, live = false) => renderToStaticMarkup(React.createElement(BotPart, { p: { kind: "steps", items }, live }));

test("原生正文与步骤保持原始消息顺序，无须新增分组标记", () => {
	const rows = group([message("a", "assistant", "先读取"), native("t"), message("b", "assistant", "再汇报")]);
	const bot = rows.find((r) => r.kind === "bot");
	assert.deepEqual(bot.parts.map((p) => p.kind), ["msg", "steps", "msg"]);
	assert.equal(bot.parts[0].m.content, "先读取");
	assert.equal(bot.parts[2].m.content, "再汇报");
});

test("原生步骤展示自身标题和来源，停止不算成功，失败标题保持可见", () => {
	const stopped = view([native("done"), native("stopped", "interrupted")]);
	assert.match(stopped, /1 成功.*1 已中断/);
	assert.doesNotMatch(stopped, /全部成功/);
	assert.match(stopped, /工具自带操作/);
	const failed = view([native("failed", "error", "写入失败 <script>")]);
	assert.match(failed, /1 失败/);
	assert.match(failed, /写入失败 &lt;script&gt;/);
	assert.doesNotMatch(failed, /<script>/);
	assert.match(view([native("done")], true), /全部成功/);
	assert.doesNotMatch(view([native("done")], true), /正在进行/);
	const activity = renderToStaticMarkup(React.createElement(Activity, { tool: native("running", "running", "读取项目文件") }));
	assert.match(activity, /读取项目文件/);
	assert.match(activity, /工具自带操作/);
});
