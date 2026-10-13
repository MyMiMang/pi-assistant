import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now, uid } from "../src/db.ts";
import { _markFinished, checkSheet, deletePet, imageSize, listPets, petOf, petSettings, petStatus, savePet, savePetSettings, setPetOf } from "../src/pet/index.ts";
import { hatchPrompt } from "../src/pet/routes.ts";

/** 只有头的 PNG（够读宽高） */
const pngHead = (w: number, h: number) => {
	const b = Buffer.alloc(33);
	b.writeUInt32BE(0x89504e47, 0);
	b.writeUInt32BE(0x0d0a1a0a, 4);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "ascii");
	b.writeUInt32BE(w, 16);
	b.writeUInt32BE(h, 20);
	return b;
};
const webpLossless = (w: number, h: number) => {
	const b = Buffer.alloc(40);
	b.write("RIFF", 0, "ascii");
	b.write("WEBP", 8, "ascii");
	b.write("VP8L", 12, "ascii");
	b[20] = 0x2f;
	b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
	return b;
};
const agent = (name: string) => {
	const id = uid("ag");
	db.prepare("INSERT INTO agents(id, name, avatar, color, sort, created_at) VALUES(?,?,?,?,?,?)").run(id, name, "🐱", "#f80", 0, now());
	return id;
};
const msg = (agentId: string, role: string, status: string, meta: Record<string, unknown> = {}, content = "", at = now()) =>
	db.prepare("INSERT INTO messages(id, agent_id, role, content, meta, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)").run(uid("m"), agentId, role, content, JSON.stringify(meta), status, at, at);

test("设置：默认关闭、大小限制在 0.6~1.4、默认宠物必须存在", () => {
	assert.equal(petSettings().enabled, false);
	assert.equal(savePetSettings({ enabled: true, scale: 9 }).scale, 1.4);
	assert.equal(savePetSettings({ scale: 0.1 }).scale, 0.6);
	assert.equal(savePetSettings({ defaultPet: "没有这只" }).defaultPet, "miao");
	assert.equal(savePetSettings({ defaultPet: "tuanzi" }).defaultPet, "tuanzi");
	assert.equal(petSettings().enabled, true);
});

test("精灵图尺寸检查：v1 / v2 / WebP，其他尺寸拒绝", () => {
	assert.deepEqual(imageSize(pngHead(1536, 1872)), { w: 1536, h: 1872, type: "png" });
	assert.deepEqual(imageSize(webpLossless(1536, 2288)), { w: 1536, h: 2288, type: "webp" });
	assert.deepEqual(checkSheet(pngHead(1536, 1872)), { ok: true, rows: 9, type: "png" });
	assert.deepEqual(checkSheet(webpLossless(1536, 2288)), { ok: true, rows: 11, type: "webp" });
	const bad = checkSheet(pngHead(1024, 1024));
	assert.ok(!bad.ok && /1536×1872/.test(bad.error));
	assert.ok(!checkSheet(Buffer.from("hello")).ok);
});

test("内置 4 只宠物；导入后出现在列表、重名加后缀、可删除，删除后助理回到默认", () => {
	const ids = listPets().filter((p) => p.builtin).map((p) => p.id);
	assert.deepEqual(ids, ["miao", "tuanzi", "xiaotie", "jiujiu"]);
	const a = savePet({ name: "Shiba Inu", sheet: pngHead(1536, 1872) });
	const b = savePet({ name: "Shiba Inu", sheet: pngHead(1536, 1872) });
	assert.equal(a.id, "shiba-inu");
	assert.equal(b.id, "shiba-inu-2");
	const c = savePet({ name: "小柴", sheet: pngHead(1536, 2288), idHint: "miao" });
	assert.notEqual(c.id, "miao", "不能顶替内置宠物");
	assert.equal(c.rows, 11);
	assert.match(c.url, /^\/api\/pets\/.+\/sheet/);
	assert.throws(() => savePet({ name: "x", sheet: pngHead(10, 10) }), /尺寸/);
	const ag = agent("小助理");
	setPetOf(ag, a.id);
	assert.equal(petOf(ag), a.id);
	savePetSettings({ defaultPet: a.id });
	assert.ok(deletePet(a.id));
	assert.equal(petSettings().defaultPet, "miao");
	assert.equal(petOf(ag), "miao");
	assert.throws(() => deletePet("miao"), /内置/);
	assert.throws(() => setPetOf(ag, "nope"), /不存在/);
});

test("状态：空闲 → 思考 → 干活 / 操作电脑 → 等批准 → 做完 → 出错", () => {
	db.exec("DELETE FROM agents; DELETE FROM messages; DELETE FROM requests;");
	savePetSettings({ follow: "auto", quiet: false });
	const a = agent("阿猫");
	const b = agent("阿狗");
	assert.equal(petStatus().state, "idle");

	db.prepare("UPDATE agents SET status = 'running' WHERE id = ?").run(b);
	msg(b, "assistant", "streaming");
	let s = petStatus();
	assert.equal(s.agent?.id, b, "自动跟随正在忙的助理");
	assert.equal(s.state, "thinking");

	msg(b, "tool", "running", { toolName: "bash" }, "", now() + 1);
	s = petStatus();
	assert.equal(s.state, "working");
	assert.equal(s.text, "正在运行命令");

	msg(b, "tool", "running", { toolName: "mcp__hostpc__click" }, "", now() + 2);
	assert.equal(petStatus().state, "computer");

	// 另一个助理来了个审批：优先显示审批
	db.prepare("INSERT INTO requests(id, agent_id, kind, tool_name, payload, status, created_at) VALUES(?,?,?,?,?,?,?)").run("ap_1", a, "approval", "bash", JSON.stringify({ summary: "删除 3 个文件", risk: "high" }), "pending", now());
	s = petStatus();
	assert.equal(s.state, "approval");
	assert.equal(s.agent?.id, a);
	assert.equal(s.request?.summary, "删除 3 个文件");
	assert.equal(s.busyOthers, 1);

	// 指定跟随 b：看不到 a 的审批
	savePetSettings({ follow: b });
	assert.equal(petStatus().state, "computer");
	savePetSettings({ follow: "auto" });
	db.prepare("UPDATE requests SET status = 'approved'").run();

	db.prepare("UPDATE agents SET status = 'idle'").run();
	msg(b, "assistant", "done", {}, "## 好了\n**文件**已经整理完", now() + 3);
	_markFinished(b);
	s = petStatus();
	assert.equal(s.agent?.id, b);
	assert.equal(s.state, "done");
	assert.equal(s.text, "好了 文件 已经整理完");
	savePetSettings({ quiet: true });
	assert.equal(petStatus().text, "");
	savePetSettings({ quiet: false });

	_markFinished(b, now() - 60_000);
	msg(b, "assistant", "error", {}, "", now() + 4);
	assert.equal(petStatus().state, "error");
});

test("孵化提示词：带描述、纯白背景、非定妆图要求保持同一角色", () => {
	const base = hatchPrompt("戴草帽的小柴犬", "base");
	assert.match(base, /戴草帽的小柴犬/);
	assert.match(base, /#FFFFFF/);
	assert.doesNotMatch(base, /reference image/);
	assert.match(hatchPrompt("x", "sad"), /same character/);
});
