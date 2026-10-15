/** 助理电脑运行时（DESIGN §15.2）：名字硬性保护、后端选择、镜像地址、下载进度解析、空闲关机判定 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOwnTarget, containerName, isOwnContainer, isOwnImage, isOwnLimaInstance, isOwnVolume, isOwnWslDistro, safeId, volumeName } from "../src/desktop/names.ts";
import { IdleTracker, shouldStop } from "../src/desktop/idle.ts";
import { pickBackend } from "../src/desktop/backend.ts";
import { checkDiskGrowOnly, mergeInstanceResources, resolveResources, resourceBounds, suggestResources, validateResourceChoice } from "../src/desktop/resources.ts";
import { normalizeMirror, pullRef, updateDesktopSettings, desktopSettings } from "../src/desktop/settings.ts";
import { parsePullLine } from "../src/desktop/image.ts";

const REPOS = ["ghcr.io/mymimang/pi-assistant-desktop", "ghcr.nju.edu.cn/mymimang/pi-assistant-desktop"];
const G = 1024 ** 3;
const ok = (args: string[]) => assert.doesNotThrow(() => assertOwnTarget(args, REPOS), args.join(" "));
const no = (args: string[]) => assert.throws(() => assertOwnTarget(args, REPOS), /拒绝操作/, args.join(" "));

test("名字：只认我们自己的实例 / 容器 / 卷", () => {
	assert.equal(containerName("a_1"), "pia-desk-a_1");
	assert.equal(volumeName("a_1"), "pia-home-a_1");
	assert.equal(containerName("a/../b; rm -rf"), "pia-desk-a..brm-rf");
	assert.throws(() => safeId("../;"));
	assert.throws(() => safeId(""));
	assert.throws(() => safeId("x".repeat(65)));
	assert.throws(() => safeId("-rf"));
	for (const n of ["pia-desk-a1", "pia-desk-A.b_c-9"]) assert.ok(isOwnContainer(n), n);
	for (const n of ["pia-desk-", "my-app", "pia-desk-a b", "pia-desk-a;rm", "xpia-desk-a", "pia-desk--rf", "pia-home-a1"]) assert.ok(!isOwnContainer(n), n);
	assert.ok(isOwnVolume("pia-home-a1") && !isOwnVolume("pia-desk-a1") && !isOwnVolume("postgres-data"));
	assert.ok(isOwnLimaInstance("pia-desktop") && !isOwnLimaInstance("default") && !isOwnLimaInstance("docker"));
	assert.ok(isOwnWslDistro("PiAssistant-Desktop") && !isOwnWslDistro("Ubuntu") && !isOwnWslDistro("PiAssistant-") && !isOwnWslDistro("PiAssistant-a;b"));
	assert.ok(isOwnImage("ghcr.io/mymimang/pi-assistant-desktop:0.1.0", REPOS));
	assert.ok(isOwnImage(`ghcr.nju.edu.cn/mymimang/pi-assistant-desktop@sha256:${"a".repeat(64)}`, REPOS));
	assert.ok(!isOwnImage("postgres:16", REPOS) && !isOwnImage("ghcr.io/mymimang/other:1", REPOS));
});

test("引擎命令：只放行指向我们自己东西的修改类命令", () => {
	ok(["version", "--format", "{{.Server.Version}}"]);
	ok(["ps", "--filter", "label=pia.agent", "--format", "{{.Names}}"]);
	ok(["inspect", "-f", "{{.State.Running}}", "pia-desk-a1"]);
	ok(["stop", "-t", "3", "pia-desk-a1"]);
	ok(["start", "pia-desk-a1"]);
	ok(["rm", "-f", "pia-desk-a1"]);
	ok(["exec", "-i", "-e", "DISPLAY=:1", "pia-desk-a1", "cua-driver", "mcp"]);
	ok(["exec", "-d", "-e", "DISPLAY=:1", "pia-desk-a1", "chromium", "--no-sandbox"]);
	ok(["cp", "/tmp/w.deb", "pia-desk-a1:/tmp/w.deb"]);
	ok(["run", "-d", "--name", "pia-desk-a1", "-v", "pia-home-a1:/home/agent", "--label", "pia.agent=a1", "img"]);
	ok(["volume", "rm", "pia-home-a1", "pia-home-b2"]);
	ok(["image", "rm", "ghcr.io/mymimang/pi-assistant-desktop:0.1.0"]);
	ok(["tag", "ghcr.nju.edu.cn/mymimang/pi-assistant-desktop:0.1.0", "ghcr.io/mymimang/pi-assistant-desktop:0.1.0"]);
	no(["stop", "my-postgres"]);
	no(["stop", "-t", "3", "pia-desk-a1", "my-postgres"]);
	no(["rm", "-f", "redis"]);
	no(["rm"]);
	no(["exec", "-i", "redis", "sh"]);
	no(["kill", "pia-desk-a1;rm"]);
	no(["cp", "/etc/passwd", "redis:/tmp/x"]);
	no(["run", "-d", "--name", "pia-desk-a1", "img"]); // 缺 pia.agent 标签
	no(["run", "-d", "--name", "web", "--label", "pia.agent=x", "img"]);
	no(["run", "-d", "img"]);
	no(["volume", "rm", "postgres-data"]);
	no(["volume", "prune", "-f"]);
	no(["system", "prune", "-af"]);
	no(["container", "prune"]);
	no(["image", "prune", "-a"]);
	no(["rmi", "postgres:16"]);
	no(["image", "rm", "ubuntu"]);
	no(["tag", "x", "ubuntu:latest"]);
	no(["network", "rm", "bridge"]);
	no(["compose", "down"]);
});

test("后端选择：auto 用自带运行时（macOS = Lima；Windows = WSL2；Linux = 原生 Docker），docker 用已装的 Docker", () => {
	assert.equal(pickBackend("auto", "linux").id, "docker");
	assert.equal(pickBackend("docker", "darwin").id, "docker");
	assert.equal(pickBackend("auto", "darwin").id, "lima"); // 第 2 步：Lima 已实现
	assert.equal(pickBackend("auto", "win32").id, "wsl"); // Windows = 自带 WSL2 发行版
	assert.equal(pickBackend("auto", "linux").id, "docker"); // Linux 直接用原生 Docker/Podman
	assert.equal(pickBackend("auto", "darwin", new Set(["lima"])).id, "lima");
	assert.equal(pickBackend("auto", "win32", new Set(["wsl"])).id, "wsl");
	assert.equal(pickBackend("docker", "win32", new Set(["wsl"])).id, "docker");
});

test("镜像地址：按 digest 固定，加速地址只换注册表主机", () => {
	const p = { repository: "ghcr.io/mymimang/pi-assistant-desktop", version: "0.1.0", digest: null, downloadBytes: 1, diskBytes: 1 };
	assert.equal(pullRef("", p), "ghcr.io/mymimang/pi-assistant-desktop:0.1.0");
	assert.equal(pullRef("ghcr.nju.edu.cn", p), "ghcr.nju.edu.cn/mymimang/pi-assistant-desktop:0.1.0");
	const d = `sha256:${"b".repeat(64)}`;
	assert.equal(pullRef("ghcr.nju.edu.cn", { ...p, digest: d as never }), `ghcr.nju.edu.cn/mymimang/pi-assistant-desktop@${d}`);
	assert.equal(normalizeMirror(" https://GHCR.nju.edu.cn/ "), "ghcr.nju.edu.cn");
	assert.equal(normalizeMirror(""), "");
	assert.throws(() => normalizeMirror("not a host"));
	assert.throws(() => normalizeMirror("evil.com; rm -rf /"));
});

test("设置：默认关闭（不下载），空闲时间只能 5/10/30/从不", () => {
	assert.deepEqual(desktopSettings(), { enabled: false, backend: "auto", idleMinutes: 10, mirror: "", fileMirror: "", separate: [], legacyMigrated: false, resources: {} });
	assert.equal(updateDesktopSettings({ idleMinutes: 30 }).idleMinutes, 30);
	assert.equal(updateDesktopSettings({ idleMinutes: 0 }).idleMinutes, 0);
	assert.throws(() => updateDesktopSettings({ idleMinutes: 7 }));
	assert.throws(() => updateDesktopSettings({ backend: "lima" as never }));
	assert.equal(updateDesktopSettings({ backend: "docker", enabled: true }).backend, "docker");
	updateDesktopSettings({ enabled: false, backend: "auto", idleMinutes: 10 });
});

test("虚拟机资源：用户选择按范围校验，非法值直接拒", () => {
	const before = desktopSettings().resources;
	assert.deepEqual(updateDesktopSettings({ resources: { cpus: 6, memoryGiB: 8, diskGiB: 80 } }).resources, { cpus: 6, memoryGiB: 8, diskGiB: 80 });
	assert.throws(() => updateDesktopSettings({ resources: { cpus: 0 } }), /CPU 核数/);
	assert.throws(() => updateDesktopSettings({ resources: { cpus: 2.5 } }), /整数/);
	assert.throws(() => updateDesktopSettings({ resources: { memoryGiB: 1 } }), /内存/);
	assert.throws(() => updateDesktopSettings({ resources: { memoryGiB: 999 } }), /内存/);
	assert.throws(() => updateDesktopSettings({ resources: { diskGiB: 5 } }), /磁盘/);
	assert.throws(() => updateDesktopSettings({ resources: { diskGiB: 99999 } }), /磁盘/);
	assert.throws(() => updateDesktopSettings({ resources: { cpus: "8" as never } }), /整数/); // 不能字符串注入
	assert.throws(() => updateDesktopSettings({ resources: [1, 2] as never }), /格式/);
	updateDesktopSettings({ resources: before });
});

test("虚拟机资源：建议值按机器算，范围不超配宿主", () => {
	// 与 vmSize 一致：内存一半（4–8）、CPU 留 2 核（2–4）、磁盘 40
	assert.deepEqual(suggestResources({ ncpu: 8, totalBytes: 8 * G }), { cpus: 4, memoryGiB: 4, diskGiB: 40 });
	assert.deepEqual(suggestResources({ ncpu: 10, totalBytes: 16 * G }), { cpus: 4, memoryGiB: 8, diskGiB: 40 });
	assert.deepEqual(suggestResources({ ncpu: 3, totalBytes: 64 * G }), { cpus: 2, memoryGiB: 8, diskGiB: 40 });
	// 内存上限 = 总内存 75%（不把总内存当可用内存花完）；CPU 上限不超过宿主核数
	assert.deepEqual(resourceBounds({ ncpu: 8, totalBytes: 8 * G }).memoryGiB, { min: 2, max: 6 });
	assert.equal(resourceBounds({ ncpu: 8, totalBytes: 0 }).memoryGiB.max, 2); // 读不到内存就只给最小
	assert.equal(resourceBounds({ ncpu: 4, totalBytes: 64 * G }).cpus.max, 4);
	assert.equal(resourceBounds({ ncpu: 64, totalBytes: 128 * G }).cpus.max, 16);
});

test("虚拟机资源：用户选择叠加到建议值，越界收窄", () => {
	const host = { ncpu: 10, totalBytes: 16 * G };
	assert.deepEqual(resolveResources({}, host), suggestResources(host));
	assert.deepEqual(resolveResources({ cpus: 6, memoryGiB: 10, diskGiB: 80 }, host), { cpus: 6, memoryGiB: 10, diskGiB: 80 });
	assert.deepEqual(resolveResources({ cpus: 999, memoryGiB: 999, diskGiB: 999 }, host), { cpus: 10, memoryGiB: 12, diskGiB: 256 });
	assert.deepEqual(resolveResources({ cpus: 0 }, host).cpus, 1);
});

test("虚拟机资源：校验只收范围内的整数", () => {
	const host = { ncpu: 10, totalBytes: 16 * G };
	assert.deepEqual(validateResourceChoice({ cpus: 4, memoryGiB: 8 }, host), { ok: true, value: { cpus: 4, memoryGiB: 8 } });
	assert.equal(validateResourceChoice({ cpus: 2.5 }, host).ok, false);
	assert.equal(validateResourceChoice({ cpus: -1 }, host).ok, false);
	assert.equal(validateResourceChoice({ memoryGiB: 1 }, host).ok, false);
	assert.equal(validateResourceChoice({ diskGiB: 1e9 }, host).ok, false);
	assert.equal(validateResourceChoice({ cpus: "4" }, host).ok, false);
	assert.equal(validateResourceChoice([], host).ok, false);
});

test("虚拟机资源：尊重现值不强行降配，磁盘只扩不缩", () => {
	const host = { ncpu: 8, totalBytes: 8 * G }; // 建议 4 核 / 4 GiB / 40 GiB
	// 没设置：保留现有实例值（不升级也不降级）
	assert.deepEqual(mergeInstanceResources({}, { cpus: 6, memoryGiB: 8, diskGiB: 120 }, host), { cpus: 6, memoryGiB: 8, diskGiB: 120 });
	// 用户显式设置优先于现有值
	assert.deepEqual(mergeInstanceResources({ cpus: 2 }, { cpus: 6, memoryGiB: 8, diskGiB: 120 }, host), { cpus: 2, memoryGiB: 8, diskGiB: 120 });
	// 磁盘比现有小：保留现有（只扩不缩），并标记
	const m = mergeInstanceResources({ diskGiB: 60 }, { cpus: 6, memoryGiB: 8, diskGiB: 120 }, host);
	assert.equal(m.diskGiB, 120);
	assert.equal(m.diskKeptLarger, true);
	// 没有现有值时用建议值
	assert.deepEqual(mergeInstanceResources({}, null, host), suggestResources(host));
	// 只扩不缩的显式校验
	assert.match(checkDiskGrowOnly({ diskGiB: 60 }, { diskGiB: 120 })!, /只能扩大/);
	assert.equal(checkDiskGrowOnly({ diskGiB: 120 }, { diskGiB: 120 }), null);
	assert.equal(checkDiskGrowOnly({ diskGiB: 200 }, { diskGiB: 120 }), null);
	assert.equal(checkDiskGrowOnly({}, { diskGiB: 120 }), null);
	assert.equal(checkDiskGrowOnly({ diskGiB: 10 }, null), null);
});

test("下载进度：解析 docker / podman 拉取输出", () => {
	const L = new Map<string, boolean>();
	for (const l of ["0.1.0: Pulling from mymimang/pi-assistant-desktop", "aaaaaaaaaaaa: Pulling fs layer", "bbbbbbbbbbbb: Already exists", "cccccccccccc: Waiting", "aaaaaaaaaaaa: Downloading  12MB/50MB", "aaaaaaaaaaaa: Pull complete"]) parsePullLine(l, L);
	assert.equal(L.size, 3);
	assert.equal([...L.values()].filter(Boolean).length, 2);
	const P = new Map<string, boolean>();
	parsePullLine("Copying blob sha256:dddddddddddd1234 done", P);
	parsePullLine("Copying blob eeeeeeeeeeee5678", P);
	assert.deepEqual([...P.values()], [true, false]);
});

test("空闲关机：没有工具调用、没人看画面、没有任务占用，超过设定时间才关", () => {
	const m = 60_000;
	assert.equal(shouldStop({ now: 10 * m, lastUse: 0, viewers: 0, busy: false, idleMinutes: 10 }), true);
	assert.equal(shouldStop({ now: 10 * m - 1, lastUse: 0, viewers: 0, busy: false, idleMinutes: 10 }), false);
	assert.equal(shouldStop({ now: 99 * m, lastUse: 0, viewers: 1, busy: false, idleMinutes: 10 }), false);
	assert.equal(shouldStop({ now: 99 * m, lastUse: 0, viewers: 0, busy: true, idleMinutes: 10 }), false);
	assert.equal(shouldStop({ now: 99 * m, lastUse: 0, viewers: 0, busy: false, idleMinutes: 0 }), false); // 从不
	assert.equal(shouldStop({ now: 5 * m, lastUse: 0, viewers: 0, busy: false, idleMinutes: 5 }), true);

	let t = 0;
	const tr = new IdleTracker(() => t);
	const busy = new Set<string>();
	const isBusy = (id: string) => busy.has(id);
	// 服务重启后第一次看到运行中的桌面：从现在开始计时，不会立刻关
	assert.deepEqual(tr.due(["a", "b"], isBusy, 10), []);
	t = 4 * m;
	tr.touch("a"); // a 有一次工具调用
	tr.viewerOpen("b"); // 有人在看 b
	busy.add("c");
	t = 11 * m;
	assert.deepEqual(tr.due(["a", "b", "c"], isBusy, 10), []); // a 才空闲 7 分钟，b 有人看，c 在跑任务
	t = 14 * m;
	assert.deepEqual(tr.due(["a", "b", "c"], isBusy, 10), ["a"]);
	tr.viewerClose("b"); // 画面关掉：从关掉时重新计时
	busy.delete("c"); // 任务结束：上一次检查时刷新过使用时间
	t = 23 * m;
	assert.deepEqual(tr.due(["b", "c"], isBusy, 10), []);
	t = 24 * m;
	assert.deepEqual(tr.due(["b", "c"], isBusy, 10), ["b", "c"]);
	assert.deepEqual(tr.due(["b", "c"], isBusy, 0), []); // 从不
});
