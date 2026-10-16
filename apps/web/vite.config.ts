import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { BRAND } from "../../packages/shared/src/index.ts";

/** 把静态文件（index.html、manifest、sw.js）里的 %BRAND_NAME% 替换成品牌名（packages/shared 是唯一定义处）。 */
function brand(): Plugin {
	const rep = (s: string) => s.replaceAll("%BRAND_NAME%", BRAND.name);
	let outDir = "dist";
	return {
		name: "brand",
		configResolved: (c) => void (outDir = c.build.outDir),
		transformIndexHtml: rep,
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const f = req.url === "/manifest.webmanifest" ? "manifest.webmanifest" : req.url === "/sw.js" ? "sw.js" : null;
				if (!f) return next();
				res.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : "application/manifest+json");
				res.end(rep(readFileSync(join(import.meta.dirname, "public", f), "utf8")));
			});
		},
		// 用 writeBundle（产物写盘后）而不是 closeBundle：Vite 8 + rolldown 下 closeBundle 早于写盘，
		// 会读不到 dist/manifest.webmanifest。
		writeBundle() {
			for (const f of ["manifest.webmanifest", "sw.js"]) {
				const p = join(import.meta.dirname, outDir, f);
				writeFileSync(p, rep(readFileSync(p, "utf8")));
			}
		},
	};
}

/**
 * 给静态资源预生成 gzip 旁路文件（`foo.js` → `foo.js.gz`）。
 *
 * 服务端 `serveStatic({ precompressed: true })` 会在客户端 Accept-Encoding 含 gzip 时直接发 .gz，
 * 避免每个请求现压 1.3MB 的 JS bundle。只压文本类、且压缩后确实更小的文件；
 * 图片 / 字体 / 已压缩格式不生成（二次压缩无收益还浪费磁盘）。
 */
function precompress(): Plugin {
	// 与浏览器 / 服务端能安全重编码的文本类型一致；不含 png/ico/woff 等已压缩格式。
	const COMPRESSIBLE = /\.(?:js|mjs|cjs|css|html|svg|json|webmanifest|txt|map)$/i;
	let outDir = "dist";
	const walk = (dir: string, out: string[] = []): string[] => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p, out);
			else if (e.isFile() && COMPRESSIBLE.test(e.name) && !e.name.endsWith(".gz")) out.push(p);
		}
		return out;
	};
	return {
		name: "precompress",
		apply: "build",
		configResolved: (c) => void (outDir = c.build.outDir),
		// writeBundle：产物写盘后再压，brand() 的品牌替换已完成。
		writeBundle() {
			const abs = join(import.meta.dirname, outDir);
			for (const p of walk(abs)) {
				const src = readFileSync(p);
				const gz = gzipSync(src, { level: 9 });
				if (gz.length < src.length) writeFileSync(`${p}.gz`, gz);
			}
			console.log(`precompress: 已为 ${relative(import.meta.dirname, abs)} 下文本资源生成 .gz`);
		}
	};
}

export default defineConfig({
	plugins: [react(), tailwindcss(), brand(), precompress()],
	server: {
		port: 5173,
		proxy: { "/api": "http://127.0.0.1:8787", "/ws": { target: "ws://127.0.0.1:8787", ws: true } },
	},
	build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
