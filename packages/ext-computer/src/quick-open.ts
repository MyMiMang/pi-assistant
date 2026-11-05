/**
 * 快速打开：`*_quick_open` 工具。
 *
 * 一次做完「开浏览器 / 开应用 → 找窗口 → 绑定 → 打开网址 → 读结构」，返回 target 和页面内容，
 * 让大模型从 5 轮变成 1 轮。网页只在支持 cua 浏览器工具的目标上出现（见 QuickOpenOptions.browser）。
 * 设计见 docs/design/fast-executor-v2-impl.md §4。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { unwrapStructured } from "./structured.ts";
import { observe as observePage, pageSummary, sleep, textOf, type ExecContext, type Outcome } from "./quick-io.ts";
import { asObj, type QuickTarget } from "./quick-steps.ts";
import { QUICK_ACTION_PARAMS, runQuickAction, type QuickActionContext, type QuickActionParams, type QuickStepsConfig } from "./quick-steps-tool.ts";

export interface QuickOpenOptions {
	/** cua 工具名前缀（`mcp__computer__` / `mcp__hostpc__`） */
	prefix: string;
	target: "sandbox" | "host";
	/** 是否支持网页（助理电脑的网页走 ext-browser；“限定”档位没有浏览器工具） */
	browser: boolean;
	/** 打开成功后记住这个目标（下次 quick_steps 可以省略 target） */
	remember?: (t: QuickTarget) => void;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** 窗口排序：layer 0 / 没有的在前；在当前屏幕的在前；有标题的在前；z_index 大的在前 */
const windowsInOrder = (s: Record<string, unknown> | null): Record<string, unknown>[] => {
	const list = Array.isArray(s?.windows) ? s.windows.map(asObj).filter((x): x is Record<string, unknown> => !!x) : [];
	const rank = (w: Record<string, unknown>) => [num(w.layer) === 0 || num(w.layer) === undefined ? 0 : 1, w.is_on_screen === false ? 1 : 0, typeof w.title === "string" && w.title.trim() ? 0 : 1];
	return list.sort((a, b) => {
		const ra = rank(a);
		const rb = rank(b);
		for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
		return (num(b.z_index) ?? -Infinity) - (num(a.z_index) ?? -Infinity);
	});
};

export function registerQuickOpen(pi: ExtensionAPI, o: QuickOpenOptions & { config: () => QuickStepsConfig | null }): void {
	if (!o.config()) return;
	const name = o.target === "host" ? "hostpc_quick_open" : "computer_quick_open";
	const stepsName = o.target === "host" ? "hostpc_quick_steps" : "computer_quick_steps";
	pi.registerTool({
		name,
		label: "快速打开",
		description:
			"一次打开网页或应用并准备好操作：开浏览器 / 开应用 → 找窗口 → 绑定 → 打开网址 → 读页面结构，返回可以直接传给 " +
			`${stepsName} 的 target 和页面内容，省掉好几种准备步骤。\n` +
			"给 url 打开网页（默认另开一个独立 Chrome，不带用户的登录状态；要用户的登录状态才用 browser:\"user\"），给 app 打开应用（名字或 bundle id）。url 和 app 只能给一个。\n" +
			`已经知道要做什么，就把 steps（或 goal + inputs）一起传给它，打开和做事一次完成；之后再在同一个页面上接着做时，${stepsName} 的 target 可以省略。`,
		promptSnippet: `${name}: 打开网页 / 应用并返回 target 和页面内容（可同时执行 steps / goal）`,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		parameters: Type.Object({
			...(o.browser
				? {
						url: Type.Optional(Type.String({ description: "要打开的网址（http / https）" })),
						browser: Type.Optional(Type.Union([Type.Literal("isolated"), Type.Literal("user")], { description: "isolated（默认）= 独立的新 Chrome；user = 连用户正在用的 Chrome（要登录状态时）" })),
					}
				: {}),
			app: Type.Optional(Type.String({ description: "要打开的应用：名字或 bundle id，例如「计算器」「com.apple.calculator」" })),
			session: Type.Optional(Type.String({ description: "会话标签，默认自动生成；后续工具用同一个" })),
			...QUICK_ACTION_PARAMS,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!o.config()) throw new Error("快速执行已关闭：在 设置 › 操作这台电脑 › 快速执行 里打开并选择决策模型。");
			const p = params as { url?: string; browser?: "isolated" | "user"; app?: string; session?: string } & QuickActionParams;
			const url = p.url?.trim();
			const app = p.app?.trim();
			if (url && !o.browser) throw new Error("这个目标不支持打开网页：助理电脑上的网页请用浏览器工具");
			if (!!url === !!app) throw new Error("url 和 app 必须恰好给一个：打开网页给 url，打开应用给 app。");
			if (url) {
				let scheme = "";
				try {
					scheme = new URL(url).protocol;
				} catch {
					throw new Error(`网址格式不对：${url}`);
				}
				// cua 的 browser_navigate 只接受 http / https / about
				if (!["http:", "https:"].includes(scheme)) throw new Error(`只支持 http / https 网址，不支持 ${scheme}`);
			}
			const session = p.session?.trim() || `quick-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
			const exec = async (tool: string, args: Record<string, unknown>): Promise<Outcome> => {
				const out = await (ctx as unknown as ExecContext).executeTool(`${o.prefix}${tool}`, args, { signal });
				if (out.isError) throw new Error(`${tool} 失败：${textOf(out).slice(0, 300) || "没有返回内容"}`);
				return out;
			};
			const structured = (out: Outcome) => unwrapStructured(out.result.structuredContent);
			/** list_windows 最多试 10 次、每次间隔 300 毫秒，返回按优先级排好的窗口列表 */
			const waitWindows = async (pid: number) => {
				for (let i = 0; i < 10; i++) {
					const list = windowsInOrder(structured(await exec("list_windows", { pid, session }))).filter((w) => num(w.window_id) !== undefined);
					if (list.length) return list;
					if (i < 9) await sleep(300);
				}
				return [];
			};

			let target: QuickTarget;
			let label: string;
			if (url) {
				let pid: number | undefined;
				if ((p.browser ?? "isolated") === "user") {
					const chrome = windowsInOrder(structured(await exec("list_windows", { app: "Chrome", session })))[0];
					if (!chrome || num(chrome.pid) === undefined || num(chrome.window_id) === undefined) throw new Error("没找到正在运行的 Chrome");
					pid = num(chrome.pid)!;
					await exec("browser_prepare", { pid, window_id: num(chrome.window_id), session, strategy: { kind: "existing_profile" } });
				} else {
					pid = num(structured(await exec("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" }, session }))?.prepared_pid);
					if (pid === undefined) throw new Error("browser_prepare 没有返回 prepared_pid");
				}
				const wins = (await waitWindows(pid)).slice(0, 5);
				if (!wins.length) throw new Error("浏览器窗口一直没有出现");
				// cua 可能先列出一个辅助 / 不可操作的窗口：按优先级逐个试，取第一个能精确绑定的
				let state: Record<string, unknown> | null = null;
				let bound: Record<string, unknown> | null = null;
				for (const w of wins) {
					const s = structured(await exec("get_browser_state", { pid, window_id: num(w.window_id)!, session }));
					if (s) state = s;
					if (s?.binding_quality === "exact" && s?.mutation_allowed === true) {
						bound = s;
						break;
					}
				}
				if (!bound) {
					const hint = asObj(state?.next_call) ?? asObj(asObj(state?.detail)?.next_call);
					const suggested = num(asObj(hint?.arguments)?.window_id);
					if (suggested !== undefined) {
						const s = structured(await exec("get_browser_state", { pid, window_id: suggested, session }));
						if (s) state = s;
						if (s?.binding_quality === "exact" && s?.mutation_allowed === true) bound = s;
					}
				}
				if (!bound) {
					const extra = [state?.hint, state?.next_call && JSON.stringify(state.next_call)].filter(Boolean).join("；");
					throw new Error(`浏览器绑定不可用（${String(state?.binding_quality ?? "unknown")}）${extra ? `：${extra}` : ""}`);
				}
				state = bound;
				const targetId = typeof state.target_id === "string" ? state.target_id : "";
				const tabs = Array.isArray(state.tabs) ? state.tabs.map(asObj).filter((x): x is Record<string, unknown> => !!x) : [];
				// 独立 Chrome 用当前标签页；用户自己的 Chrome 只用空白标签页，不把用户正在看的页面换掉（cua 不能新开标签页）
				const blank = (x: Record<string, unknown>) => typeof x.url === "string" && /^(about:blank|chrome:\/\/new-?tab)/i.test(x.url);
				const tab = (p.browser ?? "isolated") === "user" ? (tabs.find((x) => x.active === true && blank(x)) ?? tabs.find(blank)) : (tabs.find((x) => x.active === true) ?? tabs[0]);
				if (!tab) throw new Error("你的 Chrome 里没有空白标签页，不替换你正在看的页面：请先新开一个空白标签页再试，或者不传 browser（默认另开一个独立 Chrome）");
				const tabId = typeof tab?.tab_id === "string" ? tab.tab_id : "";
				if (!targetId || !tabId) throw new Error("浏览器绑定成功，但没拿到 target_id / tab_id");
				await exec("browser_navigate", { target_id: targetId, tab_id: tabId, session, url });
				target = { kind: "browser", tab_id: tabId, target_id: targetId, session };
				label = url;
			} else {
				// 形如 com.apple.calculator 才当 bundle id；名字、「TextEdit.app」、/Applications/… 路径都按 name 传（launch_app 的 name 支持 .app 路径）
				const useBundle = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(app!) && !/\.app$/i.test(app!);
				const launched = structured(await exec("launch_app", { [useBundle ? "bundle_id" : "name"]: app, session }));
				let pid = num(launched?.pid) ?? num(launched?.process_id) ?? num(asObj(launched?.app)?.pid);
				if (pid === undefined) pid = num(windowsInOrder(structured(await exec("list_windows", { app, session })))[0]?.pid);
				if (pid === undefined) throw new Error(`打开「${app}」后没找到它的窗口`);
				const win = (await waitWindows(pid))[0];
				if (!win) throw new Error(`打开「${app}」后一直没等到窗口`);
				target = { kind: "window", pid, window_id: num(win.window_id)! };
				label = app!;
			}
			// 刚打开 / 刚导航时页面可能还没渲染出元素：读到空就等一下再读（最多 3 次），不让大模型为此再多一轮
			let obs = await observePage(ctx as unknown as ExecContext, target, o.prefix, signal, false);
			for (let i = 0; i < 3 && typeof obs !== "string" && !obs.candidates.length; i++) {
				await sleep(600);
				obs = await observePage(ctx as unknown as ExecContext, target, o.prefix, signal, false);
			}
			if (typeof obs === "string") throw new Error(`读取页面失败：${obs}`);
			o.remember?.(target);
			const els = obs.candidates.slice(0, 40).map((c) => `${c.handle} ${c.role}「${c.name}」`);
			const openText = [
				`已打开：${label}。`,
				`target（传给 ${stepsName}）：${JSON.stringify(target)}`,
				`可操作的元素（前 40 个）：${els.length ? `\n${els.join("\n")}` : "（没读到可操作的元素）"}`,
				`页面内容：${pageSummary(obs) || "（空）"}`,
			].join("\n");
			// 给了 steps 或 goal：同一次调用里直接做，不用再多一轮
			const wantsAction = (Array.isArray(p.steps) && p.steps.length > 0) || (typeof p.goal === "string" && p.goal.trim() !== "");
			// 步骤参数有错时不要把已经打开的结果丢掉：打开照常返回，附上没开始执行的原因
			let action: Awaited<ReturnType<typeof runQuickAction>> | null = null;
			let actionText = "";
			if (wantsAction) {
				try {
					action = await runQuickAction(ctx as unknown as QuickActionContext, o, target, p, signal);
					actionText = action.content.map((c) => c.text ?? "").join("\n");
				} catch (e) {
					actionText = `已经打开，但步骤没有开始执行：${e instanceof Error ? e.message : String(e)}`;
				}
			}
			return {
				content: [{ type: "text" as const, text: actionText ? `${openText}\n\n${actionText}` : openText }],
				details: { target, session, action: action?.details ?? null },
			};
		},
	});
}
