# benchmark-production-fix：真实操控基准从「假可跑」修到「真可跑或明确 unsupported」

更新时间：2026-10-22（Asia/Shanghai）
树：`benchmark-production-fix`（worktree，基 `unified-final-review` `8d68f1e`，**本地提交，未 push / 未 tag / 未打包**）
边界：全程 Mock / 假 driver / 内存状态 / 临时数据目录；未开 hostpc、未跑助理电脑 VM、未碰系统钥匙串、未读 `secrets.ts` / SDK 凭据实现、未用真实 keys / 付费 API。开发用假 driver + 临时 Hono app 模拟 guest 访问，不做真实网络 / 系统设置改动。

## 修的是什么（unified-final-review 未修的 P0）

### 1. `capable` 硬编码 true → 动态、无副作用的能力探测（fail-closed）
- 新增 `packages/server/src/fast-computer/benchmark-capability.ts`：纯函数 `evaluateBenchmarkCapability`，依次判定
  「目标就绪 → 有隔离测试窗口来源 → cua MCP 暴露所需工具（`launch_app`/`list_windows`/`get_window_state`/`click`/`scroll`）
  → 助理电脑还有宿主可达网关」。缺任一条 `ok:false` + 中文原因。
- `benchmark-runtime.ts`：`refresh()` 里对默认目标做**只读 `tools/list`** 探测（不开窗、不派发），结果缓存成 `capable()`；
  `createMcpInvoke` 现在额外返回 `listTools(prefix)`。不再 `capable: () => ({ ok: true })`。
- `benchmark-driver.ts`：`capable` 不提供时默认 **fail-closed**（`ok:false` + 原因），不再默认 true。
- 隔离窗口来源：助理电脑（VM）天然隔离 + 需要宿主网关；**hostpc 必须显式提供隔离测试窗口**（`hostIsolatedWindow`），
  默认 false 并说明「不使用你的日常浏览器 profile」，避免把用户 first Chrome 当 sandbox。
- 并不写死永远 blocked：条件（隔离窗口 / 宿主网关）满足即 ready。

### 2. `scroll-target` 任务不可达 → 正式 backend `scroll` 的程序侧辅助
- `BenchmarkDriver` 打开 fixture 改用 **cua 原生 `launch_app({urls})`**（不再假设 `browser_navigate` 在 cua MCP 上；
  浏览器 `browser_*` 来自 ext-browser，不在同一 MCP）。`execute` 统一 `bareTool()` 去命名空间。
- `FastBenchmarkTask.programAssist.scroll`：第一轮观察前由程序用 `scroll` 工具**按方向**滚动（**不给坐标、不写 DOM 脚本、不透露 groundtruth**），
  之后交给快速模型在有界候选里只做 `click`。滚动计入新的 `TrialMetrics.programAssists` / 结果 DTO / UI「程序辅助（滚动，不计模型能力）」，
  **与模型能力分开计**，note 里也注明。
- 模型白名单仍只有 `click`（`BENCHMARK_ALLOWED_TOOLS`）；新增 `BENCHMARK_PROGRAM_TOOLS=["scroll"]` 仅程序侧使用。

### 3. 助理电脑 fixture 回调 `127.0.0.1` 不可达 → 受控宿主网关 + 明确 unsupported
- `RuntimeBenchmarkOptions.computerFixtureBaseUrl`：助理电脑 fixture 的宿主可达基址（受控 loopback 映射 / 反向代理）。
  **未配置 → 该目标 unsupported（fail-closed），绝不回退成 VM 里的 127.0.0.1，也不把 Pi 控制 API 暴露到 0.0.0.0**。
- fixture 状态上报收紧：必须同时带对 **nonce + 每次 run 的随机 run token**（`x-bench-fixture-token`），
  且来源必须是**回环 / 私有地址**（`isPrivateSource`，公网 403）。run token 只在服务端已 arm 后由 GET 页面烤进去，无长期 key。

### 4. fixture 状态 POST 任意伪造 success → 白名单 schema + 归属 + freshness
- `sanitizeBenchmarkStatePatch`：只接受 `clicked`/`selected`/`step` 白名单键且类型校验，出现未知键整条拒绝、不写入。
- `BenchmarkFixtureStateStore`：`arm(fixtureId, nonce, token)`；`record` 要求 nonce + token 都对且已 arm；记录 `updatedAt`；
  `getEvidence()` 返回 `{state, updatedAt}`；`reset` 清状态和时间戳。
- `validateTrial` 新增 freshness：机器状态被判 confirmed 但 `updatedAt` 早于本轮试次开始 / 缺失 → 降为 **unknown**，
  **旧状态 / 预置 / 模型自报都不算正证据**；仍要求「机器状态 + 独立 UI 观测」双证据。

### 保留（8d68f1e 已修，本树不动）
- `snapshot_id` 当窗口身份**不做相等比较**，只要求存在（拿到新鲜快照）+ prefix/pid/window_id/session/fixture_id 严格相等；
  动作前重新 `readWindow` 保持新鲜。窗口替换仍由 pid/window_id 变化拦住。

## 边界与未验
- **未在真实桌面跑 CUA**：本机未开 hostpc、未跑助理电脑 VM，真实 driver 路径仍未真机验证；能力探测、程序侧滚动、
  网关 / 隔离窗口的具体实现依赖真实后端，未实测。
- 助理电脑路径目前**没有**现成的安全宿主网关实现 → 线上默认 unsupported（明确原因），需要时由配置提供受控网关；
  这符合「若 guest gateway 无法安全通就 unsupported 明确而非 test pass 全 fake」。
- 未跑全量单测 / 全量 e2e；未写发布说明（用户未说打包）。

## 实际跑过（Node v24.20.0，Mock / 假 driver）
- 服务端 `tsc --noEmit -p .` → exit 0；网页 `tsc --noEmit -p apps/web` → exit 0。
- `fast-computer-benchmark.test.ts` + `fast-computer-benchmark-host.test.ts` **24/24**；
  连同 `fast-computer.test.ts` / `fast-computer-guard.test.ts` / `fast-computer-tool.test.ts` 共 **65/65**。
- 新增断言：能力探测五种 fail-closed 原因；程序侧滚动只给方向且计 `programAssists`、模型只 click；
  freshness 过期 / 缺失不能 confirmed；state 白名单 / token / 非 nonce / 公网来源拒绝。
