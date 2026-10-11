/** 个人微信：默认关闭；必须确认风险才能开启；只对选中的助理生效；扩展注入说明 + wechat_open */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const wx = await import("../src/wechat.ts");
const { wechatExtension } = await import("@pi-assistant/ext-connectors");

test("个人微信开关与风险确认", async () => {
	assert.equal(wx.wechatSettings().enabled, false);
	assert.equal(wx.wechatAllowed("a1"), false);
	assert.throws(() => wx.saveWechatSettings({ enabled: true }), /风险提示/);
	wx.saveWechatSettings({ enabled: true, acknowledgedAt: Date.now() });
	assert.equal(wx.wechatAllowed("a1"), false, "没选这个助理");
	wx.saveWechatSettings({ agentIds: ["a1"] });
	assert.equal(wx.wechatAllowed("a1"), true);
	assert.equal(wx.wechatAllowed("a2"), false);
	await assert.rejects(wx.openWechat("a2"), /没有开启个人微信/);
	wx.saveWechatSettings({ enabled: false });
	assert.equal(wx.wechatAllowed("a1"), false);
	await assert.rejects(wx.ensurePackage("mips"), /不支持这个架构/);
});

test("wechat 扩展：系统提示 + 打开工具", async () => {
	let hook: ((e: { systemPrompt: string }) => Promise<{ systemPrompt: string }>) | null = null;
	let tool: { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> } | null = null;
	const progress: string[] = [];
	wechatExtension({ prompt: wx.WECHAT_PROMPT, open: async (p) => (p("正在下载微信…"), { installed: true, running: true, version: "4.1" }) })({
		on: (_n: string, h: never) => (hook = h),
		registerTool: (t: never) => (tool = t),
	} as never);
	const r = await hook!({ systemPrompt: "基础" });
	assert.match(r.systemPrompt, /^基础[\s\S]*你自己的微信号[\s\S]*request_handoff[\s\S]*先征得用户同意/);
	const out = await tool!.execute("x", {}, undefined, (u: { content: { text: string }[] }) => progress.push(u.content[0].text));
	assert.match(out.content[0].text, /已打开.*request_handoff/);
	assert.deepEqual(progress, ["正在下载微信…"]);
});
