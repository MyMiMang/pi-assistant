/** 助理电脑镜像接入统一下载管理：关闭时不显示；开启后出现在“助理电脑”组；关着时不能手动下载 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { DESKTOP_IMAGE_ID, startImageDownload } = await import("../src/desktop/image-download.ts");
const { listDownloads, downloadInfo } = await import("../src/downloads.ts");
const { updateDesktopSettings } = await import("../src/desktop/settings.ts");

test("助理电脑镜像：未开启时隐藏、开启后显示在“助理电脑”组，大小来自固定版本", async () => {
	assert.ok(!listDownloads().some((d) => d.id === DESKTOP_IMAGE_ID));
	await assert.rejects(startImageDownload(), /先在 设置 › 助理电脑 里开启/);
	updateDesktopSettings({ enabled: true });
	const d = downloadInfo(DESKTOP_IMAGE_ID)!;
	assert.equal(d.group, "助理电脑");
	assert.ok(d.size! > 1e8);
	assert.ok(listDownloads().some((x) => x.id === DESKTOP_IMAGE_ID));
	updateDesktopSettings({ enabled: false });
});
