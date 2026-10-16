/**
 * Laya → 统一下载登记适配：状态投影映射（manager install 状态 → 下载 DTO）+ 登记存在。
 * 只读 state，不启动安装、不碰文件系统 / 网络 / GPU。数据目录由 setup.ts 指向临时目录。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { LAYA_DOWNLOAD_ID, projectLayaInstall } from "../src/local-laya/download.ts";
import { downloadInfo, listDownloads } from "../src/downloads.ts";
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
