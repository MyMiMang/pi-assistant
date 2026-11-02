/**
 * 长命令跑满 5 秒自动转后台（docs/design/background-commands.md）。
 * 临时数据 + Mock 模型 + 本地 sleep / echo 假命令；不碰真实控制驱动。门槛 / 上限用可调常量（bgLimits）缩短。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { approvalExtension, evaluate } from "@pi-assistant/ext-approval";
import { sandboxExtension } from "@pi-assistant/ext-sandbox";
import { bgHooks, bgLimits, getJob, killOwner, listJobs, resetJobs, runningJobs, waitJob, type BgJob } from "../src/bg-jobs.ts";
import { config } from "../src/config.ts";
import { bgJobsExtension, makeBackgroundBashTool, sendBgResult } from "../src/pi-adapter/bg-shell.ts";
import { createPiSession, PiModels, promptSession, subscribeSession } from "../src/pi-adapter/index.ts";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "../src/pi-adapter/mock-provider.ts";
import { EncryptedCredentialStore } from "../src/secrets.ts";

const owner = { key: "conv:t1", agentId: "a1", conversationId: "c1" };
const orig = { ...bgLimits };
const ended: { job: BgJob; tail: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000) => {
	const t = Date.now();
	while (!f()) {
		if (Date.now() - t > ms) throw new Error("等待条件超时");
		await sleep(30);
	}
};
const textOfResult = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");
const exec = (tool: ReturnType<typeof makeBackgroundBashTool>, command: string, signal = new AbortController().signal, timeout?: number) =>
	tool.execute("t", { command, ...(timeout ? { timeout } : {}) } as never, signal, undefined, undefined as never);

beforeEach(() => {
	Object.assign(bgLimits, orig, { afterMs: 400 });
	ended.length = 0;
	bgHooks.onEnd = (job, tail) => void ended.push({ job, tail });
	bgHooks.onStart = undefined;
	bgHooks.onFinish = undefined;
});
afterEach(() => resetJobs());

test("5 秒内结束的命令和原来一样（不转后台、没有作业）", async () => {
	const tool = makeBackgroundBashTool(config.workspaceRoot, {}, owner);
	assert.equal(tool.name, "bash");
	const r = await exec(tool, "echo 很快");
	assert.match(textOfResult(r), /很快/);
	assert.doesNotMatch(textOfResult(r), /后台/);
	assert.equal(listJobs(owner.key).length, 0);
	// 非零退出码仍是错误结果
	const bad = await exec(tool, "echo 错; exit 3");
	assert.equal((bad as { isError?: boolean }).isError, true);
	assert.match(textOfResult(bad), /exited with code 3/);
	await sleep(50);
	assert.equal(ended.length, 0, "前台结束的命令不走后台通知");
});

test("超过门槛转后台：先返回编号和目前输出，进程继续跑，结束后通知一次", async () => {
	const tool = makeBackgroundBashTool(config.workspaceRoot, {}, owner);
	const t0 = Date.now();
	const r = await exec(tool, "echo 开头; sleep 1; echo 结尾");
	assert.ok(Date.now() - t0 < 900, "工具在门槛处就返回了，没等命令结束");
	const text = textOfResult(r);
	assert.match(text, /已转到后台继续运行（编号 job_[0-9a-f]+/);
	assert.match(text, /开头/);
	assert.match(text, /不要对用户说这件事做完了/);
	const [job] = runningJobs(owner.key);
	assert.ok(job, "作业在跑");
	await until(() => ended.length === 1);
	assert.equal(ended[0].job.status, "done");
	assert.equal(ended[0].job.exitCode, 0);
	assert.match(ended[0].tail, /开头[\s\S]*结尾/);
	await sleep(100);
	assert.equal(ended.length, 1, "只通知一次");
});

test("命令出错（非零退出码）结束也通知，状态 failed", async () => {
	const tool = makeBackgroundBashTool(config.workspaceRoot, {}, owner);
	await exec(tool, "sleep 1; echo 炸了; exit 7");
	await until(() => ended.length === 1);
	assert.equal(ended[0].job.status, "failed");
	assert.equal(ended[0].job.exitCode, 7);
});

test("前台阶段用户停止（Pi 中止信号）：和原来一样直接中止，不转后台", async () => {
	const tool = makeBackgroundBashTool(config.workspaceRoot, {}, owner);
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 100);
	await assert.rejects(exec(tool, "sleep 5", ac.signal), /aborted/);
	assert.equal(listJobs(owner.key).length, 0);
});

test("转后台后 Pi 的信号不再管它；killOwner（用户点停止）整批结束，且不通知", async () => {
	const tool = makeBackgroundBashTool(config.workspaceRoot, {}, owner);
	const turn = new AbortController();
	await exec(tool, "sleep 20", turn.signal);
	await exec(tool, "sleep 20", turn.signal);
	await exec(tool, "sleep 20", turn.signal);
	turn.abort(); // 这一轮的信号中止：已转后台的作业不受它影响，只有 killOwner 才结束
	assert.equal(runningJobs(owner.key).length, 3);
	assert.equal(killOwner("conv:别人"), 0);
	assert.equal(killOwner(owner.key), 3);
	assert.equal(runningJobs(owner.key).length, 0);
	assert.ok(listJobs(owner.key).every((j) => j.status === "killed"));
	await sleep(150);
	assert.equal(ended.length, 0, "主动结束不另行通知");
});

test("30 分钟上限（用可调常量缩短）：超时结束并通知助理", async () => {
	bgLimits.maxMs = 1500;
	const tool = makeBackgroundBashTool(config.workspaceRoot, {}, owner);
	await exec(tool, "sleep 20");
	await until(() => ended.length === 1, 6000);
	assert.equal(ended[0].job.status, "timeout");
	assert.match(ended[0].job.error ?? "", /上限/);
});

test("输出有缓冲上限：只留末尾", async () => {
	bgLimits.bufferBytes = 2000;
	const tool = makeBackgroundBashTool(config.workspaceRoot, {}, owner);
	await exec(tool, "i=0; while [ $i -lt 400 ]; do echo 第$i行-aaaaaaaaaa; i=$((i+1)); done; sleep 1; echo 最后一行");
	await until(() => ended.length === 1);
	assert.match(ended[0].tail, /最后一行/);
	assert.ok(ended[0].tail.length < 3000, `输出被截断：${ended[0].tail.length}`);
	assert.doesNotMatch(ended[0].tail, /第0行/);
});

test("waitJob：等到结束就返回，等待期间结束的不再另行通知；超时返回仍在运行", async () => {
	const tool = makeBackgroundBashTool(config.workspaceRoot, {}, owner);
	await exec(tool, "sleep 1; echo ok");
	const id = runningJobs(owner.key)[0].id;
	assert.equal(await waitJob("conv:别人", id, 1), undefined, "别人看不到");
	assert.equal((await waitJob(owner.key, id, 0.1))?.status, "running");
	const done = await waitJob(owner.key, id, 5);
	assert.equal(done?.status, "done");
	await sleep(100);
	assert.equal(ended.length, 0, "已经在等待里拿到结果，不重复通知");
});

test("审批不变：工具名仍是 bash，危险命令照旧要审批；job_output / job_stop 不需要审批", () => {
	assert.equal(evaluate("bash", { command: "rm -rf x" }, undefined, "/ws").kind, "ask");
	assert.equal(evaluate("bash", { command: "sleep 30" }, undefined, "/ws").kind, "allow");
	assert.equal(evaluate("job_output", {}, undefined, "/ws").kind, "allow");
	assert.equal(evaluate("job_stop", { job_id: "job_x" }, undefined, "/ws").kind, "allow");
});

// ---------------------------------------------------------------- 真实 Pi 会话（Mock 模型）：结果送达

const models = await PiModels.create({ credentials: new EncryptedCredentialStore(), modelsPath: null, allowNetwork: false });
await registerMockProvider(models);
const approvals: string[] = [];

async function session(name: string) {
	const ws = join(config.workspaceRoot, name);
	mkdirSync(ws, { recursive: true });
	const own = { key: `conv:${name}`, agentId: name, conversationId: name };
	const s = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, name),
		sessionDir: join(config.agentsDir, name, "sessions"),
		model: { provider: MOCK_PROVIDER, id: MOCK_MODEL },
		systemPromptAppend: ["你是测试助理。"],
		extensions: [
			{ name: "bg", factory: bgJobsExtension(own) },
			{ name: "sandbox", factory: sandboxExtension({ workspace: ws, mode: "workspace", makeBashTool: ((cwd: string, o: never) => makeBackgroundBashTool(cwd, o, own)) as never }) },
			{ name: "approval", factory: approvalExtension({ workspace: ws, request: async (r) => (approvals.push(r.toolName), { approved: false }) }) },
		],
	});
	return { s, own };
}
const assistantTexts = (s: Awaited<ReturnType<typeof session>>["s"]) =>
	s.messages.filter((m) => m.role === "assistant").flatMap((m) => (m.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? ""));

test("这一轮还在进行：作业结束的结果作为插话（steer）送进这一轮，同一轮里助理就读到", async () => {
	const { s } = await session("bg-inturn");
	const events: string[] = [];
	subscribeSession(s, (e) => events.push(e.type));
	bgHooks.onEnd = (job, tail) => void sendBgResult(s, `（后台命令结束）${job.id}\n${tail}`);
	await promptSession(s, "后台命令测试 忙6");
	const texts = assistantTexts(s);
	assert.ok(texts.some((t) => /收到后台结果/.test(t)), `助理读到了后台结果：${JSON.stringify(texts)}`);
	assert.equal(events.filter((e) => e === "settled").length, 1, "没有另开一轮：在同一轮里送达");
	s.dispose();
});

test("这一轮已结束：作业结束时按唤醒机制开新一轮接着处理", async () => {
	const { s } = await session("bg-idle");
	const events: string[] = [];
	subscribeSession(s, (e) => events.push(e.type));
	bgHooks.onEnd = (job, tail) => void sendBgResult(s, `（后台命令结束）${job.id}\n${tail}`);
	await promptSession(s, "后台命令测试 忙0");
	assert.ok(assistantTexts(s).some((t) => /在后台跑着/.test(t)));
	assert.equal(s.isStreaming, false, "这一轮已经结束，命令还在后台跑");
	assert.equal(runningJobs("conv:bg-idle").length, 1);
	await until(() => assistantTexts(s).some((t) => /收到后台结果/.test(t)));
	assert.equal(events.filter((e) => e === "settled").length, 2, "新开了一轮");
	s.dispose();
});

test("job_output 工具：列出 / 等待结果 / 结束；帮手 / 后台任务不转后台", async () => {
	const { s, own } = await session("bg-tools");
	const tool = makeBackgroundBashTool(config.workspaceRoot, {}, own);
	await exec(tool, "sleep 30");
	const id = runningJobs(own.key)[0].id;
	const call = (name: string, args: Record<string, unknown>) => s.getToolDefinition(name)!.execute("x", args as never, new AbortController().signal, undefined, undefined as never) as Promise<{ content: { type: string; text?: string }[] }>;
	assert.match(textOfResult(await call("job_output", {})), new RegExp(id));
	assert.match(textOfResult(await call("job_output", { job_id: id })), /还在运行/);
	assert.match(textOfResult(await call("job_output", { job_id: "job_nope" })), /没有这个后台命令/);
	assert.match(textOfResult(await call("job_stop", { job_id: id })), /已结束/);
	assert.equal(getJob(own.key, id)?.status, "killed");
	const { bgOwnerFor } = await import("../src/agent-runtime/bg-wiring.ts");
	assert.equal(bgOwnerFor("a", "c", null, "sub1"), null, "帮手不转后台");
	assert.equal(bgOwnerFor("a", null, "task1"), null, "后台任务 / 巡检不转后台");
	assert.equal(bgOwnerFor("a", "c", null)?.key, "conv:c");
	assert.doesNotMatch(makeBackgroundBashTool(config.workspaceRoot, {}, null).description, /background/, "没有所有者就是原样的 bash");
});

test("会话里的 bash 工具审批仍然拦截", async () => {
	const { s } = await session("bg-approval");
	approvals.length = 0;
	await promptSession(s, "删除旧文件");
	assert.deepEqual(approvals, ["bash"]);
	s.dispose();
});

test("后台输出按流解码：一个汉字拆在两块输出里也不乱码", async () => {
	const { withBackground, tailOf, BgDetached } = await import("../src/bg-jobs.ts");
	const bytes = Buffer.from("第1秒\n");
	const ops = { exec: async (_c: string, _cwd: string, o: { onData: (d: Buffer) => void }) => (o.onData(bytes.subarray(0, 2)), o.onData(bytes.subarray(2)), await new Promise((r) => setTimeout(r, 300)), { exitCode: 0 }) };
	const own = { key: "conv:utf8", agentId: "utf8", conversationId: "utf8" };
	const prev = bgLimits.afterMs;
	bgLimits.afterMs = 50;
	try {
		const e = await withBackground(ops as never, own).exec("x", "/", { onData: () => {} } as never).catch((x: unknown) => x);
		assert.ok(e instanceof BgDetached);
		assert.equal(tailOf((e as InstanceType<typeof BgDetached>).job.id).trim(), "第1秒");
	} finally {
		bgLimits.afterMs = prev;
	}
});
