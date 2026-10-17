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

**当时的验证范围**：以上 1–3 先只有假 invoke / 假 deps 的定向单测（`fast-computer-benchmark*` 37/37）。**2026-10-17 已在真实隔离 daemon + 真实隔离浏览器上跑通**（§9.7）：1–3 的行为在真实链路上生效，4 个任务里没有出现 ref 作废 / owner 不符 / 绑定失败。「钥匙串弹窗已修好」仍属未证（见 §9.7 边界）。

### 9.5 已验收的证据（真实驱动，非 mock）

`scripts/laya-benchmark-driver-smoke.mjs`（手动运行，不进默认 `npm test`）：真实 `cua-driver mcp --socket …` → `browser_prepare`（隔离 new）→ `list_windows` → bind → `browser_navigate` → 快照 pin → 真实 fixture HTTP 页 → 真实 `browser_click` → 双证据判分。**chooser 是脚本固定的（按 label 关键词选），所以它证明的是 driver / 隔离窗口 / fixture / 动作 / 判分链路真实可用，不评估 Laya 的选择质量**；模型质量要另跑真实 benchmark。2026-10-17 本机实测 4/4 任务 `correctness:"correct"`（pin 形如 `p4`）。该 smoke 的 chooser 固定、**只证链路**。

### 9.6 环境污染验证的正确做法（计划；**2026-10-17 已按此执行，结果见 §9.7**）

为什么不能拿现有 smoke 证明“环境已修”：

1. `scripts/laya-benchmark-driver-smoke.mjs` 过去默认连**已安装 App 的守护进程 socket**（生产 Laya 用的那个）；而且**改 MCP 的 env 不会改已运行 daemon 的环境**——daemon 早就带着旧环境起来了。所以即使脚本跑绿，也不能说明 daemon 侧污染已解决。现在脚本**必须显式**给 `PIA_CUA_SOCKET`，否则直接退出（不再默认连生产 socket）。
2. 正确验收（待授权，单独测试槽）：
   - 起一个**本次独占**的 daemon：独立 `PIA_DATA_DIR`（socket 落在它下面）+ 本次专用 `CUA_DRIVER_BROWSER_PROFILE_ROOT`，daemon 那一侧的环境明确是原生（`HOME` = OS 账户家目录、无 `CFFIXED_USER_HOME`、无合成 `TMPDIR`）——但**服务进程自己仍必须用临时 HOME / TMPDIR**（不得把“原生子进程需要真实 HOME”误推到服务进程上）；
   - 用生产同一套 `hostMcpCommand()`（启动器 + 全量替换）连它，跑 §9.5 的链路；
   - 只启**一个**自有浏览器；结束时 `finally` 关自有浏览器并 `stop` 自有 socket 的 daemon，**不碰生产 App 的 socket / Laya**；
   - 证据：daemon 启动时的 env 断言（白名单：HOME / CFFIXED / TMPDIR 三个布尔与值；这是**交给启动器的输入配置**，不是从子进程读回的实际环境）+ 驱动自报 pid + 真实动作双证据；不打印其它 env、不读 token / credentials。
3. 真实 Laya 能力验收要走**生产的 `buildChooser` / `selectFastAction`**，不能用脚本关键词 chooser 冒充（那样只是链路 smoke，不是模型 4/4）。优先用本机回环桥接**已运行**的 Laya 服务；不得读 token / credentials；若只能自建 runtime，必须用正式 API 停掉原进程并恢复。**恢复的覆盖边界要写清**：进程内清理（finally 路径 + 到点 abort）不等于外部 watchdog，进程被 SIGKILL / OOM 时不保证恢复（2026-10-17 本轮就是只有进程内清理，不得写成“已覆盖”）。
4. ~~本分支当前没有跑任何真实浏览器 / 驱动 / 模型~~：**2026-10-17 已按本节执行真实验收**（独占 socket daemon + 驱动自有隔离浏览器 + 真实本地 Laya）。实际执行了**两轮**（授权是一次，已记为偏差），结果与限制见 §9.7。

### 9.7 真实验收结果（2026-10-17，隔离 daemon + 真实 Laya 4 题）

脚本 `scripts/laya-benchmark-isolated-harness.mjs`（手动运行，不进 `npm test`；`npm run smoke:laya-benchmark` 同一条）。**主审后入口 fail-closed**：必须由 `scripts/laya-benchmark-supervisor.mjs` 经 fd 3/4 握手启动（见 §9.9）；服务进程临时 HOME 版本的修复尚未在真实链路重跑，见本节末尾「主审后边界」。它不是另一套实现，跑的都是生产件：`nativeLaunchEnv`（原生边界）/ `hostMcpCommand`（自有启动器，`inheritEnv:false`、环境全量替换）/ `cua-driver serve`（macOS LaunchServices 打开官方签名 `CuaDriver.app`）/ `createInvokeBenchmarkDriver`（`browser_prepare{isolated_new}` → `list_windows` → bind → `browser_navigate` → 快照 pin → `browser_click`）/ `LocalLayaManager` / `buildChooser` / `selectFastAction` / `createCuaTrialRunner` / fixture 双证据判分。

**证据（repo 内）**：`evidence/laya-benchmark-real/report-2026-10-17T12-34-52-131Z.json`（含 raw chooser 诊断）与 `report-2026-10-17T12-33-19-290Z.json`（同一流程、无诊断），日志同目录 `run-*.log`。**本轮实际跑了两轮（授权只给了一次）**，JSON 原始证据不改；表格只取第二轮 scored 数据，第一轮仅供参考。

**隔离与环境（本次实测值）**
- 宿主与 daemon 白名单三项：`HOME=/Users/dengdeng`（= OS 账户家目录）、`CFFIXED_USER_HOME` 不存在、`TMPDIR=/var/folders/…/T`（不在合成根内）；`nativeLaunchEnvProblems` 返回空；`strippedKeys:[]`、`diverged:false`。**这里的 `env.daemon` 是算出来交给启动器的 env 输入配置，没有读取 daemon / Chrome 子进程的实际环境**（新脚本已把这个边界写进 `env.daemon.evidenceScope`）。另：当时**服务进程自己也是原生 HOME**，违反“服务 HOME 必须是临时目录”的隔离要求，已记为缺陷（见下节）。
- 独占 daemon：`/tmp/pia-lb-…/data/host-control/cua-open.sock`，自报 pid `20158`（第二次 `24761`），`permission mode: unrestricted`，工具清单含 `browser_prepare/browser_navigate/get_browser_state/browser_click/browser_pointer`。**生产 App 的 daemon（pid 22313，`~/Library/Application Support/Pi Assistant/host-control/cua-open.sock`）全程未被停止 / 未被复用**。
- MCP 走生产 `hostMcpCommand()`：`commandIsLauncher:true`、`inheritEnv:false`、`envReplaced:true`、socket 指向本次独占 daemon。
- 隔离浏览器（驱动自有）：prepared pid `20461` / window `17463` / `target_id bt-238383f8-…` / `tab_id tab-e5420be6-…` / 快照 pin `p1`；URL 带本次 `fixtureId+nonce`。结束后该 pid 已退出，无残留。
- 真实 Laya：baseline 生产 runtime `running pid 7991 port 60869`（health mps）→ 经生产 API `POST /api/local-models/laya/stop` 停下 → 本次独占 runtime（自有端口 + 自有 token，token 只记摘要 `05891f2f7bb5`，权重用本机已物化目录的 **clonefile 副本**，不写回原目录）→ 清理路径停自有 runtime 并 `POST /api/local-models/laya/start` 恢复。**两轮各自停 / 起一次生产 runtime**：第一轮恢复为 `pid 22676 port 49806`，第二轮再停再恢复为 `running pid 27010 port 50418, health ok, device mps, registered local-laya/multilingual`（主审只读 GET 独立确认最后状态）。

**4 题结果（生产 `selectFastAction`，threshold 0.6 / timeout 4000ms，按任务分开熔断作用域）**

| 任务 | 模型 decision | confidence | 决策延迟 | 结果（双证据） |
|---|---|---|---|---|
| pick-submit（点「提交」） | fallback `low_confidence` | **0.3816** | 105 ms | unknown（未派发） |
| pick-city（下拉选「北京」） | fallback `low_confidence` | 0.1854 | 107 ms | unknown（未派发） |
| scroll-target（滚动后点「深度目标」） | selected | 0.926 | 158 ms | **correct**（machine `clicked=deep-target` + UI「深度目标完成」） |
| dynamic-2step（下一步→完成） | fallback `low_confidence` | 0.2593 | 167 ms | unknown（未派发） |

预热 1 条（不计分）：第二轮 `fallback low_confidence 0.3969`，929 ms（冷启动；第一轮预热 `0.4673` / 1136 ms）。汇总：**1/4 correct、successRatio 0.25、fallback 3（全部 low_confidence）、timeout 0、abstain 0、p50 107 ms / p95 167 ms**；两轮结论一致（第一轮 conf 0.3693 / 0.1165 / 0.9597 / 0.3204，同样 1/4）——但两轮本身偏离授权，只作对照。

> **数字读法**：`pick-submit` 的 `0.3816` 来自 `tasks[0].fallbackDetail`（scored）；`0.3969` 是 `warmup.fallbackDetail`，旧表误填进结果列。`p50`/`p95` 只统计每题**最后一次 chooser 调用**的决策延迟，不是任务总耗时（`wallMs` 105–2810 ms），也不含诊断的额外请求。

**诊断（不是生产决策路径）**：对 3 条被阈值拦下的任务，额外用**同一个生产 chooser** 再推理一次「本来想选谁」（只记录、不执行、不计入上面的结果）。**这是额外的模型请求**，本轮只能说明：那一次诊断的**首步候选**与期望目标一致（`提交` 0.6277、`城市` 0.1935、`下一步` 0.1813）；**没有**执行下拉展开、**没有**完成 2step，所以**不是任务准确率**，也不能反推“原始 decision 其实正确”。同题不同调用置信度会变（`pick-submit` 生产那次 `0.3816`、诊断那次 `0.6277` > 0.6），因此**不写**「选得对但没信心」「raw 3/3」。没有为了“通过”下调阈值或改用脚本 chooser。

**主审后边界（2026-10-17，不改原 JSON、不重跑）**
- **执行偏差**：授权是一次受控验证，实际跑了两轮（`12:33:19` / `12:34:52`），生产 Laya 因此被停 / 起两次；两轮不合并统计。
- **隔离违规**：本轮服务进程跑在原生 HOME（脚本当时还把它当通过条件），违反“服务 HOME / DATA / WORKSPACE / TMPDIR 用临时目录”。脚本已改：临时 HOME/TMPDIR 在**任何第三方 / 服务模块动态 import 之前**设置，原生边界只从 `cloneNativeBaseEnv(process.env)` 快照经 `nativeLaunchEnv()` 计算；纯函数测试 6/6。但**这条链路没有在真实 daemon / 浏览器上重跑**，所以入口必须经 supervisor 握手（直接运行 exit 3），需受控重测。
- **证据范围**：`env.daemon` 是交给启动器的 env **输入配置**，没有读取 daemon / Chrome 子进程实际环境；能证明的是“按这份配置启动且 daemon 起来了、链路真的打开过浏览器”。
- **不是完整 production benchmark**：熔断 key 按任务分开（生产 `benchmark-host` 同一 key）+ runner 内部 retries（每题 1）+ 诊断额外请求；`p50` 只是每题最后一次 chooser 调用的决策延迟（不是任务总耗时）；主模型接管**未执行**，所以没有接管速度 / 总耗时数据；四个固定任务只是 attempt coverage，不是完整 UI / benchmark-host 验收。
- **计数器语义**（不是矛盾）：`task.retries=1` = runner 的未选中诊断；`task.fallbackCount=0` = 基准不真的执行主模型回退；summary `fallbacks=3` = `decision=fallback` 计数。
- **清理只覆盖进程内**（§9.7 那一轮）：正常清理路径 + 单次到点 abort + `unhandledRejection`/`uncaughtException`；当时**没有外部 watchdog**，进程被 SIGKILL / OOM / 掉电时不保证停自有 daemon / 恢复生产 Laya。旧注释“第二次到点强制落盘”是错的，已删。外部 supervisor 见 §9.9（已实现 + 假 worker 测试，**未在真实 daemon / 模型上重跑**）。
- **e2e helper**：`diverged` 修复归 Fast `44047ea`（独立文件），本树不重复改、合入时以那份为准。

**结论（如实）**
- 链路：修复后的原生启动环境 + 独占 daemon + 驱动自有隔离浏览器 + 真实 fixture 动作 + 双证据判分**在真实机器上跑通**，`browser_prepare → bind → snapshot pin → click` 全部有真实返回证据（但服务进程当时是原生 HOME，隔离验收要等重跑）。
- 模型：本机 `local-laya/multilingual` 在这 4 个固定任务上按产品默认阈值只完成 1 题（3 题低置信度回退），**不据此宣称 Laya 整体不可用**（只有 4 题、synthetic、单一 checkpoint / 机器）。
- 未验 / 不得宣称：「钥匙串弹窗已修好」仍未证（两轮都没弹窗，但没有系统弹窗日志，不能当永久修复结论）；服务进程临时 HOME 版本未重跑（isolated 验收待做）；系统 TCC 授权、Intel / Windows / Linux、真实 GPU、其它 checkpoint、真实付费模型、全量 `npm test` / 全量 e2e 均未跑。


### 9.8 置信度标度错误与同题浮动（2026-10-17 只读审计 + 代码修复；**本轮没有跑模型，未重测**）

§9.7 那 4 题为什么「3 题低置信度」有两种完全不同的解释：模型真的没把握，或者**产品拿错了数字**。这一节把能只读证实的那部分定死，并修掉；量级留给下一次单次受控测量。

**已证（公开源码，不需要跑模型）**

- Laya 的 choice 答案里 `confidence` 是**归一化 Shannon 熵**，不是概率：
  - `laya/agent.py` choice 分支：`"confidence": confidence_from_probs(p, k)`、`"answer_confidence": answer_confidence(p, k)`；
  - `laya/common.py:802 confidence_from_probs` = `1 - H/log(k)`，自己的文档写「not calibrated … the two must **not** be compared against the same threshold」，并且**随选项数 k 变化**；
  - `laya/common.py:779 answer_confidence` = `max(p)`，是「temperature scaling 拟合 / 所有 ECE 数字 / `min_confidence` 门限」用的那个量；`laya/confidence.py:_gate_confidence` 也优先用它。
- Jev 标度上的换算是 Laya 公开提供的（`laya/confidence.py:jev_confidence`、issue #302）：`choice = (max(p) - 1/n) / (1 - 1/n)`；文档还写「a threshold carried over from Jev selects about twice as much on Laya」。
- Pi SDK（`pi-ai/dist/api/system-one-shared.js`）只解析 `choice` / `probabilities` / `confidence`，**`answer_confidence` 被丢掉** → 产品只能由 `probabilities` 自己换算。
- 本地已物化的 `laya-multilingual`（`local-laya/runtime/weights/rl_agent_config.json`）`temperature=[1,1,1]`、无 `binning_map` → 该 checkpoint 的 `answer_confidence` 就等于 `max(p)`；同时**温度未拟合 = 官方说的 over-confident**，所以任何阈值都不能读成「准确率」。
- **纯数学的一条（只说明标度差异，不是必然结论）**：在「k=32、`max(p)=0.6`、其余概率均分」这一种形状下，熵约 `0.41`（会被 0.6 拒），Jev 标度约 `0.587`（也在 0.6 以下）。熵不是只由 `max(p)` 决定，随 k 和剩余质量分布变化，所以**不能**写成「候选越多必然被拒」；能确定的是：旧实现拿熵比 0.6，与 Laya 自己文档「不能和 max(p) 用同一个阈值」冲突，且实际把 3 次答案判成了低可信。
- **同题浮动的已知干扰源**：`captureId` 原来每次随机生成（`cap-<seq>-<time36>`），而它进 classifier 的 `state`、被 Laya 整体 `json.dumps` 进模型输入（`laya/common.py:serialize_state`）。模型是 `eval()` + argmax、无采样（`agent.py:794/903`），但这**不保证 MPS 跨进程逐位一致**（内核 / 线程调度可能带来极小数值差异），所以不能断言「同一输入必然同一分布」或「0.3816 / 0.6277 只能来自输入不同」。能确定的是：随机 capture 是**已证存在的干扰源**，页面状态本身也会变；它的**量级**没有测出来，不是已证主因。

**修法（adapter / 编排层，不碰 Pi / driver / node_modules；阈值与用户设置不动）**

- `choosers.ts` 新增 `jevChoiceConfidence()`：由 `probabilities` 按上面那个 Jev 公式换算（总和归一、**返回原始精度**、单候选 / 重复空 id / 越界概率不合成），`parseClassifierChoice` 返回 `decisionConfidence`；协议 `confidence` 原样保留。**只取整展示、不取整比较**（`0.59996` 不会因四舍五入变成 `0.6`）。
- `parseClassifierChoice` 要求 wire `choice` **就是唯一最高概率的候选**：否则（选 b 但 a 是 max(p)）判 `abstain`，不拿 a 的概率给 b 过门；并列最高同样不可执行。
- `selectFastAction` **比阈值用 `decisionConfidence`**，缺失时退回协议 `confidence`（不合成）；回退详情同时给「选项概率 / 协议 confidence / 比较值」，`fast_pick_action` 的文案同样分开显示。
- `registerCapture` 改**每次调用唯一**（`cap-<随机>`），只作进程内新鲜度 / 授权 pin，**不进模型输入**（classifier context 只有 goal + 候选 id/label，同 goal/候选输入完全一致）；同一 key 的新 capture 作废旧 capture，并发下旧结果得到 `capture_invalid`，不会落到新 capture 的 args（内容寻址会让同 id/label 的两次登记撞同一个 id，存在 ABA）。
- 顺带修（同一批，见 HANDOFF）：熔断不再把「用户取消」算成失败、保存设置会清熔断（换模型 / 改阈值后可重试）；`circuit_open` 文案改成「只有保存设置 / 重启会清熔断，重新读取窗口不会」（不再暗示重读可绕过）；`fast_pick_action` 回退提示明确由主模型在当前会话自己继续、必要时先重读窗口，程序不会另发模型请求。

**未验（如实）**：本轮**没有**起模型 / 浏览器 / daemon，所以「把那 4 题的数字换到新标度后到底过不过阈值」仍是未知；也不宣称 Laya 准确率、不宣称修复后 4 题会通过。**confidence 语义已证影响的是「能不能过阈值」这个接受比例，修后质量未知**；温度未拟合（`temperature=[1,1,1]`、无 `binning_map`）意味着 `max(p)` 偏 over-confident，阈值仍不能读成准确率。下一次**单次受控**验收看 harness 打印的 `gate=` / `p=`（报告字段 `decisionConfidence` / `probability`）就能区分「熵低」与「概率低」，不需要再开一轮研究。

**源码版本边界**：上面的行号来自本机 `research/laya` 克隆（`v0.4.7-16-g432312b3`，commit `432312b36714d8889eba405507b37eda25257d9c`，路径 `research/laya/laya/common.py`、`research/laya/laya/confidence.py`）。产品安装的是 pinned PyPI `laya==0.4.8` wheel；安装版源码**没有**逐行核对与最新上游仓库对等，行号 / 公式以该 wheel 与上述 commit 为准，不能当成「上游最新版」。

### 9.9 外部 supervisor（2026-10-17，未在真实 daemon / 模型上重跑）

§9.7 / §9.8 的 harness 清理只在进程内；进程被 SIGKILL / OOM 时「本次独占 daemon 还在跑」「生产 Laya 被停着」不受保证。新增**独立进程** `scripts/laya-benchmark-supervisor.mjs`：

- **入口证明**：harness 不再接受 `PIA_BENCH_HARNESS_ENABLE=1`（环境变量任何进程都能设）。supervisor 启动 worker 时额外给 fd 3（worker→supervisor checkpoint）和 fd 4（一次性随机 token，只在内存管道、不落盘不进 argv）；worker 必须核对 `process.ppid` 并把 token ack 回 fd 3，直接运行一律 exit 3。
- **状态文件**：supervisor 先建 scratch 根（owner marker + `supervisor-state.json`），只记 socket / pid / baseline 布尔 / 回环 API base，**不记 token、不记 env**；worker 每建一个资源（baseline、daemon、停生产 Laya、自有 Laya、各自 stop / restore）立刻 checkpoint，supervisor 原子落盘。
- **收尾**：超时 / 信号 / worker 退出后先杀 worker 进程组（detached，自成一组），再独立核验：本次 daemon 只按命令行里的**唯一 socket** 重新 `pgrep` 证明归属再 SIGTERM→SIGKILL（不按历史 pid 盲杀）；自有 Laya 只在 `ps` 命令行包含本次 scratch 根时证明归属再终止。
- **恢复生产 Laya**：仅当 baseline 是 running、checkpoint 证明我们确实停过它、且自有 daemon / Laya 都已证明停干净，才走回环 `POST /api/local-models/laya/start`（180s + 20s 轮询，总 ≤200s）并复核 health；否则明确 cleanup failure，不热第二个模型；baseline 本来是 stopped 就绝不启动。
- **验证方式**：`node --test scripts/laya-benchmark-supervisor.test.mjs` 用假 worker + 假 HTTP API 跑真实恢复路径（超时杀组 / 归属证明 / 恢复一次 / baseline stopped 不启动 / 正常退出不重复恢复），**不启动真实 daemon / Laya / 模型 / 浏览器**。

下次单次可执行验收命令（需主会话放行；本轮未跑）：

```bash
node scripts/laya-benchmark-supervisor.mjs --timeout-ms=720000 -- \
  node --import tsx scripts/laya-benchmark-isolated-harness.mjs
```

清理证据看 `supervisor-state.json` 的 `cleanup.daemon.stopped` / `cleanup.laya.stopped` / `cleanup.restore.ok`；harness 的 `evidence/laya-benchmark-real/report-*.json` 仍按原格式记录 `decisionConfidence` / `probability`。

### 9.10 修后受控真实测量（2026-10-17，**唯一一次**，已跑完；结论：仍 1/4，3 题 `low_confidence`）

**授权与执行**：主审放行**一次**真实测量。实际**只跑一次**（未因失败重跑）。树 `laya-benchmark-snapshot-fix` HEAD `26c5c51`（`git status` clean），Node `v24.19.0` 明确全路径、PATH 含其目录，`PIA_BENCH_WATCHDOG_MS=540000`，`PIA_BENCH_RAW` 未设（无额外诊断请求）：

```bash
node scripts/laya-benchmark-supervisor.mjs --timeout-ms=720000 -- \
  node --import tsx scripts/laya-benchmark-isolated-harness.mjs
```

开始 `13:59:29Z` / 结束 `14:00:00.974Z`（wall ≈31.5 s）；supervisor `exit=1`（分数不满分），`cleanup.failures=[]`。原始证据 `evidence/laya-benchmark-real/report-2026-10-17T13-59-29-808Z.json`（tracked），supervisor 日志同目录（`*.log` gitignore，原样留盘）；细节见 `progress-snapshots/laya-benchmark-measure-2026-10-17.md`。

**语义来源（安装版，不只 research HEAD）**：本机安装 wheel `laya==0.4.8`（`local-laya/runtime/env/lib/python3.12/site-packages/laya`）只读核对：`common.py:791 answer_confidence=max(p)`、`common.py:814 confidence_from_probs=1-H/log k`、`confidence.py:38 jev_confidence=(max(p)-1/n)/(1-1/n)`。与产品 `jevChoiceConfidence()` 公式一致（产品单候选不合成 1.0 是既有选择）。语义吻合后才执行。

**隔离（本轮实测）**：服务进程临时 HOME / TMPDIR / DATA / WORKSPACE 全在 scratch 根内（`homeIsOsAccount=false`）；原生边界 `HOME=/Users/dengdeng`、无 `CFFIXED_USER_HOME`、`strippedKeys=[TMPDIR,TEMP,TMP]`、`diverged=true`、`problems=[]`（仍是**交给启动器的输入配置**，未读子进程实际环境）；MCP 走生产启动器 `inheritEnv=false / envReplaced=true`；独占 daemon `31328`、驱动自有浏览器 `31357`（window `17759`、pin `p1`）、自有 Laya `31340` port `57813`（token 摘要 `42b0c2bfcf88`）。生产 Laya baseline `27010` → API 停一次 → 恢复 `running pid 34607 port 58038, health ok mps, registered`；生产 daemon `22313` 未动。

**结果（threshold 0.6 / timeout 4000ms，按任务分开熔断作用域）**

| 任务 | decision | gate（Jev 标度） | 选项概率 p | 协议 confidence（熵） | 决策延迟 | 结果（双证据） |
|---|---|---|---|---|---|---|
| pick-submit | fallback `low_confidence` | **0.5302** | 0.5973 | 0.4862 | 112 ms | unknown（未派发） |
| pick-city | fallback `low_confidence` | **0.4036** | 0.4888 | 0.2750 | 98 ms | unknown（未派发） |
| scroll-target | selected | 0.8812 | 0.8981 | 0.7487 | 155 ms | **correct**（`clicked=deep-target` + UI「深度目标完成」） |
| dynamic-2step | fallback `low_confidence` | **0.3558** | 0.4478 | 0.1972 | 149 ms | unknown（未派发） |

预热 1 条（不计分）：`pick-submit` fallback，gate `0.5302` / p `0.5973`，1251 ms（冷启动）。汇总 **1/4 correct、fallback 3、timeout 0、abstain 0、p50 112 ms / p95 155 ms**。与 §9.7 的 0.3816 / 0.1854 / 0.2593（那些是**熵**）对照：换到 Jev 标度后 gate 明显升高（0.5302 / 0.4036 / 0.3558），但**仍全部低于 0.6** → 默认阈值下结论不变。**未下调阈值、未加模式、未额外发 raw 推理、未重跑。**

**清理（按本次 socket / owned root 证明，不信历史 pid）**：`cleanup.daemon.stopped=true`（`found=[]`、`leftoverPids=[]`、socket 停后不存在）；`cleanup.laya={pid:31340, stopped:true, source:"already-dead"}`；worker 内已恢复生产 Laya，故 supervisor `restore.skipped="没有暂停过生产 Laya 或已恢复"`、`prodRestored=true`，**没有重复 stop / start**。fresh `pgrep`（按本次 socket / scratch 根）无结果，`browser-profile/` 为空，无本次 Chrome 残留。系统钥匙串 / 权限弹窗本轮未出现，未点任何按钮、未动 security / 系统权限。

**preflight 时已存在的遗留（非本次、未杀、已记录）**：旧 bench daemon `5245`（socket `/tmp/pia-laya-bench-2026-10-17T10-58-08-701Z/...`）、`laya-serve` `32630`（生产 env 路径）、`laya-serve` `31929`（旧 smoke 临时路径）。没有本次归属证明，按规则只报告不乱杀。

**边界（不得宣称）**：① 4 个固定 synthetic 任务、单机 arm64、单一 checkpoint，**不是完整 production benchmark**；② 熔断 key 按任务分开（生产 `benchmark-host` 同一 key）；③ `pick-city` 的 `afterSelect` 是**程序固定下拉选择**、`scroll-target` 的滚动是**程序侧 `programAssist`**，都不算 Laya 能力；④ **主模型接管未执行**（harness 不跑会话主接管），fallback 链路只在单测里证到「工具返回回退」，真实主接管仍未验；⑤ 3 题未派发动作 → 无「误选执行」可观测，也不反推「本来选对」；⑥ 不宣称准确率（温度未拟合，`max(p)` 偏 over-confident）；⑦「钥匙串弹窗已修好」仍未证。

### 9.11 产品路径的网页目标（`fast_pick_action` + `browser`，2026-10-17）

> 背景（主审发现）：`fast_pick_action` 以前只读 `get_window_state` 的原生 AX；而 **Chrome 后台窗口不暴露网页 AX 子树**
> （只看到工具栏，`tool.ts` 的注释也这么写）。浏览器链路（`clickCandidatesFromBrowserRefs` + `browser_click{ref}`）
> 只长在 benchmark 里，所以 **benchmark 的浏览器结果不能当成产品 fast tool 支持网页**——真实网页 fallback 时工具收集不到候选。

**接线（产品）**：`fast_pick_action` 新增可选 `browser`。

| 入参 | 行为 |
|---|---|
| 不给 `browser` | 原生路径，完全不变（`get_window_state` + `element_token`）。 |
| `browser:{target_id, tab_id}` | 用主模型自己 `get_browser_state` 绑定得到的精确身份；不额外 bind。 |
| `browser:{}` | 用既有 `pid` + `window_id` 调一次 `get_browser_state` 做**绑定核对**：`binding_quality:"exact"` + `mutation_allowed:true` + `target_id` + `tabs[]` 唯一活动标签。**绝不** `browser_prepare` / attach。 |
| 只给 `target_id` 或只给 `tab_id` | fail-closed（不猜另一个）。 |

**派发与三条不变量**：

1. **G1**：`session` 透传到 `get_browser_state` 与 `browser_click`，读 / 点同一个会话。
2. **G2**：执行前重读**同一 target + tab** 的 `semantic_v2` 快照，用**最新 ref** 做语义唯一性 + role/value/actions 未变校验；快照报回的 `target_id` / `tab_id` 与请求不一致（换 target = 换权限面）直接中止。
3. **G3**：执行后再读一次快照，按 `expected` 返回 `confirmed` / `unsatisfied` / `unknown`；没有 `expected` 只有 `unknown`。

**派发参数**：候选表内部仍用 `element_token` 存 ref，好让新鲜度校验一条路径通用于原生与页面；真正派发时换成官方入参
`browser_click{target_id, tab_id, ref}`（`element_token` **不**传给浏览器工具）。缺浏览器工具（`get_browser_state` / `browser_click`）、
绑定证据不足、快照不可用，一律 fail-closed 并把「由你自己用电脑工具完成」交回主模型。

**共享归一（不再复制一份）**：新增 `packages/server/src/fast-computer/browser-snapshot.ts`
（`browserSnapshotAsWindow` / `parseBrowserBind` / `parseBrowserSnapshotView` / `browserSnapshotId`）。benchmark 侧的
`benchmark-window.ts`（+ fixture URL/nonce 校验）与 `benchmark-driver.ts`（重新导出）改为复用同一份；tool **不** import
benchmark 运行时，避免 `benchmark-host → tool → benchmark-driver` 循环，也避免把 fixture / 判分拖进产品路径。

**候选能力语义（`refs[].actions`）**：`click` = 显式可点击；`pointer` = 可悬停 / 滚动 / 定位，**不等于** click；
`content_refs`（无 `actions`）不是动作节点，永远不进点击候选。**pointer-only 的文本节点保留**：ref 点击落在元素中心，
点「按钮里的文字」可能照样冒泡触发容器点击（label-click）——这一点**未在真实浏览器验证**，所以既不声称已证，也不凭猜删候选。
严格映射（要不要按 capability 只留 `click`）留到真实浏览器那轮用证据定。

**已知限制（不得当成结论）**：当前用的是通用多语种 checkpoint（`laya-multilingual`），不是浏览器专用训练。
上游 `docs/finetune_browser_agent.md` 的结论（主审转述：typed-decisions 零样本浏览器选择接近随机、任务通过率 0%；本轮未独立读取该文件）、`cklxx/laya-browser`
的 62% 是**第三方报告（fine-tuned 模型、非本机证据）**。所以「低 gate 是泛化能力不足」只能作为**待验证假设**，
不能写成主因已证；也不据此调阈值、微调 prompt 或只测少数题过拟合。浏览器专用 checkpoint 的许可 / 中文 / 体积 / 一键安装
是后续调研项，本轮不下载、不换用户模型。

**本轮验证范围（如实）**：只有假 MCP ctx 的定向单测（`fast-computer-tool` 24/24、`fast-computer*` 118/118、
server `tsc` exit 0）。**没有**起真实 Chrome / 驱动 / Laya，网页路径未在真实页面跑过；benchmark 与产品共用同一份归一
≠ 已在真实网页验证。

### 9.12 真实主模型接管入口（`PIA_BENCH_HANDOFF=1`，2026-10-17；**未在真实链路跑过**）

> 目的：§9.10 只证到「工具返回 fallback」，**没证到主模型真能接手**。这一节给一个最小、可复核的接管入口，
> 不重造 harness、不接第二个 MCP / daemon、不开新框架。

- **复用**：`scripts/laya-benchmark-isolated-harness.mjs` 已准备好的自有 daemon + 自有 Laya + 驱动自有 fixture 浏览器 +
  同一个 `McpClient`；`PIA_BENCH_HANDOFF=1` 时**不跑旧 4 题**。
- **真实 handler**：`fastComputerExtension({agentId})` 的真实 definition（`pi.registerTool` 只做 stub 取 definition，
  `ctx.executeTool` 经既有 `invoke` 走同一 MCP session），快速设置只写本次 scratch 数据目录（`saveFastComputerSettings(…, "hostpc")`，
  与 `scopeOfPrefix("mcp__hostpc__")` 一致），chooser 用**生产 `buildChooser`**（不 fake）。一次运行最多注册 3 次（不额外 raw）。
- **任务**：`pick-submit` / `pick-city` / `dynamic-2step` 之一（`scroll-target` 需要程序侧滚动协助，不算主模型能力）。
  收到**真实 fallback 文本**后写 `handoff.json` 并起控制面；Laya 自己 selected 也照样记录并做独立 machine/UI 核验，主确认下一题，**不凑假 fallback**。
- **控制面**：只 `127.0.0.1`、`POST /command`、`application/json`、body ≤ 4 KB、`x-pia-bench-nonce`（本次内存态随机值，不是凭据）。
  命令固定 5 个：`observe` / `click{ref}` / `pointer{ref,action}` / `next{task,fast?}` / `finish`。
  - `observe` 读 `semantic_v2`，返回 refs + 同快照的 UI（`role=status`）+ machine state + `expected`（判分可读，wrapper **不自动点击**）。
  - `click` 只接受**最近一次 observe** 的 ref（快照更新即作废）；不传 target/tab/坐标、不执行 JS。
  - trusted 报 `browser_input_trust_unavailable` 时，按工具规范**同一回合先 observe** 证明 ref 仍在，再 `input_route:"dom_event"`。
  - `next` 只接受 3 个固定 task id，由 harness 做 `store.reset` + 重新导航；`finish` 触发原清理（停自有资源 + 恢复生产 Laya）。
- **报告**：每题分开记「快模型自己做的（handler 文本 / decision）」与「主模型显式命令（ref / op / wall）」+ machine/UI 最终判断。
- **运行（12 分钟外部强超时不变）**：
  `PIA_BENCH_HANDOFF=1 node scripts/laya-benchmark-supervisor.mjs --timeout-ms=720000 -- node --import tsx scripts/laya-benchmark-isolated-harness.mjs`
  就绪后读本次 scratch 根 `handoff.json`；进程内兜底在 handoff 模式放宽到 11 分钟，supervisor 仍是外层硬边界。
- **已验 / 未验**：`scripts/laya-benchmark-handoff.test.mjs` 9/9（命令白名单 / ref 新鲜度 / fixture URL / HTTP 约束 / trusted→dom_event / next / finish 纯逻辑，假 invoke，不起 Chrome / driver / 模型）；
  真实 handler 接线与整条链路**未在真实 daemon / 浏览器 / Laya 上跑过**，待主审后跑一次。
- **顺带产品修补**：`tool.ts` 的 `readWindowState` 补显式 `tree_format:"elements"`（driver 0.35 起默认只回精简 markdown，没有 `element_token` → 原生候选会全空），
  `fast-computer-tool.test.ts` 加断言钉住；不改 native 原行为、不宣称已验证 pid/window 绑定一致性。


### 9.13 主会话真实接管已验收（2026-10-17）

本节覆盖 §9.12 的待验状态。8c99210 上真实 handler 三次均返回 low_confidence；主会话亲自按新快照选择 ref，提交、选北京、动态两步 **3/3 完成**，5 次 trusted 点击，机器与页面状态一致。未用程序固定下拉，不自动选目标；原模型恢复健康，本次隔离进程清理。Laya 本轮 0/3 自行派发，接管成绩不能当其独立准确率。definition 取出后通过真实 MCP 运行，不是安装版会话运行器验收；仍需后续候选安装测试。完整证据、命令与含推理等待的 wall 定义见 [主接管验收](../../progress-snapshots/laya-main-takeover-2026-10-17.md)。后续候选输入去重尚未在本次模型调用里使用。
