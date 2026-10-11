import { config } from "./config.ts";
import { getSetting } from "./db.ts";
import { startHttp } from "./http.ts";
import { identity } from "./identity.ts";
import { initModels } from "./models.ts";
import { checkPiCompat } from "./pi-adapter/index.ts";
import { bootstrap } from "./runtime.ts";
import { startTunnel } from "./tunnel.ts";

const compat = checkPiCompat();
console.log(`[huhao] ${compat.message}`);
await initModels();
startHttp();
console.log(`[huhao] 服务已启动：http://${config.host}:${config.port}  数据目录：${config.dataDir}  serverId=${identity().serverId}${config.mock ? "  [Mock 模型已启用]" : ""}`);
await bootstrap();
if (getSetting("remoteEnabled", false)) startTunnel();

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
