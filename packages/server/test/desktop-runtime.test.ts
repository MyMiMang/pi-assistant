/** 助理电脑运行时（DESIGN §15.2）：名字硬性保护、后端选择、镜像地址、下载进度解析、空闲关机判定 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOwnTarget, containerName, isOwnContainer, isOwnImage, isOwnLimaInstance, isOwnVolume, isOwnWslDistro, safeId, volumeName } from "../src/desktop/names.ts";
import { IdleTracker, shouldStop } from "../src/desktop/idle.ts";
import { pickBackend } from "../src/desktop/backend.ts";
import { normalizeMirror, pullRef, updateDesktopSettings, desktopSettings } from "../src/desktop/settings.ts";
import { parsePullLine } from "../src/desktop/image.ts";

const REPOS = ["ghcr.io/mymimang/pi-assistant-desktop", "ghcr.nju.edu.cn/mymimang/pi-assistant-desktop"];
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

test("后端选择：auto 用自带运行时（未实现的平台回落到 Docker），docker 用已装的 Docker", () => {
	assert.equal(pickBackend("auto", "linux").id, "docker");
	assert.equal(pickBackend("docker", "darwin").id, "docker");
	assert.equal(pickBackend("auto", "darwin").id, "docker"); // 第 2 步实现 Lima 前
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
	assert.deepEqual(desktopSettings(), { enabled: false, backend: "auto", idleMinutes: 10, mirror: "" });
	assert.equal(updateDesktopSettings({ idleMinutes: 30 }).idleMinutes, 30);
	assert.equal(updateDesktopSettings({ idleMinutes: 0 }).idleMinutes, 0);
	assert.throws(() => updateDesktopSettings({ idleMinutes: 7 }));
	assert.throws(() => updateDesktopSettings({ backend: "lima" as never }));
	assert.equal(updateDesktopSettings({ backend: "docker", enabled: true }).backend, "docker");
	updateDesktopSettings({ enabled: false, backend: "auto", idleMinutes: 10 });
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
