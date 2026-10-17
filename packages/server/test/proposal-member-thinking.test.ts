/**
 * 群提议成员的思考强度（建群 / 加成员两条确认链路，真实 SQLite + 真实 Pi 模型目录）。
 *
 * 背景：`ProposalMember` 原来没有 thinking，`normalizeProposal` 丢弃它，`createRoomAgent` 永远写
 * defaultThinking —— 用户在成员卡片上选的档位确认后就丢了。现在：
 *  - `thinking` 合法档位按**这个成员实际用到的模型** clamp（`models.clampThinking`，与运行时同一份 Pi 元数据）后落库；
 *  - null / 缺省 / 不认识的值回默认（defaultThinking），保持原有行为；
 *  - 已有助理（只填 agentId）一律不改它原来的配置。
 *
 * 边界：临时数据目录（setup.ts）+ 内存 CredentialStore + 环回假中转，不碰真实数据 / 钥匙串 / 外网。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startMockOpenAI } from "../../../e2e/mock-openai.mjs";
import { customProviders, defaultThinking, initModels, isThinkingLevel, models } from "../src/models.ts";
import { THINKING_LEVEL_ORDER } from "@pi-assistant/shared";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const relay = await startMockOpenAI({ port: 0, key: "sk-unit" });
after(() => relay.close());
await initModels(memoryCredentialStore());

const { db, now, setSetting } = await import("../src/db.ts");
const { getAgent, runtime } = await import("../src/runtime.ts");
const rooms = await import("../src/rooms/index.ts");

// 默认档用一个和下面所有显式选择都不同的值，才能证明「缺省真的走默认」而不是碰巧相等
setSetting("defaultThinking", "low");
assert.equal(defaultThinking(), "low");

/** 造一个真实的自定义模型服务（环回，不出网）：一个支持 xhigh/max，一个只支持较少的档位 */
const provider = await customProviders.save(null, {
	name: "提议思考",
	api: "openai-completions",
	baseUrl: relay.url,
	apiKey: "sk-unit",
	models: [
		{ id: "gpt-6.1-sol", reasoning: true },
		{ id: "my-private-model", reasoning: true },
	],
});
const FULL = { provider: provider.id, id: "gpt-6.1-sol" };
const SUBSET = { provider: provider.id, id: "my-private-model" };
const fullLevels = models.supportedThinking(FULL.provider, FULL.id);
const subsetLevels = models.supportedThinking(SUBSET.provider, SUBSET.id);
assert.ok(fullLevels.includes("xhigh") && fullLevels.includes("max"), `前提：gpt-6.1-sol 支持 xhigh/max：${fullLevels}`);
assert.ok(!subsetLevels.includes("xhigh") && !subsetLevels.includes("max"), `前提：my-private-model 不支持 xhigh/max：${subsetLevels}`);

const thinkingOf = (id: string) => (db.prepare("SELECT thinking FROM agents WHERE id = ?").get(id) as { thinking: string | null }).thinking;
/** 运行时实际生效档位（与 GET /api/agents 的 thinking 字段同一条链路） */
const runtimeThinking = (id: string) => runtime(id).thinkingFor(getAgent(id)!);
const expectLegal = (level: string, supported: string[], label: string) => {
	assert.ok(isThinkingLevel(level), `${label}：${level} 应是合法档位`);
	assert.ok(supported.includes(level), `${label}：${level} 应在这个模型支持的档位里（${supported}）`);
};

test("建群确认：合法档位按实际模型 clamp 落库，运行时 thinkingFor 一致", async () => {
	const room = await rooms.confirmProposal({
		name: "思考群",
		purpose: "",
		manager: 0,
		members: [
			{ name: "满档", model: FULL, thinking: "max" },
			{ name: "子集", model: SUBSET, thinking: "xhigh" },
			{ name: "关掉", model: SUBSET, thinking: "off" },
			{ name: "无效", model: FULL, thinking: "ultra" },
			{ name: "缺省", model: FULL },
		],
	});
	const rows = db.prepare("SELECT id, name FROM agents WHERE room_id = ?").all(room.id) as { id: string; name: string }[];
	const byName = new Map(rows.map((r) => [r.name, r.id]));
	const id = (n: string) => byName.get(n)!;

	// xhigh/max 全支持的模型：用户选的 max 原样落库，运行时也是 max
	assert.equal(thinkingOf(id("满档")), "max");
	assert.equal(runtimeThinking(id("满档")), "max");
	// 子集模型：xhigh 被 clamp 成它支持的档位（不报错、不静默丢值），落库与运行时一致
	const subsetStored = thinkingOf(id("子集"))!;
	expectLegal(subsetStored, subsetLevels, "子集 clamp");
	assert.equal(subsetStored, models.clampThinking(SUBSET.provider, SUBSET.id, "xhigh"));
	assert.equal(runtimeThinking(id("子集")), subsetStored);
	// off 是合法档位，不能被当成「没填」（子集模型支持 off；推理必须开着的模型会被 clamp 到它最低档）
	assert.equal(thinkingOf(id("关掉")), "off");
	assert.equal(runtimeThinking(id("关掉")), "off");
	// 不认识的值 / 没填：回默认（保持原有 defaultThinking 行为）
	assert.equal(thinkingOf(id("无效")), "low");
	assert.equal(thinkingOf(id("缺省")), "low");
	assert.equal(runtimeThinking(id("缺省")), models.clampThinking(FULL.provider, FULL.id, "low"));
});

test("加成员确认：同一个 thinking 语义，换模型按新模型档位 clamp", async () => {
	db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES('base','群主','群','#000',?)").run(now());
	const room = rooms.createRoom({ name: "加人群", memberIds: ["base"] });
	// 满档模型 + max
	const a = await rooms.confirmMemberProposal(room.id, { name: "新人A", model: FULL, thinking: "max" });
	assert.equal(thinkingOf(a), "max");
	assert.equal(runtimeThinking(a), "max");
	// 同一个选择换到子集模型：clamp 到子集支持的档位
	const b = await rooms.confirmMemberProposal(room.id, { name: "新人B", model: SUBSET, thinking: "max" });
	const clamped = thinkingOf(b)!;
	expectLegal(clamped, subsetLevels, "加成员 clamp");
	assert.equal(clamped, models.clampThinking(SUBSET.provider, SUBSET.id, "max"));
	assert.equal(runtimeThinking(b), clamped);
	// 缺省仍然回默认
	const c = await rooms.confirmMemberProposal(room.id, { name: "新人C", model: FULL });
	assert.equal(thinkingOf(c), "low");
	// 成员真的进了群
	assert.deepEqual(rooms.membersOf(room.id).map((m) => m.agent_id).sort(), [a, b, c, "base"].sort());
});

test("自动推荐链路（auto）保留用户选的档位，并按最终挑中的模型 clamp", () => {
	const p = rooms.normalizeProposal({ name: "auto", purpose: "", manager: 0, members: [{ name: "A", role: "看图、写代码", needs: ["vision"], thinking: "max" }] }, { auto: true });
	const m = p.members[0];
	assert.ok(m.model, "auto 应挑到已配置的模型");
	const supported = models.supportedThinking(m.model!.provider, m.model!.id);
	assert.equal(m.thinking, models.clampThinking(m.model!.provider, m.model!.id, "max"));
	expectLegal(m.thinking!, supported, "auto clamp");
	// 非法值不会被当成合法档位塞给新成员
	const bad = rooms.normalizeProposal({ name: "auto", purpose: "", manager: 0, members: [{ name: "B", thinking: "ultra" }] }, { auto: true });
	assert.equal(bad.members[0].thinking, null);
});

test("已有助理：提议里的 thinking 不会改用户原来的配置", async () => {
	db.prepare("INSERT INTO agents(id, name, avatar, color, model_provider, model_id, thinking, created_at) VALUES('ex','既有','既','#000',?,?,?,?)").run(FULL.provider, FULL.id, "high", now());
	// 规范化的返回里只有 agentId（不回传 thinking，避免界面/调用方以为能改）
	assert.deepEqual(rooms.normalizeProposal({ name: "x", members: [{ agentId: "ex", thinking: "max" }] }).members, [{ agentId: "ex" }]);
	const room = rooms.createRoom({ name: "既有群", memberIds: ["ex"] });
	await rooms.confirmMemberProposal(room.id, { agentId: "ex", thinking: "max" });
	assert.equal(thinkingOf("ex"), "high", "已有助理的思考强度保持原值");
	assert.equal(getAgent("ex")!.thinking, "high");
	// 建群链路同样不动它
	await rooms.confirmProposal({ name: "既有群2", manager: 0, members: [{ agentId: "ex", thinking: "off" }] });
	assert.equal(thinkingOf("ex"), "high");
});

test("提议 DTO：thinking 只会是合法档位或 null（不会把原样字符串传出去）", () => {
	const p = rooms.normalizeProposal({
		name: "dto",
		members: [
			{ name: "A", model: SUBSET, thinking: "off" },
			{ name: "B", model: FULL, thinking: null },
			{ name: "C", model: FULL, thinking: 3 as never },
			{ name: "D", model: SUBSET, thinking: "xhigh" },
		],
	});
	assert.equal(p.members[0].thinking, "off");
	assert.equal(p.members[1].thinking, null);
	assert.equal(p.members[2].thinking, null);
	expectLegal(p.members[3].thinking!, subsetLevels, "DTO clamp");
	assert.ok(THINKING_LEVEL_ORDER.includes(p.members[3].thinking as never));
});
