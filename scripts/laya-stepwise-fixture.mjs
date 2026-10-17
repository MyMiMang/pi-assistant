/**
 * 逐步（stepwise）真实评估用的**本地** fixture 页面：导出设置。
 *
 * 为什么单独一份：旧 fixture 的任务是「一次点击就结束」，控制面每换一题都要 reset + 重新导航，
 * 证不到「主模型在**同一个页面**上一步步观察 → 给局部 goal → 快模型选 → 再观察」。
 * 这里只加页面与纯函数，**不碰产品 store 的机器状态键**（仍然只有 `selected` / `clicked` / `step`）。
 *
 * 页面能力（全部本地、无真正文件下载 / 无业务后果）：
 *  - 「导出格式」自定义下拉：CSV / JSON；
 *  - 「报告语言」自定义下拉：中文 / English；
 *  - 两项都选中后上报机器状态 `selected = "<格式>:<语言>"`；
 *  - 「预览」→ `step = 1`；随后确认按钮**替换**预览按钮；确认 → `step = 2` + `clicked = "confirmed"`；
 *  - 干扰按钮：取消 / 恢复默认 / 关闭，各自上报真实 `clicked`，并回退可见状态；
 *  - 独立的 `role=status` 元素分别显示格式 / 语言 / 选择 / 预览 / 确认（UI 证据，不靠模型自评）。
 *
 * 边界：不程序固定选择答案、不调模型、不下载文件；页面只上报白名单机器状态键。
 */

/** stepwise 场景唯一任务（上层自然目标；每步的局部 goal 由主模型自己观察后决定）。 */
export const STEPWISE_TASK = {
	id: "export-settings",
	kind: "multistep",
	steps: 2,
	title: "导出设置：格式 + 语言 + 预览确认",
	goal: "将导出格式设为 JSON、报告语言设为中文，预览后确认",
	timeoutMs: 12_000,
	expect: {
		machine: { selected: "JSON:中文", step: 2, clicked: "confirmed" },
		ui: { role: "status", label_contains: "预览已确认" },
	},
};

/** 机器状态键（与产品 `BENCHMARK_ALLOWED_STATE_KEYS` 一致；这里只读用于测试断言，不另造 schema）。 */
export const STEPWISE_MACHINE_KEYS = ["selected", "clicked", "step"];

export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * 把值写进内联 `<script>` 的 JS 字面量：JSON 编码 + 转义 `<` / `>` / U+2028 / U+2029。
 * 光 `JSON.stringify` 不够——`</script>` 会提前闭合脚本块。
 */
export function jsLiteral(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** 页面渲染（纯函数：同输入同输出，无 IO、无随机）。 */
export function renderStepwiseFixtureHtml(fixtureId, nonce, token) {
	const fixtureLiteral = jsLiteral(String(fixtureId));
	const nonceLiteral = jsLiteral(String(nonce));
	const tokenLiteral = jsLiteral(String(token));
	const statePath = jsLiteral(`/api/fast-computer/benchmark/fixture/${encodeURIComponent(String(fixtureId))}/state?nonce=${encodeURIComponent(String(nonce))}`);
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pi 逐步评估测试页 ${escapeHtml(fixtureId)} ${escapeHtml(nonce)}</title>
<style>
 body{font-family:-apple-system,system-ui,"PingFang SC",sans-serif;margin:0;padding:24px;color:#111}
 h1{font-size:18px} h2{font-size:14px;margin:16px 0 4px}
 .row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
 button{padding:8px 14px;font-size:14px;border:1px solid #bbb;border-radius:8px;background:#f7f7f7;cursor:pointer}
 button[aria-expanded=true]{border-color:#7cc47f;background:#e6f4ea}
 [role=status]{display:block;margin-top:6px;font-weight:600;color:#0a7a2f}
 [hidden]{display:none !important}
</style></head>
<body>
<h1>导出设置（隔离 fixture）</h1>
<div id="panel">
  <div class="row">
    <button id="dd-format" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-label="导出格式">导出格式：未选择</button>
    <button id="dd-lang" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-label="报告语言">报告语言：未选择</button>
  </div>
  <div id="menu-format" role="listbox" aria-label="导出格式选项" hidden>
    <button class="opt" role="option" data-format="CSV">CSV</button>
    <button class="opt" role="option" data-format="JSON">JSON</button>
  </div>
  <div id="menu-lang" role="listbox" aria-label="报告语言选项" hidden>
    <button class="opt" role="option" data-lang="中文">中文</button>
    <button class="opt" role="option" data-lang="English">English</button>
  </div>
  <div class="row">
    <button id="b-preview">预览</button>
    <button id="b-confirm" hidden>确认导出</button>
    <button id="b-cancel">取消</button>
    <button id="b-reset">恢复默认</button>
    <button id="b-close">关闭</button>
  </div>
  <div id="st-format" role="status">格式：未选择</div>
  <div id="st-lang" role="status">语言：未选择</div>
  <div id="st-selection" role="status">选择：未完成</div>
  <div id="st-preview" role="status">预览：未生成</div>
  <div id="st-confirm" role="status">确认：未确认</div>
</div>
<script>
"use strict";
var FIXTURE_ID = ${fixtureLiteral};
var NONCE = ${nonceLiteral};
var TOKEN = ${tokenLiteral};
var STATE_URL = ${statePath};
window.__BENCH_FIXTURE__ = { fixtureId: FIXTURE_ID, nonce: NONCE, state: {} };
function post(patch){
  Object.assign(window.__BENCH_FIXTURE__.state, patch);
  try {
    fetch(STATE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bench-nonce": NONCE, "x-bench-fixture-token": TOKEN },
      body: JSON.stringify(patch),
      keepalive: true,
    });
  } catch (e) {}
}
function status(id, text){ var el=document.getElementById(id); if(el){ el.textContent=text; el.setAttribute("aria-label", text); } }
function byId(id){ return document.getElementById(id); }
var selection = { format: "", lang: "" };
var previewed = false;
var confirmed = false;
function combined(){ return selection.format && selection.lang ? selection.format + ":" + selection.lang : ""; }
function render(){
  byId("dd-format").textContent = "导出格式：" + (selection.format || "未选择");
  byId("dd-lang").textContent = "报告语言：" + (selection.lang || "未选择");
  status("st-format", "格式：" + (selection.format || "未选择"));
  status("st-lang", "语言：" + (selection.lang || "未选择"));
  status("st-selection", combined() ? "已选择 " + combined() : "选择：未完成");
  status("st-preview", confirmed ? "预览已确认：" + combined() : previewed ? "预览已生成：" + combined() : "预览：未生成");
  status("st-confirm", confirmed ? "预览已确认：" + combined() : "确认：未确认");
  byId("b-preview").hidden = previewed || confirmed;
  byId("b-confirm").hidden = !previewed || confirmed;
}
function choose(kind, value){
  if (confirmed) return;
  selection[kind] = value;
  previewed = false;
  closeMenus();
  render();
  // 改选择后旧预览作废：机器状态同步回 step=0（不保留过期预览），两项都选中才给组合值。
  post(combined() ? { selected: combined(), step: 0 } : { step: 0 });
}
function closeMenus(){
  byId("menu-format").hidden = true;
  byId("menu-lang").hidden = true;
  byId("dd-format").setAttribute("aria-expanded", "false");
  byId("dd-lang").setAttribute("aria-expanded", "false");
}
function toggleMenu(which){
  if (confirmed) return;
  var menu = byId("menu-" + which);
  var open = menu.hidden !== false;
  closeMenus();
  menu.hidden = !open;
  byId("dd-" + which).setAttribute("aria-expanded", String(open));
}
byId("dd-format").onclick = function(){ toggleMenu("format"); };
byId("dd-lang").onclick = function(){ toggleMenu("lang"); };
Array.prototype.forEach.call(document.querySelectorAll("#menu-format .opt"), function(btn){
  btn.onclick = function(){ choose("format", btn.getAttribute("data-format")); };
});
Array.prototype.forEach.call(document.querySelectorAll("#menu-lang .opt"), function(btn){
  btn.onclick = function(){ choose("lang", btn.getAttribute("data-lang")); };
});
byId("b-preview").onclick = function(){
  if (!combined()) { status("st-preview", "预览：先选择格式和语言"); return; }
  previewed = true;
  render();
  post({ step: 1 });
};
byId("b-confirm").onclick = function(){
  if (!previewed || confirmed) return;
  confirmed = true;
  render();
  post({ step: 2, clicked: "confirmed" });
};
byId("b-cancel").onclick = function(){
  previewed = false;
  confirmed = false;
  closeMenus();
  render();
  status("st-confirm", "确认：已取消");
  post({ step: 0, clicked: "cancelled" });
};
byId("b-reset").onclick = function(){
  selection = { format: "", lang: "" };
  previewed = false;
  confirmed = false;
  closeMenus();
  render();
  status("st-selection", "选择：未完成");
  post({ selected: "", step: 0, clicked: "reset" });
};
byId("b-close").onclick = function(){
  byId("panel").hidden = true;
  post({ clicked: "closed" });
};
render();
</script>
</body></html>`;
}
