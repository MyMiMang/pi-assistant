// Linux 服务器版发布包（在对应架构的 Linux runner 上运行）：
//   pi-assistant-<版本>-linux-<x64|arm64>.tar.gz（+ .sha256）
//   └─ pi-assistant-<版本>-linux-<arch>/
//      ├─ node            官方 Node 运行时（third-party.json 固定版本 + SHA256）
//      ├─ app/            服务端 app 目录（scripts/stage-app.mjs：源码 + 生产依赖 + 网页 + cloudflared/uv/cua-driver）
//      ├─ pi-assistant    命令行包装（start/stop/status/logs/setup-code/…，见 deploy/linux/pi-assistant）
//      └─ install.sh      安装脚本（也可单独 curl | sh）
// 用法：node scripts/package-linux.mjs [--no-bins]（先 npm run build）
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "linux") throw new Error("只在 Linux 上打 Linux 包");
const root = resolve(import.meta.dirname, "..");
const arch = { x64: "x64", arm64: "arm64" }[process.arch];
if (!arch) throw new Error(`不支持的架构 ${process.arch}`);
const triple = arch === "x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu";
const version = JSON.parse(readFileSync(join(root, "apps/tray/src-tauri/tauri.conf.json"), "utf8")).version;
const name = `pi-assistant-${version}-linux-${arch}`;
const outDir = join(root, "dist-linux");
const pkg = join(outDir, name);
rmSync(pkg, { recursive: true, force: true });
mkdirSync(pkg, { recursive: true });
execFileSync(process.execPath, [join(root, "apps/tray/scripts/build-sidecar.mjs"), triple, ...process.argv.filter((a) => a === "--no-bins")], { cwd: root, stdio: "inherit" });
copyFileSync(join(root, "apps/tray/src-tauri/binaries", `node-${triple}`), join(pkg, "node"));
chmodSync(join(pkg, "node"), 0o755);
renameSync(join(root, "dist-app"), join(pkg, "app"));
for (const f of ["pi-assistant", "install.sh"]) {
	cpSync(join(root, "deploy/linux", f), join(pkg, f));
	chmodSync(join(pkg, f), 0o755);
}
const tgz = `${name}.tar.gz`;
execFileSync("tar", ["-czf", tgz, "--owner=0", "--group=0", name], { cwd: outDir, stdio: "inherit" });
const sha = createHash("sha256").update(readFileSync(join(outDir, tgz))).digest("hex");
writeFileSync(join(outDir, `${tgz}.sha256`), `${sha}  ${tgz}\n`);
rmSync(pkg, { recursive: true, force: true });
console.log(`[linux] ${join(outDir, tgz)}  sha256 ${sha}`);
