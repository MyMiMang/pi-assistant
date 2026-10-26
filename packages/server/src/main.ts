import { backend as desktopBackend } from "./desktop/backend.ts";
import { closeAllBrowsers } from "./browser.ts";
import { startChannels, stopChannels } from "./channels/index.ts";
import { hostSettings, retryableDaemonFailure, setHostEnv, startDaemon, stopDaemon } from "./host-control.ts";
import { config } from "./config.ts";
import { getSetting } from "./db.ts";
import { startHttp } from "./http.ts";
import { startSetupWatcher } from "./setup-code.ts";
import { identity } from "./identity.ts";
import { initModels } from "./models.ts";
import { disposeClaudeCode } from "./claude-code-service.ts";
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
const { bootstrapRooms, migrateAutonomy, releaseAllHeld } = await import("./rooms/index.ts");
bootstrapRooms();
migrateAutonomy(); // 旧的「自主推进」迁移成一个 active 项目（幂等）
const { bootstrapWorkItems, startWorkWatch } = await import("./work-items.ts");
bootstrapWorkItems();
releaseAllHeld(); // 关键点前暂缓的任务：没有在等用户的关键点就放行一次
// 卡住检测 + 管理者定时检查（只检测和上报，不设次数 / 费用上限）
startWorkWatch();
(await import("./rooms/index.ts")).startRoomChecks();
await bootstrap();
startScheduler();
startProactive();
if (getSetting("remoteEnabled", false)) startTunnel();
setChatDefault(defaultModel);
// 有助理在用高级记忆时随服务启动 Hindsight（在后台，准备好之前读记忆走基础检索、写入排队）
if (hindsightInUse()) void sidecar.ensure();
// 聊天渠道：飞书 / 钉钉建立长连接，企业微信等回调
void startChannels();
// 用户开启过“操作这台电脑”：随服务启动 Cua 守护进程（清单与开启时确认的一致才会启动）。
setHostEnv({ workspaceOf, agentIds: () => listAgents().map((a) => a.id) });
// 完全权限：降权 / 暂停后中止正在跑的主机命令（每次工具调用仍由 hostFileAccess 动态判定）
initHostAccessWatch();
// 更新后重启时 Cua 偶尔来不及在 10 秒内就绪（下载 / 解压 / 上一个实例退出中），原来一次失败就再也不试，
// 用户回来只看到“电脑操作不可用”、以为授权被重置。这里改成有限重试，但每次失败都单独判定原因：
// 只有“还没就绪 / 下载中断”才重试；权限计划已变化或认不出的错误立即停下等用户（不改任何权限语义）。
if (hostSettings().enabled)
	void (async () => {
		for (const [i, wait] of [0, 2_000, 5_000].entries()) {
			if (wait) await new Promise((r) => setTimeout(r, wait));
			try {
				await startDaemon();
				if (i) console.log(`[host-control] Cua Driver 第 ${i + 1} 次启动成功`);
				return;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.warn(`[host-control] 启动失败（第 ${i + 1} 次）：${msg}`);
				// 每次失败都按当前错误重新判：第二次就算撞上真的权限变更，也不能再继续重试
				if (!retryableDaemonFailure(e)) return;
			}
		}
	})();

for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.on(sig, () => {
		// 助理电脑虚拟机（macOS Lima）/ 发行版（Windows WSL）：交给独立进程关机，不拖慢退出；登录状态在磁盘里不受影响
		disposeClaudeCode();
		desktopBackend().stopDetached?.();
		// Hindsight 守护进程是独立进程：退出前停掉它（最多等 6 秒）
		void Promise.race([Promise.all([sidecar.stop(), closeAllBrowsers(), stopDaemon(true), stopChannels()]), new Promise((r) => setTimeout(r, 6000))]).finally(() => process.exit(0));
	});
