/**
 * 首次运行向导状态回归：升级 / 标志丢失 / 配置暂时读不出时，不把「已配置」误判成「首次安装」。
 *
 * 只读非敏感元数据（向导标志、默认模型设置、助理数量）；模型是否可解析走 Pi 公开目录。
 * 经公开 `initModels(credentials?)` 注入内存 `CredentialStore`，不构造走 OS 钥匙串的安全后端。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, getSetting, setSetting } from "../src/db.ts";
import { initModels } from "../src/models.ts";
import { onboardingState, recoverOnboardingFlag } from "../src/onboarding.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

await initModels(memoryCredentialStore());

const MODEL = { provider: "openai", id: "gpt-5" };
const MISSING_MODEL = { provider: "gone-provider", id: "gone-model" };

function reset() {
	db.prepare("DELETE FROM agents").run();
	db.prepare("DELETE FROM settings WHERE key IN ('onboarded','defaultModel')").run();
}
function addAgent(id = "a_onboarding") {
	db.prepare("INSERT INTO agents(id, name, avatar, color, persona, status, unread, sort, created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, "测试助理", "π", "#888888", "", "idle", 0, 0, Date.now());
}

test("新装：没有助理、没有设置 → 走首次向导", () => {
	reset();
	const s = onboardingState();
	assert.deepEqual(s, { onboarded: false, modelSetupDone: false, modelReady: false });
});

test("旧版升级：标志丢失但有默认模型设置和助理 → 视为已完成并恢复标志", () => {
	reset();
	addAgent();
	setSetting("defaultModel", MODEL); // 旧版本写过默认模型，但从没写过 onboarded
	const s = onboardingState();
	assert.equal(s.onboarded, true, "已配置的旧数据不应再被要求首次设置");
	assert.equal(s.modelSetupDone, true);
	assert.equal(s.modelReady, true);

	assert.equal(recoverOnboardingFlag(), true, "启动时应把丢失的标志补回");
	assert.equal(getSetting("onboarded", false), true);
	assert.equal(recoverOnboardingFlag(), false, "已经是 true 时恢复应幂等、不重复写");
});

test("wizard 标志显式为 false 但库里已有配置 → recover 跳过，不强迫重设", () => {
	reset();
	addAgent();
	setSetting("defaultModel", MODEL);
	setSetting("onboarded", false);
	assert.equal(onboardingState().onboarded, true);
	assert.equal(recoverOnboardingFlag(), true);
});

test("已配置但模型暂时读不出（配置读取失败）→ 不误判为首次安装，单独标记 modelReady=false", () => {
	reset();
	addAgent();
	setSetting("onboarded", true);
	setSetting("defaultModel", MISSING_MODEL); // 目录里解析不到 → defaultModel() 返回 null
	const s = onboardingState();
	assert.equal(s.onboarded, true, "配置存在时不能因模型临时读不出就弹首次向导");
	assert.equal(s.modelSetupDone, true);
	assert.equal(s.modelReady, false, "模型不可用要单独暴露给界面做可恢复提示");
});

test("只预置了一个助理、没有模型 → 不算完成设置", () => {
	reset();
	addAgent();
	assert.equal(onboardingState().onboarded, false);
	assert.equal(recoverOnboardingFlag(), false);
});

test("只有模型设置、没有助理 → 不算完成设置", () => {
	reset();
	setSetting("defaultModel", MODEL);
	assert.equal(onboardingState().onboarded, false);
	assert.equal(recoverOnboardingFlag(), false);
});

test("删光所有助理（标志还在）→ 回到向导并从「创建助理」一步开始，不再问模型", () => {
	reset();
	setSetting("onboarded", true);
	setSetting("defaultModel", MODEL);
	const s = onboardingState();
	assert.equal(s.onboarded, false);
	assert.equal(s.modelSetupDone, true);
});
