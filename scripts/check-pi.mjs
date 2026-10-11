// Pi 版本兼容检查：已安装版本 vs 兼容基线（compat.json）vs npm 最新版。
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
const installed = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url))).version;
const { testedWith } = JSON.parse(readFileSync(new URL("../packages/server/src/pi-adapter/compat.json", import.meta.url)));
let latest = "unknown";
try {
	latest = execSync("npm view @earendil-works/pi-coding-agent version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {}
console.log(`Pi 已安装 ${installed} · 兼容基线 ${testedWith} · npm 最新 ${latest}`);
if (installed.split(".")[0] !== testedWith.split(".")[0]) {
	console.error("❌ 已安装的 Pi 主版本与兼容基线不同，请运行 npm test 并更新 pi-adapter/compat.json");
	process.exit(1);
}
if (latest !== "unknown" && latest !== installed) console.log(`ℹ️ 有新版 Pi ${latest}，pi-latest 工作流会自动尝试升级`);
