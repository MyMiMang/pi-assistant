import "./setup.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 假 cloudflared：模拟 trycloudflare 返回 429 后退出
const dir = mkdtempSync(join(tmpdir(), "fakecf-"));
const fake = join(dir, "cloudflared");
writeFileSync(fake, `#!/bin/sh\necho 'ERR failed to request quick Tunnel: quick tunnel provisioning failed with status 429 Too Many Requests' >&2\nexit 1\n`);
chmodSync(fake, 0o755);
process.env.PIA_CLOUDFLARED = fake;

const { cloudflaredManifest, platformKey } = await import("../src/cloudflared-bin.ts");
const { startTunnel, stopTunnel, tunnelStatus } = await import("../src/tunnel.ts");
const { bus } = await import("../src/bus.ts");

test("third-party.json 固定了各平台 cloudflared 及 SHA256", () => {
	const m = cloudflaredManifest();
	assert.match(m.version, /^\d{4}\.\d+\.\d+$/);
	for (const k of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]) assert.match(m.assets[k]?.sha256 ?? "", /^[0-9a-f]{64}$/, k);
	assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
});

test("429 限流：进入 10 分钟以上的冷却，不快速重试", async () => {
	const got = new Promise<void>((resolve) => {
		const off = bus.on((e) => {
			const ev = e as unknown as { type: string; status?: { state: string } };
			if (ev.type === "tunnel.status" && ev.status?.state === "cooldown") (off(), resolve());
		});
	});
	startTunnel();
	await got;
	const s = tunnelStatus();
	assert.equal(s.state, "cooldown");
	assert.equal(s.mode, "quick");
	assert.ok(s.nextRetryAt! - Date.now() >= 9.5 * 60_000, "冷却至少约 10 分钟");
	assert.ok(s.nextRetryAt! - Date.now() <= 31 * 60_000, "首次冷却不超过 30 分钟");
	assert.match(s.error ?? "", /限流（429）/);
	stopTunnel();
	assert.equal(tunnelStatus().state, "off");
});
