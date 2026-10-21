/**
 * 视频 / 音频播放：MIME 表、sendFile 的 inline + 单区间 Range（206 / 416）、播放签名链接。
 *
 * 前半是纯函数（parseRange / mimeOf）；后半起真实服务进程（内存凭据、Mock、临时数据目录，同 static-compression-http），
 * 上传一个假 mp4，再用原始 HTTP 请求验证 /api/files/:id、/api/files/:id/play-link 和换出来的 /hooks/dl 签名链接。
 * 边界：不碰真实数据目录 / 钥匙串 / 付费模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
const { parseRange } = await import("../src/routes/common.ts");
const { mimeOf } = await import("../src/files.ts");

test("MIME：常见视频 / 音频扩展名", () => {
	const want: Record<string, string> = {
		"a.mp4": "video/mp4", "a.m4v": "video/mp4", "a.MOV": "video/quicktime", "a.webm": "video/webm",
		"a.mp3": "audio/mpeg", "a.wav": "audio/wav", "a.m4a": "audio/mp4", "a.aac": "audio/aac", "a.ogg": "audio/ogg", "a.oga": "audio/ogg", "a.opus": "audio/ogg", "a.flac": "audio/flac",
		"a.unknown": "application/octet-stream",
	};
	for (const [n, m] of Object.entries(want)) assert.equal(mimeOf(n), m, n);
});

test("parseRange：首段 / 中段 / 末段 / 后缀 / 截到文件尾", () => {
	assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
	assert.deepEqual(parseRange("bytes=500-599", 1000), { start: 500, end: 599 });
	assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
	assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
	assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
	assert.deepEqual(parseRange("bytes=990-5000", 1000), { start: 990, end: 999 });
});

test("parseRange：越界 → invalid；没有 / 不认识 / 多区间 → null（按完整文件发）", () => {
	assert.equal(parseRange("bytes=1000-", 1000), "invalid");
	assert.equal(parseRange("bytes=2000-3000", 1000), "invalid");
	assert.equal(parseRange("bytes=-0", 1000), "invalid");
	assert.equal(parseRange(undefined, 1000), null);
	assert.equal(parseRange("", 1000), null);
	assert.equal(parseRange("items=0-5", 1000), null);
	assert.equal(parseRange("bytes=0-5,10-20", 1000), null);
	assert.equal(parseRange("bytes=-", 1000), null);
	assert.equal(parseRange("bytes=50-10", 1000), null);
});

const serverDir = join(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "pia-media-http-"));
const port = 29000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
let srv: ReturnType<typeof spawn> | undefined;
let out = "";
const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
let fileId = "";
let zipId = "";

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

before(async () => {
	srv = spawn(process.execPath, ["--import", "tsx", "test/launch-memory.ts"], {
		cwd: serverDir,
		env: { ...process.env, PIA_DATA_DIR: dataDir, PIA_WORKSPACE: join(dataDir, "workspace"), PIA_PORT: String(port), PIA_MOCK: "1", PIA_OFFLINE: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	srv.stdout?.on("data", (d) => (out += d));
	srv.stderr?.on("data", (d) => (out += d));
	const end = Date.now() + 30_000;
	for (;;) {
		try {
			if ((await get("/api/system")).status === 200) break;
		} catch {
			/* 未就绪 */
		}
		if (Date.now() > end) throw new Error(`服务未就绪：\n${out.slice(-2500)}`);
		await new Promise((r) => setTimeout(r, 120));
	}
	const a = await (await fetch(`${base}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "媒体测试" }) })).json();
	const fd = new FormData();
	fd.append("file", new File([BODY], "clip.mp4"));
	const up = await (await fetch(`${base}/api/agents/${a.id}/upload`, { method: "POST", body: fd })).json();
	assert.equal(up.mime, "video/mp4");
	fileId = up.fileId;
	const fd2 = new FormData();
	fd2.append("file", new File([BODY], "a.zip"));
	zipId = ((await (await fetch(`${base}/api/agents/${a.id}/upload`, { method: "POST", body: fd2 })).json()) as { fileId: string }).fileId;
});
after(() => srv?.kill("SIGKILL"));

test("无 Range：完整 200，带 Accept-Ranges，默认仍是下载（attachment）", async () => {
	const r = await get(`/api/files/${fileId}`);
	assert.equal(r.status, 200);
	assert.equal(r.headers.get("accept-ranges"), "bytes");
	assert.equal(r.headers.get("content-length"), "1000");
	assert.equal(r.headers.get("content-type"), "video/mp4");
	assert.match(r.headers.get("content-disposition") ?? "", /^attachment/);
	assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY);
});

test("inline=1：视频 / 音频在页面里播放（inline），其他类型仍然下载", async () => {
	const r = await get(`/api/files/${fileId}?inline=1`);
	assert.match(r.headers.get("content-disposition") ?? "", /^inline/);
	await r.arrayBuffer();
	const z = await get(`/api/files/${zipId}?inline=1`);
	assert.match(z.headers.get("content-disposition") ?? "", /^attachment/);
	await z.arrayBuffer();
});

test("Range 首段 / 中段 / 末段 → 206 + Content-Range + 正确字节", async () => {
	for (const [h, s, e] of [["bytes=0-9", 0, 9], ["bytes=100-199", 100, 199], ["bytes=990-", 990, 999], ["bytes=-10", 990, 999]] as const) {
		const r = await get(`/api/files/${fileId}?inline=1`, { range: h });
		assert.equal(r.status, 206, h);
		assert.equal(r.headers.get("content-range"), `bytes ${s}-${e}/1000`, h);
		assert.equal(r.headers.get("content-length"), String(e - s + 1), h);
		assert.equal(r.headers.get("accept-ranges"), "bytes");
		assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY.subarray(s, e + 1), h);
	}
});

test("Range 越界 → 416 + Content-Range: bytes */size", async () => {
	const r = await get(`/api/files/${fileId}`, { range: "bytes=1000-1999" });
	assert.equal(r.status, 416);
	assert.equal(r.headers.get("content-range"), "bytes */1000");
	await r.arrayBuffer();
});

test("播放链接：play-link 换出短时签名链接，能直接播放 + 拖动（无需 Authorization）", async () => {
	const pl = await get(`/api/files/${fileId}/play-link`);
	assert.equal(pl.status, 200);
	const { url } = (await pl.json()) as { url: string };
	assert.match(url, /^\/hooks\/dl\/[^/]+\/\d+\/[\w-]+\?inline=1$/);
	const exp = Number(url.split("/")[4]) * 1000;
	assert.ok(exp > Date.now() && exp - Date.now() <= 4 * 3600_000 + 5_000, "有效期不超过 4 小时");
	const r = await get(url, { range: "bytes=10-19" });
	assert.equal(r.status, 206);
	assert.match(r.headers.get("content-disposition") ?? "", /^inline/);
	assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY.subarray(10, 20));
	// 篡改签名 / 换文件 → 拒绝
	const bad = await get(url.replace(/\/[\w-]+\?inline=1$/, "/deadbeef?inline=1"));
	assert.equal(bad.status, 403);
	await bad.arrayBuffer();
});

test("play-link：文件不存在 → 404", async () => {
	const r = await get("/api/files/nope/play-link");
	assert.equal(r.status, 404);
	await r.arrayBuffer();
});

// cf-connecting-ip 让 isLocalRequest 判定为「经隧道」，模拟手机经隧道连回家里电脑的未登录远程请求（不是回环本机）。
const REMOTE = { "cf-connecting-ip": "9.9.9.9" };

test("play-link：本身在登录鉴权之后——未登录的远程请求拿不到链接；换了设备 token 就能拿到", async () => {
	const unauth = await get(`/api/files/${fileId}/play-link`, REMOTE);
	assert.equal(unauth.status, 401);
	await unauth.arrayBuffer();

	// 走真实配对流程换一个设备 token（本机发起配对码、免确认认领，和 App 真实流程一致）；
	// /api/pair/start 不直接回码，码在二维码链接的 hash 参数 c= 里（和手机扫码拿到的是同一样东西）。
	const start = await (await fetch(`${base}/api/pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preApproved: true }) })).json();
	const code = new URLSearchParams(new URL(start.directUrl).hash.slice(1)).get("c");
	const claim = await (await fetch(`${base}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json", ...REMOTE }, body: JSON.stringify({ code, name: "远程手机", platform: "ios" }) })).json();
	assert.ok(claim.preApproved, "免确认配对码认领后应直接生效");
	const status = await (await fetch(`${base}/api/pair/status/${claim.deviceId}`)).json();
	const token = status.token as string;
	assert.match(token, /^hh_/);

	const authed = await get(`/api/files/${fileId}/play-link`, { ...REMOTE, authorization: `Bearer ${token}` });
	assert.equal(authed.status, 200, "带设备 token 的远程请求应能换到签名链接");
	const { url } = (await authed.json()) as { url: string };

	// 签名链接本身是公开地址（/hooks/ 路由不需要登录凭证），这正是它的用途：<video src> 带不了 Authorization 头
	const play = await get(url, { ...REMOTE, range: "bytes=0-9" });
	assert.equal(play.status, 206);
	await play.arrayBuffer();
});

test("play-link：签名只认这一个文件——拼到另一个文件 id 上签名失效", async () => {
	const pl = await get(`/api/files/${fileId}/play-link`);
	const { url } = (await pl.json()) as { url: string };
	const swapped = url.replace(`/hooks/dl/${encodeURIComponent(fileId)}/`, `/hooks/dl/${encodeURIComponent(zipId)}/`);
	const r = await get(swapped);
	assert.equal(r.status, 403, "换了文件 id、签名没跟着变 → 应该被拒绝");
	await r.arrayBuffer();
});

test("signedPath/verifySigned：过期即失效（纯函数，覆盖 play-link 复用的到期逻辑）", async () => {
	const media = await import("../src/channels/media.ts");
	const past = Date.now() - 10 * 86400_000;
	const url = media.signedPath("f_expire_test", 3600_000, past); // 以「过去」为基准生成，早就过期
	const m = /\/hooks\/dl\/([^/]+)\/(\d+)\/([\w-]+)/.exec(url)!;
	assert.equal(media.verifySigned(m[1], m[2], m[3]), false, "现在校验应判定已过期");
	assert.equal(media.verifySigned(m[1], m[2], m[3], past + 1000), true, "在有效期内用当时的时间校验应通过");
});
