import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveApi, effectiveBaseUrl, guessApi, guessFromUrl, protocolBaseUrl, relayRoot } from "../src/pi-adapter/relay-protocols.ts";

test("按模型名识别协议", () => {
	assert.equal(guessApi("claude-sonnet-4"), "anthropic-messages");
	assert.equal(guessApi("anthropic/claude-3-5-haiku"), "anthropic-messages");
	assert.equal(guessApi("gemini-2.5-pro"), "google-generative-ai");
	assert.equal(guessApi("gpt-4.1"), "openai-completions");
	assert.equal(guessApi("deepseek-v3.1"), "openai-completions");
});

test("一个 Base URL 推出各协议地址，单独地址优先", () => {
	for (const b of ["https://r.example.com", "https://r.example.com/v1", "https://r.example.com/v1/", "https://r.example.com/anthropic", "https://r.example.com/v1beta"]) assert.equal(relayRoot(b), "https://r.example.com");
	const b = "https://r.example.com/v1";
	assert.equal(protocolBaseUrl(b, "openai-completions"), "https://r.example.com/v1");
	assert.equal(protocolBaseUrl(b, "anthropic-messages"), "https://r.example.com");
	assert.equal(protocolBaseUrl(b, "google-generative-ai"), "https://r.example.com/v1beta");
	assert.equal(protocolBaseUrl(b, "anthropic-messages", { "anthropic-messages": "https://other.example.com/claude/" }), "https://other.example.com/claude");
});

test("非自动模式不改协议和地址；自动模式用户改的优先", () => {
	const fixed = { api: "openai-completions", baseUrl: "https://x/v1" };
	assert.equal(effectiveApi(fixed, { id: "claude-x" }), "openai-completions");
	assert.equal(effectiveBaseUrl(fixed, { id: "claude-x" }), "https://x/v1");
	const auto = { api: "auto", baseUrl: "https://x/v1" };
	assert.equal(effectiveApi(auto, { id: "claude-x" }), "anthropic-messages");
	assert.equal(effectiveBaseUrl(auto, { id: "claude-x" }), "https://x");
	assert.equal(effectiveApi(auto, { id: "claude-x", api: "openai-completions" }), "openai-completions");
});

test("从地址猜格式和名称", () => {
	assert.deepEqual(guessFromUrl("https://api.example-relay.com/v1"), { api: "openai-completions", name: "Example-relay" });
	assert.equal(guessFromUrl("https://api.anthropic.com").api, "anthropic-messages");
	assert.equal(guessFromUrl("https://generativelanguage.googleapis.com/v1beta").api, "google-generative-ai");
	assert.equal(guessFromUrl("http://localhost:11434/v1").name, "本地服务");
	assert.deepEqual(guessFromUrl("not a url"), {});
});
