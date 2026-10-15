/**
 * 真实 CSP 下的能力探针（语音采集 worklet / PDF 预览 / 首屏主题 / blob worker）。
 *
 * 服务端给非 /api 响应下发的 CSP 是 `script-src 'self' blob:` 这类白名单。以下能力只有
 * **真浏览器 + 真响应头**才证得了（静态断言在 `packages/server/test/tray-macos-mic-usage.test.ts`）：
 *  - 语音输入：`audioWorklet.addModule(URL.createObjectURL(new Blob([...])))`（CSP 按 script-src 判定 worklet）；
 *  - 文件预览 PDF：`<object data="blob:…" type="application/pdf">`（object-src + 内置查看器再套 frame-src）；
 *  - 首屏主题：同源外部 `/theme-boot.js`（不能 inline）。
 * 少写一条指令时功能会**静默失效**（worklet 抛 AbortError、PDF 被 frame-src 拦），所以这里连同
 * 「本次页面加载有没有 CSP violation」一起看。
 *
 * 由 `e2e/run.mjs`（主流程步骤）与 `e2e/voice-csp-audioworklet.mjs`（独立发布前核查）共用。
 */

const WORKLET_SRC = `class PiaCspProbe extends AudioWorkletProcessor { process() { return true; } } registerProcessor("pia-csp-probe", PiaCspProbe);`;
const PDF_FIXTURE = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

/** 在页面里跑一遍探针；`page` 必须是已经加载好的应用页面（同源）。 */
export async function probeCsp(page) {
	return page.evaluate(async ({ src, pdf }) => {
		const out = {
			skin: document.documentElement.dataset.skin ?? null,
			mode: document.documentElement.dataset.mode ?? null,
			bootLoaded: performance.getEntriesByType("resource").some((e) => e.name.includes("/theme-boot.js")),
			hasAudioContext: typeof window.AudioContext === "function",
			workletOk: false,
			workletError: null,
			nodeCreated: false,
			objectBlob: false,
			workerBlob: { ok: false, error: null },
		};
		if (out.hasAudioContext) {
			let ctx;
			try {
				ctx = new AudioContext({ sampleRate: 16_000 });
			} catch {
				ctx = new AudioContext();
			}
			const url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
			try {
				await ctx.audioWorklet.addModule(url);
				out.workletOk = true;
				new AudioWorkletNode(ctx, "pia-csp-probe");
				out.nodeCreated = true;
			} catch (e) {
				out.workletError = `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;
			} finally {
				URL.revokeObjectURL(url);
				await ctx.close().catch(() => {});
			}
		}
		try {
			const w = new Worker(URL.createObjectURL(new Blob(["self.postMessage(1)"], { type: "application/javascript" })));
			w.terminate();
			out.workerBlob.ok = true;
		} catch (e) {
			out.workerBlob.error = `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;
		}
		// 文件预览：PDF 用 <object data=blob:>（Chromium 内置查看器还会套一层 frame）
		const pdfUrl = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
		const obj = document.createElement("object");
		obj.data = pdfUrl;
		obj.type = "application/pdf";
		document.body.appendChild(obj);
		await new Promise((r) => setTimeout(r, 1200));
		out.objectBlob = obj.data === pdfUrl;
		obj.remove();
		URL.revokeObjectURL(pdfUrl);
		return out;
	}, { src: WORKLET_SRC, pdf: PDF_FIXTURE });
}

/**
 * 判定探针结果：返回问题清单（空 = 通过）。
 * `consoleMsgs` 传页面 console 文本（`m.type(): m.text()`），用来抓真实的 CSP violation。
 */
export function cspProblems(csp, probe, consoleMsgs = []) {
	const problems = [];
	const dir = (name) => new RegExp(`${name}[^;]*`).exec(csp)?.[0] ?? "";
	if (!csp.includes("default-src 'self'")) problems.push("CSP 缺失 / 结构变了（default-src 'self'）");
	if (!dir("script-src").includes("blob:")) problems.push("script-src 未放行 blob:（语音采集 worklet 会 AbortError）");
	if (dir("script-src").includes("'unsafe-inline'")) problems.push("script-src 放开了 inline（策略被放宽）");
	if (!dir("object-src").includes("blob:")) problems.push("object-src 未放行 blob:（PDF 预览被拦）");
	if (!dir("frame-src").includes("blob:")) problems.push("frame-src 未放行 blob:（内置 PDF 查看器被拦）");
	if (!dir("img-src").includes("blob:")) problems.push("img-src 未放行 blob:（图片预览 / 主题素材被拦）");
	if (!dir("style-src").includes("'unsafe-inline'")) problems.push("style-src 未放行 inline（DIY 主题 token 注入失效）");
	if (csp.includes("frame-ancestors 'none'") === false) problems.push("frame-ancestors 'none' 被去掉");
	const violations = consoleMsgs.filter((m) => /Content Security Policy|Refused to/i.test(m));
	if (violations.length) problems.push(`控制台有 CSP 拦截：${violations.slice(0, 3).join(" | ")}`);
	if (!probe.bootLoaded || !probe.skin || !probe.mode) problems.push(`首屏主题预置未生效：${JSON.stringify(probe)}`);
	if (!probe.hasAudioContext) problems.push("页面没有 AudioContext（探针跑不了）");
	else if (!probe.workletOk) problems.push(`AudioWorklet 的 blob: 模块加载失败：${probe.workletError}`);
	if (probe.workletOk && !probe.nodeCreated) problems.push("AudioWorkletNode 创建失败");
	if (!probe.objectBlob) problems.push("PDF 预览的 <object data=blob:> 未能设置");
	return problems;
}
