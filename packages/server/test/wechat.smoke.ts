/**
 * 个人微信冒烟（需要 Docker 和助理电脑镜像）：按 third-party.json 固定 SHA 下载官方 Linux 微信 →
 * 解到助理电脑家目录卷 → 启动 → 截屏看到登录窗口（二维码）。
 *   PIA_DOCKER="sudo docker" node --import tsx test/wechat.smoke.ts
 * 可设 WECHAT_DEB=/path/to.deb 跳过下载（仍会校验 SHA）。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const { config } = await import("../src/config.ts");
const wx = await import("../src/wechat.ts");
const { containerOf, screenshotDesktop } = await import("../src/desktop.ts");
const AGENT = "wxsmoke";
const dk = (...a: string[]) => execFileSync(config.docker[0], [...config.docker.slice(1), ...a], { stdio: "pipe" });
try {
	if (process.env.WECHAT_DEB) {
		const tp = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "third-party.json"), "utf8")).components.find((c: { name: string }) => c.name === "wechat-linux");
		const buf = readFileSync(process.env.WECHAT_DEB);
		assert.equal(createHash("sha256").update(buf).digest("hex"), tp.assets.x86_64.sha256, "本地 deb 与固定 SHA 不一致");
		mkdirSync(join(config.dataDir, "cache"), { recursive: true });
		copyFileSync(process.env.WECHAT_DEB, join(config.dataDir, "cache", `wechat-${tp.version}-x86_64.deb`));
	}
	wx.saveWechatSettings({ enabled: true, acknowledgedAt: Date.now(), agentIds: [AGENT] });
	const st = await wx.openWechat(AGENT, (m) => console.log("  ", m));
	assert.ok(st.installed && st.running, JSON.stringify(st));
	console.log("✓ 微信已安装并运行", st.version);
	await new Promise((r) => setTimeout(r, 12_000));
	const titles = String(dk("exec", "-e", "DISPLAY=:1", containerOf(AGENT), "bash", "-c", "xdotool search --name . getwindowname %@ 2>/dev/null | sort -u"));
	assert.match(titles, /微信|WeChat/, titles);
	console.log("✓ 看到微信窗口");
	const png = await screenshotDesktop(AGENT);
	const out = process.env.SHOT ?? "/tmp/wechat-smoke.png";
	writeFileSync(out, png);
	console.log("✓ 截屏", out);
	// 二次打开：不重装、不重复启动
	const t0 = Date.now();
	const st2 = await wx.openWechat(AGENT);
	assert.ok(st2.running && Date.now() - t0 < 10_000);
	console.log("✓ 再次打开直接复用");
} finally {
	try {
		dk("rm", "-f", containerOf(AGENT));
		dk("volume", "rm", "-f", `pia-home-${AGENT}`);
	} catch {}
}
process.exit(0);
