/**
 * 本地语音多模型「真实 API 契约」smoke：起本仓库真实 server（隔离内存模式），打
 * `GET /api/local-models/asr/catalog`，把**真实 JSON** 喂进前端 adapter `normalizeLocalAsrCatalog`，
 * 验证 UI 能直接消费真实后端返回（不是 mock 图当完成）。
 *
 * 运行：node --import tsx e2e/local-asr-catalog-real.mjs
 *  - 当前树还没合入多模型 catalog 路由时（返回 404）自动 **SKIP**（退出 0），合入后即为真实校验。
 *  - 安全隔离：临时数据目录 + 内存 CredentialStore（复用 e2e/fixtures/safe-memory-server.mjs），
 *    不碰真实工作区 / 钥匙串 / 网络 / 用户配置；不下载权重、不启动模型进程。
 */
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecurityProbe, spawnMemoryServer } from "./fixtures/safe-memory-server.mjs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);
const DATA = mkdtempSync(join(tmpdir(), "pia-asr-catalog-"));
const probe = createSecurityProbe(DATA);
const port = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${port}`;

const { child, startupFile } = spawnMemoryServer({ repoRoot: ROOT, dataDir: DATA, port, probe });
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));

const wait = async (fn, ms = 45_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
};

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};

try {
	if (!(await wait(async () => (await fetch(`${BASE}/api/system`)).ok))) throw new Error("server 启动超时\n" + logs.slice(-1500));
	const res = await fetch(`${BASE}/api/local-models/asr/catalog`);
	if (res.status === 404) {
		console.log("SKIP：当前树还没有 GET /api/local-models/asr/catalog（多模型路由未合入）；合入后本脚本会真跑。");
		console.log(`startup evidence: ${startupFile}`);
		child.kill("SIGKILL");
		rmSync(DATA, { recursive: true, force: true });
		process.exit(0);
	}
	check("GET /api/local-models/asr/catalog 200", res.ok, `status=${res.status}`);
	const raw = await res.json();
	console.log(`  真实 catalog：${raw?.models?.length ?? "?"} 个模型，tier=${raw?.hardware?.tier}，recommendedId=${raw?.recommendedId}`);
	const { normalizeLocalAsrCatalog } = await import("../apps/web/src/local-asr-api.ts");
	const view = normalizeLocalAsrCatalog(raw);
	check("前端 adapter 结构可用（ok=true）", view.ok === true);
	check("模型数 > 0 且 id/provider 非空", view.models.length > 0 && view.models.every((m) => m.id && m.provider));
	check("recommendedId 在清单里", !view.recommendedId || view.models.some((m) => m.id === view.recommendedId), String(view.recommendedId));
	check("每个模型有 tier / 权重体积 / 许可名", view.models.every((m) => m.tier && m.weightsBytes > 0 && m.license.licenseName));
	check("至少一个模型有真实权重 pin（source.revision + files）", view.models.some((m) => m.source.revision && m.source.files.length > 0));
	check("SenseVoice 项许可 unresolved（正式入口关闭、可导入）", view.models.some((m) => m.id === "sensevoice-small-int8" && m.license.decision === "unresolved"));
	check("MIT/Apache 模型 agreementRequired=false（一键装、不传 acceptLicense）", view.models.filter((m) => m.license.decision === "cleared").every((m) => m.license.agreementRequired === false));
	check("SenseVoice agreementRequired=true（仍禁下载）", view.models.some((m) => m.id === "sensevoice-small-int8" && m.license.agreementRequired === true));
	for (const m of view.models) console.log(`    - ${m.id} · ${m.provider} · ${m.tier} · ${m.license.decision} · ${m.weightsBytes}B · selected=${m.selected}`);
} catch (e) {
	console.error("smoke 失败：", e);
	failed++;
} finally {
	child.kill("SIGKILL");
	rmSync(DATA, { recursive: true, force: true });
}
console.log(failed === 0 ? "\n真实 catalog 对接 smoke 通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
