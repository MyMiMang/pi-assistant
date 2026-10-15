/**
 * 主动性「变化驱动」的 mock Pi 集成验证：
 *  1. 无变化（没有信号、没有未闭环事项）→ 不唤醒、零模型调用；
 *  2. 有变化信号 → 只唤醒一次，且给模型的提示只带差量（不是整份 situation 快照）；
 *  3. 把这段差量提示喂给真实 Pi 会话（mock 模型），确认恰好一次模型回合并 settle。
 * 不调用真实模型、不读凭据、不碰真实用户数据。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { now } from "../src/db.ts";
import { createPiSession, isSessionBusy, promptSession, subscribeSession, PiModels, type AgentEvent } from "../src/pi-adapter/index.ts";
import { MOCK_MODEL, MOCK_PROVIDER, mockStats, registerMockProvider, resetMockStats } from "../src/pi-adapter/mock-provider.ts";
import { EncryptedCredentialStore } from "../src/secrets.ts";
import * as P from "../src/proactive.ts";

const { db } = await import("../src/db.ts");
db.prepare("INSERT OR REPLACE INTO agents(id, name, avatar, color, created_at) VALUES('ps','信号','S','#000',?)").run(now());

const models = await PiModels.create({ credentials: new EncryptedCredentialStore(), modelsPath: null, allowNetwork: false });
await registerMockProvider(models);

const spawned: string[] = [];
P.setProactiveSpawner((agentId, title, instructions) => {
	const id = `t${spawned.length + 1}`;
	db.prepare("INSERT INTO tasks(id, agent_id, conversation_id, title, instructions, status, kind, created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, agentId, P.hiddenConversation(agentId), title, instructions, "running", "heartbeat", now());
	spawned.push(instructions);
	return { id };
});

test("无变化不唤醒（零模型）；有信号才一次唤醒且只带差量；差量提示在真实 Pi 会话里恰好一次回合", async () => {
	const T = Date.UTC(2026, 9, 12, 2, 0); // 周一 10:00（Asia/Shanghai）
	P.saveProactive("ps", { level: "normal" });
	db.prepare("DELETE FROM messages WHERE agent_id = 'ps'").run();
	db.prepare("DELETE FROM proactive_signals").run();
	db.prepare("DELETE FROM proactive_runs").run();
	spawned.length = 0;
	resetMockStats();

	// 1) 无变化：即使过了很久，也不唤醒、零模型调用
	assert.deepEqual(P.tickProactive(T + 24 * 3600_000), []);
	assert.equal(spawned.length, 0, "没有信号、没有未闭环事项 → 不空巡");
	assert.equal(mockStats.steps, 0, "零模型调用");

	// 2) 有变化信号 → 一次唤醒，提示只带差量
	db.prepare("INSERT INTO messages(id, agent_id, conversation_id, role, content, status, created_at, updated_at) VALUES('ps-u','ps','cps','user','帮我看下导出','done',?,?)").run(T - 3600_000, T - 3600_000);
	assert.equal(P.recordSignal("ps", { kind: "task_failed", title: "后台任务失败：导出报表", detail: "磁盘满了", importance: 3, dedupeKey: "task:t-ps:failed" }, T), true);
	assert.deepEqual(P.tickProactive(T + P.SIGNAL_MIN_GAP_MS), ["ps:signal"]);
	assert.equal(spawned.length, 1, "有信号只唤醒一次");
	const prompt = spawned[0];
	assert.match(prompt, /需要关注的信号/);
	assert.match(prompt, /磁盘满了/);
	assert.ok(!prompt.includes("## 用户最近 3 天说过的话"), "差量提示不重载整份 situation 快照");
	// 同一信号已处理，再次 tick 不再唤醒
	db.prepare("UPDATE proactive_runs SET status='done', finished_at=? WHERE status='running'").run(now());
	assert.deepEqual(P.tickProactive(T + P.SIGNAL_MIN_GAP_MS + 60_000), []);

	// 3) 差量提示喂给真实 Pi 会话：恰好一次模型回合并 settle
	const ws = join(config.workspaceRoot, "proactive-signal");
	mkdirSync(ws, { recursive: true });
	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, "ps"),
		sessionDir: join(config.agentsDir, "ps", "sessions"),
		model: { provider: MOCK_PROVIDER, id: MOCK_MODEL },
		systemPromptAppend: ["你是测试助理。"],
		extensions: [],
	});
	const events: AgentEvent["type"][] = [];
	subscribeSession(session, (e) => events.push(e.type));
	resetMockStats();
	await promptSession(session, prompt);
	assert.equal(isSessionBusy(session), false, "一次唤醒后会话自然结束");
	assert.ok(events.includes("settled"));
	assert.equal(mockStats.steps, 1, "一次信号唤醒 = 恰好一次模型回合");
	session.dispose();
});
