import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";
import { MAX_UPLOAD_SIZE, UPLOAD_CHUNK_SIZE } from "@pi-assistant/shared";
import { config } from "../src/config.ts";
import { db, now, uid } from "../src/db.ts";
import { getFile, saveRoomUpload, saveUpload, uploadDir, workspaceOf, type UploadOwner } from "../src/files.ts";
import { housekeeping } from "../src/housekeeping.ts";
import { abandonUpload, appendUpload, beginUpload, UploadError } from "../src/uploads.ts";

const DAY = 86_400_000;
const pending: { owner: UploadOwner; uploadId: string }[] = [];
afterEach(() => {
	for (const { owner, uploadId } of pending.splice(0)) abandonUpload(owner, uploadId);
});

function owners() {
	const agentId = uid("upload_agent");
	const roomId = uid("upload_room");
	const t = now();
	db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(agentId, "上传测试助理", "A", "#000", t);
	db.prepare("INSERT INTO rooms(id, name, manager_id, created_at, updated_at) VALUES(?,?,?,?,?)").run(roomId, "上传测试群", agentId, t, t);
	db.prepare("INSERT INTO room_members(room_id, agent_id, name, avatar, color, joined_at) VALUES(?,?,?,?,?,?)").run(roomId, agentId, "上传测试助理", "A", "#000", t);
	return [{ agentId }, { roomId }] as const;
}
function start(owner: UploadOwner, name: string, size: number) {
	const { uploadId } = beginUpload(owner, name, size);
	pending.push({ owner, uploadId });
	return { uploadId, path: join(uploadDir(owner), `.pia-upload-${uploadId}.part`) };
}
function body(...chunks: Uint8Array[]) {
	return new ReadableStream<Uint8Array>({ start(controller) {
		for (const chunk of chunks) controller.enqueue(chunk);
		controller.close();
	} });
}
const status = (expected: number) => (e: unknown) => e instanceof UploadError && e.status === expected;
const fileCount = () => (db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;

async function assertGone(owner: UploadOwner, uploadId: string, path: string) {
	assert.equal(existsSync(path), false, "临时文件已删除");
	await assert.rejects(appendUpload(owner, uploadId, 0, 0, body(Buffer.from("x"))), status(404), "会话也已失效");
}

for (const kind of ["agent", "room"] as const) {
	test(`${kind} 分块上传：多次请求、每次多个流片段，最终字节与落库精确一致`, async () => {
		const owner = owners()[kind === "agent" ? 0 : 1];
		const chunks = [Buffer.from([0, 255, 128, 1]), Buffer.from("中文\0多块", "utf8"), Buffer.from([254, 0, 127])];
		const expected = Buffer.concat(chunks);
		const { uploadId, path } = start(owner, "原始.bin", expected.length);
		const count = fileCount();
		assert.deepEqual(await appendUpload(owner, uploadId, 0, 0, body(chunks[0].subarray(0, 2), chunks[0].subarray(2))), { offset: chunks[0].length });
		assert.deepEqual(readFileSync(path), chunks[0]);
		assert.equal(fileCount(), count, "未完成时不登记附件");
		const offset = chunks[0].length + chunks[1].length;
		assert.deepEqual(await appendUpload(owner, uploadId, chunks[0].length, 1, body(chunks[1])), { offset });
		const result = await appendUpload(owner, uploadId, offset, 2, body(chunks[2]));
		assert.equal(result.offset, expected.length);
		assert.ok(result.file);
		assert.equal(result.file.size, expected.length);
		assert.equal(result.file.direction, "in");
		const row = getFile(result.file.fileId)!;
		assert.deepEqual(readFileSync(row.stored_path), expected);
		assert.equal(fileCount(), count + 1);
		if ("agentId" in owner) {
			assert.equal(row.agent_id, owner.agentId);
			assert.equal(row.workspace_path, join("uploads", "原始.bin"));
			assert.deepEqual(readFileSync(join(workspaceOf(owner.agentId!), row.workspace_path!)), expected);
		} else {
			assert.equal(row.agent_id, "");
			assert.equal(row.room_id, owner.roomId);
			assert.equal(result.file.roomId, owner.roomId);
			assert.equal(row.workspace_path, null);
		}
		await assertGone(owner, uploadId, path);
	});

	test(`${kind} Buffer 上传保留可用，分块共用安全命名与同名 -1`, async () => {
		const owner = owners()[kind === "agent" ? 0 : 1];
		const name = "../../危险\\名:*?\"<>|\0.txt";
		const safe = "危险_名________.txt";
		const bytes = Buffer.from([0, 1, 255]);
		const first = "agentId" in owner ? saveUpload(owner.agentId!, name, bytes) : saveRoomUpload(owner.roomId, name, bytes);
		assert.equal(first.name, safe);
		assert.deepEqual(readFileSync(first.stored_path), bytes);
		assert.equal(getFile(first.id)!.size, bytes.length);
		const { uploadId, path } = start(owner, name, bytes.length);
		const second = await appendUpload(owner, uploadId, 0, 0, body(bytes));
		assert.ok(second.file);
		assert.equal(second.file.name, "危险_名________-1.txt");
		const row = getFile(second.file.fileId)!;
		assert.deepEqual(readFileSync(row.stored_path), bytes);
		assert.equal(basename(row.stored_path), kind === "room" ? second.file.name : `${row.id}.txt`);
		assert.deepEqual(readFileSync(join(uploadDir(owner), safe)), bytes, "同名原文件未覆盖");
		await assertGone(owner, uploadId, path);
	});
}

test("声明超过总上限时拒绝，不创建临时文件；恰好上限可以开始", () => {
	const [owner] = owners();
	mkdirSync(uploadDir(owner), { recursive: true });
	const before = readdirSync(uploadDir(owner));
	assert.throws(() => beginUpload(owner, "too-big.bin", MAX_UPLOAD_SIZE + 1), status(413));
	assert.deepEqual(readdirSync(uploadDir(owner)), before);
	const { path } = start(owner, "limit.bin", MAX_UPLOAD_SIZE);
	assert.equal(statSync(path).size, 0, "只声明大小，不分配 2GB 内容");
});

test("实际分块恰好达到分块上限可以完成", async () => {
	const [owner] = owners();
	const bytes = Buffer.alloc(UPLOAD_CHUNK_SIZE, 0xa5);
	const { uploadId, path } = start(owner, "chunk-limit.bin", bytes.length);
	const result = await appendUpload(owner, uploadId, 0, 0, body(bytes));
	assert.ok(result.file);
	assert.equal(result.offset, UPLOAD_CHUNK_SIZE);
	assert.deepEqual(readFileSync(getFile(result.file.fileId)!.stored_path), bytes);
	await assertGone(owner, uploadId, path);
});

test("实际流累计超过分块上限，拒绝且清理，不登记附件", async () => {
	const [owner] = owners();
	const { uploadId, path } = start(owner, "chunk-over.bin", UPLOAD_CHUNK_SIZE + 1);
	const count = fileCount();
	await assert.rejects(appendUpload(owner, uploadId, 0, 0, body(Buffer.alloc(UPLOAD_CHUNK_SIZE), Buffer.from([1]))), status(413));
	await assertGone(owner, uploadId, path);
	assert.equal(fileCount(), count);
	assert.deepEqual(readdirSync(uploadDir(owner)), []);
});

test("实际累计内容超过声明大小，即使各块小于上限也拒绝并清理", async () => {
	const [, owner] = owners();
	const { uploadId, path } = start(owner, "declared-over.bin", 3);
	const count = fileCount();
	await appendUpload(owner, uploadId, 0, 0, body(Buffer.from([1, 2])));
	await assert.rejects(appendUpload(owner, uploadId, 2, 1, body(Buffer.from([3]), Buffer.from([4]))), status(413));
	await assertGone(owner, uploadId, path);
	assert.equal(fileCount(), count);
});

for (const [label, offset, index] of [["偏移", 0, 1], ["序号", 2, 0]] as const) {
	test(`${label}错误清理已经写入的临时文件`, async () => {
		const [owner] = owners();
		const { uploadId, path } = start(owner, "order.bin", 4);
		const count = fileCount();
		await appendUpload(owner, uploadId, 0, 0, body(Buffer.from([1, 2])));
		assert.equal(statSync(path).size, 2);
		await assert.rejects(appendUpload(owner, uploadId, offset, index, body(Buffer.from([3, 4]))), status(400));
		await assertGone(owner, uploadId, path);
		assert.equal(fileCount(), count);
	});
}

test("流在中途抛错时清理先前写入内容和会话", async () => {
	const [, owner] = owners();
	const { uploadId, path } = start(owner, "broken.bin", 8);
	const count = fileCount();
	await appendUpload(owner, uploadId, 0, 0, body(Buffer.from([1, 2])));
	let pulls = 0;
	const broken = new ReadableStream<Uint8Array>({ pull(controller) {
		if (pulls++ === 0) controller.enqueue(Buffer.from([3, 4]));
		else controller.error(new Error("模拟传输中断"));
	} });
	await assert.rejects(appendUpload(owner, uploadId, 2, 1, broken), status(400));
	assert.equal(pulls, 2, "流先提供内容，再中断");
	await assertGone(owner, uploadId, path);
	assert.equal(fileCount(), count);
});

test("abandon 只能取消所属上传，可重复调用且不删除其他文件", async () => {
	const [agent, room] = owners();
	const a = start(agent, "cancel.bin", 4);
	const b = start(room, "keep.bin", 4);
	await appendUpload(agent, a.uploadId, 0, 0, body(Buffer.from([1, 2])));
	abandonUpload(room, a.uploadId);
	assert.equal(existsSync(a.path), true, "其他 owner 不能取消");
	abandonUpload(agent, a.uploadId);
	abandonUpload(agent, a.uploadId);
	await assertGone(agent, a.uploadId, a.path);
	assert.equal(existsSync(b.path), true);
	const result = await appendUpload(room, b.uploadId, 0, 0, body(Buffer.from([1, 2, 3, 4])));
	assert.ok(result.file, "另一个上传仍能完成");
});

test("housekeeping 实际入口清理超过一天的单聊/群临时上传，保留边界和其他文件", async () => {
	const allOwners = owners();
	const t = Math.floor(Date.now() / 1000) * 1000;
	const expired: { owner: UploadOwner; uploadId: string; path: string }[] = [];
	const expected: string[] = [];
	const keep: string[] = [];
	const touch = (path: string, age: number) => {
		writeFileSync(path, "保留或清理的内容");
		utimesSync(path, (t - age) / 1000, (t - age) / 1000);
		return path;
	};
	for (const owner of allOwners) {
		const stale = start(owner, "expired.bin", 10);
		touch(stale.path, DAY + 1000);
		expired.push({ owner, ...stale });
		expected.push(stale.path);
		const dir = uploadDir(owner);
		expected.push(touch(join(dir, ".pia-upload-up_orphan.part"), DAY + 1000));
		const boundary = start(owner, "boundary.bin", 10);
		keep.push(touch(boundary.path, DAY));
		const recent = start(owner, "recent.bin", 10);
		keep.push(touch(recent.path, DAY - 1000));
		for (const name of ["user.part", ".pia-upload-not-an-id.part", ".pia-upload-up_old.txt", "finished.bin"]) {
			keep.push(touch(join(dir, name), 90 * DAY));
		}
	}
	const result = housekeeping({ dataDir: config.dataDir, extraLogDirs: [], now: t });
	assert.deepEqual([...result.removed].sort(), expected.sort());
	for (const item of expired) await assertGone(item.owner, item.uploadId, item.path);
	for (const path of expected) assert.equal(existsSync(path), false);
	for (const path of keep) assert.equal(readFileSync(path, "utf8"), "保留或清理的内容", `${basename(path)} 不应被清理`);
});

test("正式文件名不能伪装成过期待清理的临时文件", async () => {
	const [owner] = owners();
	const row = saveUpload(owner.agentId, ".pia-upload-up_reserved.part", Buffer.from("keep"));
	assert.equal(row.name, "_.pia-upload-up_reserved.part");
	const path = join(uploadDir(owner), row.name);
	const old = (Date.now() - 3 * DAY) / 1000;
	utimesSync(path, old, old);
	housekeeping({ dataDir: config.dataDir, extraLogDirs: [] });
	assert.equal(readFileSync(path, "utf8"), "keep");
});

test("取消正在接收的上传会终止流并清理临时文件", async () => {
	const [owner] = owners();
	const { uploadId, path } = start(owner, "active.bin", 10);
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) { controller.enqueue(Buffer.from([1])); started(); return new Promise(() => {}); },
		cancel() { cancelled = true; },
	});
	const result = appendUpload(owner, uploadId, 0, 0, stream);
	const rejected = assert.rejects(result, status(400));
	await ready;
	abandonUpload(owner, uploadId);
	await rejected;
	assert.equal(cancelled, true);
	await assertGone(owner, uploadId, path);
});

test("零字节文件允许空 body 完成；非空文件收到空 body 时清理", async () => {
	const [owner] = owners();
	const empty = start(owner, "empty.bin", 0);
	const result = await appendUpload(owner, empty.uploadId, 0, 0, null);
	assert.ok(result.file);
	assert.equal(result.offset, 0);
	assert.equal(statSync(getFile(result.file.fileId)!.stored_path).size, 0);
	await assertGone(owner, empty.uploadId, empty.path);
	const missing = start(owner, "missing.bin", 1);
	await assert.rejects(appendUpload(owner, missing.uploadId, 0, 0, null), status(400));
	await assertGone(owner, missing.uploadId, missing.path);
});
