/** cua 的 structuredContent 追加给模型：Pi 的 MCP 包装（{content, structuredContent, isError}）里取出、紧凑 JSON、超长按优先字段截断 */
import assert from "node:assert/strict";
import { test } from "node:test";
await import("./setup.ts");
const { structuredNote, unwrapStructured, STRUCTURED_MAX_CHARS, computerExtension, HOST_MCP_PREFIX, MCP_PREFIX } = await import("@pi-assistant/ext-computer");

const wrap = (sc: unknown) => ({ content: [{ type: "text", text: "bound" }], structuredContent: sc });

test("绑定结果：Pi 的包装里取出 target_id / tab_id / binding_quality / mutation_allowed", () => {
	const note = structuredNote(wrap({ target_id: "bt-1", binding_quality: "exact", mutation_allowed: true, tabs: [{ tab_id: "t-9", url: "http://x" }] }), "bound target bt-1 (exact) with 1 tab(s)");
	assert.ok(note?.startsWith("结构化结果：{"));
	for (const s of ["bt-1", "t-9", "exact", '"mutation_allowed":true']) assert.ok(note?.includes(s), s);
});

test("没有结构化结果 / 只有 content 的包装 / 空对象：不追加", () => {
	assert.equal(structuredNote(undefined), null);
	assert.equal(structuredNote({ content: [{ type: "text", text: "x" }], isError: false }), null);
	assert.equal(structuredNote(wrap({})), null);
	assert.equal(structuredNote("str"), null);
	assert.equal(unwrapStructured({ a: 1 })?.a, 1, "直接就是结构化对象也认");
});

test("文本里已经完整包含同样的 JSON：不重复", () => {
	const sc = { a: 1, b: "x" };
	assert.equal(structuredNote(wrap(sc), JSON.stringify(sc, null, 2)), null);
});

test("超长：不超过上限，优先字段（target_id / tab_id / status / detail.next_call / snapshot_id）保留，大数组写明总数", () => {
	const elements = Array.from({ length: 2000 }, (_, i) => ({ id: i, role: "AXButton", title: `按钮${i}`.repeat(5) }));
	const note = structuredNote(wrap({ elements, noise: "z".repeat(50_000), target_id: "bt-keep", tab_id: "tab-keep", status: "denied", snapshot_id: "s7", detail: { next_call: { tool: "get_browser_state", args: { tab_id: "tab-keep" } }, hint: "先绑定" }, refs: Array.from({ length: 500 }, (_, i) => `p7:${i}`) })) ?? "";
	assert.ok(note.length <= STRUCTURED_MAX_CHARS + 400, `len ${note.length}`);
	for (const s of ["bt-keep", "tab-keep", "denied", "s7", "next_call", "先绑定", "共 2000 项", "共 500 项", "已截断"]) assert.ok(note.includes(s), s);
	assert.ok(note.includes("续读"));
});

test("tool_result 钩子：本机 / 助理电脑两种前缀都追加；截图块保留；非本扩展的工具不动；没有结构化结果原样", async () => {
	for (const [target, prefix] of [["host", HOST_MCP_PREFIX], ["sandbox", MCP_PREFIX]] as const) {
		const h: Record<string, (e: unknown) => Promise<{ content?: { type: string; text?: string }[] } | undefined>> = {};
		computerExtension({ target, mcp: { command: "x", args: [] }, isPaused: () => false, approvals: () => "none", request: async () => ({ approved: true }), describe: () => "d", log: () => {} } as never)({
			registerMcpServer: () => {}, registerTool: () => {}, on: (n: string, fn: never) => (h[n] = fn),
		} as never);
		const shot = { type: "image", data: "AAA", mimeType: "image/png" };
		const r = await h.tool_result({ toolName: `${prefix}get_browser_state`, toolCallId: "c1", input: {}, content: [{ type: "text", text: "bound" }, shot], isError: false, structuredContent: wrap({ tab_id: "t-1" }) });
		assert.equal(r?.content?.length, 3);
		assert.deepEqual(r?.content?.[1], shot);
		assert.ok(r?.content?.[2].text?.includes("t-1"));
		assert.deepEqual((r as { structuredContent?: unknown })?.structuredContent, wrap({ tab_id: "t-1" }), "结构化结果要原样带回，否则 Pi 会删掉，快速执行者拿不到 refs");
		assert.equal(await h.tool_result({ toolName: `${prefix}click`, toolCallId: "c2", input: {}, content: [{ type: "text", text: "ok" }], isError: false }), undefined);
		assert.equal(await h.tool_result({ toolName: "bash", toolCallId: "c3", input: {}, content: [], isError: false, structuredContent: wrap({ tab_id: "t-1" }) }), undefined);
	}
});

test("上面文本里已经有的长字符串不重复发", async () => {
	const { structuredNote } = await import("@pi-assistant/ext-computer");
	const tree = "- [1] AXButton \"保存\"\n".repeat(30);
	const note = structuredNote({ content: [], structuredContent: { snapshot_id: "s1", tree_markdown: tree } }, tree)!;
	assert.match(note, /"snapshot_id":"s1"/);
	assert.match(note, /同上面的文本/);
	assert.ok(!note.includes("AXButton"), "树没有再发一遍");
	assert.equal(structuredNote({ content: [], structuredContent: { tree_markdown: tree } }, tree), null, "只剩重复内容就不追加");
});
