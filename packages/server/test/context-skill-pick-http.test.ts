/**
 * 「整理上下文指定重点」+「本次选用技能」的**真实 HTTP 闭环**集成测试。
 *
 * 启动真实服务进程（`test/launch-memory.ts`：内存 CredentialStore 绕开钥匙串；PIA_MOCK=1 假模型；
 * PIA_DATA_DIR / PIA_WORKSPACE 指向进程专属临时目录），用真实 HTTP 验证：
 *   POST /api/conversations/:cid/compact（instructions 类型 / 长度 / 缺省）
 *   GET  /api/agents/:id/skills（enabledSkills 只含已启用技能）
 *   POST /api/agents/:id/messages（skills 校验 fail closed；通过后真进 Pi 会话）
 *   POST /api/rooms/:rid/messages（群聊暂不支持 skills）
 * 并读**服务进程写入的会话文件**确认技能块确实进了模型上下文（不是只在客户端 payload 里）。
 *
 * 边界：不读真实用户数据 / 不碰钥匙串 / 不调付费模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const serverDir = join(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "pia-context-skill-http-"));
const port = 24000 + Math.floor(Math.random() * 3000);
const base = `http://127.0.0.1:${port}`;

let srv: ReturnType<typeof spawn> | undefined;
let out = "";
type Json = Record<string, any>;

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await Promise.resolve(cond()).catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 120));
	}
	throw new Error(`等待超时。服务输出：\n${out.slice(-2500)}`);
}

async function req(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Json }> {
	const r = await fetch(base + path, {
		method: init.method ?? "GET",
		headers: init.body !== undefined ? { "content-type": "application/json" } : {},
		body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
	});
	let parsed: Json = {};
	try {
		parsed = (await r.json()) as Json;
	} catch {
		/* 非 JSON 响应 */
	}
	return { status: r.status, body: parsed };
}

const mkAgent = async (name: string): Promise<Json> => {
	const r = await req("/api/agents", { method: "POST", body: { name } });
	assert.equal(r.status, 200, `建助理失败：${JSON.stringify(r.body)}`);
	return r.body;
};

/** 等服务进程里的助理结束当前一轮（会话空闲才能整理上下文）。 */
async function waitAgentIdle(id: string): Promise<void> {
	await waitFor(async () => {
		const r = await req("/api/agents");
		const a = (r.body as unknown as Json[]).find((x) => x.id === id);
		return !!a && a.status !== "running";
	}, 30_000);
}

/** 服务进程写入的会话文件里是否已出现某段文本（证明真的进了 Pi 会话）。 */
function sessionHas(agentId: string, needle: string): boolean {
	const dir = join(dataDir, "agents", agentId, "sessions");
	if (!existsSync(dir)) return false;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".jsonl")) continue;
		try {
			if (readFileSync(join(dir, f), "utf8").includes(needle)) return true;
		} catch {
			/* 正在写，忽略 */
		}
	}
	return false;
}

before(async () => {
	srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "test/launch-memory.ts"], {
		cwd: serverDir,
		env: {
			...process.env,
			PIA_DATA_DIR: dataDir,
			PIA_WORKSPACE: join(dataDir, "workspace"),
			PIA_PORT: String(port),
			PIA_HOST: "127.0.0.1",
			PIA_MOCK: "1",
			PIA_OFFLINE: "1",
			PIA_SETUP_CHECK_MS: "9999999",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	srv.stdout?.on("data", (b) => (out += b));
	srv.stderr?.on("data", (b) => (out += b));
	await waitFor(async () => (await fetch(`${base}/api/system/public`)).status === 200, 60_000);
});

after(() => {
	srv?.kill("SIGKILL");
});

test("整理上下文：instructions 类型 / 长度 / 缺省", async () => {
	const a = await mkAgent("compact-agent");
	const cid = a.conversation_id as string;

	// 校验：非 string / 超长 —— 在调用 Pi 之前就拒掉
	const bad = await req(`/api/conversations/${cid}/compact`, { method: "POST", body: { instructions: 123 } });
	assert.equal(bad.status, 400);
	assert.equal(bad.body.error, "invalid_instructions");
	const long = await req(`/api/conversations/${cid}/compact`, { method: "POST", body: { instructions: "重".repeat(2001) } });
	assert.equal(long.status, 400);
	assert.equal(long.body.error, "instructions_too_long");

	// 缺省（无 body）：保持原行为（会话够大时成功；不够大时是 Pi 的「没有可总结内容」，不是校验错误）
	const plain = await req(`/api/conversations/${cid}/compact`, { method: "POST" });
	assert.ok(plain.status === 200 || /Nothing to compact/.test(String(plain.body.error)), JSON.stringify(plain.body));

	// 灌足够内容，让会话超过 Pi 的 keepRecentTokens（默认 20k），compact 才有可总结的早期消息
	for (let i = 0; i < 6; i++) {
		const ctx = await req(`/api/conversations/${cid}/context`);
		if ((ctx.body.tokens ?? 0) > 45000) break;
		await req(`/api/agents/${a.id}/messages`, { method: "POST", body: { text: `第${i}段命令。` + "甲".repeat(40000) } });
		await waitFor(() => sessionHas(a.id, `第${i}段命令。`), 30_000);
		await waitAgentIdle(a.id);
	}

	// 带重点：成功，返回 SDK 实际给的 tokensBefore / summary（Mock 摘要）
	const withFocus = await req(`/api/conversations/${cid}/compact`, { method: "POST", body: { instructions: "保留需求、决策和待办" } });
	assert.equal(withFocus.status, 200, JSON.stringify(withFocus.body));
	assert.equal(withFocus.body.ok, true);
	assert.ok(typeof withFocus.body.summary === "string" && withFocus.body.summary.length > 0, "返回真实摘要");
	assert.ok(typeof withFocus.body.tokensBefore === "number", "返回真实 tokensBefore");
});

test("技能入口：GET 只下发已启用技能的元数据", async () => {
	const a = await mkAgent("skill-agent");
	const s = (await req("/api/skills", { method: "POST", body: { name: "http-pick", description: "HTTP 选用测试技能", body: "步骤：先看再改。" } })).body;
	assert.ok(s.id === "user/http-pick", JSON.stringify(s));

	const before = await req(`/api/agents/${a.id}/skills`);
	assert.deepEqual(before.body.enabled, []);
	assert.deepEqual(before.body.enabledSkills, [], "未启用时不泄露任何技能名 / 描述");

	await req(`/api/agents/${a.id}/skills`, { method: "PUT", body: { ids: [s.id] } });
	const after = await req(`/api/agents/${a.id}/skills`);
	assert.deepEqual(after.body.enabled, [s.id]);
	assert.deepEqual(
		after.body.enabledSkills.map((x: Json) => x.id),
		[s.id],
	);
	assert.equal(after.body.enabledSkills[0].name, "http-pick");
	assert.equal(after.body.enabledSkills[0].description, "HTTP 选用测试技能");
});

test("发送消息：skills 只接受已启用 canonical id，fail closed，通过后真进 Pi 会话", async () => {
	const a = await mkAgent("pick-send-agent");
	const s = (await req("/api/skills", { method: "POST", body: { name: "http-send", description: "发送测试技能", body: "步骤：按技能说明做。" } })).body;
	assert.equal(s.id, "user/http-send");

	// 未启用就选：400，不自动启用，也不落库
	const denied = await req(`/api/agents/${a.id}/messages`, { method: "POST", body: { text: "用这个技能", skills: [s.id] } });
	assert.equal(denied.status, 400);
	assert.equal(denied.body.code, "skill_not_enabled");
	const list = await req(`/api/agents/${a.id}/messages`);
	assert.ok(!(list.body as unknown as Json[]).some((m) => m.role === "user" && m.content === "用这个技能"), "校验失败不落用户消息");

	// 启用后再选：通过
	await req(`/api/agents/${a.id}/skills`, { method: "PUT", body: { ids: [s.id] } });
	const ok = await req(`/api/agents/${a.id}/messages`, { method: "POST", body: { text: "用这个技能", skills: [s.id] } });
	assert.equal(ok.status, 200, JSON.stringify(ok.body));
	assert.equal(ok.body.content, "用这个技能", "界面存的还是用户正文，不含技能块");
	await waitFor(() => sessionHas(a.id, "http-send"), 30_000);
	assert.ok(sessionHas(a.id, "按技能说明做。"), "技能正文进了 Pi 会话上下文");

	// 自填路径 / 不存在的 id / 同名不同来源 → 一律 400（不接受客户端路径）
	for (const badSkills of [["/etc/passwd"], ["user/does-not-exist"], ["builtin/http-send"]]) {
		const r = await req(`/api/agents/${a.id}/messages`, { method: "POST", body: { text: "x", skills: badSkills } });
		assert.equal(r.status, 400, `应拒绝 ${JSON.stringify(badSkills)}`);
		assert.equal(r.body.code, "skill_not_enabled");
	}
	// 非数组 / 非字符串元素 → invalid_skills；多个 → too_many_skills（第一版一次一个，Pi 原生只展开开头一个）
	assert.equal((await req(`/api/agents/${a.id}/messages`, { method: "POST", body: { text: "x", skills: "nope" } })).body.error, "invalid_skills");
	assert.equal((await req(`/api/agents/${a.id}/messages`, { method: "POST", body: { text: "x", skills: [1] } })).body.error, "invalid_skills");
	const tooMany = await req(`/api/agents/${a.id}/messages`, { method: "POST", body: { text: "x", skills: [s.id, s.id] } });
	assert.equal(tooMany.status, 400);
	assert.equal(tooMany.body.code, "too_many_skills");
});

test("停用后重发：fail closed，不自动启用", async () => {
	const a = await mkAgent("pick-disable-agent");
	const s = (await req("/api/skills", { method: "POST", body: { name: "http-disable", description: "停用测试", body: "正文。" } })).body;
	await req(`/api/agents/${a.id}/skills`, { method: "PUT", body: { ids: [s.id] } });
	assert.equal((await req(`/api/agents/${a.id}/messages`, { method: "POST", body: { text: "ok", skills: [s.id] } })).status, 200);
	// 停用
	await req(`/api/agents/${a.id}/skills`, { method: "PUT", body: { ids: [] } });
	const r = await req(`/api/agents/${a.id}/messages`, { method: "POST", body: { text: "再来", skills: [s.id] } });
	assert.equal(r.status, 400);
	assert.equal(r.body.code, "skill_not_enabled");
	const enabled = (await req(`/api/agents/${a.id}/skills`)).body.enabled;
	assert.deepEqual(enabled, [], "拒绝后也不会偷偷重新启用");
});

test("群聊：暂不支持 skills（明确拒绝，不静默丢弃）", async () => {
	const a = await mkAgent("pick-room-agent");
	const room = (await req("/api/rooms", { method: "POST", body: { name: "技能群", memberIds: [a.id], managerId: a.id } })).body;
	const r = await req(`/api/rooms/${room.id}/messages`, { method: "POST", body: { text: "hi", skills: ["user/http-send"] } });
	assert.equal(r.status, 400);
	assert.equal(r.body.code, "skills_not_supported");
});
