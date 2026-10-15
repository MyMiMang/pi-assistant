import { backend as desktopBackend } from "./desktop/backend.ts";
import { closeAllBrowsers } from "./browser.ts";
import { startChannels, stopChannels } from "./channels/index.ts";
import { hostSettings, setHostEnv, startDaemon, stopDaemon } from "./host-control.ts";
import { config } from "./config.ts";
import { getSetting } from "./db.ts";
import { startHttp } from "./http.ts";
import { startSetupWatcher } from "./setup-code.ts";
import { identity } from "./identity.ts";
import { initModels } from "./models.ts";
import { migrateLegacyImageProviders } from "./image-gen/index.ts";
import { checkPiCompat } from "./pi-adapter/index.ts";
import { bootstrap, initHostAccessWatch, listAgents } from "./runtime.ts";
import { workspaceOf } from "./files.ts";
import { startTunnel } from "./tunnel.ts";
import { startScheduler } from "./routines.ts";
import { startProactive } from "./proactive.ts";
import { hindsightInUse } from "./memory/index.ts";
import { setChatDefault, sidecar } from "./memory/hindsight/sidecar.ts";
import { defaultModel } from "./models.ts";
import { recoverOnboardingFlag } from "./onboarding.ts";

const compat = checkPiCompat();
console.log(`[pi-assistant] ${compat.message}`);
await initModels();
// 幂等、非秘密的 legacy 生图凭据元数据迁移（不读、不复制明文；Key 桥接读取）
migrateLegacyImageProviders();
// 升级 / 旧数据：已配置但向导标志丢失时恢复，避免误弹首次向导覆盖原配置
recoverOnboardingFlag();
startHttp();
startSetupWatcher(Number(process.env.PIA_SETUP_CHECK_MS) || 60_000);
console.log(`[pi-assistant] 服务已启动：http://${config.host}:${config.port}${config.headless ? "  [服务器模式]" : ""}  数据目录：${config.dataDir}  serverId=${identity().serverId}${config.mock ? "  [Mock 模型已启用]" : ""}`);
const { bootstrapRooms } = await import("./rooms/index.ts");
bootstrapRooms();
await bootstrap();
startScheduler();
startProactive();
if (getSetting("remoteEnabled", false)) startTunnel();
setChatDefault(defaultModel);
// 有助理在用高级记忆时随服务启动 Hindsight（在后台，准备好之前读记忆走基础检索、写入排队）
if (hindsightInUse()) void sidecar.ensure();
// 聊天渠道：飞书 / 钉钉建立长连接，企业微信等回调
void startChannels();
// 用户开启过“操作这台电脑”：随服务启动 bounded 守护进程（清单与开启时确认的一致才会启动）
setHostEnv({ workspaceOf, agentIds: () => listAgents().map((a) => a.id) });
// 完全权限：降权 / 暂停后中止正在跑的主机命令（每次工具调用仍由 hostFileAccess 动态判定）
initHostAccessWatch();
if (hostSettings().enabled) void startDaemon().catch((e) => console.warn(`[host-control] ${e instanceof Error ? e.message : e}`));

for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.on(sig, () => {
		// 助理电脑虚拟机（macOS Lima）/ 发行版（Windows WSL）：交给独立进程关机，不拖慢退出；登录状态在磁盘里不受影响
		desktopBackend().stopDetached?.();
		// Hindsight 守护进程是独立进程：退出前停掉它（最多等 6 秒）
		void Promise.race([Promise.all([sidecar.stop(), closeAllBrowsers(), stopDaemon(true), stopChannels()]), new Promise((r) => setTimeout(r, 6000))]).finally(() => process.exit(0));
	});
