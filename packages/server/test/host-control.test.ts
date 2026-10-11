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
	await assert.rejects(hc.startDaemon(yaml), /清单已变化/);
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
		on: (_: string, h: typeof handler) => (handler = h),
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
