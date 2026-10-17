# 真实 Laya 完整 benchmark（隔离 daemon + 真实隔离浏览器）

> 2026-10-17，worktree `laya-benchmark-snapshot-fix`。本文件描述的运行发生在 `0296b5b`；`60a7101` 与本轮（主审后）只改文档 / 脚本，**没有重跑**。未 push / 未 tag / 未打包。
> 设计契约见 `docs/design/fast-model-benchmark.md` §9.6–§9.7；脚本 `scripts/laya-benchmark-isolated-harness.mjs`（`npm run smoke:laya-benchmark`）。
>
> **2026-10-17 主审后修正**：结果表里 `pick-submit` 的置信度已改为真实 scored 值 `0.3816`（`0.3969` 是预热那条）；
> 本轮实际跑了两轮（授权是一次），诊断不能当任务准确率——见文末「主审后修正与边界」。
> 脚本已改回「服务进程临时 HOME」但**未在真实链路重跑**，入口现必须由 supervisor 握手启动（直接运行 exit 3）。

## 做了什么

按 §9.6 的验收方法，一次跑完“环境已修 + 真实 Laya 模型质量”两件事，**没有**拿脚本 chooser 冒充模型验收：

1. 先断言本进程是原生环境（白名单只看 `HOME` / `CFFIXED_USER_HOME` / `TMPDIR` 三项，不打印其它 env）。**主审后认定这违反“服务进程必须用临时 HOME”的隔离要求**（见文末），脚本已改，但本轮证据仍是这份原生 HOME 下跑出来的。
2. 起**本次独占**的 CuaDriver daemon：独立 `PIA_DATA_DIR`（socket 落在 `…/host-control/cua-open.sock`）、独立 `CUA_DRIVER_BROWSER_PROFILE_ROOT`；环境用生产 `nativeLaunchEnvForChild`，macOS 经 LaunchServices `open -n -g -a <官方签名 CuaDriver.app> --env HOME=… --args serve …`。
3. 用**生产同一套** `hostMcpCommand()`（`mcp-env-launcher.mjs`，`inheritEnv:false`、环境全量替换）连它；`createInvokeBenchmarkDriver` 真实走 `browser_prepare{allow_launch,isolated_new}` → `list_windows(prepared_pid)` → `get_browser_state` bind → `browser_navigate`（fixture + nonce）→ `get_browser_state{semantic_v2}` 取 pin `snapshot.id` → `browser_click{ref}`。
4. 真实 Laya：经生产 API 停原 runtime（16GB 不同时热两个模型），用生产 `LocalLayaManager` 在**自有 data dir** 起本次 runtime（自有端口 + 自有 token；权重来自本机已物化目录的 **clonefile 副本**，不写回原目录、不读生产 token / DB），经生产 `buildChooser()`（systemone → `models.classify`）+ `selectFastAction()` 跑完整 4 题；清理路径停自有 runtime 并用生产 API 恢复原 runtime（**进程内**，无外部 watchdog）。
5. 每题记 decision / confidence / latency / fallback / 派发动作 / 双证据（fixture 机器状态 + 独立 UI 观测）；被阈值拦下时额外用同一个生产 chooser 再推理一次“本来想选谁”（**额外请求、只诊断、不执行、不计入结果**）。

## 结果

证据：`evidence/laya-benchmark-real/report-2026-10-17T12-34-52-131Z.json`（含 raw chooser 诊断）、`report-2026-10-17T12-33-19-290Z.json`（同一流程无诊断）、同目录 `run-*.log`。

| 任务 | decision | confidence | 决策延迟 | 双证据 |
|---|---|---|---|---|
| pick-submit | fallback `low_confidence` | **0.3816**（注） | 105 ms | unknown（未派发） |
| pick-city | fallback `low_confidence` | 0.1854 | 107 ms | unknown（未派发） |
| scroll-target | selected | 0.926 | 158 ms | **correct**（`clicked=deep-target` + UI「深度目标完成」） |
| dynamic-2step | fallback `low_confidence` | 0.2593 | 167 ms | unknown（未派发） |

> 注：`pick-submit` 的 `0.3816` 取自 `report-…12-34-52.json` → `tasks[0].fallbackDetail`（scored 那次调用）。`0.3969` 是**预热**那条（`warmup.fallbackDetail`），旧表把它误填进结果列，已改正。

- 预热 1 条（不计分）：第二轮 `low_confidence 0.3969`，929 ms（冷启动；第一轮预热是 `0.4673` / 1136 ms）。
- 汇总：**1/4 correct，successRatio 0.25，fallback 3（全部 low_confidence），timeout 0，abstain 0，p50 107 ms / p95 167 ms**（p50/p95 只统计每题**最后一次 chooser 调用**的决策延迟，不是任务总耗时，见文末）。
- 两轮对照（第一轮 conf 0.3693 / 0.1165 / 0.9597 / 0.3204，同样 1/4）：因为**两轮本身就偏离了“一次受控验证”的授权**，这里只作对照，**不作为可复现性证据**；统计只取第二轮 scored 数据。
- 诊断（非生产决策）：详见下一节与文末——**不能**读成“选得对但没信心”，也不是任务准确率。

## 隔离 / 清理证据

- 宿主与 daemon 白名单：服务进程 `HOME=/Users/dengdeng`（= OS 账户家目录）、无 `CFFIXED_USER_HOME`、`TMPDIR` 不在合成根内；`nativeLaunchEnvProblems` 空。**注意**：`report.json` 里的 `env.daemon` 是**送给启动器的 env 输入配置**（`envWhitelistFrom(daemonEnv.env)`），不是从 daemon / Chrome 子进程读回来的实际环境；它能证明“按这份配置启动、daemon 起来了、链路真的打开过浏览器”，不能证明“daemon 最终环境 ≡ 这份”。
- 独占 daemon 自报 pid `20158`（第二次 `24761`），`unrestricted`；工具清单含 `browser_prepare/browser_navigate/get_browser_state/browser_click/browser_pointer`。
- 生产 App 的 daemon（pid `22313`，`~/Library/Application Support/Pi Assistant/host-control/cua-open.sock`）**未被停止、未被复用**；生产 socket 文件仍在。
- 隔离浏览器：prepared pid `20461` / window `17463` / `target_id bt-238383f8-…` / `tab_id tab-e5420be6-…` / pin `p1`；结束后进程已退出。
- Laya：baseline `running pid 7991 port 60869` → 停 → 自有 runtime（token 只记摘要）→ 第一轮恢复为 `pid 22676 port 49806` → 第二轮再停 → 恢复为 `running pid 27010 port 50418, health ok, device mps, registered local-laya/multilingual`（即生产 runtime **被停 / 起两次**，主审已用只读 GET 独立确认最后状态）。
- 结束时无本次遗留进程 / socket（`daemonLeftoverPids:[]`、`socketExistsAfterStop:false`）；scratch 目录 2.1 MB（权重副本已删）。

## 本轮脚本自检发现的两个真实坑（已修）

1. **unix socket 路径长度**：macOS `sun_path` ≈ 104 字节。默认 scratch 落在 `/var/folders/…/T/pia-laya-bench-<长 ISO 时间戳>/…` 时 socket 路径 135 字节 → daemon 直接 bind 失败，症状只是“20s 内不就绪”。改成短根 `/tmp/pia-lb-<owner>-<base36>` 并在启动前显式断言长度。
2. **`pgrep -f "--socket …"` 被当成选项**：`--socket` 以 `--` 开头，pgrep 会按长选项解析 → 匹配 0 个进程，误报“无法证明归属”。改成 `pgrep -f -- "…"`。

## 关于 e2e 复制版 helper 的 `diverged` 缺陷（Fast 44047ea 报告；本树核对结论）

- **本次 harness 没有用它**：`scripts/laya-benchmark-isolated-harness.mjs` 只 import 生产 TS 模块 `packages/server/src/native-launch-env.ts`（本轮用 `nativeLaunchEnvForChild` / `nativeLaunchEnvProblems`；主审后改为 `nativeLaunchEnv` 从显式 clone 的 base env 计算原生边界）。TS 版在覆盖 `HOME` **之前**算 `diverged`（`native-launch-env.ts:81` vs `:91`），逻辑正确；本次实测证据也一致：daemon env 白名单 `tmpdirUnderSyntheticRoot:false`、`nativeLaunchEnvProblems` 空、`strippedKeys:[]`（因为调用方本来就是原生 HOME——这也是主审定下的隔离缺陷）。
- **缺陷真实存在**：`e2e/fixtures/native-launch-env.mjs` 把 `const diverged = … env.HOME !== realHome` 写在 `env.HOME = realHome` **之后** → 恒为 `false`。纯函数对照（不起 Chrome、无副作用）：
  - 场景 A（调用方 HOME 已是合成值、`syntheticRoots` 未含该根）：e2e helper 输出 `TMPDIR="/tmp/synthetic-tmp"`（**漏删**）；TS 生产模块输出 `TMPDIR:null, diverged:true, stripped:["TMPDIR"]`（正确）。
  - 场景 B（当前唯一调用方 `e2e/subagent-thinking-loading.mjs` 的真实用法：先取 env 再覆盖、传入全部合成根、TMPDIR 是真实 OS 临时目录）：两份实现**行为相同**（都保留真实 `/var/folders/x/T/`）。
- **影响界限（如实）**：该缺陷**没有影响本次任何一次 daemon / 浏览器启动**（本 harness 不走它），对当前唯一调用方按现有调用顺序也**无行为差异**；它只会在“覆盖 HOME/TMPDIR 之后再调用、或漏传合成根”的未来调用里把合成 `TMPDIR` 带进原生浏览器。
- **修复归属**：Fast 分支 `44047ea` 已把 `diverged` 移到赋值前并加 4 项回归；**本树不重复改**（避免同一文件重复修改 / 合入冲突），合入时以那份修正为准。本树未因它重跑任何浏览器测试。

## 主审后修正与边界（2026-10-17；未重跑）

以上结果与证据 JSON **原样保留**（不再改统计、不重跑浏览器 / 驱动 / 模型）；以下是主审核对后必须一起读的修正：

1. **执行偏差（如实）**：授权是**一次**受控验证，实际跑了两轮（`12:33:19` 无诊断、`12:34:52` 含诊断，两轮间隔约 90s），生产 Laya 因此被停 / 起两次。两轮不合并统计；结果表只取第二轮的 scored 数据。
2. **数字更正**：`pick-submit` scored 值是 `0.3816`；`0.3969` 是第二轮**预热**那条。旧表把 warmup 当结果，已改正（`0.1854` / `0.2593` 确为 scored）。表格置信度应只从 `tasks[].fallbackDetail` 解析，不要把诊断那次新调用的值混进来。
3. **raw chooser 诊断的正确读法**：它是 fallback 之后**额外再做一次推理**（每题多一次模型请求，`diag-<taskId>`），不在生产决策路径上。它只能说明“**那次独立诊断的首步候选**与期望目标一致”；本轮**没有**执行下拉展开、也没有完成 2step，所以既不是任务准确率，也不能用来断言“原始 decision 其实是对的”。同题不同调用置信度会变：`pick-submit` 生产那次 `0.3816`，诊断那次 `0.6277`（>0.6）——“选对但没信心”“raw 3/3”都不能作为结论。
4. **可复现性 / 计时边界**：harness 的熔断 key 是 `hostpc:<pid>:<window>:<taskId>`（**per-task**），生产 `benchmark-host` 是同一 key `hostpc:<pid>:<window>`——两者作用域不同。`task.retries=1` 是 runner 的“未选中”诊断计数，`task.fallbackCount=0` 是“基准不真的执行主模型回退”，summary `fallbacks=3` 是 `decision=fallback` 计数——三个不同计数器，不是矛盾。`latencyMs` / `p50` 只是每题**最后一次 chooser 调用**的决策延迟，不是任务总耗时（`wallMs` 105–2810ms），也不含诊断的额外请求。
5. **不是完整 production benchmark**：主模型接管**没有执行**，所以没有接管速度 / 总耗时数据；只是 4 个固定 synthetic 任务的 attempt coverage，不是完整 UI / `benchmark-host` 验收，不给 Laya 整体能力结论。
6. **隔离违规（本轮的）**：本轮服务进程跑在**原生 HOME**（脚本自己断言并要求 native HOME），与“服务 HOME / DATA / WORKSPACE / TMPDIR 用临时目录”的隔离要求相反。脚本已改（见下条），但**本轮证据不满足该隔离要求**，不能当隔离验收证据。
7. **脚本修复状态（已改，未验证）**：临时 `HOME` / `TMPDIR` / `PIA_DATA_DIR` / `PIA_WORKSPACE` 现在在**任何第三方与服务模块（hono / pi-mcp / TS 生产件）动态 import 之前**设置；原生边界只从 `cloneNativeBaseEnv(process.env)` 显式快照经生产 `nativeLaunchEnv()` 计算，不要求本进程是原生 HOME；内存凭据保留、不读凭据、不改 SDK。纯函数测试 `node --test scripts/laya-benchmark-harness-env.test.mjs` **6/6**。但这条链路**没有在真实 daemon / 浏览器上跑过**，因此入口改为**必须经 supervisor 握手**（fd 3/4），直接运行 exit 3；需在受控测试槽里重测后才算可用。
8. **清理覆盖边界（§9.7 那一轮）**：当时只有**进程内**兜底（正常 finally 路径 + 单次到点 abort + `unhandledRejection`/`uncaughtException` 走同一条幂等清理）；**没有外部 watchdog**，进程被 SIGKILL / OOM / 掉电时，自有 daemon / 自有 Laya 可能残留、生产 Laya 可能停着——本轮没触发这些异常路径，所以不声称“这条路径已验证”。旧注释里“第二次到点强制落盘”是错的（单次 `setTimeout` 不会触发第二次），已删。现在新增独立 supervisor（假 worker 测试 3/3，未在真实 daemon / 模型上重跑）：超时 / 信号后杀 worker 进程组，按 socket / 命令行证明归属收尾，≤200s 恢复生产 Laya。浏览器侧：拿到 handle 时 `close()` 与 prepare 后失败的清理都走 driver 自己的 `releasePrepared()`（kill 前用 `list_windows` 复核归属），同样是进程内保证。
9. **e2e 复制版 helper 的 `diverged` 缺陷**：修复来源是 Fast `44047ea`（独立文件），本树**不重复改**、合入时以那份为准；本树本次也没用它（用的是生产 TS 模块），所以它不影响本轮结果。

发布 / 引用时请连同这几条边界一起引用；不要把“1/4 + 诊断看起来对”写成“Laya 选得对只是没信心”，也不要写成“环境隔离已验收”。

## 边界（不得宣称）

- 「钥匙串弹窗已修好」**仍未证**：两轮都没有弹窗，但没有系统弹窗日志，不能当永久修复结论。
- 只有 4 个固定 synthetic 任务、单机（Apple 芯片 macOS arm64）、单一 checkpoint `multilingual`；不据此给 Laya 整体能力 / 准确率结论。
- 系统 TCC 授权、Intel / Windows / Linux、真实 GPU、其它 checkpoint、真实付费模型、全量 `npm test` / 全量 `e2e/run.mjs` 均未跑。
- 与生产 `benchmark-host` 的实现差异（不止一处）：熔断作用域按任务分开（否则前几条 fallback 会把后面几条直接熔断成 `circuit_open`，扭曲每题结论）；诊断又额外发请求；runner 的 `retries` / `fallbackCount` 与 summary `fallbacks` 计数语义不同（见上节第 4 条）。report 的 `model.circuitKeyScope` 记为 `per-task`。
- 本轮**不是**隔离验收：服务进程当时跑在原生 HOME（见上节第 6 条），修好的临时 HOME 版本尚未重跑。
- 本轮**不是**完整 production benchmark：主模型接管未执行、延迟只覆盖最后一次 chooser 调用、只有 4 个固定任务。

## 2026-10-17 补充：置信度标度错误（只读审计 + 小修，**未跑模型 / 浏览器 / daemon**）

原始两轮报告与统计**保持原样**，不改数字。这一节只补「3 次 `low_confidence` 到底是什么」的只读根因，以及据此做的最小代码修复；**没有**为了通过而改阈值、也没有重跑模型。

### 已证（公开源码 + 纯数学，不需要跑模型）

1. **阈值比错了量**。Laya 的 choice 答案 `confidence` 是**归一化 Shannon 熵** `1 - H/log(k)`（`laya/common.py:802 confidence_from_probs`，`laya/agent.py` choice 分支写入），文档自己写「not calibrated … 不能和 `max(p)` 用同一个阈值比较」，而且**随候选数 k 变化**；概率质量是 `answer_confidence = max(p)`（`laya/common.py:779`，也是 `laya/confidence.py:_gate_confidence` 优先用的量）。产品默认阈值 0.6 是 Jev 标度上的数字。
2. **SDK 拿不到那个字段**：`pi-ai/dist/api/system-one-shared.js` 只解析 `choice` / `probabilities` / `confidence`，`answer_confidence` 被丢掉 → 只能从 `probabilities` 自己换算（Laya 公开提供 `jev_confidence`，#302：`(max(p)-1/n)/(1-1/n)`）。
3. **纯数学的一条（只说明标度差异）**：在「k=32、`max(p)=0.6`、其余概率均分」这一种形状下，熵 ≈ `0.41`（会被 0.6 拒），Jev 标度 ≈ `0.587`（也在 0.6 以下）。熵不只由 `max(p)` 决定，随 k 与剩余质量分布变化，**不能**写成「候选越多必然被拒」；能确定的是旧实现拿熵比 0.6，与 Laya 文档「不能和 max(p) 用同一个阈值」冲突，且实际把 3 次答案判成低可信。
4. **同题浮动的已知干扰源（不是已证主因）**：`captureId` 原来每次随机生成，而它进 `state`、被 Laya 整体 `json.dumps` 进模型输入（`serialize_state`）；模型 `eval()` + argmax、无采样，但这**不保证 MPS 跨进程逐位一致**，所以不能断言「同一输入必然同一分布」或「0.3816 / 0.6277 只能来自输入不同」。随机 capture 是**已证存在的干扰源**，页面状态本身也会变；量级没有测出来。原报告已写的「不能读成选得对但没信心」不变。
5. **checkpoint 侧**：本机物化的 `laya-multilingual` `rl_agent_config.json` 是 `temperature=[1,1,1]`、无 `binning_map` → 它的 `answer_confidence` 就等于 `max(p)`；但温度未拟合（官方说 over-confident），所以任何阈值都不能读成准确率。

### 改了什么（adapter / 编排层；不碰 Pi / driver / node_modules）

- `packages/server/src/fast-computer/choosers.ts`：新增 `jevChoiceConfidence()`（Jev 标度换算、**原始精度返回**、`n<2` / 重复空 id / 越界概率不合成）；`parseClassifierChoice` 多返回 `decisionConfidence`，协议 `confidence` 原样保留；wire `choice` 必须是**唯一最高概率**候选，否则 `abstain`（不拿别人的概率过门）。
- `index.ts`：阈值改比 `decisionConfidence`（缺失退回 `confidence`）；回退详情带「选项概率 / 协议 confidence / 比较值」；`selected` 结果多带 `decisionConfidence` / `probabilities`；`registerCapture` 改**每次唯一**（只作程序内新鲜度 pin，**不进模型输入**；并发旧结果得到 `capture_invalid`，不会用新 capture 的 args）；用户取消不计熔断、保存设置清熔断、`circuit_open` 文案改为「只有保存设置 / 重启会清，重新读窗口不会」。
- `tool.ts`：`fast_pick_action` 分开显示两个数（展示取 4 位小数，比较不取整）；回退提示明确由主模型在当前会话自己继续、必要时先重读窗口，程序不会另发模型请求。
- `scripts/laya-benchmark-isolated-harness.mjs`：只加记录字段 `decisionConfidence` / `probability`（`gate=` / `p=`），报告 schema 兼容；入口改为**必须由 supervisor 握手启动**（fd 3/4，不再接受 `PIA_BENCH_HARNESS_ENABLE=1`）；资源创建即 checkpoint，SIGINT/SIGTERM 走同一条清理。
- 新增 `scripts/laya-benchmark-supervisor.mjs` + `laya-benchmark-supervisor-handshake.mjs` + 假 worker 测试：独立进程负责超时、杀 worker 进程组、按 socket / 命令行证明归属收尾、≤200s 恢复生产 Laya（baseline stopped 不启动；自有资源未清则拒绝恢复）。

### 实跑（Node 24.20.0；外层临时 HOME / TMPDIR；无模型 / 浏览器 / daemon）

- `fast-computer*.test.ts` + `fast-model-auto-discovery` + `fast-model-discovery-http`：**116/116**。
- `packages/server` `tsc --noEmit`：exit 0。`node --check` harness：通过。
- 新增用例：熵低但概率够 → 选中；概率不够 → 回退且详情带两个数；无概率退回协议值；单候选不合成；取消不熔断；保存设置清熔断；captureId 每次唯一且不进模型输入（同 goal/候选 context 完全一致）；并发同 key 同 id/label 但 args 已变 → 旧结果 `capture_invalid`；`choice` 与唯一最高概率不一致 → 不可执行；`0.59996` 不因四舍五入越过 `0.6`。

### supervisor 与入口（2026-10-17 收口；假 worker 测试，**未跑真实 daemon / 模型**）

- 入口不再用 `PIA_BENCH_HARNESS_ENABLE=1`（任何进程都能设）。harness 必须由 `scripts/laya-benchmark-supervisor.mjs` 通过 fd 3/4 握手启动；直接运行 5s 内 exit 3、不启动任何进程（实测）。
- supervisor 测试 `node --test scripts/laya-benchmark-supervisor.test.mjs` **3/3**：超时杀组 + 按 socket / 命令行证明归属收掉假 daemon / 假 Laya + 恢复生产 Laya（POST 一次）；baseline stopped 不启动；正常退出不重复恢复。`supervisor-state.json` 只含 socket / pid / baseline 布尔 / 回环 API base，不含 token / env。
- 下次单次可执行验收（**未跑**，等主会话放行）：`node scripts/laya-benchmark-supervisor.mjs --timeout-ms=720000 -- node --import tsx scripts/laya-benchmark-isolated-harness.mjs`。清理证据看 state 的 `cleanup.daemon.stopped` / `cleanup.laya.stopped` / `cleanup.restore.ok`。
- 源码版本边界：行号来自 `research/laya` 克隆 `v0.4.7-16-g432312b3`（`432312b36714d8889eba405507b37eda25257d9c`）；产品安装 pinned `laya==0.4.8` wheel，安装版源码**未**逐行核对与最新上游对等。

### 未验（不得宣称）

- 本轮**没有**运行 Laya（生产 runtime `27010:50418` 历史状态未动），所以「那 4 题换到新标度后过不过阈值」**未知**；不宣称 Laya 准确率、不宣称修完 4 题会通过。
- 阈值语义变化对**真实 Jev** 的影响未实测（我们只从 `probabilities` 重算同一公式；真实 Jev 若与其 `confidence` 不一致，会略有差异）。
- 没有重跑 harness 链路（临时 HOME 版仍未在真实链路验证）；清理仍只有进程内兜底，无外部 watchdog。
