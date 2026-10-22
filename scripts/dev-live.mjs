#!/usr/bin/env node
/**
 * 开发实测环境（决策 0021）：用真实模型渠道跑开发中的代码，不用每次打包再测。
 *  - 数据目录固定在 ~/.pi-assistant-dev（和装好的 App 完全分开），端口 8788（App 是 8787）；
 *  - 主密钥放在这个数据目录的文件里（PIA_SECRETS=file），不碰系统钥匙串；
 *  - 模型渠道由用户自己在 http://127.0.0.1:8788 里登录 / 填一次，之后一直用；
 *  - 只在这里实测，而且只用新建的测试助理和测试群。自动化测试（npm run check / e2e）照旧用 Mock。
 * 运行：npm run dev:live（会先构建网页）。
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = process.env.PIA_DATA_DIR ?? join(homedir(), ".pi-assistant-dev");
mkdirSync(dataDir, { recursive: true });
const port = process.env.PIA_PORT ?? "8788";
console.log(`开发实测环境：http://127.0.0.1:${port}（数据目录 ${dataDir}，真实模型，和装好的 App 分开）`);
const child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], {
	cwd: root,
	stdio: "inherit",
	env: { ...process.env, PIA_DATA_DIR: dataDir, PIA_PORT: port, PIA_SECRETS: "file", PIA_MOCK: "" },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
