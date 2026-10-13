/** 磁盘占用兜底：日志超限截断保留尾部、过期 .part / 任务会话删除、操作记录文字版（给助理复盘） */
await import("./setup.ts");
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const hk = await import("../src/housekeeping.ts");

test("capLog：超过上限保留尾部到 .old，原文件截断", () => {
	const d = mkdtempSync(join(tmpdir(), "hk-"));
	const f = join(d, "a.log");
	writeFileSync(f, "x".repeat(1000) + "TAIL");
	assert.equal(hk.capLog(f, 500, 100), true);
	assert.equal(statSync(f).size, 0);
	assert.match(readFileSync(`${f}.old`, "utf8"), /TAIL$/);
	assert.equal(hk.capLog(f, 500, 100), false);
});

test("housekeeping：过期 .part / 任务会话删除，工作区不动", () => {
	const d = mkdtempSync(join(tmpdir(), "hk-"));
	const old = (Date.now() - 90 * 86400_000) / 1000;
	const mk = (p: string) => (mkdirSync(join(d, p, ".."), { recursive: true }), writeFileSync(join(d, p), "1"), utimesSync(join(d, p), old, old), join(d, p));
	const part = mk("downloads/x.bin.part");
	const task = mk("agents/a1/tasks/t.jsonl");
	const conv = mk("agents/a1/sessions/s.jsonl");
	const ws = mk("workspace/keep.part");
	hk.housekeeping({ dataDir: d, extraLogDirs: [] });
	assert.equal(existsSync(part), false);
	assert.equal(existsSync(task), false);
	assert.equal(existsSync(conv), true, "对话会话不清");
	assert.equal(existsSync(ws), true, "工作区不清");
});

test("actionHistoryText：最新在前、带结果", async () => {
	const { recordAction, actionHistoryText } = await import("../src/action-log.ts");
	recordAction("histagent", null, { phase: "start", callId: "h1", target: "sandbox", tool: "click", input: { x: 1 }, summary: "点" } as never);
	recordAction("histagent", null, { phase: "done", callId: "h1", target: "sandbox", tool: "click", input: { x: 1 }, summary: "点" } as never);
	const t = actionHistoryText("histagent", { target: "sandbox" });
	assert.match(t, /助理电脑 click \{"x":1\} → 完成/);
	assert.equal(actionHistoryText("nobody"), "还没有电脑操作记录。");
});
