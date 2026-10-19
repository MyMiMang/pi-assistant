// 把服务端打成“可直接运行的 app 目录”，供安装包（Tauri resources）使用：
//   <out>/package.json, third-party.json, packages/**（源码，tsx 运行）, node_modules（仅生产依赖，工作区链接已解引用）,
//   apps/web/dist, apps/rendezvous/dist, bin-seed/（cloudflared / uv / cua-driver，按 third-party.json 固定版本 + SHA256）
//   不含本地语音识别的运行环境和权重（可选模块，用户在 设置 › 语音 安装；见决策 0013，下面有检查）
// 用法：node scripts/stage-app.mjs <out> [--no-bins]
// 在目标平台的 runner 上运行（node_modules 里的平台相关依赖、二进制都按当前平台取）。
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, realpathSync, mkdirSync, readdirSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "dist-app"));
// 必须在仓库外暂存：在工作区根目录下面跑 npm ci 会被当成工作区的一部分
const tmp = join(tmpdir(), `pia-stage-${process.pid}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });

for (const need of ["apps/web/dist/index.html", "apps/rendezvous/dist/worker.js"]) if (!existsSync(join(root, need))) throw new Error(`先运行 npm run build（缺 ${need}）`);
rmSync(tmp, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// 1) 拷源码（不含 node_modules / 测试 / 文档）
const skip = new Set(["node_modules", "test", "e2e", "docs", ".git", "dist-app", "src-tauri", "screenshots", "vendor", ".venv"]);
const copy = (rel) => cpSync(join(root, rel), join(tmp, rel), { recursive: true, filter: (src) => !skip.has(src.split(/[\\/]/).pop()) });
for (const f of ["package.json", "package-lock.json", "third-party.json", ".npmrc"]) if (existsSync(join(root, f))) copy(f);
for (const d of readdirSync(join(root, "packages"))) copy(join("packages", d));
for (const d of readdirSync(join(root, "apps"))) {
	// 只要 package.json（npm 工作区要求）+ 构建产物
	mkdirSync(join(tmp, "apps", d), { recursive: true });
	cpSync(join(root, "apps", d, "package.json"), join(tmp, "apps", d, "package.json"));
}
cpSync(join(root, "apps/web/dist"), join(tmp, "apps/web/dist"), { recursive: true });
cpSync(join(root, "apps/rendezvous/dist"), join(tmp, "apps/rendezvous/dist"), { recursive: true });

// 2) 只装生产依赖（只为服务端及其工作区依赖）
sh(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--workspace=@pi-assistant/server", "--include-workspace-root"], { cwd: tmp, env: { ...process.env, npm_config_update_notifier: "false" } });

// 3) 第三方二进制（复用服务端自己的下载 + SHA256 校验逻辑）
const seed = join(tmpdir(), `pia-stage-bins-${process.pid}`);
rmSync(seed, { recursive: true, force: true });
if (!process.argv.includes("--no-bins")) sh(process.execPath, ["--import", "tsx", join(root, "scripts", "fetch-bins.ts")], { cwd: root, env: { ...process.env, PIA_DATA_DIR: seed, PIA_OFFLINE: "1" } });

// node_modules/.bin 运行时用不到（而且多是符号链接）
const dropBins = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) if (f.isDirectory() && !f.isSymbolicLink()) f.name === ".bin" ? rmSync(join(d, f.name), { recursive: true, force: true }) : f.name !== "src" && dropBins(join(d, f.name)); };
dropBins(join(tmp, "node_modules"));

// 4) 解引用工作区链接（安装包里不放符号链接 / junction；fs.cpSync 的 dereference 不处理嵌套链接，自己走一遍）
const derefCopy = (src, dst) => {
	const st = lstatSync(src);
	if (st.isSymbolicLink()) {
		let real;
		try { real = realpathSync(src); } catch { return; } // 断链：跳过
		return derefCopy(real, dst);
	}
	if (st.isDirectory()) {
		mkdirSync(dst, { recursive: true });
		for (const f of readdirSync(src)) derefCopy(join(src, f), join(dst, f));
		return;
	}
	copyFileSync(src, dst);
	if (process.platform !== "win32") chmodSync(dst, st.mode & 0o777);
};
derefCopy(tmp, out);
rmSync(tmp, { recursive: true, force: true });
if (existsSync(join(seed, "bin"))) cpSync(join(seed, "bin"), join(out, "bin-seed"), { recursive: true, verbatimSymlinks: true });
rmSync(seed, { recursive: true, force: true });
// 本地语音识别是可选模块（决策 0013）：运行环境（uv venv + sherpa-onnx）和权重只在用户点「安装」时下载到数据目录，
// 绝不进安装包。这里兜底检查，发现就让打包失败（防止以后有人把权重 / venv 拷进来让安装包变大）。
const asrLeaks = [];
const walk = (p) => (lstatSync(p).isDirectory() ? readdirSync(p).forEach((f) => walk(join(p, f))) : /\.onnx$|[\\/]sherpa[-_]onnx/i.test(p) && asrLeaks.push(p));
walk(out);
if (asrLeaks.length) throw new Error(`安装包里不应有本地语音运行环境 / 权重（可选模块，按需安装）：\n${asrLeaks.slice(0, 5).join("\n")}`);
// 托盘 / 前端用不到的工作区包在 node_modules 里也删掉
for (const d of ["tray", "web"]) rmSync(join(out, "node_modules", "@pi-assistant", d), { recursive: true, force: true });
const version = JSON.parse(readFileSync(join(root, "apps/tray/src-tauri/tauri.conf.json"), "utf8")).version;
writeFileSync(join(out, "app-version.json"), JSON.stringify({ version, builtAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}` }, null, 2));
const size = (p) => { const s = lstatSync(p); return s.isDirectory() ? readdirSync(p).reduce((a, f) => a + size(join(p, f)), 0) : s.size; };
console.log(`staged → ${out}（${(size(out) / 1e6).toFixed(0)} MB）`);
