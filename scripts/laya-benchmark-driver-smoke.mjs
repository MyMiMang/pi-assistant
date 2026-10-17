/**
 * 快速操作模型基准 · **真实驱动契约 smoke**（显式手动运行；不进默认 npm test，默认不跑）。
 *
 * 跑的是生产实现本身：
 *   `createInvokeBenchmarkDriver` → 真实 cua-driver（`cua-driver mcp --socket …`）
 *   → `browser_prepare{allow_launch,profile.isolated_new}`（**驱动自有隔离浏览器**，不用用户日常 Chrome）
 *   → `list_windows(prepared_pid)` → `get_browser_state(pid,window_id)` 绑定
 *   → `browser_navigate(target_id,tab_id,fixture?nonce=…)` → `get_browser_state(target_id,tab_id,semantic_v2)` 取 pin `snapshot.id`
 *   → 真实 fixture 页（本脚本起的 127.0.0.1 HTTP 窄网关）
 *   → 真实页面快照 observce → 候选 → 一次真实 `browser_click{ref}` → 双证据判分（fixture 上报机器状态 + 独立 UI 观测）。
 *
 * 诚实边界：
 *  - **chooser 是脚本固定的**（按候选 label 关键词选），所以本脚本**不评估 Laya 的选择能力**，
 *    只证明 driver / 隔离窗口 / fixture / 动作 / 判分这整条链路真实可用；模型质量要另外跑真实 benchmark。
 *  - 真实失败的链路如实报 `correctness`，不伪造通过。
 *  - 只用**驱动自有**隔离浏览器；结束时只 kill 本次 `prepared_pid`，不碰用户 Chrome / 其它窗口。
 *
 * 用法：
 *   node --import tsx scripts/laya-benchmark-driver-smoke.mjs
 *   PIA_CUA_SOCKET=… PIA_CUA_DRIVER=… PIA_SMOKE_KEEP=1 node --import tsx scripts/laya-benchmark-driver-smoke.mjs
 */
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";

// **必须显式给 socket**：这里不再默认连已安装 App 的守护进程。
//  1) 那条 socket 属于正在运行的 App（生产 Laya）；本脚本只读/驱动测试不该碰它。
//  2) 就算只改 MCP 的 env，也不会改**已经跑起来的**守护进程的环境——拿它跑“修好了”证明不了环境污染已解决。
// 要证明环境隔离，必须自己起一个本次独占 socket 的 daemon（env 与 profile root 明确为原生 / 本次独占），
// 脚本结束时 stop 掉自己的 socket，生产 Laya 不受影响。见 docs/design/fast-model-benchmark.md §9.6。
const SOCKET = process.env.PIA_CUA_SOCKET;
if (!SOCKET) {
	console.error("[smoke] 需要 PIA_CUA_SOCKET 指向**本次独占**的 daemon socket（不要用已安装 App 的生产 socket）");
	process.exit(2);
}
const DRIVER =
	process.env.PIA_CUA_DRIVER ??
	"/Applications/Pi Assistant.app/Contents/Resources/app/bin-seed/cua-driver-0.35.4/cua-driver-rs-0.35.4-darwin-universal/cua-driver";
// 与生产一致：默认不写死 session 标签（用这条 MCP 连接的隐式 session）；显式标签一旦 end_session 结束就不能复用。
const SESSION = process.env.PIA_SMOKE_SESSION || undefined;

const log = (...a) => console.log("[smoke]", ...a);
let exitCode = 0;
const fail = (msg) => {
	console.error("[smoke] FAIL:", msg);
	exitCode = 1;
};

const { createInvokeBenchmarkDriver } = await import("../packages/server/src/fast-computer/benchmark-driver.ts");
const { BenchmarkFixtureStateStore, benchmarkFixtureTasks } = await import("../packages/server/src/fast-computer/benchmark-fixture.ts");
const { mountFastComputerRoutes } = await import("../packages/server/src/fast-computer/routes.ts");
const { createCuaTrialRunner } = await import("../packages/server/src/fast-computer/benchmark-cua.ts");
const { clickCandidatesFromWindowState, clickCandidatesFromBrowserRefs } = await import("../packages/server/src/fast-computer/tool.ts");

if (!existsSync(SOCKET)) fail(`驱动 socket 不存在：${SOCKET}（先在设置 › 电脑开启「操作这台电脑」）`);
if (!existsSync(DRIVER)) fail(`cua-driver 不存在：${DRIVER}（用 PIA_CUA_DRIVER 指定）`);
if (exitCode) process.exit(exitCode);

// ---------------------------------------------------------------- 真实 MCP 连接（与生产同一命令 / 同一客户端）
const client = new McpClient({ name: "pia-laya-bench-smoke", version: "1.0.0", requestTimeoutMs: 30_000 });
// 原生驱动的 env 走生产同一层（OS 账户家目录 / 不继承合成 HOME），不在这里另写一套。
// 与生产同一条路：自有启动器把最终环境全量替换（Pi StdioTransport 会把 process.env 合并回来，只传缺键的 env 删不掉东西）。
const { nativeLaunchCommand } = await import("../packages/server/src/native-launch-env.ts");
const DRIVER_CMD = nativeLaunchCommand(
	{ command: DRIVER, args: ["mcp", "--socket", SOCKET] },
	{ syntheticRoots: [process.env.PIA_DATA_DIR], extra: { CUA_DRIVER_TELEMETRY: "0", CUA_DRIVER_DISABLE_RUN_SCRIPT: "1" } },
);
await client.connect(new StdioTransport({ command: DRIVER_CMD.command, args: DRIVER_CMD.args, env: DRIVER_CMD.env, inheritEnv: DRIVER_CMD.inheritEnv, stderr: "pipe", onStderr: () => {} }));

const invoke = async (_prefix, tool, args) => {
	try {
		const r = await client.callTool(tool, args);
		const text = (r.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
		return { isError: !!r.isError, structuredContent: r.structuredContent, contentText: text };
	} catch (e) {
		return { isError: true, contentText: e instanceof Error ? e.message : String(e) };
	}
};

// ---------------------------------------------------------------- fixture 窄网关（真实 HTTP，仅 127.0.0.1）
const store = new BenchmarkFixtureStateStore();
const app = new Hono();
mountFastComputerRoutes(app, {
	host: { availability: () => ({ cuaReady: true, modelReady: false, fixtureReady: true, reasons: [] }), start: async () => { throw new Error("smoke 不走 host.start"); } },
	store,
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise((r) => setTimeout(r, 80));
const port = server.address()?.port;
if (!port) fail("fixture 网关没起来");

const driver = createInvokeBenchmarkDriver({
	target: () => ({ prefix: "hostpc", ...(SESSION ? { session: SESSION } : {}) }),
	invoke,
	fixtureUrl: (path) => `http://127.0.0.1:${port}${path}`,
	windowKindOf: () => "driver-isolated-browser",
	capable: () => ({ ok: true }),
});

const fixtureId = `smoke-${Math.random().toString(36).slice(2, 8)}`;
const nonce = Math.random().toString(36).slice(2, 12);
const token = Math.random().toString(36).slice(2, 26);
store.arm(fixtureId, nonce, token);

const KEYWORDS = {
	"pick-submit": ["提交"],
	"pick-city": ["combobox", "北京"],
	"scroll-target": ["深度目标"],
	"dynamic-2step": ["下一步", "完成"],
};

const summary = { fixtureId, pin: null, candidates: [], tasks: [], passed: 0, total: 0 };
let opened;
try {
	// 1) 真实隔离窗口 + 真实 pin 契约（beta.29 就是死在这一步）
	opened = await driver.openFixtureWindow({ url: `/api/fast-computer/benchmark/fixture/${fixtureId}?nonce=${nonce}`, fixtureId, nonce, target: "hostpc" });
	const handle = opened.handle;
	summary.pin = { pid: handle.pid, windowId: handle.windowId, windowToken: handle.windowToken, targetId: handle.targetId, tabId: handle.tabId, url: handle.url };
	log("pin ok:", JSON.stringify(summary.pin));

	// 2) 真实受控任务（脚本 chooser 按关键词选；只验链路，不评模型）
	const window = { prefix: handle.prefix, pid: handle.pid, windowId: handle.windowId, session: handle.session, windowToken: handle.windowToken, fixtureId };
	const prefixTool = "mcp__hostpc__";
	const fastTarget = { pid: window.pid, window_id: window.windowId, ...(window.session ? { session: window.session } : {}) };
	const browserTarget = handle.targetId && handle.tabId ? { target_id: handle.targetId, tab_id: handle.tabId, ...(window.session ? { session: window.session } : {}) } : null;

	for (const task of benchmarkFixtureTasks()) {
		store.reset(fixtureId, nonce);
		// 每个任务回起点：同一 tab 重新导航 fixture 根。
		if (browserTarget) await invoke("hostpc", "browser_navigate", { ...browserTarget, url: `http://127.0.0.1:${port}/api/fast-computer/benchmark/fixture/${fixtureId}?nonce=${nonce}` });
		let step = 0;
		const words = KEYWORDS[task.id] ?? [];
		const runner = createCuaTrialRunner(window, {
			readWindow: () => driver.readWindow(handle),
			observe: () => driver.observe(handle),
			collectCandidates: (structured) =>
				browserTarget ? clickCandidatesFromBrowserRefs(prefixTool, browserTarget, structured) : clickCandidatesFromWindowState(prefixTool, fastTarget, structured),
			choose: async (_goal, candidates) => {
				summary.candidates.push({ task: task.id, labels: candidates.map((c) => c.label) });
				const want = words[Math.min(step, words.length - 1)];
				step++;
				const hit = candidates.find((c) => c.label.includes(want)) ?? null;
				return hit ? { kind: "selected", candidate: hit } : { kind: "fallback", reason: "abstain" };
			},
			execute: (tool, args, signal) => driver.execute(handle, tool, args, signal),
			// 与生产同一条 afterSelect：下拉选项由程序侧按任务声明的目标值点（不计入模型能力）。
			afterSelect: async (t, _selected, signal) => {
				const want = t.expect?.machine?.selected;
				if (typeof want !== "string" || !want) return;
				const observed = await driver.observe(handle);
				if (!("ok" in observed)) return;
				const collect = (st) => (browserTarget ? clickCandidatesFromBrowserRefs(prefixTool, browserTarget, st) : clickCandidatesFromWindowState(prefixTool, fastTarget, st));
				const option = collect(observed.structured).find((c) => c.label.includes(want));
				if (option) await driver.execute(handle, option.tool, option.args, signal);
			},
			readMachineState: async () => {
				const ev = store.getEvidence(fixtureId, nonce);
				if (process.env.PIA_SMOKE_DEBUG) log("evidence", task.id, JSON.stringify(ev));
				return ev;
			},
		});
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), 30_000);
		const result = await runner(task, { signal: ac.signal }).finally(() => clearTimeout(t));
		summary.tasks.push({ id: task.id, ...result });
		log("task", task.id, "→", JSON.stringify(result));
	}
	summary.passed = summary.tasks.filter((r) => r.correctness === "correct").length;
	summary.total = summary.tasks.length;
} catch (e) {
	fail(e instanceof Error ? e.message : String(e));
} finally {
	if (opened && !process.env.PIA_SMOKE_KEEP) await opened.close().catch(() => {});
	store.disarm(fixtureId, nonce);
	if (SESSION) await invoke("hostpc", "end_session", { session: SESSION });
	server.close();
	try { await client.close?.(); } catch {}
}

console.log("\n===== SMOKE SUMMARY (JSON) =====");
console.log(JSON.stringify(summary, null, 2));
if (summary.passed !== summary.total || summary.total === 0) {
	const bad = summary.tasks.filter((r) => r.correctness !== "correct");
	fail(`受控任务 ${summary.passed}/${summary.total} 通过：${JSON.stringify(bad)}`);
}
process.exit(exitCode);
