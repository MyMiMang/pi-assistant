// 准备安装包的内容（在目标平台的 runner 上运行）：
//  1) src-tauri/binaries/node-<target-triple>[.exe]：官方 Node 运行时（third-party.json 固定版本 + SHA256）
//  2) <repo>/dist-app：服务端 app 目录（scripts/stage-app.mjs：源码 + 生产依赖 + 网页 + cloudflared/uv/cua-driver）
// 用法：node apps/tray/scripts/build-sidecar.mjs [target-triple] [--no-bins]
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..", "..");
const triple = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? execSync("rustc -vV").toString().match(/host: (\S+)/)[1];
const win = triple.includes("windows");
const node = JSON.parse(readFileSync(join(root, "third-party.json"), "utf8")).components.find((c) => c.name === "node");
const asset = node.assets[triple];
if (!asset) throw new Error(`没有 ${triple} 的 Node 运行时（third-party.json）`);
const file = asset.file.replaceAll("{v}", node.version);
const url = node.base.replaceAll("{v}", node.version) + file;
console.log(`[sidecar] ${triple}: ${url}`);
const r = await fetch(url);
if (!r.ok) throw new Error(`下载 Node 失败：HTTP ${r.status}`);
const buf = Buffer.from(await r.arrayBuffer());
const got = createHash("sha256").update(buf).digest("hex");
if (got !== asset.sha256) throw new Error(`Node 校验失败：期望 ${asset.sha256} 实际 ${got}`);
const work = join(tmpdir(), `pia-node-${Date.now()}`);
mkdirSync(work, { recursive: true });
writeFileSync(join(work, file), buf);
execFileSync(win && process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar", ["-xf", file], { cwd: work, stdio: "inherit" }); // Windows 10+ 自带的 bsdtar 也能解 zip
const dirName = file.replace(/\.(tar\.gz|tar\.xz|zip)$/, "");
const src = win ? join(work, dirName, "node.exe") : join(work, dirName, "bin", "node");
const binDir = join(root, "apps", "tray", "src-tauri", "binaries");
mkdirSync(binDir, { recursive: true });
const dst = join(binDir, `node-${triple}${win ? ".exe" : ""}`);
copyFileSync(src, dst);
if (!win) chmodSync(dst, 0o755);
rmSync(work, { recursive: true, force: true });
console.log(`[sidecar] node ${node.version} → ${dst}（sha256 ok）`);

execFileSync(process.execPath, [join(root, "scripts", "stage-app.mjs"), join(root, "dist-app"), ...process.argv.filter((a) => a === "--no-bins")], { cwd: root, stdio: "inherit" });
