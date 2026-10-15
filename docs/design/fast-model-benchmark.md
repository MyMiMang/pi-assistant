# 快速操作模型 · 真实操控基准测试（fast-model-benchmark）

> 2026-10-22 用户纠正：**不是**测模型 API 连接 / 固定 choice 题的时延，而是让快速模型在**专用隔离的本地 fixture 测试窗口**里真实走一遍操控，评估它「适不适用（快不快 / 稳不稳）」。原 synthetic HTTP 时延方案作废，不作为交付。

## 1. 目标与不做

- 目标：点一个「测试速度」按钮，用**真实受控 CUA 执行**在隔离 fixture 窗口完成固定、有限、可判分的 synthetic 任务，给出 p50/p95 / 成功率 / 稳定性，并给 **advisory 建议**（慢 → 建议主模型/云端，仍可继续用；不稳 → 建议排查，**不封死配置**）。
- 不做：不测连接时延当结论；不把模型推理时延当推荐唯一依据；不自动跑付费模型列表；不接任意外部 URL / Key；不用 mock 冒充 real；不在用户点按钮前偷偷起虚拟机。

## 2. 真实执行闭环（与正式操控**同一条路径**）

```
读窗口身份(fail-closed) → 观察 get_window_state → 程序收集候选 → 快速模型选一个
  → 执行前重读窗口身份 + 候选新鲜度(role/value/actions 不变, 换新 element_token)
  → 经既有电脑工具钩子派发 click（权限/审批/暂停原样生效）
  → fixture 机器状态 reporter + 独立 UI 观测 双证据判分
```

- 覆盖：目标按钮、下拉选择、输入框、多步（含滚动/布局变化/歧义目标）。
- 快速模型**只 click**；type / 下拉项由**程序固定输入**完成，**不计入模型 typing 能力**（不为 benchmark 放大 fast 权限）。
- 多步任务每步都重新观察 → 选 → 派发（`FastBenchmarkTask.steps`）。

## 3. 安全边界（fail-closed）

- 动作**只作用**在给定 `BenchmarkWindow`（`prefix`+`pid`+`window_id`+`session`+**精确 `window_token`**+`fixture_id`）；每次派发前重读身份，任一不符 → `WindowIdentityError` → 整轮 `blocked`，绝不切到用户其它窗口 / app / 账号 / 文件 / 付款 / 发送。
- 候选工具白名单 = `["click"]`（`BENCHMARK_ALLOWED_TOOLS`）；非白名单动作记 `unknown`、不派发。
- 任务集合固定、有限、synthetic；不接任意外部 URL / Key。
- 判分**只用** fixture 机器状态 + 独立 UI 观测双证据，绝不采信模型自评。
- 用户电脑 host 工具当前**未开**：产品运行由用户点击授权；**本轮开发不实际操作用户电脑**；CI / 无真实 CUA 环境明确标 `blocked`，不 mock 冒充。

## 4. 共享结果 DTO（UI 直接渲染，不拆独立 config section）

`FastBenchmarkResult`（`packages/server/src/fast-computer/benchmark.ts`）：

| 字段 | 说明 |
|---|---|
| `id` / `status` | `running` \| `done` \| `cancelled` \| `blocked` \| `failed` |
| `provider` / `model` / `modelVersion` | 所选快速模型；版本未知写 `"unknown"` 不编造 |
| `target` | `{ prefix, fixtureId }`，只安全元数据 |
| `startedAt` / `finishedAt` / `createdAt` | UTC ISO |
| `warmup` / `samples` | 预热条数 / 有效样本数 |
| `coldStartMs` | **冷启动单独列，不进 p50/p95** |
| `p50Ms` / `p95Ms` / `p95Approx` | 端到端 request latency（含 network/queue），**不是** full CUA speed；样本 < `p95MinSamples`(20) → 粗略 |
| `timeouts` / `errors` / `successRatio` | 失败率 / 有效完成比 |
| `actions` / `retries` / `fallbackCount` / `abstains` | 动作数 / 重试 / 回退 / 弃权 |
| `correctness` / `correctTrials` | synthetic 正确率（**不等于**真实 task accuracy），未知 `null` |
| `note` | 诊断说明（推理时延仅诊断子项、样本少结论有限、type 不计模型能力…） |
| `advisory` | `{ verdict: ok\|slow\|unstable\|blocked, recommended, message, reason }` |
| `reason` | 中止 / 阻塞原因 |

**advisory 规则（不 hard-disable）**：
- `successRatio < 0.6` 或 `errors ≥ 3` → `unstable`，`recommended:false`，建议排查；
- `p50 > responseBudgetMs`（默认 1000，可配 500/1000，仅产品目标非行业标准）→ `slow`，`recommended:true`，仍可继续用；
- 否则 `ok`。

## 5. HTTP API（UI 对接）

| 方法 / 路径 | 行为 |
|---|---|
| `GET /api/fast-computer/benchmark` | `{ availability, runs: FastBenchmarkResult[] }` |
| `POST /api/fast-computer/benchmark` | body `{ provider, model, maxTrials?, warmup? }`；未就绪 → `409 { blocked:true, availability }`；成功 → `{ ok:true, run }` |
| `GET /api/fast-computer/benchmark/:id` | 单个 `FastBenchmarkResult`（可轮询进度） |
| `POST /api/fast-computer/benchmark/:id/cancel` | `{ ok }`，中止在跑试次，不再派发 |

`BenchmarkAvailability = { cuaReady, modelReady, fixtureReady, reasons: string[] }`：
- `POST` 前 UI **必须**先展示「真实操控测试、可能少量云端计费（仅云端分类器）、将测 N 题、可随时取消」；`local`（本地分类器）无需云。
- 任一 `ready=false` → UI 显示 `reasons` 并禁用开始；**local 未就绪提示先安装，不自动 pip/下载**。

## 6. 注入点（runtime / registry / UI 协作）

- `mountFastComputerRoutes(app, host?)`：默认 `unavailableHost`（全 blocked）。`http.ts` 现在实际注入 `createRuntimeBenchmarkHost({ agentId })`，不是「永无 host」。
- `BenchmarkHost.availability()`：目标电脑（`hostpc` 需开启「操作这台电脑」且 cua 守护进程在跑 / `computer` 需助理电脑运行中）、快速模型、fixture 是否就绪；任一不就绪 → 阻塞并给原因，**绝不偷偷开 VM**。
- `BenchmarkDriver`（`benchmark-driver.ts`）：`target(requested?)` / `capable()` / `openFixtureWindow` / `readWindow` / `observe` / `execute`。生产经统一 computer backend 的 MCP（`createMcpInvoke` → `get_window_state` / `list_windows` / `click`）；测试注入假 driver，源码仍是真路径。拿不到「独立受控窗口」证明时 `capable:false` → blocked，不假装 ready。
- `createBenchmarkHost`（`benchmark-host.ts`）：`start()` 只为本次运行打开受控 fixture 窗口并 pin `prefix/pid/window_id/session/window_token/fixture_id/nonce`；全局并发互斥；结束时**只关闭自己打开的那个 fixture 窗口 / 标签页**，绝不杀用户浏览器；每轮试次前重置 fixture 状态。
- fixture（`benchmark-fixture.ts`）：本地 sandbox HTML（多按钮选对 / 下拉展开选对 / 滚动后目标 / 动态布局两步），机器状态经 `POST …/fixture/:id/state?nonce=` 回传，`BenchmarkFixtureStateStore` 只接受被 `arm` 过的 `(fixtureId, nonce)`。
- 共享结果 DTO 只此一份：UI 渲染 `FastBenchmarkResult`，不要在 UI 侧再定义一套结果结构。

## 7. 未做 / 边界（本轮）

- **真实 CUA 运行仍未实测**：当前开发环境未开启「操作这台电脑」、也未启动助理电脑，`createRuntimeBenchmarkHost` 的 `refresh()` 探测到两者都没就绪 → availability 全 blocked。真实桌面上打开 fixture 窗口 / 执行动作**未在真实桌面上验证**。
- fixture 页 / 机器状态 reporter / host / driver 的**逻辑**已实现并用假 driver 的调用序列做了集成测试；CI / 无真实 CUA 环境明确标 `blocked`，不 mock 冒充 real。
- 未跑真实付费模型、未跑 GPU / desktop / App VM / keychain、未做全量 e2e；未真下载模型。
- 结果持久化只允许安全 metadata + timestamp，需提示「可能过时」；不永久判定机器性能优劣；缓存按 `provider/model/actualVersion/device` 区分，避免混用。
- 快速操控基准只测**本轮 bench task** 正确率（不是泛化 accuracy）；`fallbackCount` 只有在**真正执行了主模型回退**时才算，基准不执行回退 → 恒为 0。

## 8. 已实现文件

- `packages/server/src/fast-computer/benchmark.ts`：契约 + 可注入 runner（状态 / 取消 / 聚合 / advisory）+ 窗口身份 fail-closed + 双证据判分。
- `packages/server/src/fast-computer/benchmark-cua.ts`：真实 CUA 试验执行器（click 白名单、程序固定输入、逐次 fail-closed）。
- `packages/server/src/fast-computer/benchmark-fixture.ts`：本地 sandbox fixture（HTML + 任务集 + 机器状态存储，arm + nonce）。
- `packages/server/src/fast-computer/benchmark-host.ts`：`BenchmarkHost`（availability / 并发互斥 / 只关自有窗口 / 清理）。
- `packages/server/src/fast-computer/benchmark-driver.ts`：真实 driver 路径（统一 computer backend invoke + fixture 窗口身份 pin，capable fail-closed）。
- `packages/server/src/fast-computer/benchmark-runtime.ts`：运行时接线（目标探测 + MCP invoke），`http.ts` 实际注入。
- `packages/server/src/fast-computer/routes.ts`：`GET/POST /api/fast-computer/benchmark`、`GET /:id`、`POST /:id/cancel` + fixture 页 / 状态上报 + owner 过滤。
- `packages/server/test/fast-computer-benchmark.test.ts` + `fast-computer-benchmark-host.test.ts`：契约 13 项 + fixture/host/routes 7 项（假 driver 模拟真调用序列、0 真实付费 / 0 真实桌面）。
