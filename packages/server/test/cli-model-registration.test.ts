/** 渠道注册恢复与禁止静默换模型；全程假 register、临时数据、Mock。 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCliChannelService } from "../src/cli-channel-service.ts";
import { cliServices, resolveCliModel } from "../src/cli-services.ts";
import { initModels, models, defaultModel } from "../src/models.ts";
import type { PiModels } from "../src/pi-adapter/index.ts";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "../src/pi-adapter/mock-provider.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";
import { db, now, setSetting } from "../src/db.ts";
import { createConversation } from "../src/conversations.ts";
import { runtime, tasks } from "../src/runtime.ts";
import { getSubagent } from "../src/subagents.ts";

function fixture(register: () => Promise<{ disposeAll(): void }>, intervals = [5, 10, 15], status = { installed: true, loggedIn: true }) {
	return createCliChannelService({
		id: "fake-cli", label: "测试编程工具", envName: "TEST_REGISTRATION_COMMAND", managed: true,
		find: () => process.execPath, notFound: "还没安装", requireLogin: true,
		detect: async () => status, register,
	}, intervals);
}

test("失败按退避间隔自动恢复，成功停止；并发 ensure 合并", async () => {
	const times: number[] = [];
	const svc = fixture(async () => {
		times.push(Date.now());
		if (times.length < 4) throw new Error("timed out waiting for available models");
		return { disposeAll() {} };
	});
	try {
		const catalog = {} as PiModels;
		const p = svc.ensure(catalog);
		assert.equal(svc.registering(), p);
		await assert.rejects(p, /timed out/);
		for (let i = 0; i < 100 && !svc.registered(); i++) await delay(5);
		assert.equal(svc.registered(), true);
		assert.equal(times.length, 4);
		assert.ok(times[1] - times[0] >= 4);
		assert.ok(times[2] - times[1] >= 9);
		assert.ok(times[3] - times[2] >= 14);
		assert.equal(svc.error(), "");
		await delay(25);
		assert.equal(times.length, 4);
	} finally { svc.dispose(); }
});

test("启动检测未完成时重新检测：沿用新状态立即注册，多次 ensure 只注册一次", async () => {
	let detected!: () => void, calls = 0, detects = 0;
	const gate = new Promise<void>(r => { detected = r; });
	const svc = createCliChannelService({
		id: "pending-cli", label: "测试渠道", envName: "TEST_PENDING_COMMAND", managed: true,
		find: () => process.execPath, notFound: "未安装", requireLogin: true,
		detect: async () => { if (++detects === 1) { await gate; return { installed: true, loggedIn: false }; } return { installed: true, loggedIn: true }; },
		register: async () => { calls++; return { disposeAll() {} }; },
	}, [5]);
	try {
		const catalog = {} as PiModels;
		const initial = svc.ensure(catalog);
		const check = svc.check(catalog);
		const concurrent = svc.check(catalog);
		await delay(1); // 两次重新检测都并入启动中的注册
		detected();
		assert.equal(await initial, false);
		assert.equal((await check).registered, true);
		assert.equal((await concurrent).registered, true);
		await delay(15);
		assert.equal(calls, 1);
	} finally { detected(); svc.dispose(); }
});

test("关闭服务取消重试；命令消失后不再注册", async () => {
	let calls = 0;
	const svc = fixture(async () => { calls++; throw new Error("列表超时"); });
	await assert.rejects(svc.ensure({} as PiModels));
	svc.dispose();
	await delay(25);
	assert.equal(calls, 1);
	assert.equal(await svc.ensure({} as PiModels), false);
});

test("明确卸载或退出登录后取消自动重试", async () => {
	for (const field of ["installed", "loggedIn"] as const) {
		const status = { installed: true, loggedIn: true };
		let calls = 0;
		const svc = fixture(async () => { calls++; throw new Error("列表超时"); }, [20], status);
		try {
			const catalog = {} as PiModels;
			await assert.rejects(svc.ensure(catalog));
			status[field] = false;
			await svc.check(catalog, true);
			await delay(40);
			assert.equal(calls, 1);
		} finally { svc.dispose(); }
	}
});

test("有默认模型时 CLI 注册失败：单聊和群回合中文报错，保留所选模型且不建默认会话", async () => {
	await initModels(memoryCredentialStore());
	await registerMockProvider(models);
	setSetting("defaultModel", { provider: MOCK_PROVIDER, id: MOCK_MODEL });
	assert.ok(defaultModel());
	let attempts = 0;
	const svc = fixture(async () => { attempts++; throw new Error("timed out waiting for available models"); }, [60_000]);
	cliServices.push(svc);
	try {
		const id = "cli-registration-agent";
		db.prepare("INSERT INTO agents(id,name,avatar,color,persona,model_provider,model_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "注册测试", "🤖", "#fff", "", svc.id, "gemini", now());
		const conv = createConversation(id);
		const rt = runtime(id, conv.id);
		assert.equal(await rt.send("你好"), "none");
		assert.equal(rt.session, null, "没有创建默认模型会话");
		const result = await rt.turn("群里回复");
		assert.equal(result.ok, false);
		assert.match(result.error!, /测试编程工具.*timed out.*没有改用其他模型/);
		assert.equal(attempts, 2, "每轮主动重试一次");
		const task = tasks.spawn(id, "离线任务", "不应使用默认模型", { conversationId: conv.id });
		for (let i = 0; i < 100 && getSubagent(task.id)?.status === "running"; i++) await delay(5);
		const failed = getSubagent(task.id)!;
		assert.equal(failed.status, "failed");
		assert.match(failed.error_reason!, /测试编程工具.*没有改用其他模型/);
		assert.equal(failed.model_provider, svc.id);
		const messages = db.prepare("SELECT content, meta FROM messages WHERE conversation_id = ? AND role = 'system' AND json_extract(meta, '$.action') = 'open-models'").all(conv.id) as { content: string; meta: string }[];
		assert.equal(messages.length, 2);
		for (const m of messages) {
			assert.match(m.content, /设置 › 模型服务/);
			assert.equal(JSON.parse(m.meta).action, "open-models");
		}
		assert.equal((db.prepare("SELECT model_provider FROM agents WHERE id = ?").get(id) as { model_provider: string }).model_provider, svc.id);
	} finally { cliServices.splice(cliServices.indexOf(svc), 1); svc.dispose(); }
});

test("已有注册并发等待同一轮，等待有上限，超时后保留后台注册", async () => {
	let finish!: () => void;
	let calls = 0, registered = false;
	const gate = new Promise<void>(r => { finish = r; });
	const svc = fixture(async () => { calls++; await gate; registered = true; return { disposeAll() {} }; });
	const catalog = { getModel: () => registered ? {} : undefined } as unknown as PiModels;
	cliServices.push(svc);
	try {
		const pick = { provider: svc.id, id: "gemini" };
		const pending = svc.ensure(catalog);
		const keepAlive = delay(25);
		await assert.rejects(resolveCliModel(catalog, pick, 5), /仍在加载/);
		assert.equal(calls, 1);
		finish();
		await pending;
		await resolveCliModel(catalog, pick);
		await keepAlive;
		assert.equal(calls, 1);
	} finally { finish(); cliServices.splice(cliServices.indexOf(svc), 1); svc.dispose(); }
});

test("模型已注册时无需触发注册；API 模型解析行为不受影响", async () => {
	let calls = 0;
	const svc = fixture(async () => { calls++; throw new Error("不该调用"); });
	cliServices.push(svc);
	try {
		await resolveCliModel({ getModel: () => ({}) } as unknown as PiModels, { provider: svc.id, id: "gemini" });
		await resolveCliModel({} as PiModels, { provider: "api-example", id: "m" });
		assert.equal(calls, 0);
	} finally { cliServices.splice(cliServices.indexOf(svc), 1); svc.dispose(); }
});
