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

## 9. 隔离浏览器 pin 契约（cua-driver 0.35.4 **实测**，2026-10-17）

> 这一节替代此前「bind 就该给出 `snapshot_id`」的假设。beta.29 用户点「开始实际操作测试」后**必然**报
> 「隔离浏览器读不到可 pin 的快照 id（fail-closed）」，根因就是那条假设不符合驱动的真实返回。

### 9.1 两个模式返回的是**不同**字段

| 模式 | 入参 | 真实返回（实测抓取） |
|---|---|---|
| bind | `pid` + `window_id`（可选 `session`） | `{status:"ok", mode:"bind", binding_quality:"exact", binding_route:"native_cdp_window", endpoint_transport, endpoint_access_class, mutation_allowed:true, native_title, target_id:"bt-…", tabs:[{active:true, tab_id:"tab-…", title, url}]}` — **没有 `snapshot_id` / `snapshot` / 顶层 `url`**（bind 只证明「原生窗口 ↔ CDP target」，不开页面快照） |
| snapshot | `target_id` + `tab_id` + `snapshot_format:"semantic_v2"` | `{status:"ok", mode:"snapshot", target_id, tab_id, page:{title,url}, snapshot:{id:"p1", format:"semantic_v2", complete, omitted, continuation}, outline, refs:[{ref:"p1:0", role, name, actions}], content_refs:[…], oopif}` — **pin 是 `snapshot.id`（refs 前缀 `p<n>` 就是它）**，URL 在 `page.url`，**没有** `binding_quality` / `mutation_allowed` |

`browser_prepare{allow_launch:true, profile:{mode:"isolated_new"}}` 只返回 `prepared_pid`（+ `side_effects` / `endpoint_ownership`），**没有 `target_id` / `window_id`**。

### 9.2 适配层必须遵守的四条（已按此实现）

1. **bind 不要求 pin**：只校 `binding_quality=exact` + `mutation_allowed=true` + `target_id` + `tabs[]`（唯一 `active:true`，否则只有一个标签时用它）。tab_id 来自 `tabs[]`，不是顶层。
2. **pin 只从快照拿**：`snapshot.id`；兼容旧 `dom_refs_v1` 的顶层 `snapshot_id` / `state_id`。**拿不到就 fail-closed，绝不自己编 id**。
3. **动作前复核不能再取快照**：驱动的新快照会作废旧 ref（官方「a newer snapshot stales the tokens」）。身份复核复用**刚刚观察到的那个 pin**，否则会把自己即将点击的目标弄成 stale（表现为：点击返回成功、页面毫无变化、机器证据为空）。
4. **浏览器 fixture 的观察/动作走浏览器能力**：原生 AX **看不到网页内容**（Chrome 后台窗口只暴露工具栏），所以 `observe` 用 `get_browser_state` 的 `refs`/`content_refs` 归一成同一套 `elements`，动作走 `browser_click{target_id,tab_id,ref}`，程序侧滚动走 `browser_pointer{action:"scroll",delta_y}`（需 ref 或视口坐标）。

### 9.3 其它实测坑（都已修）

- `get_window_state` **没有** `require_complete` 参数，传了会被驱动整调用拒绝（`unknown argument require_complete`）；要结构化 token 用 `tree_format:"elements"`，并抬一个**有限**的 `max_elements`（默认 250 对大页会截断）。
- 机器证据是页面**异步 POST**：动作返回 ≠ 上报已到，判分前要有界等待本轮新证据（2.5 s / 120 ms 轮询），否则把成功误判成「证据不足」。
- fixture 的 `role=status` 容器在 CDP 里 `name` 为 null、文本落在子 `statictext` 上；状态节点要带 `aria-label` 才在两边都读得到（独立 UI 证据）。
- 原生 `<select>` 的弹层是 OS 级窗口，后台拿不到 option 的可点 ref（`browser_ref_stale`）；fixture 的下拉改用自定义按钮选项。
- 错误要收敛成一行可读原因（`shortError`），不把整段协议/AX payload 抛到设置页。

### 9.4 第二轮收口（2026-10-17，同分支；**未再起真实浏览器**）

1. **派发前必须重新观察**：旧代码把 `choose` 之前那次 `observe` 的快照当成「新快照」传给 `resolveFreshCandidate`，模型推理期间页面若变了（按钮改名 / 消失 / 出现第二个同名目标）根本验不出来。现在 `choose` 之后**再 `observe()` 一次**（浏览器 fixture 会拿到新 `snapshot.id` + 新 refs；原生窗口拿到新 `element_token`），用这次的结果做新鲜度校验与派发；观察失败按 `unknown` 返回、不派发。**注意**：身份复核（`readWindow`）仍复用这次观察的 pin，不再额外取快照（否则作废即将点击的 ref，见 9.2 第 3 条）。
2. **导航重试只认导航超时**：旧条件 `/navigate|timed out|timeout/i` 会把任何含 `navigate` 字样的错误（含权限桥拒绝、绑定失败、传输错误）也重试一次，等于把 fail-closed 变成猜。现在必须同时命中 `Page.navigate` 与 timeout 字样才重试一次；fixture 是幂等 GET，重放不改状态，成功与否仍以真实快照的 URL+nonce 复核为准。
3. **owner 不一致在绑定阶段就失败**：驱动若在快照 / 绑定里报了一个**不等于本次 `prepared_pid`** 的 owner，说明无法证明这个页面属于本次启动的隔离浏览器 → 直接抛错，不再返回「能用但不关」的 handle。关闭与打开中途失败的清理走**同一条**路径，只针对本次 `prepared_pid`（不认后续快照里报的任何 pid）。**局限（如实）**：pid 在几秒内被系统复用给别的进程时这层无法区分（没有进程启动时间可比）。
4. **原生进程环境与服务的合成 HOME 分离**：隔离启动时服务用临时 HOME（凭据 / 数据隔离），但守护进程与它拉起的系统 Chrome 必须拿到 OS 账户家目录（见 `DESIGN.md` §5.19.3）。**已证**的是合成 HOME 会被传给原生进程（会把驱动缓存 / 家目录指到临时目录）；「Chrome 弹找不到钥匙串是因为这个」只有时间相关，macOS 因果未验。
   - **MCP 通道必须全量替换环境**：Pi `StdioTransport` 默认 `{...process.env, ...env}`，只传“删过键”的 env 删不掉任何东西（`CFFIXED_USER_HOME` / 合成 `TMPDIR` 会从父进程回来）。所以走项目自有 `nativeLaunchCommand()` + `src/mcp-env-launcher.mjs`（argv 只带键名与非敏感 HOME，不把整份环境塞进 argv）。证据：`test/native-launch-env-stdio.test.ts` 用**真实 `StdioTransport`** 起只回显白名单的无害子进程，先复现红再证明绿。
   - **清理前证明归属**：`releasePrepared()` 在 `kill_app` 前用当前 `list_windows(pid)` 复核「同一个 window_id 仍属于同一个 pid」（还没 pin 到窗口时要求该 pid 当下确实持有窗口），证明不了就**不杀**并 `console.warn` 留痕。不再按历史 pid 盲杀（PID 复用会误杀别人的进程）。

**未验**：以上 1–3 只有假 invoke / 假 deps 的定向单测（`fast-computer-benchmark*` 37/37），**没有再跑真实隔离浏览器**（等主会话给测试槽许可 + 新鲜进程状态）；「钥匙串弹窗已修好」属未证。

### 9.5 已验收的证据（真实驱动，非 mock）

`scripts/laya-benchmark-driver-smoke.mjs`（手动运行，不进默认 `npm test`）：真实 `cua-driver mcp --socket …` → `browser_prepare`（隔离 new）→ `list_windows` → bind → `browser_navigate` → 快照 pin → 真实 fixture HTTP 页 → 真实 `browser_click` → 双证据判分。**chooser 是脚本固定的（按 label 关键词选），所以它证明的是 driver / 隔离窗口 / fixture / 动作 / 判分链路真实可用，不评估 Laya 的选择质量**；模型质量要另跑真实 benchmark。2026-10-17 本机实测 4/4 任务 `correctness:"correct"`（pin 形如 `p4`）。该 smoke 的 chooser 固定、**只证链路**。

### 9.6 环境污染验证的正确做法（计划，**未运行**，等主 review 授权）

为什么不能拿现有 smoke 证明“环境已修”：

1. `scripts/laya-benchmark-driver-smoke.mjs` 过去默认连**已安装 App 的守护进程 socket**（生产 Laya 用的那个）；而且**改 MCP 的 env 不会改已运行 daemon 的环境**——daemon 早就带着旧环境起来了。所以即使脚本跑绿，也不能说明 daemon 侧污染已解决。现在脚本**必须显式**给 `PIA_CUA_SOCKET`，否则直接退出（不再默认连生产 socket）。
2. 正确验收（待授权，单独测试槽）：
   - 起一个**本次独占**的 daemon：独立 `PIA_DATA_DIR`（socket 落在它下面）+ 本次专用 `CUA_DRIVER_BROWSER_PROFILE_ROOT`，环境明确是原生（`HOME` = OS 账户家目录、无 `CFFIXED_USER_HOME`、无合成 `TMPDIR`）；
   - 用生产同一套 `hostMcpCommand()`（启动器 + 全量替换）连它，跑 §9.5 的链路；
   - 只启**一个**自有浏览器；结束时 `finally` 关自有浏览器并 `stop` 自有 socket 的 daemon，**不碰生产 App 的 socket / Laya**；
   - 证据：daemon 启动时的 env 断言（白名单：HOME / CFFIXED / TMPDIR 三个布尔与值）+ 驱动自报 pid + 真实动作双证据；不打印其它 env、不读 token / credentials。
3. 真实 Laya 能力验收要走**生产的 `buildChooser` / `selectFastAction`**，不能用脚本关键词 chooser 冒充（那样只是链路 smoke，不是模型 4/4）。优先用本机回环桥接**已运行**的 Laya 服务；不得读 token / credentials；若只能自建 runtime，必须用正式 API 停掉原进程并外部 `finally` 恢复。
4. 本分支当前**没有**跑任何真实浏览器 / 驱动 / 模型（测试闸门未通过）：§9.4 的 1–4 只有假 invoke / 假 deps 的定向单测。
