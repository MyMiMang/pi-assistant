/**
 * 快速操作模型 · 真实操控基准测试 —— 本地专用 fixture（测试页 + 机器状态 reporter + 任务集）。
 *
 * 设计要点（2026-10-22 用户要求）：
 *  - 专用、隔离、本地的 sandbox HTML 测试页，**不是**真实业务、**不含**付款 / 发送 / 删除等有后果的动作；
 *  - 覆盖：多按钮里选对、下拉展开后选对、滚动后目标、动态布局多步；
 *  - 页面把**机器可读状态**通过 HTTP POST 回本机服务（reporter 绑定 `fixtureId` + `session nonce`），
 *    与「独立 UI 观测」构成双证据，模型自评不参与判分；
 *  - 每个 fixture 实例只接受被 `arm` 过的 (fixtureId, nonce)，别的 run / 别的页面写不进来（防串扰）。
 *
 * 本模块只提供 fixture 与状态存储；真实打开哪个窗口、经哪台电脑操控由 host / driver 决定。
 */
import type { FastBenchmarkTask } from "./benchmark.ts";

/** fixture 页面路由（相对页面自身的 state reporter 路径由 `fixtureStatePath` 派生）。 */
export const BENCHMARK_FIXTURE_BASE = "/api/fast-computer/benchmark/fixture";

export const benchmarkFixturePagePath = (fixtureId: string, nonce?: string) => `${BENCHMARK_FIXTURE_BASE}/${encodeURIComponent(fixtureId)}${nonce ? `?nonce=${encodeURIComponent(nonce)}` : ""}`;
export const benchmarkFixtureStatePath = (fixtureId: string) => `${BENCHMARK_FIXTURE_BASE}/${encodeURIComponent(fixtureId)}/state`;

/**
 * 固定、有界、synthetic 的任务集。每步只做「点击」；type / 选择项由程序固定输入，**不计入模型能力**。
 * `expect.machine` 由 fixture 页面 POST 上报；`expect.ui` 由独立 CUA 观察到 fixture 页面里的状态元素。
 */
export function benchmarkFixtureTasks(): FastBenchmarkTask[] {
	return [
		{
			id: "pick-submit",
			kind: "click",
			title: "多按钮里选对「提交」",
			goal: "在页面的按钮里点击「提交」，不要点「取消」或「稍后再说」",
			timeoutMs: 8000,
			expect: { machine: { clicked: "submit" }, ui: { role: "status", label_contains: "提交完成" } },
		},
		{
			id: "pick-city",
			kind: "click",
			title: "下拉展开后选对选项",
			goal: "点击下拉框，再在展开的选项里点击「北京」",
			timeoutMs: 8000,
			expect: { machine: { selected: "北京" }, ui: { role: "status", label_contains: "已选择 北京" } },
		},
		{
			id: "scroll-target",
			kind: "click",
			title: "滚动后点击底部目标",
			goal: "向下滚动页面，点击最下面的「深度目标」按钮",
			timeoutMs: 12_000,
			expect: { machine: { clicked: "deep-target" }, ui: { role: "status", label_contains: "深度目标完成" } },
		},
		{
			id: "dynamic-2step",
			kind: "multistep",
			steps: 2,
			title: "动态布局两步",
			goal: "第一步点击「下一步」，页面变化后再点击「完成」",
			timeoutMs: 12_000,
			expect: { machine: { step: 2, clicked: "finish" }, ui: { role: "status", label_contains: "流程完成" } },
		},
	];
}

/**
 * fixture 页面 HTML：把 fixtureId + nonce 写进标题（供窗口身份 / URL 校验），
 * 状态变化经相对路径 `state?nonce=…` POST 回本机；每个动作后写入可见的 `role=status` 结果元素（独立 UI 证据）。
 */
export function renderBenchmarkFixtureHtml(fixtureId: string, nonce: string): string {
	const id = JSON.stringify(fixtureId);
	const n = JSON.stringify(nonce);
	const statePath = JSON.stringify(`${benchmarkFixtureStatePath(fixtureId)}?nonce=${encodeURIComponent(nonce)}`);
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pi 快速操作测试页 ${escapeHtml(fixtureId)} ${escapeHtml(nonce)}</title>
<style>
 body{font-family:-apple-system,system-ui,"PingFang SC",sans-serif;margin:0;padding:24px;color:#111}
 h1{font-size:18px} .row{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
 button,select{padding:8px 14px;font-size:14px;border:1px solid #bbb;border-radius:8px;background:#f7f7f7;cursor:pointer}
 button[data-hit]{background:#e6f4ea;border-color:#7cc47f}
 .spacer{height:1400px;background:linear-gradient(#fff,#eee)}
 [role=status]{display:block;margin-top:8px;font-weight:600;color:#0a7a2f}
</style></head>
<body>
<h1>Pi 快速操作测试页（隔离 fixture）</h1>
<div id="app"></div>
<script>
"use strict";
var FIXTURE_ID = ${id};
var NONCE = ${n};
var STATE_URL = ${statePath};
window.__BENCH_FIXTURE__ = { fixtureId: FIXTURE_ID, nonce: NONCE, state: {} };
function post(patch){
  Object.assign(window.__BENCH_FIXTURE__.state, patch);
  try {
    fetch(STATE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bench-nonce": NONCE },
      body: JSON.stringify(patch),
      keepalive: true,
    });
  } catch (e) {}
}
function status(id, text){ var el=document.getElementById(id); if(el) el.textContent=text; }
function h(html){ document.getElementById("app").innerHTML = html; }
function main(){
  h(
    '<div class="row">' +
      '<button id="b-cancel">取消</button>' +
      '<button id="b-submit" data-hit>提交</button>' +
      '<button id="b-later">稍后再说</button>' +
      '<select id="sel-city">' +
        '<option value="">请选择城市</option><option>上海</option><option>北京</option><option>广州</option>' +
      '</select>' +
      '<button id="b-next">下一步</button>' +
    '</div>' +
    '<div id="st-submit" role="status"></div>' +
    '<div id="st-city" role="status"></div>' +
    '<div id="st-step" role="status"></div>' +
    '<div class="spacer"></div>' +
    '<div class="row"><button id="b-deep" data-hit>深度目标</button></div>' +
    '<div id="st-deep" role="status"></div>'
  );
  var submit=document.getElementById("b-submit");
  var cancel=document.getElementById("b-cancel");
  var later=document.getElementById("b-later");
  var city=document.getElementById("sel-city");
  var next=document.getElementById("b-next");
  var deep=document.getElementById("b-deep");
  cancel.onclick=function(){ post({ clicked: "cancel" }); };
  later.onclick=function(){ post({ clicked: "later" }); };
  submit.onclick=function(){ post({ clicked: "submit" }); status("st-submit","提交完成"); };
  deep.onclick=function(){ post({ clicked: "deep-target" }); status("st-deep","深度目标完成"); };
  city.onchange=function(){ var v=city.value; if(v){ post({ selected: v }); status("st-city","已选择 "+v); } };
  next.onclick=function(){
    post({ step: 1 });
    // 动态布局：点「下一步」后出现第二步的「完成」按钮
    document.getElementById("st-step").textContent="第一步完成";
    next.outerHTML='<button id="b-finish" data-hit>完成</button>';
    document.getElementById("b-finish").onclick=function(){ post({ step: 2, clicked: "finish" }); status("st-step","流程完成"); };
  };
}
main();
</script>
</body></html>`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * fixture 机器状态存储（服务端内存）：只接受被 `arm` 过的 (fixtureId, nonce)。
 * 每次试次开始前 `reset`，避免上一轮遗留状态把本轮误判成通过。
 */
export class BenchmarkFixtureStateStore {
	private readonly states = new Map<string, Record<string, unknown>>();
	private readonly armed = new Set<string>();
	private static key(fixtureId: string, nonce: string) {
		return `${fixtureId}\u0000${nonce}`;
	}
	arm(fixtureId: string, nonce: string) {
		this.armed.add(BenchmarkFixtureStateStore.key(fixtureId, nonce));
		this.states.set(BenchmarkFixtureStateStore.key(fixtureId, nonce), {});
	}
	disarm(fixtureId: string, nonce: string) {
		this.armed.delete(BenchmarkFixtureStateStore.key(fixtureId, nonce));
		this.states.delete(BenchmarkFixtureStateStore.key(fixtureId, nonce));
	}
	/** 返回是否被接受（未 arm / nonce 不符 → false，杜绝其它 run 串扰）。 */
	record(fixtureId: string, nonce: string, patch: Record<string, unknown>): boolean {
		const k = BenchmarkFixtureStateStore.key(fixtureId, nonce);
		if (!this.armed.has(k) || !patch || typeof patch !== "object") return false;
		this.states.set(k, { ...(this.states.get(k) ?? {}), ...patch });
		return true;
	}
	get(fixtureId: string, nonce: string): Record<string, unknown> {
		return this.states.get(BenchmarkFixtureStateStore.key(fixtureId, nonce)) ?? {};
	}
	reset(fixtureId: string, nonce: string) {
		if (this.armed.has(BenchmarkFixtureStateStore.key(fixtureId, nonce))) this.states.set(BenchmarkFixtureStateStore.key(fixtureId, nonce), {});
	}
}
