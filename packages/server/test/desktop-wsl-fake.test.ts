/**
 * WSL 后端集成测试（Linux 上跑）：假 wsl.exe（test/fixtures/fake-wsl.sh）模拟发行版的导入 / 启动 / 关闭 / 注销，
 * `--exec nerdctl …` 转给本机真实 Docker，所以桌面容器、host 网络、每个助理独立端口与显示器编号、家目录卷、硬性保护都是真的。
 * PIA_WSL_REAL_ROOTFS=<rootfs.tar.gz> + PIA_WSL_VARLIB=<ext4 目录>：改为用我们构建的 rootfs 模拟发行版（真实 containerd + nerdctl + pia-engine）。
 * 覆盖：WSL 没装 / 要重启的提示、第一次导入发行版、两个助理同时开（端口和显示器错开）、所有桌面停了关发行版、
 * 端口被占时换端口重建（家目录保留）、导入失败中文报错、删除发行版。需要 Docker 和本地镜像 pi-assistant/desktop:dev（没有就跳过）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pia-wslhome-"));
process.env.PIA_TEST_WSL = "1";
process.env.PIA_WSL_EXE = join(import.meta.dirname, "fixtures", "fake-wsl.sh");
process.env.PIA_WSL_HOME = home;
const REAL = process.env.PIA_WSL_REAL_ROOTFS;
const TEST_IMAGE = `pia-wsltest/desktop:${process.pid}`;
try {
	execFileSync("docker", ["tag", "pi-assistant/desktop:dev", TEST_IMAGE], { stdio: "ignore" });
} catch {}
process.env.PIA_DESKTOP_IMAGE = TEST_IMAGE;
if (REAL) {
	process.env.FAKE_WSL_CT = `pia-wslsim-${process.pid}`;
	process.env.FAKE_WSL_IMAGE = `pia-wslsim/rootfs:${process.pid}`;
	process.env.FAKE_WSL_VARLIB = join(process.env.PIA_WSL_VARLIB ?? "/mnt/pia-wsl", `varlib-${process.pid}`);
	execFileSync("docker", ["import", REAL, process.env.FAKE_WSL_IMAGE], { stdio: "ignore" });
	execFileSync("sudo", ["mkdir", "-p", process.env.FAKE_WSL_VARLIB]);
}
await import("./setup.ts");
import assert from "node:assert/strict";
const { test, after } = await import("node:test");

let haveDocker = false;
try {
	execFileSync("docker", ["image", "inspect", TEST_IMAGE], { stdio: "ignore" });
	haveDocker = true;
} catch {}

const W = await import("../src/desktop/wsl.ts");
const D = await import("../src/desktop.ts");
const { updateDesktopSettings, setSeparate, localImage } = await import("../src/desktop/settings.ts");
const { backend } = await import("../src/desktop/backend.ts");

const A1 = `wslit${process.pid}a`;
const A2 = `wslit${process.pid}b`;
process.env.FAKE_WSL_PS_NAME = `pia-desk-wslit${process.pid}`;
const F = join(home, "fake");
const calls = () => (existsSync(join(F, "calls.log")) ? readFileSync(join(F, "calls.log"), "utf8") : "");
/** 在“发行版”里执行 nerdctl（默认模式 = 本机 docker） */
const nd = (...a: string[]) => execFileSync(process.env.PIA_WSL_EXE!, ["-d", W.WSL_DISTRO, "-u", "root", "--exec", "nerdctl", ...a], { encoding: "utf8", env: { ...process.env } }).trim();

test("WSL 后端：没装 WSL / 装完要重启 → 中文提示 + 修复按钮", { timeout: 30_000 }, async () => {
	mkdirSync(F, { recursive: true });
	writeFileSync(join(F, "status-out"), "The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.");
	writeFileSync(join(F, "status-rc"), "1");
	W._resetWslProbe();
	let d = await W.detectWsl();
	assert.equal(d.ok, false);
	assert.equal(d.fix, "install-wsl");
	assert.match(d.reason!, /还没有安装 WSL/);
	writeFileSync(join(F, "status-out"), "Error code: Wsl/0x80370102 Please enable virtualization in BIOS");
	W._resetWslProbe();
	d = await W.detectWsl();
	assert.match(d.reason!, /虚拟化/);
	assert.equal(d.fix, undefined, "BIOS 的问题我们修不了，不显示安装按钮");
	writeFileSync(join(F, "status-out"), "Default Version: 2");
	writeFileSync(join(F, "status-rc"), "0");
	W._resetWslProbe();
	assert.deepEqual(await W.detectWsl(), { ok: true });
});

test("WSL 后端：完整生命周期（假 wsl.exe + 真容器引擎）", { skip: !haveDocker && "没有 Docker 或 pi-assistant/desktop:dev 镜像", timeout: 600_000 }, async () => {
	// 已下载好的 rootfs（默认模式内容不重要，.ok 记录摘要 = 已校验；真实模式用真的 rootfs）
	const f = W.rootfsFile();
	mkdirSync(join(f.dest, ".."), { recursive: true });
	writeFileSync(f.dest, REAL ? readFileSync(REAL) : "x");
	writeFileSync(`${f.dest}.ok`, f.digest);
	updateDesktopSettings({ enabled: true, idleMinutes: 5 });
	// 这里测的是“每个助理一台电脑”的后端生命周期：两个助理都选“单独的电脑”（共用电脑见 shared-computer.test.ts）
	setSeparate(A1, true);
	setSeparate(A2, true);
	assert.equal(backend().id, "wsl");
	assert.equal(await W.distroState(), "missing");
	if (REAL) {
		// 真实 rootfs：先导入并把测试镜像装进发行版里的 containerd
		await W.ensureWsl();
		execFileSync("bash", ["-c", `docker save ${TEST_IMAGE} | docker exec -i ${process.env.FAKE_WSL_CT} nerdctl load`], { stdio: "ignore", maxBuffer: 1 << 30 });
		await W.stopWsl();
	}
	W.markImage(localImage());
	D.resetAvailability();

	// 发行版关着：状态查询不开机
	writeFileSync(join(F, "calls.log"), "");
	let st = await D.desktopStatus(A1);
	assert.equal(st.available, true, st.reason ?? "");
	assert.equal(st.state, "stopped");
	assert.equal(st.vm?.running, false);
	assert.ok(!/pia-engine|--import/.test(calls()), "查询状态不应开机");

	// 第一次开机：（导入发行版）→ 拉起引擎守护进程 → 桌面容器（host 网络）→ 端口在宿主 127.0.0.1 上能连
	st = await D.startDesktop(A1);
	assert.equal(st.state, "running");
	assert.ok(st.port && st.cdpPort);
	assert.ok(await D.reachable(st.port!));
	if (!REAL) assert.match(calls(), /^--import PiAssistant-Desktop .*PiAssistant-Desktop .*\.tar\.gz --version 2$/m);
	assert.match(calls(), /^-d PiAssistant-Desktop -u root --cd \/ --exec \/usr\/local\/bin\/pia-engine$/m);
	assert.ok(W.importedInfo(), "记下导入的版本");
	assert.equal(W.wslPhase().phase, "running");
	const ins = JSON.parse(nd("inspect", "-f", "{{json .Config.Labels}}", `pia-desk-${A1}`));
	assert.match(ins["pia.ports"], /^6080:\d+,9223:\d+,5900:\d+,9222:\d+$/);
	assert.equal(nd("exec", `pia-desk-${A1}`, "sh", "-c", "echo $DISPLAY $BIND_ADDR"), `:${ins["pia.display"]} 127.0.0.1`);
	nd("exec", `pia-desk-${A1}`, "sh", "-c", "echo keep > /home/agent/keep.txt");

	// 第二个助理：同一个发行版，端口和显示器编号都错开，两个都能用
	const st2 = await D.startDesktop(A2);
	assert.equal(st2.state, "running");
	assert.notEqual(st2.port, st.port);
	const ins2 = JSON.parse(nd("inspect", "-f", "{{json .Config.Labels}}", `pia-desk-${A2}`));
	assert.notEqual(ins2["pia.display"], ins["pia.display"]);
	assert.ok(await D.reachable(st.port!));
	assert.ok(await D.reachable(st2.port!));
	const png = await D.screenshotDesktop(A2);
	assert.ok(png.length > 5000, "第二个桌面的截图不是空白");
	assert.equal(png.subarray(1, 4).toString(), "PNG");
	// 浏览器（Chromium 调试端口也是每个桌面独立的）
	const cdp = await D.ensureDesktopBrowser(A2);
	const ver = (await (await fetch(`${cdp}/json/version`)).json()) as { Browser?: string };
	assert.match(ver.Browser ?? "", /Chrom/);
	assert.deepEqual((await D.runningDesktops()).sort(), [A1, A2].sort());

	// 所有桌面都停了：关掉发行版
	writeFileSync(join(F, "calls.log"), "");
	await D.stopDesktop(A1);
	assert.ok(!/--terminate/.test(calls()), "还有桌面在跑，不关发行版");
	await D.stopDesktop(A2);
	assert.match(calls(), /^--terminate PiAssistant-Desktop$/m);
	assert.equal(await W.distroState(), "stopped");
	assert.equal((await D.desktopStatus(A1)).state, "stopped");

	// 上次的端口被 Windows 上别的程序占了：换端口重建，家目录还在，发行版不重新导入
	writeFileSync(join(F, "calls.log"), "");
	const oldPort = st.port!;
	const blocker = createServer().listen(oldPort, "127.0.0.1");
	await new Promise((r) => blocker.once("listening", r));
	st = await D.startDesktop(A1);
	blocker.close();
	assert.equal(st.state, "running");
	assert.notEqual(st.port, oldPort);
	assert.equal(nd("exec", `pia-desk-${A1}`, "cat", "/home/agent/keep.txt"), "keep");
	assert.ok(!/--import/.test(calls()), "已导入的发行版不重新导入");
	await D.stopDesktop(A1);

	// 删除：注销发行版 + 删目录（默认模式下这台机器的 Docker 是共用的，只删自己的容器和卷）
	updateDesktopSettings({ enabled: false });
	await D.shutdownAll();
	for (const a of [A1, A2]) {
		try {
			nd("rm", "-f", `pia-desk-${a}`);
			nd("volume", "rm", `pia-home-${a}`);
		} catch {}
	}
	await backend().destroyEngine();
	assert.ok(!existsSync(home), "我们自己的 WSL 目录整个删掉");
	mkdirSync(F, { recursive: true });
	assert.equal(await W.distroState(), "missing", "发行版已注销");
});

test("WSL 后端：导入失败给中文原因", { skip: !haveDocker && "没有 Docker", timeout: 60_000 }, async () => {
	mkdirSync(F, { recursive: true });
	const f = W.rootfsFile();
	mkdirSync(join(f.dest, ".."), { recursive: true });
	writeFileSync(f.dest, "x");
	writeFileSync(`${f.dest}.ok`, f.digest);
	writeFileSync(join(F, "fail-import"), "");
	W._resetWslProbe();
	await assert.rejects(W.ensureWsl(), /重启电脑|安装 WSL/);
	assert.equal(W.wslPhase().phase, "error");
	rmSync(home, { recursive: true, force: true });
});

after(() => {
	for (const a of [["rm", "-f", `pia-desk-${A1}`, `pia-desk-${A2}`], ["volume", "rm", `pia-home-${A1}`, `pia-home-${A2}`], ["image", "rm", TEST_IMAGE]])
		try {
			execFileSync("docker", a, { stdio: "ignore" });
		} catch {}
	if (REAL) {
		for (const a of [["rm", "-f", process.env.FAKE_WSL_CT!], ["image", "rm", process.env.FAKE_WSL_IMAGE!]])
			try {
				execFileSync("docker", a, { stdio: "ignore" });
			} catch {}
		try {
			execFileSync("sudo", ["rm", "-rf", process.env.FAKE_WSL_VARLIB!]);
		} catch {}
	}
});
