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
