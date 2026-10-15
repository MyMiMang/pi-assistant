/**
 * 子代理思考档位「选项不全」回归（真实模型目录 + 临时数据目录 + 内存凭据，无钥匙串 / 无真实 Key）。
 *
 * 根因：助理设置里的子代理思考档位原来是取候选池所有模型支持档位的**交集**；池子里只要有一个模型
 * 不支持 xhigh / max（例如只能到 high），这两档就会被裁掉，用户看到「子代理档位比主会话少」。
 * 正确规则是按「至少一个候选支持」取并集，真正落到某个模型时由服务端 clamp。
 *
 * 这里用真实 Pi 目录造两个自定义模型（一个有 xhigh/max、一个没有），断言：
 *  - 跟随主会话（单模型）时，子代理档位 = 主会话档位（同一份 Pi 能力来源）；
 *  - 多候选池取并集，保留 xhigh/max；并证明旧的交集写法会漏掉（根因）；
 *  - 不支持的模型由 clampThinking 合法降级，不报错、不静默吞用户值。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startMockOpenAI } from "../../../e2e/mock-openai.mjs";
import { customProviders, initModels, models } from "../src/models.ts";
import { thinkingLevelsFor, thinkingLevelsUnion } from "@pi-assistant/shared";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const relay = await startMockOpenAI({ port: 0, key: "sk-unit" });
after(() => relay.close());
await initModels(memoryCredentialStore());

/** 旧实现（交集）——只用于证明根因，不参与产品逻辑 */
const intersect = (lists: string[][]): string[] => lists.reduce((a, b) => (a.length && b.length ? a.filter((x) => b.includes(x)) : []));

test("档位并集 helper：按 Pi 顺序去重、过滤非法档位、空输入不产生 undefined", () => {
	// 输入乱序 + 非法值 + 重复：输出仍是 Pi 的规范顺序，且不含非法项
	assert.deepEqual(thinkingLevelsUnion([["xhigh", "off", "high", "bogus"], ["high", "off", "max"]]), ["off", "high", "xhigh", "max"]);
	assert.deepEqual(thinkingLevelsUnion([]), []);
	assert.deepEqual(thinkingLevelsUnion([undefined, null, [] as string[]]), []);
	// 目录里没有的模型 ref：返回空数组（界面显示「未加载 / 未配置」而不是 undefined 文案）
	assert.deepEqual(thinkingLevelsFor([{ provider: "a", id: "x", thinking: ["off", "high"] }], [{ provider: "a", id: "missing" }]), []);
	// 空 refs（模型还没选中）也是空数组
	assert.deepEqual(thinkingLevelsFor([{ provider: "a", id: "x", thinking: ["off", "high"] }], []), []);
});

test("子代理思考档位：跟随主会话与主会话一致；多候选池取并集保留 xhigh/max（不再交集裁掉）", async () => {
	const p = await customProviders.save(null, {
		name: "子代理档位",
		api: "openai-completions",
		baseUrl: relay.url,
		apiKey: "sk-unit",
		models: [
			{ id: "gpt-6.1-sol", reasoning: true },
			{ id: "my-private-model", reasoning: true },
		],
	});
	try {
		const catalog = models.listModels(p.id);
		const sol = catalog.find((m) => m.id === "gpt-6.1-sol")!;
		const priv = catalog.find((m) => m.id === "my-private-model")!;
		// 能力来源是同一份 Pi 元数据：主会话列表 / 服务端 supportedThinking / 子代理 helper 都必须一致
		assert.deepEqual(sol.thinking, models.supportedThinking(p.id, "gpt-6.1-sol"));
		assert.deepEqual(priv.thinking, models.supportedThinking(p.id, "my-private-model"));
		assert.ok(sol.thinking.includes("xhigh") && sol.thinking.includes("max"), `有 xhigh/max 的模型：${sol.thinking}`);
		assert.ok(!priv.thinking.includes("xhigh") && !priv.thinking.includes("max"), `目录里没有的模型不凭空补档位：${priv.thinking}`);

		// 1) 空候选池 = 跟随主会话：子代理档位必须和主会话当前模型完全一致（不能比主会话少）
		assert.deepEqual(thinkingLevelsFor(catalog, [{ provider: p.id, id: "gpt-6.1-sol" }]), sol.thinking);
		// 2) 多候选池：并集保留任何候选支持的 xhigh/max
		const union = thinkingLevelsFor(catalog, [
			{ provider: p.id, id: "gpt-6.1-sol" },
			{ provider: p.id, id: "my-private-model" },
		]);
		assert.ok(union.includes("xhigh") && union.includes("max"), `并集保留 xhigh/max：${union}`);
		// 3) 根因证据：旧的交集写法会把这两档裁掉（并集是它的严格超集）
		const oldIntersection = intersect([sol.thinking, priv.thinking]);
		assert.ok(!oldIntersection.includes("xhigh") && !oldIntersection.includes("max"), `旧交集确实漏掉 xhigh/max：${oldIntersection}`);
		assert.ok(union.length > oldIntersection.length, "并集比交集多（修复生效）");
		// 4) 合法降级：并集里选了 xhigh，落到不支持它的模型时 clamp 到 high，不报错
		assert.equal(models.clampThinking(p.id, "my-private-model", "xhigh"), "high");
		assert.equal(models.clampThinking(p.id, "gpt-6.1-sol", "xhigh"), "xhigh");
	} finally {
		await customProviders.remove(p.id);
	}
});
