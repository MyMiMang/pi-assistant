/** 仅临时服务测试：通过本次临时目录传指令，复用真实 extension/requests/registry；无产品调试路由。 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { isMainThread } from "node:worker_threads";

const directory = process.env.PIA_BROWSER_TEST_DIR;
const rel = directory ? relative(tmpdir(), directory) : "..";
if (!directory || rel.startsWith("..") || isAbsolute(rel)) throw new Error("浏览器测试指令目录必须是临时目录");
let loaded, busy = false;
if (isMainThread && process.argv[1]?.endsWith("launch-memory.ts")) setInterval(async () => {
	const command = join(directory, "browser-command.json");
	if (busy || !existsSync(command)) return;
	busy = true;
	try {
		const input = JSON.parse(readFileSync(command, "utf8")); unlinkSync(command);
		if (!loaded) {
			const [browser, ext, requests, files, desktop, database] = await Promise.all([
				import("../../packages/server/src/browser.ts"), import("../../packages/ext-browser/src/index.ts"),
				import("../../packages/server/src/requests.ts"), import("../../packages/server/src/files.ts"),
				import("../../packages/server/src/desktop.ts"), import("../../packages/server/src/db.ts"),
			]);
			loaded = { browser, ext, requests: requests.requests, files, desktop, db: database.db, tools: new Map() };
		}
		const x = loaded;
		if (!x.tools.has(input.agentId)) {
			const tools = new Map();
			x.ext.browserExtension({ session: x.browser.browserPagesFor(input.agentId), mode: () => "host", workspace: x.files.workspaceOf(input.agentId), isPaused: () => x.desktop.desktopPause.isPaused(input.agentId), request: r => x.requests.approval(input.agentId, null, r.toolName, r.input, r.summary, r.risk), handoff: async () => "已完成" })({ registerTool: t => tools.set(t.name, t) });
			x.tools.set(input.agentId, tools);
		}
		const result = await x.tools.get(input.agentId).get(input.tool).execute("e2e", input.input ?? {});
		writeFileSync(join(directory, "browser-result.json"), JSON.stringify({ result }));
	} catch (e) { writeFileSync(join(directory, "browser-result.json"), JSON.stringify({ error: String(e) })); }
	finally { busy = false; }
}, 40).unref();
