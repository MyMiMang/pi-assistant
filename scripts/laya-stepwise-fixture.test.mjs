/**
 * stepwise fixture 纯逻辑测试（不起浏览器 / 模型 / driver）。
 *   node --test scripts/laya-stepwise-fixture.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { HANDOFF_TASK_IDS } from "./laya-benchmark-handoff.mjs";
import { STEPWISE_MACHINE_KEYS, STEPWISE_TASK, escapeHtml, jsLiteral, renderStepwiseFixtureHtml } from "./laya-stepwise-fixture.mjs";

const FIXTURE_ID = "bench-abc123";
const NONCE = "nonce-xyz";
const TOKEN = "tok-1";
const html = renderStepwiseFixtureHtml(FIXTURE_ID, NONCE, TOKEN);

test("渲染：格式 / 语言两个自定义下拉 + 预览→替换确认 + 干扰按钮 + 独立状态元素", () => {
	for (const id of ["dd-format", "dd-lang", "menu-format", "menu-lang", "b-preview", "b-confirm", "b-cancel", "b-reset", "b-close", "st-format", "st-lang", "st-selection", "st-preview", "st-confirm"]) {
		assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`);
	}
	assert.match(html, /role="combobox"[^>]*aria-label="导出格式"/);
	assert.match(html, /role="combobox"[^>]*aria-label="报告语言"/);
	assert.match(html, /data-format="CSV"/);
	assert.match(html, /data-format="JSON"/);
	assert.match(html, /data-lang="中文"/);
	assert.match(html, /data-lang="English"/);
	assert.match(html, /id="b-confirm" hidden/, "确认按钮默认不出现（预览后才替换）");
	assert.match(html, /byId\("b-preview"\)\.hidden = previewed \|\| confirmed/);
	assert.match(html, /previewed = true;[\s\S]*post\(\{ step: 1 \}\)/);
	assert.match(html, /post\(\{ step: 2, clicked: "confirmed" \}\)/);
	// 状态元素都是独立的 role=status，供另一路 UI 观察取证据。
	assert.equal((html.match(/role="status"/g) ?? []).length, 5);
});

test("内联脚本可编译（不执行、不起浏览器）", () => {
	const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
	assert.ok(script, "页面应有内联脚本");
	assert.doesNotThrow(() => new vm.Script(script));
});

test("注入：fixtureId / nonce / token 不能闭合 script，也不能直接进 HTML", () => {
	const evil = '</script><script>alert(1)</script>"\'&';
	const out = renderStepwiseFixtureHtml(evil, evil, evil);
	assert.equal((out.match(/<\/script>/g) ?? []).length, 1, "注入值不得产生第二个 </script>");
	assert.doesNotMatch(out, /<script>alert\(1\)<\/script>/);
	assert.match(out, /&lt;\/script&gt;/);
	assert.equal(escapeHtml(evil), "&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;");
	assert.equal(jsLiteral("</script>"), '"\\u003c/script\\u003e"');
	assert.equal(jsLiteral("\u2028\u2029"), '"\\u2028\\u2029"');
});

test("页面只上报白名单机器状态键（selected / clicked / step），不新增产品 store keys", () => {
	const patches = [...html.matchAll(/^[ \t]*post\(([^;]+)\);[ \t]*$/gm)].map((m) => m[1]);
	assert.ok(patches.length >= 6, `应有多处上报，实际 ${patches.length}`);
	for (const body of patches) {
		const keys = [...body.matchAll(/([a-zA-Z_]+)\s*:/g)].map((m) => m[1]);
		for (const key of keys) assert.ok(STEPWISE_MACHINE_KEYS.includes(key), `上报了未允许的键：${key}`);
		assert.ok(keys.length > 0);
	}
	// 只使用字符串 / 数字：selected / clicked 为字符串，step 为数字；改选择会把过期预览回退成 step=0。
	assert.match(html, /post\(combined\(\) \? \{ selected: combined\(\), step: 0 \} : \{ step: 0 \}\)/);
	assert.match(html, /post\(\{ step: 1 \}\)/);
	assert.match(html, /post\(\{ step: 2, clicked: "confirmed" \}\)/);
	assert.match(html, /post\(\{ step: 0, clicked: "cancelled" \}\)/);
	assert.match(html, /post\(\{ selected: "", step: 0, clicked: "reset" \}\)/);
	assert.match(html, /post\(\{ clicked: "closed" \}\)/);
});

test("没有真正下载 / 业务后果：不建 blob、不写 download 链接", () => {
	assert.doesNotMatch(html, /createObjectURL/);
	assert.doesNotMatch(html, /download=/);
	assert.doesNotMatch(html, /<a\s/i);
	assert.doesNotMatch(html, /Blob\(/);
});

test("页面不预选答案：初始格式 / 语言都为空，须由操作者自己选", () => {
	assert.match(html, /var selection = \{ format: "", lang: "" \};/);
	assert.match(html, /导出格式：未选择/);
	assert.match(html, /报告语言：未选择/);
	assert.match(html, /选择：未完成/);
});

test("stepwise 任务：自然目标 + 可复用机器状态预期（不含新键）", () => {
	assert.equal(STEPWISE_TASK.id, "export-settings");
	assert.ok(!HANDOFF_TASK_IDS.includes(STEPWISE_TASK.id), "新任务不应混进旧 handoff 固定任务白名单");
	assert.equal(STEPWISE_TASK.goal, "将导出格式设为 JSON、报告语言设为中文，预览后确认");
	const machine = STEPWISE_TASK.expect.machine;
	assert.deepEqual(Object.keys(machine).sort(), ["clicked", "selected", "step"]);
	assert.equal(machine.selected, "JSON:中文");
	assert.equal(machine.clicked, "confirmed");
	assert.equal(machine.step, 2);
	for (const key of Object.keys(machine)) assert.ok(STEPWISE_MACHINE_KEYS.includes(key));
	assert.equal(STEPWISE_TASK.expect.ui.role, "status");
	assert.match(STEPWISE_TASK.expect.ui.label_contains, /预览已确认/);
	// UI 里确认后的状态文本必须真的包含判分用的子串。
	assert.match(html, /"预览已确认：" \+ combined\(\)/);
});
