// 把 Worker 打包成单个 ES 模块（dist/worker.js），供 App 内“一键部署到你自己的 Cloudflare”使用。
import { build } from "esbuild";
await build({ entryPoints: [new URL("../src/index.ts", import.meta.url).pathname], outfile: new URL("../dist/worker.js", import.meta.url).pathname, bundle: true, format: "esm", target: "es2022", platform: "neutral", minify: true, legalComments: "none" });
console.log("rendezvous → dist/worker.js");
