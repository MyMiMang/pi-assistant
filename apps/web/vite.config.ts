import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		proxy: { "/api": "http://127.0.0.1:8787", "/ws": { target: "ws://127.0.0.1:8787", ws: true } },
	},
	build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
