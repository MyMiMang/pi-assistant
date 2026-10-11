// 构建 pi-assistant-server sidecar：esbuild 打包服务端 → Node SEA 单文件可执行；并下载对应平台的 cloudflared。
// 产物放到 src-tauri/binaries/{pi-assistant-server,cloudflared}-<target-triple>[.exe]（Tauri externalBin 约定）。
// TODO(P1 收尾)：在 release 工作流的 mac/windows runner 上执行；签名/公证由 tauri-action 处理。
import { execSync } from "node:child_process";
const triple = execSync("rustc -vV").toString().match(/host: (\S+)/)[1];
console.log("target:", triple);
console.log("1) npx esbuild packages/server/src/main.ts --bundle --platform=node --format=cjs --outfile=dist/server.cjs");
console.log("2) node --experimental-sea-config sea-config.json && postject（Node 22 SEA）");
console.log("3) 下载 cloudflared 对应平台二进制并校验 sha256");
console.log("该脚本为骨架，见 docs/DESIGN.md「打包与发布」。");
