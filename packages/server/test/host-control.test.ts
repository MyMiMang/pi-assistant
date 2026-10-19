/**
 * 操作这台电脑：能力清单生成（三平台）、开启前必须确认同一份清单、ext-computer 本机目标逐项审批 +
 * “本任务内都允许” + 一键暂停、只读观察不审批。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { computerExtension, HOST_MCP_PREFIX, HOST_MCP_SERVER, isHostTool } = await import("@pi-assistant/ext-computer");
const hc = await import("../src/host-control.ts");

test("能力清单：bounded v3、只列允许的工具与应用、整屏观察关闭、工作区读写", () => {
	const mac = hc.buildManifest({ apps: [{ name: "文本编辑", id: "com.apple.TextEdit" }], workspaceFiles: true }, ["/Users/a/ws"], "darwin");
	assert.match(mac, /^version: 3$/m);
	assert.match(mac, /^expires_after: 8h$/m);
	assert.match(mac, /^idle_timeout: 30m$/m);
	assert.match(mac, /- bundle_id: "com.apple.TextEdit"/);
	assert.match(mac, /terminate: driver_launched/);
	assert.match(mac, /display: false/);
	assert.match(mac, /dir: "\/Users\/a\/ws"/);
	for (const bad of ["get_desktop_state", "clipboard_read", "start_recording", "install_extension", "set_config", "browser_prepare", "page"]) assert.doesNotMatch(mac, new RegExp(`- ${bad}$`, "m"), bad);
	const win = hc.buildManifest({ apps: [{ name: "记事本", id: "C:\\Windows\\System32\\notepad.exe" }], workspaceFiles: false }, ["C:\\ws"], "win32");
	assert.match(win, /- executable: "C:\\\\Windows\\\\System32\\\\notepad.exe"/, "Windows 路径按 YAML 双引号转义");
	assert.doesNotMatch(win, /files:/);
	assert.match(hc.buildManifest({ apps: [], workspaceFiles: false }, [], "linux"), /apps: \[\]/);
	assert.equal(hc.cuaAssetKey("darwin", "arm64"), "darwin");
	assert.equal(hc.cuaAssetKey("win32", "x64"), "win-x64");
	assert.equal(hc.cuaAssetKey("linux", "arm64"), "linux-arm64");
});

test("开启：默认关闭；清单哈希与用户确认的不一致就拒绝启动", async () => {
	assert.equal(hc.hostSettings().enabled, false);
	assert.equal(hc.hostAllowedFor("a1"), false);
	const yaml = hc.buildManifest({ apps: [{ name: "x", id: "/usr/bin/x" }], workspaceFiles: true }, ["/w"]);
	hc.saveHostSettings({ enabled: true, approvedHash: "different", agents: ["a1"] });
	await assert.rejects(hc.startDaemon(yaml), /权限设置已变化/);
	assert.equal(hc.hostAllowedFor("a1"), true);
	assert.equal(hc.hostAllowedFor("a2"), false, "只允许选中的助理");
	hc.saveHostSettings({ enabled: false, approvedHash: undefined, agents: "all" });
	assert.match(hc.describeHostAction("type_text", { text: "你好" }), /输入文字「你好」/);
});

test("ext-computer 本机目标：MCP 服务名独立、逐项审批、本任务内都允许、只读不问、暂停即拒", async () => {
	const servers: { name: string; cfg: { command: string; args: string[]; env: Record<string, string> } }[] = [];
	const tools: string[] = [];
	let handler: ((e: { toolName: string; input: unknown }) => Promise<{ block?: boolean; reason?: string } | undefined>) | null = null;
	const asks: { summary: string; allowTask?: boolean }[] = [];
	let answer: { approved: boolean; scope?: "task" } = { approved: false };
	let paused = false;
	computerExtension({ target: "host", mcp: { command: "/bin/cua-driver", args: ["mcp", "--socket", "/s"] }, isPaused: () => paused, request: async (r) => (asks.push(r), answer), describe: hc.describeHostAction })({
		registerMcpServer: (name: string, cfg: never) => servers.push({ name, cfg }),
		registerTool: (t: { name: string }) => tools.push(t.name),
		on: (n: string, h: typeof handler) => n === "tool_call" && (handler = h),
	} as never);
	assert.equal(servers[0].name, HOST_MCP_SERVER);
	assert.deepEqual(servers[0].cfg.args, ["mcp", "--socket", "/s"]);
	assert.equal(servers[0].cfg.env.CUA_DRIVER_TELEMETRY, "0");
	assert.ok(!tools.includes("computer_screenshot"), "本机不提供整屏截图");
	const call = (tool: string, input: Record<string, unknown> = {}) => handler!({ toolName: `${HOST_MCP_PREFIX}${tool}`, input });
	assert.equal(await call("list_windows"), undefined, "只读观察不审批");
	assert.equal(await call("get_window_state", { pid: 1 }), undefined);
	assert.equal(asks.length, 0);
	const r1 = await call("type_text", { text: "hello" });
	assert.equal(r1?.block, true);
	assert.match(asks[0].summary, /在你的电脑上输入文字「hello」/);
	assert.equal(asks[0].allowTask, true);
	answer = { approved: true, scope: "task" };
	assert.equal(await call("type_text", { text: "a" }), undefined);
	answer = { approved: false };
	assert.equal(await call("type_text", { text: "b" }), undefined, "本任务内都允许后不再问");
	assert.equal((await call("click", { x: 1 }))?.block, true, "其他动作仍要问");
	paused = true;
	assert.match((await call("list_windows"))?.reason ?? "", /暂停/);
	assert.ok(isHostTool(`${HOST_MCP_PREFIX}click`));
});

test("权限档位：按助理设置；默认限定；只看/信任/完全权限连 unrestricted 守护进程；计划里列出各助理档位", () => {
	hc.setHostEnv({ workspaceOf: (id) => `/ws/${id}`, agentIds: () => ["a1", "a2", "a3"] });
	hc.saveHostSettings({ agents: "all", apps: [{ name: "TextEdit", id: "/usr/bin/textedit" }], tiers: {}, defaultTier: "bounded" });
	assert.equal(hc.tierOf("a1"), "bounded");
	assert.equal(hc.hostApprovals("a1"), "all");
	assert.deepEqual(hc.neededDaemons(), ["bounded"]);
	hc.saveHostSettings({ tiers: { a2: "trusted", a3: "observe" } });
	assert.equal(hc.hostApprovals("a2"), "sensitive");
	assert.equal(hc.hostApprovals("a3"), "observe");
	assert.deepEqual(hc.neededDaemons(), ["bounded", "open"]);
	hc.saveHostSettings({ tiers: { a1: "full", a2: "trusted", a3: "observe" } });
	assert.equal(hc.hostApprovals("a1"), "none");
	assert.deepEqual(hc.neededDaemons(), ["open"]);
	const plan = hc.hostPlan();
	assert.match(plan, /a1: 完全权限/);
	assert.match(plan, /a2: 信任/);
	assert.match(plan, /a3: 只看/);
	assert.doesNotMatch(plan, /version: 3/, "没有限定档位的助理时不需要清单");
	hc.saveHostSettings({ tiers: { a1: "bounded", a2: "trusted", a3: "observe" } });
	assert.match(hc.hostPlan(), /version: 3/);
	assert.match(hc.boundedManifest(), /\/ws\/a1/);
	assert.doesNotMatch(hc.boundedManifest(), /\/ws\/a2/, "清单只包含限定档位助理的工作区");
	const open = hc.serveArgs("open");
	assert.deepEqual(open.slice(open.indexOf("--permission-mode"), open.indexOf("--permission-mode") + 3), ["--permission-mode", "unrestricted", "--dangerously-bypass-approvals"]);
	assert.ok(hc.serveArgs("bounded").includes("--capability-manifest"));
	assert.notEqual(hc.socketPath("open"), hc.socketPath("bounded"));
	hc.saveHostSettings({ tiers: { a1: "trusted" } });
	assert.match(hc.hostMcpCommand("a1").args.join(" "), /cua-open/);
	hc.saveHostSettings({ tiers: {} });
	assert.match(hc.hostMcpCommand("a1").args.join(" "), /cua-bounded/);
	assert.equal(hc.sandboxComputerSettings().approvals, "none", "助理自己的电脑默认完全权限");
	assert.throws(() => hc.saveSandboxComputerSettings({ approvals: "x" as never }));
});

test("新助理继承默认档位；改默认不影响已有助理（固定成显式设置）；删除的助理清理", async () => {
	let ids = ["a1", "a2"];
	hc.setHostEnv({ workspaceOf: (id) => `/ws/${id}`, agentIds: () => ids });
	hc.saveHostSettings({ enabled: false, tiers: { a1: "trusted" }, defaultTier: "observe", fullAck: {} });
	await hc.hostAgentsChanged();
	assert.deepEqual(hc.hostSettings().tiers, { a1: "trusted", a2: "observe" });
	hc.saveHostSettings({ defaultTier: "full" });
	ids = ["a1", "a2", "a3"];
	await hc.hostAgentsChanged();
	assert.equal(hc.tierOf("a2"), "observe", "已有助理不变");
	assert.equal(hc.tierOf("a3"), "full", "新助理继承默认");
	assert.ok(hc.hostSettings().fullAck.a3);
	ids = ["a1", "a3"];
	await hc.hostAgentsChanged();
	assert.deepEqual(Object.keys(hc.hostSettings().tiers).sort(), ["a1", "a3"]);
	assert.match(hc.hostPlan(), /新助理默认：完全权限/);
	hc.saveHostSettings({ tiers: {}, defaultTier: "bounded", fullAck: {} });
});

test("只看档位：输入工具被隐藏并拦下；硬性保护只在非完全权限档位要求批准且不能本任务内允许", async () => {
	const { computerExtension, HOST_MCP_PREFIX, INPUT_TOOLS } = await import("@pi-assistant/ext-computer");
	let policy: "observe" | "sensitive" | "none" = "observe";
	const asks: { summary: string; allowTask?: boolean }[] = [];
	let answer = { approved: true, scope: "task" as const };
	const h: Record<string, (e: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>> = {};
	let cfg: { toolExposure: Record<string, string> } | null = null;
	computerExtension({ target: "host", mcp: { command: "x", args: [] }, isPaused: () => false, approvals: () => policy, request: async (r) => (asks.push(r), answer), guard: { target: "host" } })({
		registerMcpServer: (_n: string, c: never) => (cfg = c),
		registerTool: () => {},
		on: (n: string, fn: (e: unknown) => Promise<{ block?: boolean } | undefined>) => (h[n] = fn),
	} as never);
	for (const t of INPUT_TOOLS.slice(0, 5)) assert.equal(cfg!.toolExposure[t], "hidden");
	const call = (tool: string, input: Record<string, unknown> = {}) => h.tool_call({ toolName: `${HOST_MCP_PREFIX}${tool}`, input, toolCallId: tool });
	assert.equal(await call("get_window_state", { pid: 1 }), undefined);
	assert.match((await call("click", { x: 1 }))?.reason ?? "", /只看/);
	assert.equal(asks.length, 0);
	// 信任：普通动作不问，受保护动作要批准、不能“本任务内都允许”、批准了也不记住
	policy = "sensitive";
	assert.equal(await call("click", { x: 1 }), undefined, "信任：普通点击不问");
	assert.equal(asks.length, 0);
	assert.equal(await call("hotkey", { keys: ["cmd", "shift", "q"] }), undefined, "信任：受保护快捷键批准后放行");
	assert.match(asks[0].summary, /受保护的操作/);
	assert.equal(asks[0].allowTask, false, "受保护的操作不提供本任务内都允许");
	answer = { approved: false } as never;
	assert.equal((await call("hotkey", { keys: ["cmd", "shift", "q"] }))?.block, true, "批准过也不记住，拒绝后拦下");
	assert.equal(asks.length, 2);
	// 完全权限：应用层不再创建审批请求（即使 stub 一律拒绝也不问）
	policy = "none";
	assert.equal(await call("click", { x: 1 }), undefined, "完全权限：普通动作不问");
	assert.equal(await call("kill_app", { name: "Pi Assistant" }), undefined, "完全权限：受保护动作直接放行");
	assert.equal(await call("hotkey", { keys: ["cmd", "shift", "q"] }), undefined, "完全权限：受保护快捷键也直接放行");
	assert.equal(asks.length, 2, "完全权限：一次审批请求都不创建");
});

test("完全权限：应用层审批入口 requests.approval 直接放行、不写卡片；非 full 照常等用户；暂停后立刻恢复", async () => {
	const { requests } = await import("../src/requests.ts");
	const { db, now } = await import("../src/db.ts");
	for (const [id, name] of [["fa", "完全"], ["ta", "信任"]] as const) db.prepare("INSERT OR REPLACE INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#000", now());
	const count = (agent: string) => (db.prepare("SELECT COUNT(*) c FROM requests WHERE agent_id = ?").get(agent) as { c: number }).c;
	hc.setHostEnv({ workspaceOf: (id) => `/ws/${id}`, agentIds: () => ["fa", "ta"] });
	hc.saveHostSettings({ enabled: true, approvedHash: "h", agents: "all", tiers: { fa: "full", ta: "trusted" }, defaultTier: "bounded", fullAck: {} });
	const ok = await requests.approval("fa", null, "email_send", { 收件: "a@b.c" }, "发送邮件给 a@b.c", "high");
	assert.equal(ok.approved, true, "完全权限：直接批准");
	assert.equal(ok.note, "完全权限：应用层不弹审批，已自动放行");
	assert.equal(count("fa"), 0, "完全权限：不创建审批请求、不写卡片");
	// 非 full：仍然创建 pending 卡片，等用户回应
	const p = requests.approval("ta", null, "email_send", {}, "发送邮件", "high");
	assert.equal((db.prepare("SELECT status FROM requests WHERE agent_id = ?").get("ta") as { status: string }).status, "pending");
	requests.resolve((db.prepare("SELECT id FROM requests WHERE agent_id = ?").get("ta") as { id: string }).id, { approved: true }, "test");
	assert.equal((await p).approved, true);
	// 主 / 子 / 后台都用所属助理的当前档位：后台任务的审批同样直接放行
	await import("../src/subagents.ts");
	// 后台任务 / 巡检都是帮手（决策 0014）
	const helperRow = (id: string, kind: string) => db.prepare("INSERT INTO subagents(id, agent_id, conversation_id, task, context, model_provider, model_id, model_reason, status, last_activity_at, created_at, kind) VALUES(?,'fa','c','x','','mock','echo','','running',?,?,?)").run(id, now(), now(), kind);
	helperRow("bg1", "task");
	assert.equal((await requests.approval("fa", "bg1", "email_send", {}, "后台发邮件", "high")).approved, true, "后台任务用父助理档位：直接放行");
	assert.equal(count("fa"), 0, "后台任务也不写卡片");
	// 例外：主动巡检（心跳）仍然不自主执行需要批准的操作（主动 ≠ 自主），但不弹卡片
	helperRow("hb1", "heartbeat");
	const hb = await requests.approval("fa", "hb1", "email_send", {}, "巡检发邮件", "high");
	assert.equal(hb.approved, false, "心跳任务仍不自主执行需批准的操作");
	assert.equal(count("fa"), 0, "心跳只在内存里拒绝，不写卡片");
	// 暂停（或降权 / 关闭）：hostFileAccess 立刻变假，完全权限也回到审批
	await hc.setHostPaused(true);
	const paused = requests.approval("fa", null, "email_send", {}, "发送邮件", "high");
	const row = db.prepare("SELECT id, status FROM requests WHERE agent_id = ?").get("fa") as { id: string; status: string };
	assert.equal(row.status, "pending", "暂停后不再 bypass");
	requests.resolve(row.id, { approved: false, note: "测试拒绝" }, "test");
	assert.equal((await paused).approved, false);
	await hc.setHostPaused(false);
	hc.saveHostSettings({ enabled: false, approvedHash: undefined, agents: "all", tiers: {}, defaultTier: "bounded", fullAck: {} });
});

test("ext-approval：硬性保护命中的 shell/文件操作必须批准，即使工具被标为 trusted", async () => {
	const { approvalExtension, hardGuard } = await import("@pi-assistant/ext-approval");
	assert.equal(hardGuard("bash", { command: "sudo shutdown -h now" }, "/ws", { target: "host" })?.rule, "power");
	assert.equal(hardGuard("write", { path: "../../.zshrc" }, "/Users/d/ws", { target: "host" })?.rule, "rc");
	const asks: string[] = [];
	let approved = false;
	let fn: ((e: unknown) => Promise<{ block?: boolean } | undefined>) | null = null;
	approvalExtension({ workspace: "/ws", trusted: () => true, guard: { target: "host" }, request: async (r) => (asks.push(r.summary), { approved }) })({ on: (_n: string, f: never) => (fn = f), getAllTools: () => [] } as never);
	assert.equal((await fn!({ toolName: "bash", input: { command: "killall Finder" } }))?.block, true);
	assert.match(asks[0], /受保护的操作（结束系统进程）/);
	assert.equal(await fn!({ toolName: "bash", input: { command: "ls" } }), undefined, "trusted 的普通命令不问");
	approved = true;
	assert.equal(await fn!({ toolName: "bash", input: { command: "killall Finder" } }), undefined);
	assert.equal(asks.length, 2);
});

test("敏感动作判断：结束应用、回车/删除键、带换行的输入、点到“发送/支付/删除”", async () => {
	const { isSensitiveAction } = await import("@pi-assistant/ext-computer");
	assert.equal(isSensitiveAction("kill_app", {}), true);
	assert.equal(isSensitiveAction("press_key", { key: "Return" }), true);
	assert.equal(isSensitiveAction("press_key", { key: "a" }), false);
	assert.equal(isSensitiveAction("hotkey", { keys: ["cmd", "Delete"] }), true);
	assert.equal(isSensitiveAction("hotkey", { keys: ["cmd", "c"] }), false);
	assert.equal(isSensitiveAction("type_text", { text: "你好" }), false);
	assert.equal(isSensitiveAction("type_text", { text: "你好\n" }), true);
	const tree = ['[e12] AXButton "发送(S)"', '[e13] AXTextArea "输入"', '[e14] AXButton "立即支付"'].join("\n");
	assert.equal(isSensitiveAction("click", { element_token: "e12" }, [tree]), true);
	assert.equal(isSensitiveAction("click", { element_token: "e13" }, [tree]), false);
	assert.equal(isSensitiveAction("click", { element_token: "e14" }, [tree]), true);
	assert.equal(isSensitiveAction("click", { x: 10, y: 10 }, [tree]), false);
	assert.equal(isSensitiveAction("invoke_menu", { path: ["文件", "删除"] }), true);
	assert.equal(isSensitiveAction("scroll", {}), false);
});

test("审批策略 + 操作记录：sensitive 只问敏感动作、none 不问、暂停仍拦、全部记录（含被拒）", async () => {
	const { computerExtension, HOST_MCP_PREFIX } = await import("@pi-assistant/ext-computer");
	const { recordAction, listActions } = await import("../src/action-log.ts");
	let policy: "all" | "sensitive" | "none" = "sensitive";
	let paused = false;
	const asks: string[] = [];
	const h: Record<string, (e: unknown) => Promise<{ block?: boolean } | undefined>> = {};
	computerExtension({ target: "host", mcp: { command: "x", args: [] }, isPaused: () => paused, approvals: () => policy, request: async (r) => (asks.push(r.summary), { approved: false }), describe: hc.describeHostAction, log: (e) => recordAction("logagent", "t1", e) })({
		registerMcpServer: () => {},
		registerTool: () => {},
		on: (n: string, fn: (e: unknown) => Promise<{ block?: boolean } | undefined>) => (h[n] = fn),
	} as never);
	let n = 0;
	const call = async (tool: string, input: Record<string, unknown> = {}, result = "ok") => {
		const id = `c${++n}`;
		const r = await h.tool_call({ toolName: `${HOST_MCP_PREFIX}${tool}`, input, toolCallId: id });
		if (!r?.block) await h.tool_result({ toolName: `${HOST_MCP_PREFIX}${tool}`, toolCallId: id, input, content: [{ type: "text", text: result }], isError: false });
		return r;
	};
	await call("get_window_state", { pid: 1 }, '[e7] AXButton "发送"\n[e8] AXButton "表情"');
	assert.equal(await call("click", { element_token: "e8" }), undefined, "非敏感点击不问");
	assert.equal((await call("click", { element_token: "e7" }))?.block, true, "点“发送”要问");
	assert.equal(asks.length, 1);
	policy = "none";
	assert.equal(await call("click", { element_token: "e7" }), undefined, "none 不问");
	assert.equal(asks.length, 1);
	paused = true;
	assert.equal((await call("click", { x: 1 }))?.block, true, "暂停在任何模式下都拦");
	const log = listActions({ agentId: "logagent" });
	assert.deepEqual(log.map((r) => [r.tool, r.outcome]).reverse(), [["get_window_state", "done"], ["click", "done"], ["click", "blocked"], ["click", "done"], ["click", "blocked"]]);
	assert.match(log[0].detail ?? "", /暂停/);
	assert.match(log[2].detail ?? "", /拒绝/);
	assert.equal(log[1].approval, "auto");
});

test("正在操作判断：只看最近的 host 动作（进行中 / 刚结束几秒内），思考或很久前的动作不算", () => {
	const now = 1_000_000_000;
	assert.equal(hc.hostActive(undefined, now), false);
	assert.equal(hc.hostActive({ outcome: "running", started_at: now - 5_000 }, now), true);
	assert.equal(hc.hostActive({ outcome: "running", started_at: now - 11 * 60_000 }, now), false);
	assert.equal(hc.hostActive({ outcome: "ok", started_at: now - 3_000, finished_at: now - 2_000 }, now), true);
	assert.equal(hc.hostActive({ outcome: "ok", started_at: now - 30_000, finished_at: now - 20_000 }, now), false);
	assert.equal(hc.hostActive({ outcome: "ok", started_at: now - 60_000, finished_at: now - hc.HOST_ACTIVE_MS - 1 }, now), false);
});

test("CDP 浏览器工具：限定档位不提供且清单不放行；连接浏览器按档位审批；上传下载限工作区；助理电脑隐藏", async () => {
	const mac = hc.buildManifest({ apps: [{ name: "Chrome", id: "com.google.Chrome" }], workspaceFiles: true }, ["/Users/a/ws"], "darwin");
	for (const t of ["browser_prepare", "get_browser_state", "browser_navigate", "browser_click"]) assert.doesNotMatch(mac, new RegExp(`- ${t}$`, "m"));
	assert.doesNotMatch(mac, /existing_profile/);

	const { computerExtension, HOST_MCP_PREFIX, MCP_PREFIX, CUA_BROWSER_TOOLS, HIDDEN_TOOLS } = await import("@pi-assistant/ext-computer");
	const mk = (o: Record<string, unknown>) => {
		const asks: { summary: string; allowTask?: boolean }[] = [];
		const h: Record<string, (e: unknown) => Promise<{ block?: boolean; reason?: string; systemPrompt?: string } | undefined>> = {};
		let cfg: { toolExposure: Record<string, string> } | null = null;
		computerExtension({ target: "host", workspace: "/Users/a/ws", mcp: { command: "x", args: [] }, isPaused: () => false, request: async (r: { summary: string; allowTask?: boolean }) => (asks.push(r), { approved: true, scope: "task" as const }), guard: { target: "host" }, ...o } as never)({
			registerMcpServer: (_n: string, c: never) => (cfg = c), registerTool: () => {}, on: (n: string, fn: never) => (h[n] = fn),
		} as never);
		const call = (tool: string, input: Record<string, unknown> = {}) => h.tool_call({ toolName: `${(o.target === "sandbox" ? MCP_PREFIX : HOST_MCP_PREFIX)}${tool}`, input, toolCallId: tool });
		return { asks, h, cfg: cfg!, call };
	};
	// 限定档位（bounded → approvals all）
	const b = mk({ approvals: () => "all", browserTools: false });
	// Pi 1.2.0 起 before_agent_start 是按 messageType 区分的 union；测试桩按真实的用户回合事件传参
	const userEvent = { systemPrompt: "", messageType: "user" as const, prompt: "" };
	for (const t of CUA_BROWSER_TOOLS) assert.equal(b.cfg.toolExposure[t], "hidden");
	assert.match((await b.h.before_agent_start(userEvent))?.systemPrompt ?? "", /信任/);
	assert.match((await b.call("browser_prepare", { pid: 1 }))?.reason ?? "", /信任/);
	// 完全权限
	const f = mk({ approvals: () => "none" });
	for (const t of CUA_BROWSER_TOOLS) assert.equal(f.cfg.toolExposure[t], undefined, `${t} 可见`);
	for (const t of ["page", "install_extension", "set_config", "parse_visual_regions"]) assert.ok(HIDDEN_TOOLS.includes(t) && f.cfg.toolExposure[t] === "hidden");
	const prompt = (await f.h.before_agent_start(userEvent))?.systemPrompt ?? "";
	assert.ok(prompt.indexOf("get_browser_state {pid") < prompt.indexOf("browser_prepare {pid"), "先绑定，需要时才 prepare");
	assert.match(prompt, /include_screenshot:true/);
	assert.match(prompt, /dom_event/);
	assert.equal(await f.call("browser_prepare", { pid: 1, window_id: 2, strategy: { kind: "existing_profile" } }), undefined);
	assert.equal(f.asks.length, 0, "完全权限：连接浏览器也不问");
	assert.equal(await f.call("browser_navigate", { url: "https://x.com" }), undefined);
	assert.match((await f.call("browser_set_input_files", { files: ["/etc/passwd"] }))?.reason ?? "", /工作区/);
	assert.equal(await f.call("browser_set_input_files", { files: ["/Users/a/ws/a.png"] }), undefined);
	assert.match((await f.call("browser_download", { destination_root: "/Users/a/ws/../.ssh" }))?.reason ?? "", /工作区/);
	// 信任档位：下载算敏感动作
	const t = mk({ approvals: () => "sensitive" });
	await t.call("browser_prepare", { pid: 1, window_id: 2, strategy: { kind: "existing_profile" } });
	assert.equal(t.asks.length, 0, "信任：连接浏览器按普通动作，不问");
	await t.call("browser_download", { destination_root: "/Users/a/ws" });
	assert.equal(t.asks.length, 1);
	// 助理电脑
	const s = mk({ target: "sandbox" });
	for (const x of CUA_BROWSER_TOOLS) assert.equal(s.cfg.toolExposure[x], "hidden", `${x} 助理电脑隐藏（用 Playwright）`);
	assert.equal((await s.call("browser_click", {}))?.block, true);
});

test("本机桌面：只看隐藏全部输入工具（含剪贴板/窗口大小/录屏/光标/批量）；完全权限任意应用不问；信任只问敏感动作；提示按官方流程", async () => {
	const { computerExtension, HOST_MCP_PREFIX, INPUT_TOOLS } = await import("@pi-assistant/ext-computer");
	for (const t of ["drag", "scroll", "hotkey", "launch_app", "clipboard_write", "set_window_frame", "start_recording", "stop_recording", "set_agent_cursor_enabled", "run_steps"]) assert.ok(INPUT_TOOLS.includes(t), t);
	const mk = (p: string) => {
		const asks: unknown[] = [];
		const h: Record<string, (e: unknown) => Promise<{ block?: boolean; reason?: string; systemPrompt?: string } | undefined>> = {};
		let cfg: { toolExposure: Record<string, string>; description: string } | null = null;
		computerExtension({ target: "host", mcp: { command: "x", args: [] }, isPaused: () => false, approvals: () => p, request: async (r: unknown) => (asks.push(r), { approved: true }), guard: { target: "host" } } as never)({
			registerMcpServer: (_n: string, c: never) => (cfg = c), registerTool: () => {}, on: (n: string, fn: never) => (h[n] = fn),
		} as never);
		return { asks, h, cfg: cfg!, call: (tool: string, input: Record<string, unknown> = {}) => h.tool_call({ toolName: `${HOST_MCP_PREFIX}${tool}`, input, toolCallId: tool }) };
	};
	const o = mk("observe");
	for (const t of ["clipboard_write", "set_agent_cursor_enabled", "set_window_frame", "drag"]) assert.equal(o.cfg.toolExposure[t], "hidden");
	assert.equal(o.cfg.toolExposure.get_desktop_state, undefined, "只看也能看全屏");
	const f = mk("none");
	for (const t of ["get_desktop_state", "drag", "scroll", "hotkey", "launch_app", "clipboard_write", "set_agent_cursor_enabled"]) assert.equal(f.cfg.toolExposure[t], undefined, `${t} 完全权限可见`);
	for (const [t, i] of [["launch_app", { bundle_id: "com.tencent.xinWeChat" }], ["click", { pid: 1, window_id: 2, element_token: "s1:3" }], ["type_text", { text: "hi\n" }], ["press_key", { key: "return" }], ["hotkey", { keys: ["cmd", "tab"] }], ["drag", { from_x: 1, from_y: 1, to_x: 9, to_y: 9 }], ["scroll", {}], ["kill_app", { name: "TextEdit" }]] as const)
		assert.equal(await f.call(t, i), undefined, `${t} 完全权限直接执行`);
	assert.equal(f.asks.length, 0, "完全权限：普通动作（含回车/发送/结束应用）都不问");
	assert.match(f.cfg.description, /完全权限：所有应用/);
	const fp = (await f.h.before_agent_start({ systemPrompt: "", messageType: "user" as const, prompt: "" }))?.systemPrompt ?? "";
	for (const k of ["get_window_state", "element_token", "background_unavailable", "delivery_mode:\"foreground\"", "get_desktop_state", "verify_state"]) assert.ok(fp.includes(k), k);
	const t = mk("sensitive");
	await t.call("drag", {});
	await t.call("launch_app", { bundle_id: "com.tencent.xinWeChat" });
	assert.equal(t.asks.length, 0);
	await t.call("press_key", { key: "return" });
	assert.equal(t.asks.length, 1, "信任：回车（可能是发送）要问");
	const b = mk("all");
	const bp = (await b.h.before_agent_start({ systemPrompt: "", messageType: "user" as const, prompt: "" }))?.systemPrompt ?? "";
	assert.match(bp, /限定/);
	assert.ok(!bp.includes("get_desktop_state"), "限定档位没有整屏观察");
});

test("完全权限判定 hostFileAccess：开启 + 允许该助理 + full + 未暂停；降权 / 暂停 / 关闭立即生效", async () => {
	hc.setHostEnv({ workspaceOf: (id) => `/ws/${id}`, agentIds: () => ["a1", "a2"] });
	hc.saveHostSettings({ enabled: true, approvedHash: "h", agents: "all", tiers: { a1: "full", a2: "trusted" }, defaultTier: "bounded", fullAck: {} });
	assert.equal(hc.hostFileAccess("a1"), true);
	assert.equal(hc.hostFileAccess("a2"), false, "非 full 档位");
	hc.saveHostSettings({ tiers: { a1: "trusted", a2: "trusted" } });
	assert.equal(hc.hostFileAccess("a1"), false, "降权立即生效");
	hc.saveHostSettings({ tiers: { a1: "full" }, agents: ["a2"] });
	assert.equal(hc.hostFileAccess("a1"), false, "不在允许名单");
	hc.saveHostSettings({ agents: "all" });
	await hc.setHostPaused(true);
	assert.equal(hc.hostFileAccess("a1"), false, "暂停立即生效");
	hc.saveHostSettings({ enabled: false, approvedHash: undefined });
	assert.equal(hc.hostFileAccess("a1"), false, "关闭");
	await hc.setHostPaused(false);
	hc.saveHostSettings({ enabled: false, approvedHash: undefined, agents: "all", tiers: {}, defaultTier: "bounded", fullAck: {} });
});

test("草稿设置：改默认档位时现有助理固定成旧默认档位；预览与实际保存的计划 hash 一致", () => {
	hc.setHostEnv({ workspaceOf: (id) => `/ws/${id}`, agentIds: () => ["a1", "a2"] });
	hc.saveHostSettings({ enabled: false, agents: "all", apps: [{ name: "TextEdit", id: "/usr/bin/textedit" }], workspaceFiles: true, tiers: { a1: "bounded" }, defaultTier: "bounded", fullAck: {} });
	const draft = hc.draftHostSettings({ defaultTier: "trusted" });
	assert.equal(draft.tiers.a2, "bounded", "新助理按旧默认固定");
	assert.equal(draft.defaultTier, "trusted");
	// 客户端拿 /plan 的 hash 去 PUT：服务端用同一份草稿重算，哈希必须一致（否则会 409）
	const previewHash = hc.manifestHash(hc.hostPlan(draft));
	hc.saveHostSettings(draft);
	assert.equal(hc.manifestHash(hc.hostPlan()), previewHash);
	hc.saveHostSettings({ enabled: false, agents: "all", apps: [], tiers: {}, defaultTier: "bounded", fullAck: {} });
});

test("升级稳定性：应用内授权只看设置（档位 / 允许名单 / 已确认哈希），与守护进程瞬时状态无关", async () => {
	hc.setHostEnv({ workspaceOf: (id) => `/ws/${id}`, agentIds: () => ["a1"] });
	// 模拟“刚更新完、服务重启、Cua 还在启动中”：enabled 与 approvedHash 都是升级前那套 → 依然算已授权
	hc.saveHostSettings({ enabled: true, approvedHash: "h", agents: "all", tiers: { a1: "full" }, defaultTier: "bounded", fullAck: {} });
	assert.equal(hc.hostAllowedFor("a1"), true, "与 daemon.state 无关");
	assert.equal(hc.hostFileAccess("a1"), true);
	// 状态里带上（可能为空的）系统权限探测结果，后台据此判断“是不是缺系统授权”，不需要自己起进程探测
	const st = hc.hostStatus();
	assert.ok("macPermissions" in st);
	assert.equal(st.macPermissions, hc.hostPermissionsCache());
	// 非 macOS / 未安装 Cua：只读探测直接返回 null，不发任何系统授权请求
	const perms = await hc.macPermissions();
	assert.ok(perms === null || (typeof perms.accessibility === "string" && typeof perms.screenRecording === "string"));
	// 缓存：同一时刻复用结果，不会每次轮询都起进程
	if (perms) assert.equal(await hc.macPermissions(), perms);
	hc.saveHostSettings({ enabled: false, approvedHash: undefined, agents: "all", tiers: {}, defaultTier: "bounded", fullAck: {} });
});

test("升级稳定性：计划哈希只覆盖能力与作用域，不含版本号 / 构建号 / 驱动版本", () => {
	hc.setHostEnv({ workspaceOf: (id) => `/ws/${id}`, agentIds: () => ["a1"] });
	hc.saveHostSettings({ enabled: false, agents: "all", apps: [{ name: "TextEdit", id: "/usr/bin/textedit" }], workspaceFiles: true, tiers: { a1: "bounded" }, defaultTier: "bounded", fullAck: {} });
	const before = hc.manifestHash(hc.hostPlan());
	// 计划里除了清单自身的 schema 版本（version: 3）不该带 App / 驱动 / 构建版本
	assert.doesNotMatch(hc.hostPlan(), /^version: (?!3$)/m);
	assert.equal(hc.manifestHash(hc.hostPlan()), before, "同一份设置的哈希稳定");
	// 但新增作用域（多允许一个应用）必须变哈希 → 需要用户重新确认
	hc.saveHostSettings({ apps: [{ name: "TextEdit", id: "/usr/bin/textedit" }, { name: "计算器", id: "/usr/bin/calc" }] });
	assert.notEqual(hc.manifestHash(hc.hostPlan()), before, "新增能力 / 作用域必须重新确认");
	hc.saveHostSettings({ enabled: false, agents: "all", apps: [], tiers: {}, defaultTier: "bounded", fullAck: {} });
});

test("启动重试边界：只有“还没就绪 / 下载中断”可重试，权限计划变化与认不出的错误立即停", () => {
	// 前两类是真实的瞬时原因
	assert.equal(hc.retryableDaemonFailure(new hc.HostDaemonError("Cua Driver（bounded）没有在 10 秒内就绪", "not_ready")), true);
	assert.equal(hc.retryableDaemonFailure(new Error("下载 Cua Driver 失败：network timeout")), true);
	// 权限计划变化：必须等用户重新确认，重试没有意义（也不能因为第二次失败就继续）
	const changed = new hc.HostDaemonError("权限设置已变化，需要在设置里重新确认后才能开启", "permissions_changed");
	assert.equal(hc.daemonFailReason(changed), "permissions_changed");
	assert.equal(hc.retryableDaemonFailure(changed), false);
	// 详细错误文本里出现“权限”不等于权限计划变化
	assert.equal(hc.retryableDaemonFailure(new Error("Cua Driver 启动失败：辅助功能权限不足")), false);
	assert.equal(hc.retryableDaemonFailure(new Error("Cua Driver 校验失败（SHA256 与 third-party.json 不一致），已丢弃")), false);
	assert.equal(hc.retryableDaemonFailure(new Error("Cua Driver 解压后找不到可执行文件")), false);
	assert.equal(hc.retryableDaemonFailure("随便一个字符串"), false);
});

test("系统授权状态：unknown / 空值不得当已授权", () => {
	assert.equal(hc.macPermissionState("granted"), "granted");
	assert.equal(hc.macPermissionState("TRUE"), "granted");
	assert.equal(hc.macPermissionState("denied"), "denied");
	assert.equal(hc.macPermissionState(false as never), "denied");
	for (const v of ["unknown", "", null, undefined, "maybe", "not_checked"])
		assert.notEqual(hc.macPermissionState(v as never), "granted", `“${String(v)}”不能当已授权`);
	// 探测失败时（未知）也不得显示成已授权：只有明确 denied 才提示用户去开授权
	assert.equal(hc.macPermissionState("unknown"), "unknown");
});

test("系统权限只读探测：结果（包括 null）也进缓存，不每次轮询都重新起进程", async () => {
	const before = hc.lastMacPermissionProbeAt();
	await hc.macPermissions(true); // 强制探一次（非 macOS / 未安装 Cua 时结果是 null，同样要缓存）
	const at = hc.lastMacPermissionProbeAt();
	assert.ok(at > 0 && at >= before, "探测时间被记录");
	const again = await hc.macPermissions(); // 非 force：命中缓存，不再探测
	assert.equal(hc.lastMacPermissionProbeAt(), at, "null 结果同样命中缓存，没有重新起进程");
	assert.equal(again, hc.hostPermissionsCache(), "缓存值就是状态里暴露的值");
	assert.equal(hc.hostPermissionsCache(at + 60_000), null, "过期后按未知处理，不冒充授权结果");
});

test("原生驱动环境：MCP 命令用自有启动器全量替换，HOME 是 OS 账户家目录，CFFIXED_USER_HOME 被删", async () => {
	const { userInfo } = await import("node:os");
	// 模拟隔离启动的父进程 env（合成 HOME / CFFIXED / 合成 TMPDIR）——现实里就是这种环境才需要擦。
	const saved = { HOME: process.env.HOME, CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME, TMPDIR: process.env.TMPDIR };
	process.env.HOME = "/tmp/pia-hc/home";
	process.env.CFFIXED_USER_HOME = "/tmp/pia-hc/home";
	process.env.TMPDIR = "/tmp/pia-hc/tmp";
	try {
		const cmd = hc.hostMcpCommand("some-agent");
		// 理由：StdioTransport 会 {...process.env, ...env}，只传缺键的 env 删不掉任何东西，所以用自有启动器全量替换。
		assert.equal(cmd.command, process.execPath, "用自有启动器（由当前 node 跑）");
		assert.equal(cmd.envReplaced, true);
		assert.ok(cmd.args[0].endsWith("mcp-env-launcher.mjs"), "第一条参数是自有启动器");
		assert.ok(cmd.args.includes(`--set=HOME=${userInfo().homedir}`), "`cua-driver mcp` 是原生进程，HOME 必须来自 OS 账户信息");
		for (const k of ["CFFIXED_USER_HOME", "TMPDIR"]) assert.ok(cmd.args.includes(`--strip=${k}`), `${k} 必须由启动器删掉（argv 里只有键名）`);
		assert.equal(cmd.env.CUA_DRIVER_TELEMETRY, "0");
		// 扩展侧原本另塞的两个变量必须进 argv 的 --set，否则全量替换后会丢（run_script 会被重新放开）。
		assert.equal(cmd.env.CUA_DRIVER_DISABLE_RUN_SCRIPT, "1");
		assert.ok(cmd.args.includes("--set=CUA_DRIVER_DISABLE_RUN_SCRIPT=1"));
		// 数据 / profile 隔离变量照旧保留（隔离靠它们，不靠改 HOME）。
		assert.equal(cmd.env.PIA_DATA_DIR, process.env.PIA_DATA_DIR);
		// 真正的 cua-driver 命令仍在启动器后面，socket 名称不变。
		const tail = cmd.args.slice(-3);
		assert.equal(tail[0], "mcp");
		assert.equal(tail[1], "--socket");
		assert.match(tail[2], /cua-bounded\.sock$/, "socket 名称不变");
		assert.match(cmd.args[cmd.args.indexOf("--") + 1], /cua-driver$/, "`--` 之后才是真实的 cua-driver 命令");
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});
