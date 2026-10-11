// 把 Worker 打包成单个 ES 模块（dist/worker.js），供 App 内“一键部署到你自己的 Cloudflare”使用。
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url)); // Windows 上 URL.pathname 是 /D:/…，不能直接当路径
await build({ entryPoints: [p("../src/index.ts")], outfile: p("../dist/worker.js"), bundle: true, format: "esm", target: "es2022", platform: "neutral", minify: true, legalComments: "none" });
console.log("rendezvous → dist/worker.js");
