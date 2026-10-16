/**
 * 静态资源预压缩 + API JSON 压缩的**真实 HTTP** 回归测试。
 *
 * 启动真实服务进程（`test/launch-memory.ts`：内存 CredentialStore 绕开钥匙串；PIA_MOCK=1；
 * PIA_DATA_DIR / PIA_WORKSPACE 指向进程专属临时目录），`WEB_DIST` 指向测试自己造的迷你静态目录
 * （含预生成的 .gz 旁路），用原始 HTTP 请求断言：
 *   - 静态 JS/CSS：Accept-Encoding 含 gzip 时发 .gz（Content-Encoding / Content-Length / Vary / Cache-Control 正确），
 *     不带 gzip 时发原始件；HEAD 不破坏 Content-Length；Range 仍 206。
 *   - index.html：gzip + no-cache。
 *   - API JSON：gzip；不带 gzip 时是明文；Vary 正确。
 *   - 二进制图片不二次压缩。
 * 边界：不读真实用户数据 / 不碰钥匙串 / 不调付费模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { after, before, test } from "node:test";

const serverDir = join(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "pia-compress-http-"));
const webDist = join(dataDir, "webdist");
mkdirSync(join(webDist, "assets"), { recursive: true });

const HTML = "<!doctype html><html><body>hello compression</body></html>";
const JS = "// synthetic bundle\n" + "const x = 1;\n".repeat(2000);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
writeFileSync(join(webDist, "index.html"), HTML);
writeFileSync(join(webDist, "index.html.gz"), gzipSync(HTML));
writeFileSync(join(webDist, "assets", "app-abc123.js"), JS);
writeFileSync(join(webDist, "assets", "app-abc123.js.gz"), gzipSync(JS, { level: 9 }));
writeFileSync(join(webDist, "icon.png"), PNG);

const port = 27000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
let srv: ReturnType<typeof spawn> | undefined;
let out = "";

function raw(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = http.request(new URL(path, base), { method, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (d) => chunks.push(Buffer.from(d)));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

async function waitReady(): Promise<void> {
	const end = Date.now() + 30_000;
	while (Date.now() < end) {
		try {
			const r = await raw("/api/system");
			if (r.status === 200) return;
		} catch {
			/* 未就绪 */
		}
		await new Promise((r) => setTimeout(r, 120));
	}
	throw new Error(`服务未就绪：\n${out.slice(-2500)}`);
}

before(async () => {
	srv = spawn(process.execPath, ["--import", "tsx", "test/launch-memory.ts"], {
		cwd: serverDir,
		// 注意环境变量前缀是 `PIA_`（config.ts 的 env() 会拼 BRAND.envPrefix）：写法必须是 PIA_WEB_DIST，否则会被静默忽略、用真实 dist。
		env: { ...process.env, PIA_DATA_DIR: dataDir, PIA_WORKSPACE: join(dataDir, "workspace"), PIA_PORT: String(port), PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_WEB_DIST: webDist },
		stdio: ["ignore", "pipe", "pipe"],
	});
	srv.stdout?.on("data", (d) => (out += d));
	srv.stderr?.on("data", (d) => (out += d));
	await waitReady();
});
after(() => srv?.kill("SIGKILL"));

test("静态 JS：Accept-Encoding gzip → 发 .gz，Content-Encoding/Length/Vary/Cache-Control 正确", async () => {
	const r = await raw("/assets/app-abc123.js", { "Accept-Encoding": "gzip" });
	assert.equal(r.status, 200);
	assert.equal(r.headers["content-encoding"], "gzip");
	assert.equal(Number(r.headers["content-length"]), gzipSync(JS, { level: 9 }).length, "Content-Length 应为压缩件大小");
	assert.match(String(r.headers["cache-control"]), /immutable/);
	assert.equal(String(r.headers["vary"]).toLowerCase(), "accept-encoding");
	assert.equal(r.body.length, gzipSync(JS, { level: 9 }).length, "线缆上应是压缩字节");
});

test("静态 JS：不带 gzip → 发原始件，仍是普通 200", async () => {
	const r = await raw("/assets/app-abc123.js", { "Accept-Encoding": "identity" });
	assert.equal(r.status, 200);
	assert.equal(r.headers["content-encoding"], undefined);
	assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(JS));
	assert.equal(r.body.toString("utf8"), JS);
});

test("静态 JS：HEAD 带 gzip 不破坏 Content-Length（无 body）", async () => {
	const r = await raw("/assets/app-abc123.js", { "Accept-Encoding": "gzip" }, "HEAD");
	assert.equal(r.status, 200);
	assert.equal(r.headers["content-encoding"], "gzip");
	assert.equal(Number(r.headers["content-length"]), gzipSync(JS, { level: 9 }).length);
	assert.equal(r.body.length, 0);
});

test("静态 JS：Range 请求仍是 206，走压缩表示", async () => {
	const r = await raw("/assets/app-abc123.js", { "Accept-Encoding": "gzip", Range: "bytes=0-9" });
	assert.equal(r.status, 206);
	assert.match(String(r.headers["content-range"]), /^bytes 0-9\/\d+$/);
	assert.equal(r.body.length, 10);
});

test("index.html：gzip 且 no-cache（更新要及时）", async () => {
	const r = await raw("/", { "Accept-Encoding": "gzip" });
	assert.equal(r.status, 200);
	assert.equal(r.headers["content-encoding"], "gzip");
	assert.match(String(r.headers["cache-control"]), /no-cache/);
});

test("API JSON：gzip；不带 gzip 时明文；Vary 正确", async () => {
	const gz = await raw("/api/system", { "Accept-Encoding": "gzip" });
	assert.equal(gz.status, 200);
	assert.equal(gz.headers["content-encoding"], "gzip");
	assert.equal(String(gz.headers["vary"]).toLowerCase(), "accept-encoding");
	const plain = await raw("/api/system", { "Accept-Encoding": "identity" });
	assert.equal(plain.headers["content-encoding"], undefined);
	// node:http 客户端不像 fetch 那样自动解压：压缩体要自己 gunzip 后再比内容
	assert.equal(JSON.parse(gunzipSync(gz.body).toString("utf8")).serverId, JSON.parse(plain.body.toString("utf8")).serverId);
});

test("二进制图片不二次压缩", async () => {
	const r = await raw("/icon.png", { "Accept-Encoding": "gzip" });
	assert.equal(r.status, 200);
	assert.equal(r.headers["content-encoding"], undefined);
	assert.equal(r.body.length, PNG.length);
});
