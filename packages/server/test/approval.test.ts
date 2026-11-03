import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "@pi-assistant/ext-approval";

const ws = "/home/u/ws";
test("只读工具直接放行", () => {
	assert.equal(evaluate("read", { path: "a.txt" }, undefined, ws).kind, "allow");
	assert.equal(evaluate("computer_open", {}, undefined, ws).kind, "allow", "开自己的助理电脑不用批准（同一轮直接用）");
	assert.equal(evaluate("bash", { command: "ls -la && cat a.txt" }, undefined, ws).kind, "allow");
});
test("删除 / git push / sudo 需要审批", () => {
	for (const command of ["rm -rf build", "git push origin main", "sudo apt install x", "curl -X POST https://x.com -d a=1"])
		assert.equal(evaluate("bash", { command }, undefined, ws).kind, "ask", command);
});
test("凭据文件直接拒绝", () => {
	assert.equal(evaluate("read", { path: "/home/u/.ssh/id_rsa" }, undefined, ws).kind, "deny");
	assert.equal(evaluate("bash", { command: "cat ~/.aws/credentials" }, undefined, ws).kind, "deny");
});
test("写工作区外的文件被拒绝", () => {
	assert.equal(evaluate("write", { path: "/etc/hosts" }, undefined, ws).kind, "deny");
	assert.equal(evaluate("write", { path: "notes/a.md" }, undefined, ws).kind, "allow");
});
test("未知工具按 annotations 判断", () => {
	assert.equal(evaluate("gmail_send", {}, undefined, ws).kind, "ask");
	assert.equal(evaluate("gmail_search", {}, { readOnlyHint: true }, ws).kind, "allow");
});
test("完全权限（hostAccess）：普通命令与主机文件放行，凭据仍拒绝；其他档位不变", () => {
	assert.equal(evaluate("bash", { command: "rm -rf build" }, undefined, ws, true).kind, "allow");
	assert.equal(evaluate("bash", { command: "git push origin main" }, undefined, ws, true).kind, "allow");
	assert.equal(evaluate("bash", { command: "sudo apt install x" }, undefined, ws, true).kind, "allow", "普通 sudo 不再逐条审批（完全权限下应用层不弹审批）");
	assert.equal(evaluate("bash", { command: "cat ~/.aws/credentials" }, undefined, ws, true).kind, "deny", "凭据命令仍拒绝");
	assert.equal(evaluate("write", { path: "/etc/hosts" }, undefined, ws, true).kind, "allow", "完全权限可写主机文件");
	assert.equal(evaluate("write", { path: "/home/u/.ssh/id_rsa" }, undefined, ws, true).kind, "deny", "凭据文件仍拒绝");
	assert.equal(evaluate("bash", { command: "rm -rf build" }, undefined, ws, false).kind, "ask", "非完全权限行为不变");
	assert.equal(evaluate("write", { path: "/etc/hosts" }, undefined, ws, false).kind, "deny");
});
test("完全权限：应用层完全不创建审批请求（含硬性保护），凭据仍拒绝；降权后立刻恢复审批", async () => {
	const { approvalExtension } = await import("@pi-assistant/ext-approval");
	const asks: string[] = [];
	let full = true;
	let fn: ((e: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>) | null = null;
	approvalExtension({ workspace: "/ws", guard: { target: "host" }, hostAccess: () => full, request: async (r) => (asks.push(r.summary), { approved: true }) })({ on: (_n: string, f: never) => (fn = f), getAllTools: () => [] } as never);
	assert.equal(await fn!({ toolName: "bash", input: { command: "rm -rf build" } }), undefined, "普通删除不问");
	assert.equal(await fn!({ toolName: "bash", input: { command: "npm install" } }), undefined);
	assert.equal(await fn!({ toolName: "bash", input: { command: "killall Finder" } }), undefined, "硬性保护：完全权限下也直接放行");
	assert.equal(await fn!({ toolName: "bash", input: { command: "shutdown -h now" } }), undefined, "关机这类受保护命令也直接放行");
	assert.equal(await fn!({ toolName: "write", input: { path: "/etc/hosts" } }), undefined, "写系统文件也放行");
	assert.equal(asks.length, 0, "完全权限：一次审批请求都不创建");
	const secret = await fn!({ toolName: "bash", input: { command: "cat ~/.aws/credentials" } });
	assert.equal(secret?.block, true, "凭据路径仍然拒绝");
	assert.match(secret?.reason ?? "", /凭据/);
	assert.equal((await fn!({ toolName: "read", input: { path: "/home/u/.ssh/id_rsa" } }))?.block, true);
	assert.equal(asks.length, 0, "凭据拒绝不经过审批");
	// 降权 / 暂停：hostAccess 立刻变假，硬性保护又回到明确批准
	full = false;
	assert.equal(await fn!({ toolName: "bash", input: { command: "killall Finder" } }), undefined, "非完全权限：批准后放行");
	assert.match(asks[0], /受保护的操作/);
});
test("不能用命令 / 脚本直接调 cua：命令、写文件都拒绝，所有档位生效（电脑工具本身不受影响）", async () => {
	const { usesCuaDirectly } = await import("@pi-assistant/ext-approval");
	const sock = "/Users/u/.pi-assistant-dev/host-control/cua-open.sock";
	const cmds = [
		`python3 run.py`.replace("run.py", `-c "import subprocess;subprocess.run(['/x/bin/cua-driver-0.38.0/CuaDriver.app/Contents/MacOS/cua-driver','mcp','--socket','${sock}'])"`),
		`~/.pi-assistant-dev/bin/cua-driver mcp`,
		`echo '{}' | nc -U ${sock}`,
		`open /x/CuaDriver.app`,
	];
	for (const hostAccess of [false, true]) {
		for (const command of cmds) assert.equal(evaluate("bash", { command }, undefined, ws, hostAccess).kind, "deny", command);
		assert.equal(evaluate("write", { path: "run.py", content: `s.connect("${sock}")` }, undefined, ws, hostAccess).kind, "deny", "写脚本也拦");
		assert.equal(evaluate("write", { path: "run.py", content: "subprocess.run(['cua-driver','mcp'])" }, undefined, ws, hostAccess).kind, "deny");
		assert.equal(evaluate("edit", { path: "run.py", edits: [{ oldText: "a", newText: "cua-driver mcp" }] }, undefined, ws, hostAccess).kind, "deny");
	}
	assert.equal(usesCuaDirectly("powershell", { command: "cua-driver.exe mcp" }), true);
	assert.equal(usesCuaDirectly("bash", { command: "ls -la && cat a.txt" }), false);
	assert.equal(usesCuaDirectly("write", { path: "a.md", content: "普通笔记" }), false);
	// 只提到这个词不算：搜索、写笔记、开发相关代码
	assert.equal(usesCuaDirectly("bash", { command: "rg -n cua-driver docs" }), false);
	assert.equal(usesCuaDirectly("bash", { command: "which cua-driver" }), false);
	assert.equal(usesCuaDirectly("write", { path: "notes.md", content: "今天把 cua-driver 升到 0.38.0" }), false);
	assert.equal(usesCuaDirectly("mcp__hostpc__click", { command: "cua-driver" }), false, "电脑工具不检查");
	assert.equal(usesCuaDirectly("read", { path: "host-control/cua-open.sock" }), false);
});
