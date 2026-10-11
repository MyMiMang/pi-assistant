import { config } from "./config.ts";
import { getSetting } from "./db.ts";
import { startHttp } from "./http.ts";
import { identity } from "./identity.ts";
import { initModels } from "./models.ts";
import { checkPiCompat } from "./pi-adapter/index.ts";
import { bootstrap } from "./runtime.ts";
import { startTunnel } from "./tunnel.ts";
import { startScheduler } from "./routines.ts";
import { hindsightInUse } from "./memory/index.ts";
import { setChatDefault, sidecar } from "./memory/hindsight/sidecar.ts";
import { defaultModel } from "./models.ts";

const compat = checkPiCompat();
console.log(`[pi-assistant] ${compat.message}`);
await initModels();
startHttp();
console.log(`[pi-assistant] 服务已启动：http://${config.host}:${config.port}  数据目录：${config.dataDir}  serverId=${identity().serverId}${config.mock ? "  [Mock 模型已启用]" : ""}`);
await bootstrap();
startScheduler();
if (getSetting("remoteEnabled", false)) startTunnel();
setChatDefault(defaultModel);
// 有助理在用高级记忆时随服务启动 Hindsight（在后台，准备好之前读记忆走基础检索、写入排队）
if (hindsightInUse()) void sidecar.ensure();

for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.on(sig, () => {
		// Hindsight 守护进程是独立进程：退出前停掉它（最多等 6 秒）
		void Promise.race([sidecar.stop(), new Promise((r) => setTimeout(r, 6000))]).finally(() => process.exit(0));
	});
