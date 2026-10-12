/**
 * 只在 Windows 上跑（CI windows-latest）：真实 wsl.exe 的探测与错误归类、真实下载并校验发布的 rootfs、Windows 路径下的硬性保护。
 * 托管 Windows 运行器通常没有嵌套虚拟化（WSL2 起不来）：探测结果只要求是我们能解释的状态；
 * 如果运行器的 WSL2 真的可用（PIA_WSL_TRY_IMPORT=1），再真实 --import / 启动 containerd / --unregister 一遍。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { downloadFile } from "../src/downloads.ts";
import * as W from "../src/desktop/wsl.ts";

const win = process.platform === "win32";

test("Windows：wsl.exe 在系统目录，探测结果可解释（不抛异常、不改动任何发行版）", { skip: !win && "只在 Windows 上跑" }, async () => {
	assert.ok(W.wslExe().toLowerCase().endsWith("\\system32\\wsl.exe"));
	const r = await W.probeWsl(true);
	console.log(`[wsl] wsl.exe 存在=${existsSync(W.wslExe())} 探测=${JSON.stringify(r)}`);
	assert.ok(["ok", "missing", "reboot", "virtualization", "update", "unknown"].includes(r.health));
	if (r.health !== "ok") assert.ok(r.reason && /[\u4e00-\u9fa5]/.test(r.reason), "不可用时给中文原因");
	const d = await W.detectWsl();
	assert.equal(d.ok, r.health === "ok");
	// 列表只读
	const st = await W.distroState();
	assert.ok(["missing", "stopped", "running", "installing"].includes(st));
});

test("Windows：路径里有空格 / 中文的数据目录也能通过保护校验；用户发行版一律拒绝", { skip: !win && "只在 Windows 上跑" }, () => {
	const home = "C:\\Users\\张 三\\AppData\\Local\\Pi Assistant\\wsl";
	const ctx = { home, tarball: () => join(home, "files", "r.tar.gz") };
	assert.doesNotThrow(() => W.assertWslArgs(["--import", W.WSL_DISTRO, join(home, W.WSL_DISTRO), join(home, "files", "r.tar.gz"), "--version", "2"], ctx));
	assert.throws(() => W.assertWslArgs(["--unregister", "Ubuntu"], ctx), /拒绝/);
	assert.throws(() => W.assertWslArgs(["--shutdown"], ctx), /拒绝/);
	assert.ok(W.isOwnWslHome(join(process.env.LOCALAPPDATA!, "Pi Assistant", "wsl")));
	assert.ok(!W.isOwnWslHome(process.env.LOCALAPPDATA!));
	const c = W.elevationCommand();
	assert.ok(existsSync(c.command), `PowerShell 在 ${c.command}`);
});

test("Windows：真实下载发布的 rootfs 并按固定 SHA256 校验（断点续传）", { skip: (!win || process.env.PIA_WSL_REAL_DOWNLOAD !== "1") && "设置 PIA_WSL_REAL_DOWNLOAD=1 时在 Windows 上跑", timeout: 15 * 60_000 }, async () => {
	process.env.PIA_TEST_FAST = "1";
	const f = W.rootfsFile();
	let last = 0;
	const out = await downloadFile(f, { bytes: (r) => void (last = r), detail: () => {} });
	assert.equal(out, f.dest);
	assert.equal(last, f.size);
	assert.ok(existsSync(`${f.dest}.ok`));
});

test("Windows：运行器的 WSL2 可用时，真实导入 / 启动容器引擎 / 注销", { skip: (!win || process.env.PIA_WSL_TRY_IMPORT !== "1") && "设置 PIA_WSL_TRY_IMPORT=1", timeout: 20 * 60_000 }, async (t) => {
	const r = await W.probeWsl(true);
	if (r.health !== "ok") return t.skip(`这台运行器的 WSL 不可用：${r.reason}`);
	try {
		await W.ensureWsl();
		assert.equal(await W.distroState(), "running");
		assert.ok(await W.wslRunning());
		await W.stopWsl();
		assert.equal(await W.distroState(), "stopped");
	} catch (e) {
		// 托管运行器没有嵌套虚拟化时 WSL2 起不来：记录原因，不算失败
		const msg = e instanceof Error ? e.message : String(e);
		if (/虚拟化|重启|HCS|0x8037/.test(msg)) return t.skip(`运行器不支持 WSL2：${msg}`);
		throw e;
	} finally {
		await W.destroyWsl().catch(() => {});
	}
	assert.equal(await W.distroState(), "missing");
});
