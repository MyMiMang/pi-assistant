/** Windows 自带运行时（WSL2，DESIGN §15.2 第 3 步）：清单、环境检测、错误归类、wsl.exe 硬性保护、提权命令、host 网络参数 */
import "./setup.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import * as W from "../src/desktop/wsl.ts";
import { hostNetArgs, pickDisplay, READY_PROBE, desktopChromiumArgs } from "../src/desktop.ts";
import { pickBackend } from "../src/desktop/backend.ts";
import { assertOwnTarget, isOwnWslDistro } from "../src/desktop/names.ts";

const ctx = { home: "/data/wsl", tarball: () => "/data/wsl/files/rootfs.tar.gz" };
const D = W.WSL_DISTRO;

test("清单：pia-wsl-rootfs 两个架构都固定了 SHA256 和大小，下载地址指向我们的 Release", () => {
	const m = W.rootfsManifest();
	assert.equal(m.repo, "MyMiMang/pi-assistant");
	assert.equal(m.tagPrefix, "wsl-rootfs-v");
	for (const k of ["win-x64", "win-arm64"]) {
		assert.match(m.assets[k].sha256, /^[a-f0-9]{64}$/, `${k} 的 SHA256 还没填`);
		assert.ok(m.assets[k].size > 3e7 && m.assets[k].size < 5e8);
	}
	const f = W.rootfsFile("x64", "", "");
	assert.deepEqual(f.urls, [
		`https://ghcr.io/v2/mymimang/pi-assistant-desktop/blobs/sha256:${m.assets["win-x64"].sha256}`,
		`https://github.com/MyMiMang/pi-assistant/releases/download/wsl-rootfs-v${m.version}/pia-wsl-rootfs-${m.version}-amd64.tar.gz`,
	]);
	assert.equal(f.algo, "sha256");
	assert.equal(f.digest, m.assets["win-x64"].sha256, "GHCR blob 摘要就是压缩包 SHA256（内容寻址）");
	const g = W.rootfsFile("arm64", "https://ghfast.top/", "ghcr.nju.edu.cn");
	assert.equal(g.urls.length, 4);
	assert.ok(g.urls[0].startsWith("https://ghcr.nju.edu.cn/v2/mymimang/pi-assistant-desktop/blobs/sha256:"), "镜像加速地址优先");
	assert.ok(g.urls[2].startsWith("https://ghfast.top/https://github.com/"), "GitHub 加速前缀在官方 Release 之前");
	assert.match(g.urls[3], /arm64\.tar\.gz$/);
	assert.throws(() => W.wslArchKey("ia32"), /不支持/);
});

test("镜像仓库 blob 下载：401 → 按 WWW-Authenticate 匿名换 token → 带 token 下载，断点续传（Range）照常可用", async () => {
	const { createServer } = await import("node:http");
	const { createHash } = await import("node:crypto");
	const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { downloadFile } = await import("../src/downloads.ts");
	const body = Buffer.alloc(300_000, 7);
	const sha = createHash("sha256").update(body).digest("hex");
	let tokenCalls = 0;
	const ranges: string[] = [];
	const srv = createServer((req, res) => {
		if (req.url!.startsWith("/token")) {
			tokenCalls++;
			assert.match(req.url!, /scope=repository%3Amymimang%2Fpi-assistant-desktop%3Apull/);
			return res.end(JSON.stringify({ token: "anon-tok" }));
		}
		if (req.headers.authorization !== "Bearer anon-tok") {
			res.writeHead(401, { "www-authenticate": `Bearer realm="http://127.0.0.1:${(srv.address() as { port: number }).port}/token",service="ghcr.io",scope="repository:mymimang/pi-assistant-desktop:pull"` });
			return res.end();
		}
		const r = /bytes=(\d+)-/.exec(req.headers.range ?? "");
		ranges.push(req.headers.range ?? "");
		const from = r ? Number(r[1]) : 0;
		res.writeHead(r ? 206 : 200, { "content-length": body.length - from });
		res.end(body.subarray(from));
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	const dir = mkdtempSync(join(tmpdir(), "pia-blob-"));
	const dest = join(dir, "r.tar.gz");
	writeFileSync(`${dest}.part`, body.subarray(0, 100_000)); // 上次下了一部分
	const url = `http://127.0.0.1:${port}/v2/mymimang/pi-assistant-desktop/blobs/sha256:${sha}`;
	await downloadFile({ urls: [url], dest, algo: "sha256", digest: sha, size: body.length }, undefined, { fetchImpl: W.registryFetch() });
	srv.close();
	assert.equal(tokenCalls, 1);
	assert.deepEqual(ranges, ["bytes=100000-"], "带 token 的请求从断点续传");
	assert.ok(readFileSync(dest).equals(body));
	assert.deepEqual(W.parseBearer('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"'), { realm: "https://ghcr.io/token", service: "ghcr.io", scope: "repository:a/b:pull" });
	assert.equal(W.parseBearer("Basic realm=x"), null);
});

test("目录：发行版放在 %LOCALAPPDATA%（不进漫游配置文件），只删除我们自己的目录", () => {
	assert.equal(W.wslHome({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "/x"), join("C:\\Users\\a\\AppData\\Local", "Pi Assistant", "wsl"));
	assert.equal(W.wslHome({}, "/data"), join("/data", "vm", "wsl"));
	assert.ok(W.isOwnWslHome(join("/data", "vm", "wsl"), {}, "/data"));
	assert.ok(!W.isOwnWslHome("/data", {}, "/data"));
	assert.ok(!W.isOwnWslHome("/home/u", { LOCALAPPDATA: "/home/u" }, "/data"));
	assert.ok(W.wslExe({ SystemRoot: "C:\\Windows" }).endsWith(join("System32", "wsl.exe")), "只用系统目录里的 wsl.exe（绝对路径）");
});

test("环境检测：Windows 10 2004（19041）起支持，家庭版也行；老系统 / 非 Windows 给中文原因", () => {
	assert.deepEqual(W.checkWindows({ platform: "win32", release: "10.0.19045", arch: "x64" }), { ok: true });
	assert.deepEqual(W.checkWindows({ platform: "win32", release: "10.0.26100", arch: "arm64" }), { ok: true });
	assert.match(W.checkWindows({ platform: "win32", release: "10.0.18363", arch: "x64" }).reason!, /19041/);
	assert.match(W.checkWindows({ platform: "win32", release: "10.0.22631", arch: "ia32" }).reason!, /架构/);
	assert.equal(W.checkWindows({ platform: "linux", release: "6.1", arch: "x64" }).ok, false);
});

test("wsl.exe 输出：UTF-16 / UTF-8 都能解码，发行版列表解析", () => {
	const text = "  NAME                   STATE           VERSION\r\n* Ubuntu                 Running         2\r\n  PiAssistant-Desktop    Stopped         2\r\n";
	assert.equal(W.decodeWsl(Buffer.from(text, "utf16le")), text);
	assert.equal(W.decodeWsl(Buffer.from(text, "utf8")), text);
	assert.deepEqual(W.parseWslList(text), { state: "stopped", version: 2 });
	assert.equal(W.parseWslList(text.replace("Stopped ", "Running ")).state, "running");
	assert.equal(W.parseWslList("* PiAssistant-Desktop    Installing    2").state, "installing");
	assert.equal(W.parseWslList("Windows Subsystem for Linux has no installed distributions.").state, "missing");
	// 用户自己的发行版名字里包含我们的名字也不会误认
	assert.equal(W.parseWslList("  PiAssistant-Desktop-old  Running  2").state, "missing");
});

test("WSL 状态归类：没装 / 要重启 / BIOS 没开虚拟化 / 版本太旧", () => {
	assert.equal(W.classifyWsl("Default Version: 2", 0).health, "ok");
	assert.equal(W.classifyWsl("The Windows Subsystem for Linux is not installed.", 1).health, "missing");
	assert.equal(W.classifyWsl("Error code: Wsl/Service/RegisterDistro/0x80370114", 1).health, "reboot");
	assert.equal(W.classifyWsl("WslRegisterDistribution failed with error: 0x8007019e", 1).health, "reboot");
	const v = W.classifyWsl("Please enable virtualization in BIOS. Error code: 0x80370102", 1);
	assert.equal(v.health, "virtualization");
	assert.match(v.reason!, /BIOS/);
	assert.equal(W.classifyWsl("Invalid command line option: --no-distribution", 1).health, "update");
	assert.equal(W.classifyWsl("something odd", 5).health, "unknown");
});

test("装完 WSL 没重启：安装时间晚于本次开机时间 → 提示重启", () => {
	const now = 1_000_000_000;
	assert.equal(W.rebootPending({ at: now - 60_000, ok: true }, now, 3600), true, "开机 1 小时，1 分钟前装的");
	assert.equal(W.rebootPending({ at: now - 7200_000, ok: true }, now, 3600), false, "装完后已经重启过");
	assert.equal(W.rebootPending({ at: now - 60_000, ok: false }, now, 3600), false);
	assert.equal(W.rebootPending(null, now, 3600), false);
});

test("硬性保护：wsl.exe 只对 PiAssistant-Desktop，拒绝 --shutdown / 用户的发行版 / 非我们的目录和压缩包", () => {
	const ok = (a: string[]) => assert.doesNotThrow(() => W.assertWslArgs(a, ctx), a.join(" "));
	const no = (a: string[]) => assert.throws(() => W.assertWslArgs(a, ctx), /拒绝/, a.join(" "));
	ok(["--status"]);
	ok(["--list", "--verbose"]);
	ok(["--install", "--no-distribution"]);
	ok(["--import", D, "/data/wsl/PiAssistant-Desktop", "/data/wsl/files/rootfs.tar.gz", "--version", "2"]);
	ok(["--terminate", D]);
	ok(["--unregister", D]);
	ok(["-d", D, "-u", "root", "--cd", "/", "--exec", "nerdctl", "ps"]);
	ok(["-d", D, "-u", "root", "--exec", "/usr/local/bin/pia-engine"]);
	no(["--shutdown"]);
	no(["--unregister", "Ubuntu"]);
	no(["--terminate", "docker-desktop"]);
	no(["--unregister", "PiAssistant-Other"]);
	no(["--set-default", D]);
	no(["--install", "Ubuntu"]);
	no(["--import", "Ubuntu", "/data/wsl/PiAssistant-Desktop", "/data/wsl/files/rootfs.tar.gz", "--version", "2"]);
	no(["--import", D, "C:\\Users\\a\\elsewhere", "/data/wsl/files/rootfs.tar.gz", "--version", "2"]);
	no(["--import", D, "/data/wsl/PiAssistant-Desktop", "/tmp/evil.tar", "--version", "2"]);
	no(["-d", "Ubuntu", "-u", "root", "--exec", "rm", "-rf", "/"]);
	no(["-d", D, "--exec", "nerdctl"]); // 必须 -u root（固定形态）
	no(["-d", D, "-u", "root", "--cd", "/mnt/c", "--exec", "ls"]);
	no(["-d", D, "-u", "root", "bash", "-c", "x"]); // 必须 --exec（不经过 shell）
	no(["--mount", "\\\\.\\PHYSICALDRIVE0"]);
	assert.ok(isOwnWslDistro(D));
	assert.ok(!isOwnWslDistro("Ubuntu-22.04"));
	// nerdctl 命令前缀本身也过了保护
	assert.deepEqual(W.nerdctlCli().slice(1), ["-d", D, "-u", "root", "--cd", "/", "--exec", "nerdctl"]);
});

test("安装 WSL：PowerShell 一次 UAC 提权执行 wsl --install --no-distribution（不装任何发行版）", () => {
	const c = W.elevationCommand("C:\\Windows\\System32\\wsl.exe");
	assert.match(c.command, /powershell\.exe$/i);
	const script = c.args[c.args.length - 1];
	assert.match(script, /Start-Process -FilePath 'C:\\Windows\\System32\\wsl\.exe' -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait -PassThru/);
	assert.match(script, /exit 1223/, "用户取消 UAC 时返回 1223");
	assert.ok(c.args.includes("-NoProfile"));
	// 路径里有单引号也不会破坏脚本
	assert.match(W.elevationCommand("C:\\a'b\\wsl.exe").args.at(-1)!, /'C:\\a''b\\wsl\.exe'/);
});

test("磁盘空间：不够时给中文说明", () => {
	assert.equal(W.diskShortfall(20e9, 1e8, false), null);
	assert.match(W.diskShortfall(3e9, 1e8, false)!, /磁盘空间不足/);
	assert.equal(W.diskShortfall(3e9, 0, true), null);
});

test("后端选择：Windows 的自带运行时就是 WSL；选 Docker 时用已装的 Docker", () => {
	assert.equal(pickBackend("auto", "win32").id, "wsl");
	assert.equal(pickBackend("docker", "win32").id, "docker");
	assert.equal(pickBackend("auto", "win32").hostNetwork, true);
});

test("host 网络：每个桌面独立的端口 + 显示器编号经环境变量传给 start.sh，只监听 127.0.0.1，端口记在标签里", () => {
	const a = hostNetArgs({ novnc: 41001, cdpProxy: 41002, vnc: 41003, cdp: 41004, display: 12 });
	assert.deepEqual(a.slice(0, 2), ["--network", "host"]);
	const env = Object.fromEntries(a.flatMap((x, i) => (a[i - 1] === "-e" ? [x.split("=")] : [])));
	assert.deepEqual(env, { DISPLAY_NUM: "12", DISPLAY: ":12", NOVNC_PORT: "41001", CDP_PROXY_PORT: "41002", VNC_PORT: "41003", CDP_PORT: "41004", BIND_ADDR: "127.0.0.1" });
	assert.ok(a.includes("pia.ports=6080:41001,9223:41002,5900:41003,9222:41004"));
	assert.ok(a.includes("pia.display=12"));
	assert.equal(pickDisplay(new Set()), 10);
	assert.equal(pickDisplay(new Set([10, 11, 13])), 12);
	// 引擎命令保护照样放行（host 网络的 run 仍然必须是我们的名字 + 标签）
	assert.doesNotThrow(() => assertOwnTarget(["run", "-d", "--name", "pia-desk-a", ...a, "--label", "pia.agent=a", "img"], ["img"]));
	assert.match(READY_PROBE, /\$\{NOVNC_PORT:-6080\}/);
	assert.match(READY_PROBE, /DISPLAY_NUM:-1/);
	assert.ok(desktopChromiumArgs(41004).includes("--remote-debugging-port=41004"));
	assert.ok(desktopChromiumArgs().includes("--remote-debugging-port=9222"));
});
