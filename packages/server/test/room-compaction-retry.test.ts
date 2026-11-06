import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const { db, now } = await import("../src/db.ts");
const R = await import("../src/runtime.ts");
const rooms = await import("../src/rooms/index.ts");
const AD = await import("../src/rooms/after-delivery.ts");
const { memberConversation } = await import("../src/rooms/store.ts");
const { insertMessage } = await import("../src/messages.ts");

// 与 room-floor 相同：仅替换运行时，不起真实模型，数据由 setup 隔离。
const calls: string[] = [];
const failing = new Set<string>();
const proto = Object.getPrototypeOf(R.runtime("retry-a", "conv_probe"));
proto.compact = async function (this: { id: string }) {
	calls.push(this.id);
	if (failing.has(this.id)) throw new Error("测试整理失败");
};
Object.defineProperty(proto, "busy", { get() { return false; } });
for (const id of ["retry-a", "retry-b"]) {
	db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, id, "A", "#111", now());
}
const usage = (roomId: string, agentId: string, tokens: number) => insertMessage({
	agentId, conversationId: memberConversation(roomId, agentId), role: "assistant", content: "好的",
	meta: { usage: { input: 1000, cacheRead: tokens - 1000, cacheWrite: 0 } },
});
async function size(roomId: string, agentId = "retry-a") {
	AD.maybeTidyMember(roomId, agentId, memberConversation(roomId, agentId));
	await AD.tidyingOf(roomId, agentId);
}
async function delivered(roomId: string) {
	AD.afterDelivery(roomId, { id: "retry-project", title: "测试" }, "retry-a", { summary: "", files: [], notDone: "" });
	AD.maybeTidy(roomId, { idle: true, openProjects: 0 });
	await AD.tidyingOf(roomId);
}

test("失败重试：两入口双向共享门槛，增长不足不重试，刚好两万重试，成功清除", async () => {
	const room = rooms.createRoom({ name: "重试群", memberIds: ["retry-a"], managerId: "retry-a" });
	usage(room.id, "retry-a", 149_999);
	await size(room.id);
	await delivered(room.id);
	assert.equal(calls.length, 0, "保留十五万门槛");
	failing.add("retry-a");
	usage(room.id, "retry-a", 160_000);
	await size(room.id);
	assert.equal(calls.length, 1);
	await size(room.id);
	await delivered(room.id);
	usage(room.id, "retry-a", 179_999);
	await size(room.id);
	await delivered(room.id);
	assert.equal(calls.length, 1, "两入口都不重复尝试，差一个 token 也不行");
	usage(room.id, "retry-a", 180_000);
	await delivered(room.id);
	assert.equal(calls.length, 2, "交付入口刚好增长两万可重试");
	usage(room.id, "retry-a", 199_999);
	await size(room.id);
	assert.equal(calls.length, 2, "交付失败也更新共同基线");
	usage(room.id, "retry-a", 200_000);
	failing.delete("retry-a");
	await size(room.id);
	assert.equal(calls.length, 3);
	// 成功后模拟用量下降，但仍超过首次整理门槛；旧失败记录必须清除。
	usage(room.id, "retry-a", 150_000);
	await delivered(room.id);
	await size(room.id);
	assert.equal(calls.length, 5, "按大小整理成功后，两入口都不受旧失败记录阻挡");
	failing.add("retry-a");
	await size(room.id);
	usage(room.id, "retry-a", 170_000);
	failing.delete("retry-a");
	await delivered(room.id);
	usage(room.id, "retry-a", 150_000);
	await size(room.id);
	assert.equal(calls.length, 8, "交付整理成功也清除共同失败记录");
});

test("失败记录按群和成员隔离，不阻止其他成员或同成员的另一个群", async () => {
	calls.length = 0;
	failing.add("retry-a");
	const room = rooms.createRoom({ name: "隔离群", memberIds: ["retry-a", "retry-b"], managerId: "retry-a" });
	usage(room.id, "retry-a", 160_000);
	usage(room.id, "retry-b", 160_000);
	await delivered(room.id);
	assert.deepEqual(calls.slice().sort(), ["retry-a", "retry-b"]);
	await size(room.id);
	await size(room.id, "retry-b");
	assert.deepEqual(calls, ["retry-a", "retry-b", "retry-b"]);
	const other = rooms.createRoom({ name: "另一群", memberIds: ["retry-a"], managerId: "retry-a" });
	usage(other.id, "retry-a", 160_000);
	await size(other.id);
	assert.equal(calls.filter((id) => id === "retry-a").length, 2);
});
