// 安装包内容冒烟测试：用打进安装包的 Node 运行时启动 dist-app 里的服务（Mock 模型），确认网页、接口、内置二进制都可用。
// 用法：node scripts/smoke-app.mjs <node 可执行文件> [dist-app]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [nodeBin, appArg] = process.argv.slice(2);
const app = resolve(appArg ?? "dist-app");
const data = mkdtempSync(join(tmpdir(), "pia-smoke-"));
const port = 18000 + Math.floor(Math.random() * 1000);
const p = spawn(resolve(nodeBin), ["--disable-warning=ExperimentalWarning", "--import", "tsx", join("packages", "server", "src", "main.ts")], {
	cwd: app,
	env: { ...process.env, PIA_DATA_DIR: data, PIA_PORT: String(port), PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_APP_DIR: app },
	stdio: ["ignore", "inherit", "inherit"],
});
const fail = (m) => (console.error(`❌ ${m}`), p.kill(), process.exit(1));
const base = `http://127.0.0.1:${port}`;
let ok = false;
for (let i = 0; i < 90 && !ok; i++) {
	await new Promise((r) => setTimeout(r, 1000));
	ok = await fetch(`${base}/api/system/public`).then((r) => r.ok, () => false);
}
if (!ok) fail("服务 90 秒内没有启动");
const html = await (await fetch(base)).text();
if (!html.includes("<div id=\"root\"")) fail("网页没有正确提供");
const sys = await (await fetch(`${base}/api/system`)).json();
if (!sys.pi?.version) fail("Pi 版本信息缺失");
const bins = existsSync(join(data, "bin")) ? readdirSync(join(data, "bin")) : [];
if (existsSync(join(app, "bin-seed")) && !["cloudflared", "uv"].every((b) => bins.some((x) => x.startsWith(b)))) fail(`内置二进制没有复制到数据目录：${bins}`);
console.log(`✅ 安装包冒烟测试通过：Pi ${sys.pi.version}，二进制 ${bins.join(", ") || "（未内置）"}`);
p.kill();
process.exit(0);
