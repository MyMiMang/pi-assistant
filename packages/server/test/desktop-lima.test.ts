/** macOS 自带运行时（Lima，DESIGN §15.2 第 2 步）：清单、配置生成、环境检测、limactl 硬性保护、断点续传下载 */
import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { downloadFile } from "../src/downloads.ts";
import { parsePullLine } from "../src/desktop/image.ts";
import * as L from "../src/desktop/lima.ts";
import { labelValues } from "../src/desktop/names.ts";
import { normalizeFileMirror } from "../src/desktop/settings.ts";
import { updateDesktopSettings } from "../src/desktop/settings.ts";
import { pickBackend } from "../src/desktop/backend.ts";

process.env.PIA_TEST_FAST = "1";

test("清单：Lima 2.2.1 / nerdctl-full 2.4.1 / Debian 12 都固定了摘要和大小", () => {
	const m = L.vmManifest();
	assert.equal(m.lima.version, "2.2.1");
	assert.equal(m.nerdctl.version, "2.4.1");
	for (const k of ["darwin-arm64", "darwin-x64"]) assert.match(m.lima.assets[k].sha256!, /^[a-f0-9]{64}$/);
	for (const k of ["linux-arm64", "linux-x64"]) {
		assert.match(m.nerdctl.assets[k].sha256!, /^[a-f0-9]{64}$/);
		assert.match(m.debian.assets[k].sha512!, /^[a-f0-9]{128}$/);
		assert.ok(m.debian.assets[k].size > 1e8);
	}
	for (const arch of ["arm64", "x64"] as const) {
		const f = L.vmFiles(arch, "");
		assert.deepEqual(f.map((x) => x.id), ["lima", "nerdctl", "debian"]);
		assert.ok(f.every((x) => x.urls.every((u) => u.startsWith("https://"))));
		assert.ok(f.every((x) => x.dest.startsWith(L.vmDir())));
	}
	assert.match(L.vmFiles("arm64", "")[0].urls[0], /lima-vm\/lima\/releases\/download\/v2\.2\.1\/lima-2\.2\.1-Darwin-arm64\.tar\.gz$/);
	assert.match(L.vmFiles("x64", "")[2].urls[0], /debian-12-genericcloud-amd64-\d{8}-\d+\.qcow2$/);
	assert.throws(() => L.archKeys("ia32"));
});

test("GitHub 加速前缀：先走加速，失败回官方；格式校验", () => {
	assert.deepEqual(L.githubUrls("a/b", "1.0", "x.tgz", "https://ghfast.top/"), ["https://ghfast.top/https://github.com/a/b/releases/download/v1.0/x.tgz", "https://github.com/a/b/releases/download/v1.0/x.tgz"]);
	assert.deepEqual(L.githubUrls("a/b", "1.0", "x.tgz", ""), ["https://github.com/a/b/releases/download/v1.0/x.tgz"]);
	assert.equal(normalizeFileMirror(" ghfast.top "), "https://ghfast.top/");
	assert.equal(normalizeFileMirror("https://gh.example.com/proxy"), "https://gh.example.com/proxy/");
	assert.equal(normalizeFileMirror(""), "");
	assert.throws(() => normalizeFileMirror("javascript:alert(1)"));
	assert.throws(() => normalizeFileMirror("https://a b/"));
});

test("Lima 配置：vz、不挂载任何文件夹、本地系统盘与 containerd、端口只到 127.0.0.1", () => {
	const y = L.limaConfig({ arch: "aarch64", imagePath: "/Users/d/Library/Application Support/Pi Assistant/vm/files/d.qcow2", imageDigest: "a".repeat(128), nerdctlPath: "/x/n.tgz", nerdctlDigest: "b".repeat(64), cpus: 4, memoryGiB: 8, diskGiB: 40 });
	const c = parse(y);
	assert.equal(c.vmType, "vz");
	assert.equal(c.arch, "aarch64");
	assert.deepEqual(c.mounts, []);
	assert.equal(c.images.length, 1);
	assert.equal(c.images[0].location, "/Users/d/Library/Application Support/Pi Assistant/vm/files/d.qcow2");
	assert.equal(c.images[0].digest, `sha512:${"a".repeat(128)}`);
	assert.deepEqual({ system: c.containerd.system, user: c.containerd.user }, { system: true, user: false });
	assert.equal(c.containerd.archives[0].digest, `sha256:${"b".repeat(64)}`);
	assert.equal(c.ssh.loadDotSSHPubKeys, false);
	assert.equal(c.ssh.forwardAgent, false);
	assert.ok(c.portForwards.every((p: { hostIP: string }) => p.hostIP === "127.0.0.1"));
	assert.equal(c.memory, "8GiB");
	// 当前机器的配置也能生成（两个架构）
	for (const a of ["arm64", "x64"] as const) assert.equal(parse(L.currentConfig(a)).images[0].arch, a === "arm64" ? "aarch64" : "x86_64");
});

test("虚拟机大小：内存一半（4–8 GiB），CPU 核数 − 2（2–4）", () => {
	const G = 1024 ** 3;
	assert.deepEqual(L.vmSize(8 * G, 8), { memoryGiB: 4, cpus: 4, diskGiB: 40 });
	assert.deepEqual(L.vmSize(16 * G, 10), { memoryGiB: 8, cpus: 4, diskGiB: 40 });
	assert.deepEqual(L.vmSize(64 * G, 3), { memoryGiB: 8, cpus: 2, diskGiB: 40 });
});

test("虚拟机资源：写配置时尊重现有实例、用户选择优先、磁盘只扩不缩", () => {
	const c = (y: string) => {
		const p = parse(y) as { cpus: number; memory: string; disk: string };
		return { cpus: p.cpus, memory: p.memory, disk: p.disk };
	};
	const existing = { cpus: 6, memoryGiB: 8, diskGiB: 120 };
	updateDesktopSettings({ resources: {} });
	// 没设置：完全保留现有实例（不升级也不降配）
	assert.deepEqual(c(L.configForInstance("arm64", existing)), { cpus: 6, memory: "8GiB", disk: "120GiB" });
	// 用户选 CPU 变小、磁盘变小时：CPU 按用户，磁盘保留现有（只扩不缩）
	updateDesktopSettings({ resources: { cpus: 2, diskGiB: 60 } });
	assert.deepEqual(c(L.configForInstance("arm64", existing)), { cpus: 2, memory: "8GiB", disk: "120GiB" });
	// 用户选磁盘变大：按用户
	updateDesktopSettings({ resources: { diskGiB: 160 } });
	assert.deepEqual(c(L.configForInstance("arm64", existing)), { cpus: 6, memory: "8GiB", disk: "160GiB" });
	// 新虚拟机（没有现有值）：按建议值
	updateDesktopSettings({ resources: {} });
	const fresh = parse(L.configForInstance("arm64", null)) as { cpus: number; disk: string };
	assert.equal(fresh.cpus, L.vmSize().cpus);
	assert.equal(fresh.disk, "40GiB");
});

test("环境检测：macOS 版本、虚拟化、架构，中文说明", () => {
	const mac = (release: string, hv: boolean | null = true, arch = "arm64") => L.checkMac({ platform: "darwin", release, arch, hvSupport: hv });
	assert.equal(mac("22.1.0").ok, true); // macOS 13
	assert.equal(mac("25.0.0", null, "x64").ok, true);
	assert.match(mac("21.6.0").reason!, /macOS 13/);
	assert.match(mac("23.0.0", false).reason!, /虚拟化/);
	assert.match(mac("23.0.0", true, "ia32").reason!, /架构/);
	assert.equal(L.checkMac({ platform: "linux", release: "6.1", arch: "x64", hvSupport: null }).ok, false);
	const G = 1024 ** 3;
	assert.equal(L.diskShortfall(20 * G, 1 * G, false), null);
	assert.match(L.diskShortfall(5 * G, 1 * G, false)!, /磁盘空间不足.*9\.0 GB.*5\.0 GB/);
	assert.equal(L.diskShortfall(3 * G, 0, true), null);
});

test("LIMA_HOME：自己的目录；数据目录有空格或太长时用 ~/.pia-vm（ssh 套接字 104 字节限制）", () => {
	assert.equal(L.limaHome("/Users/d/Library/Application Support/Pi Assistant/vm", "/Users/d"), "/Users/d/.pia-vm");
	assert.equal(L.limaHome("/opt/pia/vm", "/Users/d"), "/opt/pia/vm/lima");
	assert.equal(L.limaHome(`/x/${"y".repeat(70)}/vm`, "/Users/d"), "/Users/d/.pia-vm");
	assert.notEqual(L.limaHome("/opt/pia/vm", "/Users/d"), "/Users/d/.lima");
	assert.ok(L.isOwnLimaHome("/Users/d/.pia-vm", "/opt/pia/vm", "/Users/d"));
	assert.ok(L.isOwnLimaHome("/opt/pia/vm/lima", "/opt/pia/vm", "/Users/d"));
	for (const h of ["/Users/d/.lima", "/Users/d", "/", "/opt/pia"]) assert.ok(!L.isOwnLimaHome(h, "/opt/pia/vm", "/Users/d"), h);
	// 环境里用户自己的 LIMA_* 变量不会传给我们的 limactl
	process.env.LIMA_INSTANCE = "default";
	const env = L.limaEnv();
	delete process.env.LIMA_INSTANCE;
	assert.equal(env.LIMA_INSTANCE, undefined);
	assert.equal(env.LIMA_HOME, L.limaHome());
});

test("limactl 硬性保护：只对 pia-desktop，只用我们下载的 limactl", () => {
	const ok = (a: string[]) => assert.doesNotThrow(() => L.assertLimaArgs(a), a.join(" "));
	const no = (a: string[]) => assert.throws(() => L.assertLimaArgs(a), /拒绝/, a.join(" "));
	ok(["list", "--json", "pia-desktop"]);
	ok(["start", "--tty=false", "--timeout=10m", "pia-desktop"]);
	ok(["stop", "pia-desktop"]);
	ok(["stop", "--force", "pia-desktop"]);
	ok(["delete", "--force", "pia-desktop"]);
	ok(["shell", "--workdir", "/", "pia-desktop", "sudo", "nerdctl", "ps"]);
	ok(["create", "--name=pia-desktop", "--tty=false", L.configPath()]);
	ok(["validate", L.configPath()]);
	no(["list", "--json"]);
	no(["stop", "default"]);
	no(["delete", "--force", "docker"]);
	no(["delete", "pia-desktop", "default"]);
	no(["shell", "default", "rm", "-rf", "/"]);
	no(["shell", "--workdir", "pia-desktop", "default"]);
	no(["create", "--name=default", L.configPath()]);
	no(["create", "--name=pia-desktop", "template://docker"]);
	no(["validate", "/tmp/evil.yaml"]);
	no(["prune"]);
	no(["factory-reset", "pia-desktop"]);
	no(["edit", "pia-desktop"]);
	assert.ok(L.limactlPath().startsWith(L.vmDir()) || !!process.env.PIA_LIMACTL);
	const cli = L.nerdctlCli();
	assert.equal(cli[0], "/usr/bin/env");
	assert.equal(cli[1], `LIMA_HOME=${L.limaHome()}`);
	assert.equal(cli[2], L.limactlPath());
	assert.deepEqual(cli.slice(3), ["shell", "--workdir", "/", "pia-desktop", "sudo", "nerdctl"]);
	assert.doesNotThrow(() => L.assertLimaArgs(cli.slice(3)));
});

test("limactl list 解析、nerdctl 拉取进度、ps 标签解析", () => {
	assert.equal(L.parseLimaList(""), "missing");
	assert.equal(L.parseLimaList('{"name":"pia-desktop","status":"Running"}\n'), "running");
	assert.equal(L.parseLimaList('time="x" level=warning msg="y"\n{"name":"pia-desktop","status":"Stopped"}'), "stopped");
	assert.equal(L.parseLimaList('{"name":"pia-desktop","status":"Broken"}'), "broken");
	assert.equal(L.parseLimaList('{"name":"default","status":"Running"}'), "missing");
	const layers = new Map<string, boolean>();
	parsePullLine(`layer-sha256:${"a".repeat(64)}:    downloading    |++++------| 1.0 MiB/3.0 MiB`, layers);
	parsePullLine(`layer-sha256:${"b".repeat(64)}:    done           |++++++++++|`, layers);
	parsePullLine(`layer-sha256:${"c".repeat(64)}:    exists         |++++++++++|`, layers);
	parsePullLine(`layer-sha256:${"b".repeat(64)}:    downloading    |+++++|`, layers); // 刷新行不会把已完成改回去
	assert.deepEqual([...layers.entries()], [["a".repeat(12), false], ["b".repeat(12), true], ["c".repeat(12), true]]);
	assert.deepEqual(labelValues("pia.agent=a1,org.x=y\nfoo=bar,pia.agent=b-2\n\nnothing=1", "pia.agent"), ["a1", "b-2"]);
	assert.deepEqual(labelValues("map[org.x:y pia.agent:a1]", "pia.agent"), ["a1"]);
});

test("后端选择：macOS 自动用 Lima，用户选 Docker 时用 Docker", () => {
	assert.equal(pickBackend("auto", "darwin").id, "lima");
	assert.equal(pickBackend("docker", "darwin").id, "docker");
	assert.equal(pickBackend("auto", "win32").id, "wsl"); // Windows 自带 WSL2 运行时
});

test("limaErr：常见错误转成中文", () => {
	assert.match(L.limaErr({ stderr: 'level=fatal msg="VZErrorDomain Code=2"' }), /虚拟化不可用/);
	assert.match(L.limaErr({ stderr: "write: no space left on device" }), /磁盘空间不足/);
	assert.match(L.limaErr(new Error("context deadline exceeded")), /超时/);
});

// ---------------------------------------------------------------- 断点续传下载
function serve(body: Buffer, opts: { dropAfter?: number; noRange?: boolean } = {}) {
	let hits = 0;
	const ranges: string[] = [];
	const srv = createServer((req, res) => {
		hits++;
		const r = req.headers.range;
		ranges.push(r ?? "");
		let start = 0;
		if (r && !opts.noRange) start = Number(/bytes=(\d+)-/.exec(r)![1]);
		const chunk = body.subarray(start);
		res.writeHead(start ? 206 : 200, { "content-length": chunk.length, ...(start ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
		if (opts.dropAfter && hits === 1) {
			res.write(chunk.subarray(0, opts.dropAfter));
			setTimeout(() => res.destroy(), 20);
		} else res.end(chunk);
	});
	return new Promise<{ url: string; close: () => void; hits: () => number; ranges: string[] }>((ok) => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/f`, close: () => srv.close(), hits: () => hits, ranges })));
}
const dir = mkdtempSync(join(tmpdir(), "pia-dl-"));
const body = Buffer.from(Uint8Array.from({ length: 300_000 }, (_, i) => i % 251));
const sha = (algo: string) => createHash(algo).update(body).digest("hex");

test("下载：断了接着下（Range），校验 sha512 后改名并记录 .ok", async () => {
	const s = await serve(body, { dropAfter: 100_000 });
	const dest = join(dir, "a.qcow2");
	const seen: number[] = [];
	await downloadFile({ urls: [s.url], dest, algo: "sha512", digest: sha("sha512"), size: body.length }, { bytes: (r) => seen.push(r), detail: () => {} });
	s.close();
	assert.deepEqual(readFileSync(dest), body);
	assert.equal(readFileSync(`${dest}.ok`, "utf8"), sha("sha512"));
	assert.ok(s.ranges.some((r) => /^bytes=\d+-$/.test(r) && r !== "bytes=0-"), `应续传：${s.ranges}`);
	assert.equal(Math.max(...seen), body.length);
	assert.ok(!existsSync(`${dest}.part`));
	// 再调一次：不发请求
	const again = await serve(body);
	await downloadFile({ urls: [again.url], dest, algo: "sha512", digest: sha("sha512"), size: body.length });
	again.close();
	assert.equal(again.hits(), 0);
});

test("下载：第一个源内容不对就换下一个源；全错时报错且不留下坏文件", async () => {
	const bad = await serve(Buffer.alloc(body.length, 1));
	const good = await serve(body);
	const dest = join(dir, "b.tgz");
	await downloadFile({ urls: [bad.url, good.url], dest, algo: "sha256", digest: sha("sha256"), size: body.length });
	assert.deepEqual(readFileSync(dest), body);
	const dest2 = join(dir, "c.tgz");
	await assert.rejects(downloadFile({ urls: [bad.url], dest: dest2, algo: "sha256", digest: sha("sha256"), size: body.length }), /校验失败/);
	assert.ok(!existsSync(dest2) && !existsSync(`${dest2}.part`));
	bad.close();
	good.close();
});

test("下载：服务器不支持续传时从头写；已有完整文件但没有 .ok 时只校验不下载", async () => {
	const s = await serve(body, { dropAfter: 50_000, noRange: true });
	const dest = join(dir, "d.bin");
	await downloadFile({ urls: [s.url], dest, algo: "sha256", digest: sha("sha256"), size: body.length });
	assert.deepEqual(readFileSync(dest), body);
	s.close();
	const dest2 = join(dir, "e.bin");
	writeFileSync(dest2, body);
	await downloadFile({ urls: ["http://127.0.0.1:1/never"], dest: dest2, algo: "sha256", digest: sha("sha256") });
	assert.equal(readFileSync(`${dest2}.ok`, "utf8"), sha("sha256"));
});

// macOS CI：真下载我们固定的 limactl（校验 SHA256），对生成的配置跑 `limactl validate`
test("macOS：真实 limactl 校验生成的配置", { skip: process.platform !== "darwin" || process.env.PIA_LIMA_REAL !== "1" }, async () => {
	const files = L.vmFiles();
	const lima = files[0];
	await downloadFile(lima);
	const out = mkdtempSync(join(tmpdir(), "pia-lima-"));
	execFileSync("/usr/bin/tar", ["xzf", lima.dest, "-C", out]);
	const limactl = join(out, "bin", "limactl");
	const ver = execFileSync(limactl, ["--version"], { encoding: "utf8" });
	assert.match(ver, /2\.2\.1/);
	const { mkdirSync } = await import("node:fs");
	mkdirSync(L.vmDir(), { recursive: true });
	// validate 会检查 images/archives 的本地路径格式，不要求文件存在
	writeFileSync(L.configPath(), L.currentConfig());
	execFileSync(limactl, ["validate", L.configPath()], { env: { ...process.env, LIMA_HOME: mkdtempSync(join(tmpdir(), "lh-")) }, stdio: "inherit" });
});
