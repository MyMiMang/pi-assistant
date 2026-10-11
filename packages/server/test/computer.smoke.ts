/**
 * 助理电脑冒烟测试（需要 Docker 与 pi-assistant/desktop 镜像，不在默认 npm test 里）：
 *   PIA_DOCKER="sudo docker" node --import tsx test/computer.smoke.ts
 * 验证：容器启动 → 整屏截图 → Pi 会话通过 MCP 连上 cua-driver，工具出现且非 MIT 相关工具被隐藏。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { computerExtension, HIDDEN_TOOLS, MCP_PREFIX } from "@pi-assistant/ext-computer";
import { config } from "../src/config.ts";
import { cuaMcpCommand, screenshotDesktop, startDesktop, stopDesktop } from "../src/desktop.ts";
import { createPiSession, PiModels } from "../src/pi-adapter/index.ts";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "../src/pi-adapter/mock-provider.ts";
import { EncryptedCredentialStore } from "../src/secrets.ts";

const AGENT = "smoke";
const st = await startDesktop(AGENT);
console.log("desktop running on 127.0.0.1:" + st.port);
const png = await screenshotDesktop(AGENT);
assert.equal(png.subarray(1, 4).toString(), "PNG");
console.log(`screenshot ${png.length} bytes`);

const models = await PiModels.create({ credentials: new EncryptedCredentialStore(), modelsPath: null, allowNetwork: false });
await registerMockProvider(models);
const ws = join(config.workspaceRoot, AGENT);
mkdirSync(ws, { recursive: true });
const session = await createPiSession({
	models,
	cwd: ws,
	agentDir: join(config.agentsDir, AGENT),
	sessionDir: join(config.agentsDir, AGENT, "sessions"),
	model: { provider: MOCK_PROVIDER, id: MOCK_MODEL },
	systemPromptAppend: ["冒烟测试"],
	extensions: [
		{
			name: "computer",
			factory: computerExtension({ target: "sandbox", mcp: cuaMcpCommand(AGENT), isPaused: () => false, screenshot: () => screenshotDesktop(AGENT), handoff: async () => "已完成", request: async () => ({ approved: false }) }),
		},
	],
});
let tools: string[] = [];
for (let i = 0; i < 30 && !tools.some((t) => t.startsWith(MCP_PREFIX)); i++) {
	await new Promise((r) => setTimeout(r, 500));
	tools = session.getActiveToolNames();
}
const cua = tools.filter((t) => t.startsWith(MCP_PREFIX));
console.log(`cua-driver tools via MCP: ${cua.length}`, cua.slice(0, 8).join(", "), "…");
assert.ok(cua.length > 20, "应通过 MCP 拿到 cua-driver 工具");
assert.ok(cua.some((t) => t.endsWith("click")) && cua.some((t) => t.endsWith("type_text")));
for (const h of HIDDEN_TOOLS) assert.ok(!cua.includes(MCP_PREFIX + h), `${h} 应被隐藏`);
assert.ok(tools.includes("computer_screenshot") && tools.includes("request_handoff"));
session.dispose();
if (process.env.KEEP !== "1") await stopDesktop(AGENT);
console.log("✅ computer smoke ok");
process.exit(0);
