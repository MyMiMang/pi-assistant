/**
 * 帮手（子代理）卡住处理（决策 0014 第 3 步，按用户反馈改为主会话自己解决）：
 * 先诊断（预计时长内的工具、还在变的工作区文件、等用户批准都不算卡住）；真卡住由主会话按阶梯处理
 * （看记录 + 带纠正重启 → 换做法 → 最后提醒 → 办法用尽就失败并写明试过什么）；同一原因反复失败要换策略；
 * 只有需要用户才能给的东西才找用户，且说清楚要什么。不再出现「继续等 / 停止」提问卡片。
 * 临时数据 + Mock + 内存凭据；driver 是可控假驱动，不跑模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Subagent, SubagentEvent } from "../src/subagents.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";
process.env.PIA_MOCK = "1";
const { db } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore());
const s = await import("../src/subagents.ts");
await import("../src/task-waits.ts");
const { requests } = await import("../src/requests.ts");
const { workspaceOf } = await import("../src/files.ts");
const { subagentEventGuidance } = await import("../src/subagent-supervision.ts");
const { userOnlyNeed } = await import("../src/subagent-stuck.ts");
const { createConversation } = await import("../src/conversations.ts");
db.prepare("INSERT INTO agents(id, name, avatar, color, persona, created_at) VALUES(?,?,'🔧','#888','',?)").run("stuck-test", "测试", Date.now());
const conv = createConversation("stuck-test").id;
const tick = () => new Promise((r) => setTimeout(r, 20));
const woken: SubagentEvent[] = [];
const inputs: (string | undefined)[] = [];
s.setSubagentDriver({ run: (_r, connect, input) => { inputs.push(input?.text); return new Promise<string>((resolve) => connect(async () => resolve("停止"), async () => {})); }, notify: async (_r: Subagent, e: SubagentEvent) => void woken.push(e) });
s.saveSubagentSettings({ maxMinutes: 600, maxConcurrent: 10 });
const questions = () => (db.prepare("SELECT COUNT(*) n FROM requests WHERE agent_id = 'stuck-test' AND kind = 'question'").get() as { n: number }).n;
const STALL = 180_000;
const spawn = async (task: string, kind?: "task") => { const r = s.spawnSubagent("stuck-test", conv, { provider: "mock", id: "echo" }, { task, kind }); await tick(); return r; };
const events = (id: string, kind: string) => woken.filter((e) => e.subagent_id === id && e.kind === kind);

test("慢但在动不算卡住：工具在预计时长内、工作区文件还在变，都不打断也不报", async () => {
	const r = await spawn("跑一个很长的构建");
	const t0 = s.getSubagent(r.id)!.last_activity_at;
	s.subagentActivity(r.id, 60 * 60_000); // 一个预计 1 小时的命令开始了
	await s.checkSubagents(t0 + STALL + 1);
	assert.equal(s.getSubagent(r.id)!.status, "running");
	s.subagentActivity(r.id, 0); // 命令结束（之后不再有工具在跑）
	const f = join(workspaceOf("stuck-test"), "build.log");
	writeFileSync(f, "进度 50%");
	const t1 = s.getSubagent(r.id)!.last_activity_at;
	utimesSync(f, new Date(t1 + 1000), new Date(t1 + 1000)); // 日志在最后一次消息之后还在写
	await s.checkSubagents(t1 + STALL + 1);
	assert.equal(s.getSubagent(r.id)!.status, "running", "日志还在写：不是卡住");
	assert.ok(s.getSubagent(r.id)!.last_activity_at > t1, "重新计时");
	assert.equal(events(r.id, "stalled").length, 0);
	rmSync(f);
	await s.stopSubagent(r.id);
});

test("等用户批准 / 回答期间不算卡住", async () => {
	const r = await spawn("发一封邮件");
	const t0 = s.getSubagent(r.id)!.last_activity_at;
	void requests.question("stuck-test", r.id, "发给哪个邮箱？", ["工作邮箱", "私人邮箱"], false, conv);
	await s.checkSubagents(t0 + 5 * STALL);
	assert.equal(s.getSubagent(r.id)!.status, "running");
	await s.stopSubagent(r.id);
});

test("真卡住：主会话按阶梯自己处理（诊断 + 带纠正重启 → 换做法 → 最后提醒 → 失败总结），全程不问用户", async () => {
	const before = questions();
	const r = await spawn("整理很多文件");
	const t0 = s.getSubagent(r.id)!.last_activity_at;
	await s.checkSubagents(t0 + STALL + 1);
	assert.equal(s.getSubagent(r.id)!.status, "stalled");
	const e1 = events(r.id, "stalled")[0];
	assert.ok(e1, "叫醒主会话");
	assert.match(e1.reason, /没有任何输出/);
	assert.match(e1.reason, /subagent_list[\s\S]*subagent_restart/, "第一级：看记录，再带纠正重启");
	// 主会话按建议重启：同一个帮手，带着纠正从检查点续跑
	assert.equal(await s.restartSubagent(r.id, "别再整个目录一起处理，按子目录分批"), true);
	await tick(); await tick();
	assert.equal(s.getSubagent(r.id)!.status, "running");
	assert.match(inputs.at(-1) ?? "", /按子目录分批[\s\S]*已经完成的步骤不要重做/);
	await s.checkSubagents(t0 + 2 * STALL + 2);
	assert.match(events(r.id, "stalled")[1]?.reason ?? "", /换个做法[\s\S]*spawn_subagent/, "第二级：换做法");
	await s.checkSubagents(t0 + 3 * STALL + 3);
	assert.match(events(r.id, "stalled")[2]?.reason ?? "", /最后一次提醒/);
	await s.checkSubagents(t0 + 4 * STALL + 4);
	await tick();
	const done = s.getSubagent(r.id)!;
	assert.equal(done.status, "failed");
	assert.match(done.error_reason ?? "", /已用尽办法：已叫主会话诊断并带纠正重启；已提示主会话换做法；已最后提醒主会话/);
	assert.match(subagentEventGuidance("failed", done.error_reason ?? ""), /失败总结[\s\S]*试过哪些办法/);
	assert.equal(questions(), before, "没有任何「继续等 / 停止」提问");
});

test("后台任务的帮手（没有主会话回合负责）：系统自己重启一次，仍卡住就失败并写明试过什么", async () => {
	const r = await spawn("后台导出报表", "task");
	const t0 = s.getSubagent(r.id)!.last_activity_at;
	await s.checkSubagents(t0 + STALL + 1);
	await tick(); await tick();
	assert.equal(s.getSubagent(r.id)!.status, "running", "已从检查点重启");
	assert.match(inputs.at(-1) ?? "", /系统发现你卡住了/);
	await s.checkSubagents(t0 + 2 * STALL + 2);
	assert.equal(s.getSubagent(r.id)!.status, "failed");
	assert.match(s.getSubagent(r.id)!.error_reason ?? "", /已用尽办法：从最近检查点重启过一次/);
});

test("反复卡在同一处：第 2 次提示换方法，第 3 次起拒绝原样续跑、必须换策略；不同原因不算", async () => {
	const r = await spawn("部署网站");
	const fail = (why: string) => {
		db.prepare("UPDATE subagents SET status = 'running' WHERE id = ?").run(r.id);
		s.finishSubagent(r.id, "failed", why);
		return s.getSubagent(r.id)!.error_reason ?? "";
	};
	assert.doesNotMatch(fail("连接 api.example.com 超时（第 1 次）"), /反复/);
	assert.match(fail("连接 api.example.com 超时（第 2 次）"), /反复卡在同一处，第 2 次：换个方法/);
	assert.match(fail("连接 api.example.com 超时（第 3 次）"), /第 3 次：原样续跑已停用，必须换策略/);
	fail("连接 api.example.com 超时（第 4 次）");
	assert.throws(() => s.resumeSubagent(r.id, { mode: "manual" }), /换策略/);
	assert.equal(s.withResumeInfo(s.getSubagent(r.id)!).canResume, false);
	assert.doesNotMatch(fail("磁盘空间不足，写入失败"), /反复/, "不同原因不算同一处");
});

test("只有用户能给的东西才找用户，并说清楚要什么", () => {
	assert.equal(userOnlyNeed("401 Unauthorized: invalid api key"), "登录或提供有效的凭据");
	assert.equal(userOnlyNeed("用户拒绝了这个操作（未获批准）"), "批准这一步操作或给出相应权限");
	assert.equal(userOnlyNeed("连接超时"), null, "网络问题由主会话自己想办法");
	const r = s.spawnSubagent("stuck-test", conv, { provider: "mock", id: "echo" }, { task: "同步日历" });
	s.finishSubagent(r.id, "failed", "401 Unauthorized: invalid api key");
	const why = s.getSubagent(r.id)!.error_reason ?? "";
	assert.match(why, /（需要用户：登录或提供有效的凭据）/);
	assert.match(subagentEventGuidance("failed", why), /直接向用户提出这个具体需要/);
});
