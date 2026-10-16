/**
 * Laya → 统一下载登记适配：状态投影映射（manager install 状态 → 下载 DTO）+ 登记存在。
 * 只读 state，不启动安装、不碰文件系统 / 网络 / GPU。数据目录由 setup.ts 指向临时目录。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { bus } from "../src/bus.ts";
import { LAYA_DOWNLOAD_ID, cancelLayaDownload, projectLayaInstall } from "../src/local-laya/download.ts";
import { cancelDownload, downloadInfo, listDownloads } from "../src/downloads.ts";
import type { LayaStatus } from "../src/local-laya/manager.ts";

const install = (p: Partial<LayaStatus["install"]>): LayaStatus["install"] => ({ state: "not_installed", phase: "idle", received: 0, total: null, error: null, installedAt: null, ...p });

test("projectLayaInstall：未安装 → missing；依赖阶段总量未知 → downloading 且 percent 由 total=null 表示（不编假百分比）", () => {
	assert.equal(projectLayaInstall(install({ state: "not_installed" })).state, "missing");

	const uv = projectLayaInstall(install({ state: "installing", phase: "torch" }));
	assert.equal(uv.state, "downloading");
	assert.equal(uv.total, null, "非权重阶段总量未知");
	assert.equal(uv.detail, "安装 Python 依赖（torch / laya）");

	// 权重阶段：已知总量才带 total，界面据此显示字节百分比
	const weights = projectLayaInstall(install({ state: "installing", phase: "weights", received: 323_000_000, total: 646_000_000 }));
	assert.equal(weights.state, "downloading");
	assert.equal(weights.total, 646_000_000);

	const failed = projectLayaInstall(install({ state: "failed", phase: "rollback", error: "权重校验未通过：符号链接越界" }));
	assert.equal(failed.state, "error");
	assert.equal(failed.error, "权重校验未通过：符号链接越界");

	assert.equal(projectLayaInstall(install({ state: "installed", phase: "done" })).state, "ready");
});

test("local-laya 已登记进统一下载列表（两个入口读同一个 job），有 start / cancel / status 投影", () => {
	const item = listDownloads().find((x) => x.id === LAYA_DOWNLOAD_ID);
	assert.ok(item, "Laya 必须出现在统一下载列表里");
	assert.equal(item!.name, "本地快速操作模型（Laya）");
	assert.equal(item!.group, "本地模型");
	assert.ok(item!.canStart, "可下载 / 重试");
	assert.ok(item!.canCancel, "下载中可取消");
	assert.equal(item!.percent, null, "无实进度时不报假百分比");
	assert.equal(downloadInfo(LAYA_DOWNLOAD_ID)!.state, "missing");
});

test("进度事件驱动：local-laya.changed → downloads.changed（首 / 终事件都转发，不再全局每秒轮询）", async () => {
	const forwarded: string[] = [];
	const off = bus.on((e) => {
		if (e.type === "downloads.changed" && (e as { item?: { id?: string } }).item?.id === LAYA_DOWNLOAD_ID) forwarded.push("dl");
	});
	const st = (install: LayaStatus["install"]) => ({
		platform: { support: "supported", accelerator: "mps", torchBackend: "default", pins: [], reason: null },
		install,
		runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1" },
		health: null,
		configured: false,
		registered: null,
	} as unknown as LayaStatus);
	// 首个安装事件：常规进度转发
	bus.emit({ type: "local-laya.changed", status: st({ state: "installing", phase: "weights", received: 1, total: 2, error: null, installedAt: null }) });
	// 终态事件：也必须转发（不能只在安装中才有进度）
	bus.emit({ type: "local-laya.changed", status: st({ state: "installed", phase: "done", received: 0, total: null, error: null, installedAt: 1 }) });
	await new Promise((r) => setTimeout(r, 20));
	off();
	assert.equal(forwarded.length, 2, "两个事件都要转成 downloads.changed");
});

test("取消链路：下载条目的 cancel 就是同一个 manager cancel（未安装时返回 ok:false，不抛）", async () => {
	// 未安装时 manager.cancel() 返回 { ok:false }；下载面板的 cancelDownload 必须走到它，而不是另建 controller。
	assert.deepEqual(cancelLayaDownload(), { ok: false });
	const item = await cancelDownload(LAYA_DOWNLOAD_ID);
	assert.equal(item?.id, LAYA_DOWNLOAD_ID, "取消后仍返回同一条目");
});
