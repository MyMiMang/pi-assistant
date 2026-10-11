// 命令行版“一键部署远程入口”：调用本机正在运行的胡好好服务的同一个 API（与设置页完全相同的流程）。
// 用法：CLOUDFLARE_API_TOKEN=... node scripts/deploy-rendezvous.mjs --zone example.com [--sub huhao] [--port 8787]
// Token 只通过环境变量传给本机服务，由服务加密保存，不会写进仓库或日志。
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const zone = arg("zone");
const subdomain = arg("sub", "huhao");
const port = arg("port", process.env.HUHAO_PORT ?? "8787");
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!zone || !token) {
	console.error("用法：CLOUDFLARE_API_TOKEN=... node scripts/deploy-rendezvous.mjs --zone example.com [--sub huhao]");
	process.exit(2);
}
const base = `http://127.0.0.1:${port}`;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.onmessage = (m) => {
	const e = JSON.parse(m.data);
	if (e.type === "cloudflare.progress") console.log(`${e.state === "ok" ? "✅" : e.state === "error" ? "❌" : "…"} ${e.step}${e.detail ? `：${e.detail}` : ""}`);
};
const res = await fetch(`${base}/api/remote/cloudflare/deploy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ zone, subdomain, token }) });
const j = await res.json();
ws.close();
if (!res.ok) {
	console.error("部署失败：", j.error);
	process.exit(1);
}
console.log(`\n远程入口：https://${j.config.hostname}`);
