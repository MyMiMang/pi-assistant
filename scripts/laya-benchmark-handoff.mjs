/**
 * 快速操作模型 · **真实主模型接管**（handoff）最小入口。
 *
 * 背景：`laya-benchmark-isolated-harness.mjs` 只证明「工具返回 fallback」，没证明「主模型真的能接手」。
 * 这里不重造 harness / 不接第二个 MCP / 不开新 daemon：复用 harness 已经准备好的自有 daemon + 自有 Laya +
 * fixture 浏览器 + 同一个 `McpClient`，只做两件事：
 *
 *  1. 用**真实注册的** `fastComputerExtension` handler（`pi.registerTool` 只做 stub 取 definition，
 *     `ctx.executeTool` 经既有 `invoke` 走同一个 MCP session）跑**一个**真实 task，拿到真实返回文本；
 *  2. 起一个**仅 127.0.0.1** 的小 HTTP 控制面，让主模型自己用固定命令 `observe / click / pointer / next / finish`
 *     读真实快照、自己挑 ref、自己点。**不选目标、不给坐标、不执行 JS、不替主模型决策。**
 *
 * stepwise 场景（`PIA_BENCH_SCENARIO=stepwise`，只与 `PIA_BENCH_HANDOFF=1` 同用）额外提供**可选**命令
 * `fast{goal,expected?}`：主模型在**同一个页面**上给出**本步**局部目标，经真实注册的 definition 跑一次快模型选择
 * （不 reset / 不导航 / 不清熔断 / 不额外 raw），返回真实 handler 文本并作废旧 ref。每轮最多 6 次，计数在 await 前。
 *
 * 诚实边界：
 *  - 控制面只认本次 fixture（target/tab + 完整 fixture URL + nonce），换 target / 换页面一律拒绝；
 *  - `click` 只接受**主模型最近一次 observe** 返回的 ref（快照更新即作废旧 ref），不做「猜 ref」；
 *  - `next` 只接受 3 个固定 task id（`pick-submit` / `pick-city` / `dynamic-2step`），
 *    `scroll-target` 需要程序侧滚动协助，不属于主模型接管验收；stepwise 只有一个页面，**不提供 next**；
 *  - `expected` 只读给主模型判分，wrapper **不会**自动点击 / 自动完成；`fast` 的 expected 只交给产品工具做后置核验，
 *    不进快模型输入，也不把机器状态 / 判分 oracle 回传给主模型；
 *  - 控制面命令严格串行：同时来第二条返回 `409 busy`，客户端**不要重试**；
 *  - nonce 是本次测试的**临时随机值**（内存态，不是凭据 / 不是真实 key），只经 stdout / handoff.json 交给主模型。
 */
import { createServer } from "node:http";

/** 允许接管的固定任务（不含需要程序侧滚动的 scroll-target）。 */
export const HANDOFF_TASK_IDS = ["pick-submit", "pick-city", "dynamic-2step"];
/** 一次运行最多注册几次真实 handler（真实 Laya 调用上限，不额外 raw）。 */
export const MAX_HANDLER_RUNS = 3;
/** stepwise：主模型每步一次 `fast` 的真实 handler 调用上限（不是“必须用满”）。 */
export const MAX_FAST_STEPS = 6;
const MAX_FAST_GOAL_CHARS = 240;
const MAX_BODY_BYTES = 4096;
const NONCE_HEADER = "x-pia-bench-nonce";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * `fast` 的 expected 只收有限字段：role / label_contains（非空字符串）+ exists 仅 `true`。
 * 产品工具 schema 还有 value_equals / action_contains，但逐步评估不需要；本轮也**不采用** `exists:false`（缺席无法证明）。
 */
function parseFastExpected(raw) {
	if (raw === undefined || raw === null) return {};
	if (!isObj(raw)) return { error: "expected 必须是对象" };
	const out = {};
	for (const [k, v] of Object.entries(raw)) {
		if (k === "exists") {
			if (v !== true) return { error: "expected.exists 只接受 true（本轮不采用“不存在”后置条件）" };
			out.exists = true;
		} else if (k === "role" || k === "label_contains") {
			if (typeof v !== "string" || !v.trim()) return { error: `expected.${k} 必须是非空字符串` };
			out[k] = v.trim();
		} else {
			return { error: `expected 不支持的字段：${k}` };
		}
	}
	return Object.keys(out).length ? { expected: out } : {};
}

/**
 * 纯校验：控制面命令白名单 + 形状。任何多余 / 未知字段都不透传到 MCP（只挑白名单字段）。
 * @returns {{op:string, ref?:string, inputRoute?:string, action?:string, deltaY?:number, deltaX?:number, task?:string, fast?:boolean, goal?:string, expected?:object} | {error:string}}
 */
export function parseHandoffCommand(raw) {
	if (!isObj(raw)) return { error: "命令必须是 JSON 对象" };
	const op = typeof raw.op === "string" ? raw.op : "";
	const out = { op };
	switch (op) {
		case "observe":
		case "finish":
			return out;
		case "fast": {
			if (typeof raw.goal !== "string") return { error: "fast 需要 goal（本步的局部目标）" };
			const goal = raw.goal.trim();
			if (goal.length < 1 || goal.length > MAX_FAST_GOAL_CHARS) return { error: `goal 长度必须是 1..${MAX_FAST_GOAL_CHARS} 个字符` };
			out.goal = goal;
			const parsed = parseFastExpected(raw.expected);
			if (parsed.error) return { error: parsed.error };
			if (parsed.expected) out.expected = parsed.expected;
			return out;
		}
		case "click": {
			if (typeof raw.ref !== "string" || !raw.ref.trim()) return { error: "click 需要 ref" };
			out.ref = raw.ref.trim();
			if (raw.input_route !== undefined && !["trusted", "dom_event"].includes(raw.input_route)) return { error: "不支持的 input_route" };
			out.inputRoute = raw.input_route ?? "trusted";
			return out;
		}
		case "pointer": {
			if (typeof raw.ref !== "string" || !raw.ref.trim()) return { error: "pointer 需要 ref" };
			out.ref = raw.ref.trim();
			const action = typeof raw.action === "string" ? raw.action : "hover";
			if (!["hover", "double_click", "right_click", "scroll"].includes(action)) return { error: `pointer 不支持的动作：${action}` };
			out.action = action;
			if (action === "scroll") {
				const dy = Number(raw.delta_y ?? 0);
				const dx = Number(raw.delta_x ?? 0);
				if (!Number.isFinite(dy) || !Number.isFinite(dx)) return { error: "scroll 需要有限的 delta_x / delta_y" };
				if (!dy && !dx) return { error: "scroll 需要非零 delta_x / delta_y" };
				out.deltaY = Math.max(-4000, Math.min(4000, dy));
				out.deltaX = Math.max(-4000, Math.min(4000, dx));
			}
			return out;
		}
		case "next": {
			if (typeof raw.task !== "string" || !HANDOFF_TASK_IDS.includes(raw.task)) return { error: `next 只接受固定任务：${HANDOFF_TASK_IDS.join(" / ")}` };
			out.task = raw.task;
			out.fast = raw.fast === true;
			return out;
		}
		default:
			return { error: `未知命令：${op || "(空)"}` };
	}
}

/** 主模型自己看到的 ref 清单（只读；`clickable` 只按 actions 描述能力，不替主模型选）。 */
export function describeRefs(elements) {
	const list = Array.isArray(elements) ? elements : [];
	return list
		.filter((e) => e && typeof e.element_token === "string" && e.element_token)
		.map((e) => ({
			ref: e.element_token,
			role: e.role ?? null,
			label: e.label ?? null,
			value: e.value ?? null,
			actions: Array.isArray(e.actions) ? e.actions : [],
			clickable: !Array.isArray(e.actions) || e.actions.includes("click") || e.actions.includes("pointer"),
		}));
}

/** UI 证据：同一份快照里 role=status 的可见文本（不另读一次快照，否则会把主模型手上的 ref 作废）。 */
export function statusEvidence(elements) {
	const list = Array.isArray(elements) ? elements : [];
	return list.filter((e) => e && /status/i.test(String(e.role ?? ""))).map((e) => ({ role: e.role ?? null, label: e.label ?? null }));
}

/** 页面必须是本次 fixture：完整 URL 一致（忽略 hash），否则拒绝。 */
export function isFixtureUrl(url, fixtureUrl) {
	if (typeof url !== "string" || !url) return false;
	const strip = (u) => u.split("#")[0];
	return strip(url) === strip(fixtureUrl);
}

/**
 * 控制面：只挂在 127.0.0.1，POST /command + nonce 头 + JSON + 小 body。
 * 所有能力都来自传入的 `invoke`（同一个 MCP client session），不新接 MCP / daemon。
 */
export function createHandoffControl(options) {
	const { fixtureUrl, fixtureId, nonce, invoke, handle, readSnapshot, readMachine, taskOf, log, onNext, onFast, onCommand, onFinish } = options;
	const state = { refs: new Map(), snapshotToken: null, handlerRuns: 0, fastSteps: 0, busy: false, commands: [], closed: false, lastObserveAt: null };
	const sessionArg = handle.session ? { session: handle.session } : {};
	const target = { target_id: handle.targetId, tab_id: handle.tabId };

	async function observe() {
		const snap = await readSnapshot();
		if (snap.url !== undefined && !isFixtureUrl(snap.url, fixtureUrl)) throw new Error(`当前页面不是本次 fixture（${String(snap.url).slice(0, 120)}），拒绝继续`);
		const refs = describeRefs(snap.elements);
		state.refs = new Map(refs.map((r) => [r.ref, r]));
		state.snapshotToken = snap.token ?? null;
		state.lastObserveAt = new Date().toISOString();
		return {
			refs,
			ui: statusEvidence(snap.elements),
			snapshotToken: state.snapshotToken,
			url: snap.url ?? null,
			fixture: { id: fixtureId, url: fixtureUrl },
			target: { target_id: target.target_id, tab_id: target.tab_id },
		};
	}

	async function machineEvidence(task) {
		const ev = await readMachine();
		return { state: ev.state ?? {}, updatedAt: ev.updatedAt ?? null, expected: task?.expect ?? null };
	}

	async function run(op, cmd) {
		const task = taskOf();
		if (op === "observe") return { ...(await observe()), machine: await machineEvidence(task), expected: task?.expect ?? null, task: task?.id ?? null, title: task?.title ?? null, goal: task?.goal ?? null };
		if (op === "click") {
			if (!state.refs.has(cmd.ref)) return { error: `ref ${cmd.ref} 不在主模型最近一次 observe 的结果里（快照已更新就作废，请先 observe）`, stale: true };
			const args = { ...target, ...sessionArg, ref: cmd.ref, ...(cmd.inputRoute === "dom_event" ? { input_route: "dom_event" } : {}) };
			let r = await invoke("hostpc", "browser_click", args);
			let route = cmd.inputRoute ?? "trusted";
			// 按工具规范：trusted 在 macOS 可能报 input trust 不可用 → 同一回合先 observe（拿新 ref 证明目标还在）再 dom_event。
			if (r.isError && /input_trust|trust_unavailable|browser_input_trust/i.test(String(r.contentText ?? ""))) {
				const fresh = await observe();
				if (!fresh.refs.some((x) => x.ref === cmd.ref)) return { error: "dom_event 回退前目标已变化（ref 不在新快照里），已中止", stale: true };
				route = "dom_event";
				r = await invoke("hostpc", "browser_click", { ...args, input_route: "dom_event" });
			}
			return { dispatched: !r.isError, route, error: r.isError ? String(r.contentText ?? "").slice(0, 400) : null, toolText: String(r.contentText ?? "").slice(0, 1000) };
		}
		if (op === "pointer") {
			if (!state.refs.has(cmd.ref)) return { error: `ref ${cmd.ref} 不在主模型最近一次 observe 的结果里（请先 observe）`, stale: true };
			const args = { ...target, ...sessionArg, action: cmd.action, ref: cmd.ref, ...(cmd.action === "scroll" ? { delta_x: cmd.deltaX, delta_y: cmd.deltaY } : {}) };
			const r = await invoke("hostpc", "browser_pointer", args);
			// pointer 会改变页面（滚动 / 悬停菜单），旧 ref 一律作废，逼主模型重新 observe。
			state.refs = new Map();
			return { ok: !r.isError, error: r.isError ? String(r.contentText ?? "").slice(0, 400) : null };
		}
		if (op === "fast") {
			if (!onFast) return { error: "本次运行没有启用 fast 逐步选择（只有 stepwise 场景提供）" };
			if (state.fastSteps >= MAX_FAST_STEPS) return { error: `fast 最多 ${MAX_FAST_STEPS} 次（本次已用 ${state.fastSteps} 次），请改用 click 自己接管或 finish` };
			// 计数在 await 之前：并发 / 异常都不会多跑。页面可能变化，旧 ref 立即作废（返回里也要求重新 observe）。
			state.fastSteps++;
			state.refs = new Map();
			try {
				const out = await onFast(cmd.goal, cmd.expected);
				return {
					fast: state.fastSteps,
					remaining: Math.max(0, MAX_FAST_STEPS - state.fastSteps),
					handlerKind: out?.kind ?? null,
					handlerText: out?.text ?? null,
					wallMs: out?.wallMs ?? null,
					// 不回传机器状态 / 判分 oracle：主模型自己 observe 看真实页面与状态。
					note: "refs 已作废：请先 observe 再决定下一步；expected 的后置核验已记录在报告里",
				};
			} finally {
				state.refs = new Map();
			}
		}
		if (op === "next") {
			if (!onNext) return { error: "本次运行不支持切换任务（stepwise 只有一个页面）" };
			// 新任务 = 新导航：旧 ref 全部作废，状态由调用方（harness）reset + navigate。
			state.refs = new Map();
			await onNext(cmd.task, cmd.fast === true);
			return { next: cmd.task, fast: cmd.fast === true };
		}
		if (op === "finish") {
			state.refs = new Map();
			setImmediate(() => onFinish?.());
			return { closing: true };
		}
		return { error: `未知命令：${op}` };
	}

	async function handleRequest(req, res) {
		const send = (code, body) => {
			res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify(body));
		};
		if (req.method !== "POST") return send(405, { ok: false, error: "只接受 POST /command" });
		if (req.url !== "/command") return send(404, { ok: false, error: "只接受 POST /command" });
		if (req.headers[NONCE_HEADER] !== nonce) return send(403, { ok: false, error: "nonce 不匹配" });
		const ctype = String(req.headers["content-type"] ?? "");
		if (!/^application\/json\b/i.test(ctype)) return send(415, { ok: false, error: "只接受 application/json" });
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				// 不 destroy：先把剩余 body 丢掉再回 413，否则调用方只会看到连接被掐断。
				req.resume();
				return send(413, { ok: false, error: `body 超过 ${MAX_BODY_BYTES} 字节` });
			}
			chunks.push(chunk);
		}
		let raw;
		try {
			raw = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
		} catch {
			return send(400, { ok: false, error: "body 不是合法 JSON" });
		}
		const parsed = parseHandoffCommand(raw);
		if (parsed.error) return send(400, { ok: false, error: parsed.error });
		// 命令严格串行：in-flight 时第二条直接 409，不排队、不自动重试（避免同页并发 / 双算计数）。
		if (state.busy) return send(409, { ok: false, busy: true, error: "busy：控制面一次只执行一条命令，请等上一条返回后再发（不要重试）" });
		state.busy = true;
		const entry = { op: parsed.op, ref: parsed.ref ?? null, action: parsed.action ?? null, task: parsed.task ?? null, fast: parsed.fast ?? null, goal: parsed.goal ?? null, at: new Date().toISOString() };
		try {
			const result = await run(parsed.op, parsed);
			if (result?.error) entry.error = result.error;
			else entry.ok = true;
			state.commands.push(entry);
			onCommand?.(entry);
			log?.(`handoff ${parsed.op} ${parsed.ref ?? parsed.task ?? parsed.goal ?? ""} → ${result?.error ? `error=${result.error}` : "ok"}`);
			send(200, { ok: !result?.error, op: parsed.op, ...result });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			entry.error = msg;
			state.commands.push(entry);
			onCommand?.(entry);
			send(500, { ok: false, op: parsed.op, error: msg });
		} finally {
			state.busy = false;
		}
	}

	return {
		state,
		handler: handleRequest,
		async listen() {
			const server = createServer((req, res) => void handleRequest(req, res));
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const port = server.address()?.port;
			if (!port) throw new Error("控制面没有拿到端口");
			return { server, origin: `http://127.0.0.1:${port}` };
		},
	};
}

/**
 * 主模型接管报告条目：把「快模型自己做的」和「主模型显式命令做的」分开记。
 */
export function summarizeHandoff(entries) {
	return entries.map((e) => ({
		task: e.task,
		title: e.title ?? null,
		handler: { kind: e.handlerKind ?? null, text: e.handlerText ?? null, wallMs: e.handlerWallMs ?? null },
		// 逐步评估：每一步单独一条（目标 / 真实选择结果 / 后置独立观察的机器状态）；主模型接管点击另算。
		fastSteps: (e.fastSteps ?? []).map((s) => ({
			goal: s.goal,
			expected: s.expected ?? null,
			handler: { kind: s.handlerKind ?? null, text: s.handlerText ?? null, wallMs: s.handlerWallMs ?? null },
			machine: s.machine ?? null,
			ui: s.ui ?? null,
		})),
		fastAlone: e.handlerKind === "selected" ? { decision: e.handlerDecision ?? "selected", machine: e.machine ?? null, ui: e.ui ?? null } : null,
		mainTakeover: { commands: e.commands ?? [], wallMs: e.wallMs ?? null, machine: e.machine ?? null, ui: e.ui ?? null },
	}));
}
