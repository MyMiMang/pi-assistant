/**
 * 任务等待（DESIGN §28.1）的「合作式结束」集成验证，用**真实 Pi 会话 + mock 模型**证明：
 *  1. 模型调用 task_wait 后，这一轮确实自然结束、会话 settle（工具只返回一句提示，没有阻塞/中断；
 *     是否 settle 取决于模型照做——这是合作式结束，不是强制 yield）；
 *  2. 等待期间（tick 只查状态、目标还没结果）会话保持空闲，mock 模型步骤计数不增长 = 零模型调用。
 *
 * 注意：不能拿之后的 waker triggerTurn 当 yield 证据——那是另一次唤醒回合，不是本轮的结束。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deliveryExtension } from "@pi-assistant/ext-delivery";
import { config } from "../src/config.ts";
import { createPiSession, isSessionBusy, promptSession, subscribeSession, PiModels, type AgentEvent } from "../src/pi-adapter/index.ts";
import { MOCK_MODEL, MOCK_PROVIDER, mockStats, registerMockProvider, resetMockStats } from "../src/pi-adapter/mock-provider.ts";
import { EncryptedCredentialStore } from "../src/secrets.ts";
import { listWaits, registerWait, setWaitWaker, tickWaits } from "../src/task-waits.ts";
import { now } from "../src/db.ts";

const models = await PiModels.create({ credentials: new EncryptedCredentialStore(), modelsPath: null, allowNetwork: false });
await registerMockProvider(models);

test("task_wait 后会话自然结束（settle），等待期零模型调用", async () => {
	const agentId = "yield-a";
	const ws = join(config.workspaceRoot, "task-wait-yield");
	mkdirSync(ws, { recursive: true });
	// 本测试里等待目标不会出结果：唤醒不应发生，也不该有模型调用
	let wakes = 0;
	setWaitWaker(async () => { wakes++; });

	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, agentId),
		sessionDir: join(config.agentsDir, agentId, "sessions"),
		model: { provider: MOCK_PROVIDER, id: MOCK_MODEL },
		systemPromptAppend: ["你是测试助理。"],
		extensions: [
			{
				name: "delivery",
				factory: deliveryExtension({
					deliverFile: async () => ({ fileId: "f1", name: "f1" }),
					ask: async () => "A",
					waits: {
						register: (i) => {
							const w = registerWait(agentId, null, { reason: i.reason, dueAt: now() + 30 * 60_000 });
							return { id: w.id, kind: w.target_kind, dueAt: w.due_at, intervalMs: w.check_interval_ms };
						},
						list: () => [],
						refresh: async () => ({ status: "waiting", detail: "还没结果", fired: false }),
						cancel: () => false,
					},
				}),
			},
		],
	});

	resetMockStats();
	const events: AgentEvent["type"][] = [];
	subscribeSession(session, (e) => events.push(e.type));

	await promptSession(session, "帮我等构建完成再核对产物");

	// 1) 合作式结束：模型照做后这一轮结束、会话 settle
	assert.equal(isSessionBusy(session), false, "task_wait 之后这一轮自然结束、会话空闲（不是强制 yield，是模型照做）");
	assert.ok(events.includes("settled"), "Pi 发出 settled 事件");
	const stepsAfterTurn = mockStats.steps;
	assert.ok(stepsAfterTurn >= 1, "登记这一轮至少有一次模型调用");
	assert.equal(listWaits(agentId, { status: "waiting" }).length, 1, "等待已持久化登记");

	// 2) 等待期：目标未出结果，tick 只查状态，不再调用模型
	await tickWaits(now() + 61_000);
	await tickWaits(now() + 10 * 60_000);
	assert.equal(isSessionBusy(session), false, "等待期间会话一直空闲");
	assert.equal(mockStats.steps, stepsAfterTurn, "等待期间零模型调用");
	assert.equal(wakes, 0, "没有结果就不唤醒");

	session.dispose();
});
