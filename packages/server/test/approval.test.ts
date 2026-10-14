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
	assert.equal(evaluate("bash", { command: "sudo apt install x" }, undefined, ws, true).kind, "allow", "普通 sudo 不再逐条审批（硬性保护在 approvalExtension 里单独问）");
	assert.equal(evaluate("bash", { command: "cat ~/.aws/credentials" }, undefined, ws, true).kind, "deny", "凭据命令仍拒绝");
	assert.equal(evaluate("write", { path: "/etc/hosts" }, undefined, ws, true).kind, "allow", "完全权限可写主机文件");
	assert.equal(evaluate("write", { path: "/home/u/.ssh/id_rsa" }, undefined, ws, true).kind, "deny", "凭据文件仍拒绝");
	assert.equal(evaluate("bash", { command: "rm -rf build" }, undefined, ws, false).kind, "ask", "非完全权限行为不变");
	assert.equal(evaluate("write", { path: "/etc/hosts" }, undefined, ws, false).kind, "deny");
});
test("完全权限：普通命令不问，硬性保护仍要明确批准", async () => {
	const { approvalExtension } = await import("@pi-assistant/ext-approval");
	const asks: string[] = [];
	let fn: ((e: unknown) => Promise<{ block?: boolean } | undefined>) | null = null;
	approvalExtension({ workspace: "/ws", guard: { target: "host" }, hostAccess: () => true, request: async (r) => (asks.push(r.summary), { approved: true }) })({ on: (_n: string, f: never) => (fn = f), getAllTools: () => [] } as never);
	assert.equal(await fn!({ toolName: "bash", input: { command: "rm -rf build" } }), undefined, "普通删除不问");
	assert.equal(await fn!({ toolName: "bash", input: { command: "npm install" } }), undefined);
	assert.equal(asks.length, 0);
	assert.equal(await fn!({ toolName: "bash", input: { command: "killall Finder" } }), undefined, "硬性保护：批准后放行");
	assert.match(asks[0], /受保护的操作/);
});
