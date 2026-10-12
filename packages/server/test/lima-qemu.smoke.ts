/**
 * 真实 Lima 虚拟机冒烟测试（在有 KVM 的 Linux 上跑；macOS 托管 CI 没有嵌套虚拟化，vz 只能在真 Mac 上测）。
 * 与 macOS 的唯一区别是 vmType: qemu（PIA_LIMA_VMTYPE=qemu）和 Linux 版 limactl（PIA_LIMACTL）；其余全部走正式代码：
 * 真实下载（断点续传 + 摘要校验）→ 创建并启动 Debian 12 虚拟机 → 虚拟机里 rootful containerd/nerdctl →
 * 把本地桌面镜像导入虚拟机 → 开桌面容器 → Lima 端口转发到宿主 127.0.0.1 → 截图 → 关桌面后自动关虚拟机 →
 * 再开机（家目录保留）→ 删除虚拟机。
 *
 *   PIA_LIMACTL=/path/to/linux/limactl PIA_LIMA_VMTYPE=qemu PIA_LIMA_MEMORY_GIB=3 \
 *   PIA_DESKTOP_IMAGE=pi-assistant/desktop:dev node --import tsx test/lima-qemu.smoke.ts
 */
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PIA_TEST_LIMA = "1";
process.env.PIA_LIMA_HOME ??= mkdtempSync(join(tmpdir(), "pia-lq-"));
process.env.PIA_DATA_DIR ??= mkdtempSync(join(tmpdir(), "pia-lqdata-"));
const L = await import("../src/desktop/lima.ts");
const D = await import("../src/desktop.ts");
const { updateDesktopSettings, localImage } = await import("../src/desktop/settings.ts");
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const AG = "smoke1";
try {
	updateDesktopSettings({ enabled: true });
	log("下载虚拟机组件…");
	await L.ensureVmFiles();
	log("创建 + 启动虚拟机…");
	await L.ensureVm();
	log(`虚拟机：${await L.vmState()}`);
	const cli = L.nerdctlCli().join(" ");
	log("导入本地桌面镜像到虚拟机…");
	execSync(`docker save ${localImage()} | ${cli.replace("shell --workdir /", "shell --workdir / ")} load`, { stdio: "inherit", shell: "/bin/bash", maxBuffer: 1e9 });
	L.markImage(localImage());
	D.resetAvailability();
	log("开桌面…");
	let st = await D.startDesktop(AG);
	log(`桌面：${st.state} noVNC 127.0.0.1:${st.port} CDP ${st.cdpPort}`);
	if (!(await D.reachable(st.port!))) throw new Error("宿主连不上 noVNC 端口");
	const png = await D.screenshotDesktop(AG);
	log(`截图 ${png.length} 字节，PNG=${png.subarray(1, 4).toString()}`);
	await D.ensureDesktopBrowser(AG).then((u) => log(`浏览器 CDP：${u}`));
	execSync(`${cli} exec pia-desk-${AG} sh -c 'echo keep > /home/agent/keep.txt'`, { shell: "/bin/bash" });
	log("关桌面（应自动关虚拟机）…");
	await D.stopDesktop(AG);
	log(`虚拟机：${await L.vmState()}`);
	if ((await L.vmState()) !== "stopped") throw new Error("所有桌面停了，虚拟机没关");
	log("再开机…");
	st = await D.startDesktop(AG);
	const keep = execSync(`${cli} exec pia-desk-${AG} cat /home/agent/keep.txt`, { shell: "/bin/bash", encoding: "utf8" }).trim();
	log(`家目录文件：${keep}`);
	if (keep !== "keep") throw new Error("家目录没保留");
	log("✅ 全部通过");
} finally {
	updateDesktopSettings({ enabled: false });
	log("删除虚拟机…");
	await D.purgeAll().catch((e) => log(`删除出错：${e}`));
	log(`删除后：${await L.vmState()}`);
}
