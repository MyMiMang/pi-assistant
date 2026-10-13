/**
 * Lima 后端集成测试（Linux 上跑）：假 limactl（test/fixtures/fake-limactl.sh）模拟实例的创建 / 开机 / 关机 / 删除，
 * 虚拟机里的 `sudo nerdctl` 转给本机真实 Docker，所以桌面容器、端口、家目录卷、硬性保护都是真的。
 * 覆盖：第一次开机建虚拟机、开机后同轮可用、虚拟机没响应自动重启、所有桌面停了关虚拟机、
 * 宿主端口被占时换端口重建（家目录保留）、开机失败中文报错、删除虚拟机和镜像。
 * 需要 Docker 和本地镜像 pi-assistant/desktop:dev（没有就跳过）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pia-limahome-"));
process.env.PIA_TEST_LIMA = "1";
process.env.PIA_LIMACTL = join(import.meta.dirname, "fixtures", "fake-limactl.sh");
process.env.PIA_LIMA_HOME = home;
// 用一个一次性的标签（删除流程会删镜像，不能碰其他开发者在用的 pi-assistant/desktop:dev）
const TEST_IMAGE = `pia-limatest/desktop:${process.pid}`;
try {
	execFileSync("docker", ["tag", "pi-assistant/desktop:dev", TEST_IMAGE], { stdio: "ignore" });
} catch {}
process.env.PIA_DESKTOP_IMAGE = TEST_IMAGE;
await import("./setup.ts");
import assert from "node:assert/strict";
const { test } = await import("node:test");

let haveDocker = false;
try {
	execFileSync("docker", ["image", "inspect", TEST_IMAGE], { stdio: "ignore" });
	haveDocker = true;
} catch {}

const L = await import("../src/desktop/lima.ts");
const D = await import("../src/desktop.ts");
const { updateDesktopSettings, setSeparate, localImage } = await import("../src/desktop/settings.ts");
const { backend } = await import("../src/desktop/backend.ts");

const AG = `limait${process.pid}`;
process.env.FAKE_LIMA_PS_NAME = `pia-desk-${AG}`;
const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8") : "");
const status = () => readFileSync(join(home, "pia-desktop", "status"), "utf8").trim();
const dk = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8" }).trim();

test("Lima 后端：完整生命周期（假 limactl + 真 Docker）", { skip: !haveDocker && "没有 Docker 或 pi-assistant/desktop:dev 镜像", timeout: 240_000 }, async () => {
	// 已下载好的虚拟机组件（内容不重要，.ok 记录摘要 = 已校验）
	for (const f of L.vmFiles()) {
		mkdirSync(join(f.dest, ".."), { recursive: true });
		writeFileSync(f.dest, "x");
		writeFileSync(`${f.dest}.ok`, f.digest);
	}
	updateDesktopSettings({ enabled: true, idleMinutes: 5 });
	// 这里测的是“每个助理一台电脑”的后端生命周期：两个助理都选“单独的电脑”（共用电脑见 shared-computer.test.ts）
	setSeparate(AG, true);
	assert.equal(backend().id, "lima");
	assert.equal(await L.vmState(), "missing");
	L.markImage(localImage());
	D.resetAvailability();

	// 虚拟机关机：状态查询不开机
	let st = await D.desktopStatus(AG);
	assert.equal(st.available, true, st.reason ?? "");
	assert.equal(st.state, "stopped");
	assert.equal(st.vm?.running, false);
	assert.ok(!/^(create|start)/m.test(calls()), "查询状态不应开机");

	// 第一次开机：建虚拟机 → 开机 → 桌面容器 → 端口在宿主上能连
	st = await D.startDesktop(AG);
	assert.equal(st.state, "running");
	assert.ok(st.port && st.cdpPort);
	assert.ok(await D.reachable(st.port!));
	assert.match(calls(), /^create --name=pia-desktop --tty=false .*pia-desktop\.yaml$/m);
	assert.match(calls(), /^start --tty=false --timeout=10m pia-desktop$/m);
	assert.equal(status(), "Running");
	assert.equal(readFileSync(join(home, "pia-desktop", "lima.yaml"), "utf8"), L.currentConfig());
	assert.equal(L.vmPhase().phase, "running");
	assert.ok((await D.runningDesktops()).includes(AG));
	dk("exec", `pia-desk-${AG}`, "sh", "-c", "echo keep > /home/agent/keep.txt");

	// 所有桌面都停了：关掉虚拟机
	await D.stopDesktop(AG);
	assert.equal(status(), "Stopped");
	assert.equal((await D.desktopStatus(AG)).state, "stopped");
	assert.deepEqual(await D.runningDesktops(), []);

	// 上次的宿主端口被 Mac 上别的程序占了：换端口重建，家目录还在
	const oldPort = st.port!;
	const blocker = createServer().listen(oldPort, "127.0.0.1");
	await new Promise((r) => blocker.once("listening", r));
	st = await D.startDesktop(AG);
	blocker.close();
	assert.equal(st.state, "running");
	assert.notEqual(st.port, oldPort);
	assert.equal(dk("exec", `pia-desk-${AG}`, "cat", "/home/agent/keep.txt"), "keep");

	// 睡眠唤醒后虚拟机里引擎没响应：强制重启虚拟机
	writeFileSync(join(home, "unhealthy-once"), "");
	writeFileSync(join(home, "calls.log"), "");
	await L.ensureVm();
	assert.match(calls(), /^stop --force pia-desktop$/m);
	assert.match(calls(), /^start --tty=false/m);
	assert.ok(!/^create/m.test(calls()), "已有虚拟机不应重建");

	// 开机失败：中文原因
	await D.stopDesktop(AG);
	writeFileSync(join(home, "fail-start"), "");
	await assert.rejects(D.startDesktop(AG), /虚拟化不可用/);
	assert.equal(L.vmPhase().phase, "error");
	execFileSync("rm", ["-f", join(home, "fail-start")]);

	// 关掉开关 → 关机 + 删除虚拟机：实例和下载文件都清掉。
	// （purgeAll 会删虚拟机里所有 pia-desk-* / pia-home-*；这台测试机的 Docker 是共用的，所以这里只删自己的容器和卷，再测删除虚拟机）
	updateDesktopSettings({ enabled: false });
	await D.shutdownAll();
	assert.equal(status(), "Stopped");
	dk("rm", "-f", `pia-desk-${AG}`);
	dk("volume", "rm", `pia-home-${AG}`);
	dk("image", "rm", TEST_IMAGE);
	await backend().destroyEngine();
	assert.ok(!existsSync(home), "我们自己的 LIMA_HOME 整个删掉");
	assert.ok(!existsSync(join(home, "pia-desktop")));
	assert.ok(!existsSync(L.vmDir()));
});

const { after } = await import("node:test");
after(() => {
	for (const a of [["rm", "-f", `pia-desk-${AG}`], ["volume", "rm", `pia-home-${AG}`], ["image", "rm", TEST_IMAGE]])
		try {
			execFileSync("docker", a, { stdio: "ignore" });
		} catch {}
});
