import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export default defineConfig({
	plugins: [react(), tailwindcss(), brand()],
	server: {
		port: 5173,
		proxy: { "/api": "http://127.0.0.1:8787", "/ws": { target: "ws://127.0.0.1:8787", ws: true } },
	},
	build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
