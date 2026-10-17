# beta.30 后续候选整合（本地 worktree，未 push）

时间：2026-10-17（Asia/Shanghai）。worktree `beta30-followup-integration`（分支同名），本任务独占写入。
> 本文件先写**计划与统计**，合并过程中逐段补**已发生事实**。不把计划写成已完成。

## 0. 边界（本轮授权）

- 只做 **local git**：新建独立 worktree + 分支，`--no-ff` 合入三个 frozen ref；**不 push / 不动 main / 不打 tag / 不打包 / 不装 App**。
- 不编辑源树（`release-candidate-validation` 及三个来源 worktree 一律只读）；不碰 `main` 历史与 stash。
- 不改 Pi SDK / `node_modules` / 用户设置 / 凭据文件 / 日常 Chrome / 系统权限；不 `npm ci`、不装依赖、不改系统 Node。
- 本轮**只整合 + 源码 review + 必要纯检查**：不起服务 / 浏览器 / 驱动 / 模型，不下载模型，不连真实 DB，不跑 Laya 旧四题或 stepwise 调词。
- 来源一律按 **frozen ref** 取，不跟进其他树后续未验变动。

## 1. 起点核对（已做）

| 项 | 结果 |
|---|---|
| 候选树 `release-candidate-validation` | HEAD `2e87f511f75e61fe3141922cf2015d215a94a2ff`，`git status --porcelain` 为空 |
| `git log 2e87f51..main` | 空（main 在候选树之后无提交；不动 main） |
| 新 worktree 是否已存在 | `git worktree list` 中无 `beta30-followup-integration`（新建前确认 absence） |
| 新 worktree | 从 `2e87f51` 新建，分支 `beta30-followup-integration`，起点干净 |

## 2. merge-base / 提交数 / 改动面（合并前统计）

三个 ref 的 merge-base **都是** `2e87f51`（都从当前候选 HEAD 分出，无遗漏历史）：

| 顺序 | 分支 | frozen ref | 领先提交 | 改动文件 | 增删 |
|---|---|---|---|---|---|
| 1 | `thinking-slider-visual-refinement` | `8b8d8360a2e70e488920466ca38857ea0595b5ed` | 8 | 22 | +583 / −94 |
| 2 | `fast-inference-mode-implementation` | `f7ef9b11cee3320f3329667191b616da70e15925` | 22 | 65 | +3477 / −294 |
| 3 | `laya-benchmark-snapshot-fix` | `3462f8eae3a2715c3a9e06eb195407d9e63ec582` | 25 | 58 | +11045 / −236 |

**关键 ancestry 事实**：`8b8d836`（滑块视觉）**已是** `f7ef9b1`（Fast）的祖先 —— Fast 树建在滑块视觉之上（`a5ea85d` 的父就是 `2e87f51`，其后是滑块 7 个提交再接 Fast 提交）。所以第 1、2 次合并**不会**在 `ModelPicker.tsx` / `ThinkingSlider.tsx` / `app.css` 上产生冲突；Fast 的 300 行 `ModelPicker` 改动**已包含**滑块视觉的最终形态。

## 3. 交叉改动面（冲突预判）

| 组合 | 重叠文件 |
|---|---|
| 滑块视觉 × Fast | 无（Fast 是其后代） |
| 滑块视觉 × Laya | `docs/HANDOFF.md`、`docs/ROADMAP.md` |
| Fast × Laya | `docs/DESIGN.md`、`docs/HANDOFF.md`、`docs/ROADMAP.md`、`e2e/fixtures/native-launch-env.mjs` |

即：**代码冲突只有 1 个文件**（`e2e/fixtures/native-launch-env.mjs`），其余全是文档。

### 3.1 native helper 冲突的既定口径（主会话已明确）

- 两棵树的 `e2e/fixtures/native-launch-env.mjs` 是同一份规则的两份拷贝；**Laya 那份有真 bug**：`const diverged = …` 写在 `if (realHome) env.HOME = realHome;` **之后**，比较恒为 false → 父进程本来就是合成 HOME/TMPDIR 时会把合成 TMPDIR 漏给 Chrome。
- **以 Fast 的版本为机制基准**（它在覆盖 HOME 之前判定 `diverged`，与生产 TS `packages/server/src/native-launch-env.ts` 一致），**不 merge 回 bug**。
- Laya 需要的**生产机制**（`packages/server/src/native-launch-env.ts`、`mcp-env-launcher.mjs`、`host-control.ts` 的 `driverEnv()` / `nativeLaunchCommand()`、`browser.ts` 两处 Chrome env）是另一套 TS 实现，**照常并入**，与 fixture 的取舍不冲突。

### 3.2 必须保住的既有语义（review 清单）

- 两层紧凑弹层（默认只有当前模型 / 强度 / Fast / 滑块；点模型名才进目录）、Fast 是**独立请求参数** `service_tier:"priority"`，**不降 thinking**；
- 滑块：白色实心圆钮 / 主题 token / 拖动取消（`pointercancel` 不写库）/ 拖动预览只改头部与 `aria-valuetext`；
- Fast 已正确修的 `latest-write` 代次与 `esc-layer` 分层：**不被旧滑块代码覆盖**；
- 生产 `native-launch-env.ts` 的 `diverged` 判定顺序**不得**被 fixture 的旧写法影响；
- Laya 侧：supervisor / service 隔离、记忆注入、raw reports **不可变保留**。

## 4. 文档口径（合并后统一写）

- HANDOFF / ROADMAP 各加**新的 top 段**：当前公开版仍是 **beta.29（tag `ab8e0f3`，2026-10-17T04:36:44Z 公开）**；本树是 **beta.30 未发布候选**（未 push / 未 tag / 未打包），写清**已验 / 未验**与各来源的进度合并。
- 用新段覆盖历史状态，**不删除历史证据**；三个来源各自的进度条目保留。
- Laya 相关：`3462f8e` 的**质量未真验**（不得迁移旧成绩），generic 模型高置信误选的问题不写成已解决；保留原设置 / 可选关闭 + 主模型 fallback。
- `scripts/laya-browser-input.ts` / `.test.ts` 是**研究用**，未被产品代码 import（合并后需复核）；不新增空卡片、不新增下载。

## 5. 执行顺序（每个 merge 后立即 commit，小步可 review）

1. 本文件（计划）单独提交。
2. `--no-ff` 合 `8b8d836` → 记录 merge commit。
3. `--no-ff` 合 `f7ef9b1` → 记录 merge commit（预期代码零冲突）。
4. `--no-ff` 合 `3462f8e` → 手工解 `e2e/fixtures/native-launch-env.mjs`（取 Fast 版）与 docs（逐段合），记录 merge commit。
5. 文档新 top 段 + 本文件收口提交。
6. 纯检查：`node --check` 改动脚本、纯逻辑单测（不连服务/浏览器/模型/DB），并确认新树 module 解析不是指回旧树。

## 6. 进展（已发生事实）

### 6.1 合并结果

| 顺序 | 来源 | frozen ref | 合并提交 | 冲突 |
|---|---|---|---|---|
| 1 | `thinking-slider-visual-refinement` | `8b8d836` | **`49b1dec`** | 无（自动合并全部成功） |
| 2 | `fast-inference-mode-implementation` | `f7ef9b1` | **`57cd8d7`** | 无（滑块视觉已是其后代，代码零冲突） |
| 3 | `laya-benchmark-snapshot-fix` | `3462f8e` | **`6344aba`** | 1 个：`e2e/fixtures/native-launch-env.mjs`（add/add） |

- 合并前计划提交：`04f5b41`（本文件）。
- 三个 ref 合并后 `git rev-list --count HEAD..<ref>` 均为 0（无遗漏）。
- 全树 `2e87f51..HEAD`：**没有删除任何文件**，**没有修改任何既有 `evidence/` 文件**（Laya 的 6 份 report 都是新增，raw 证据原样保留）。
- 未用 `-X ours/theirs` 整篇覆盖；docs 冲突逐段核对，全树无残留冲突标记。

### 6.2 唯一代码冲突的解法（`e2e/fixtures/native-launch-env.mjs`）

- 取 **Fast 版**（= `f7ef9b1` 里的内容，已核对逐字节一致）：`const diverged = …` 在 `if (realHome) env.HOME = realHome;` **之前**判定。
- 不并入 Laya 拷贝的旧写法（先覆盖 HOME 再比较 → 恒为 `false` → 父进程本来就是合成 HOME/TMPDIR 时把合成 TMPDIR 漏给 Chrome）。
- 生产 TS `packages/server/src/native-launch-env.ts` 本来就是正确顺序，所以这次没有把缺陷带进产品代码；两者现在语义一致。
- 钉住它的用例：`e2e/native-launch-env-fixture.test.mjs` 的「合成父环境（隔离启动）」一条，**本树已跑过**（见 6.4）。

### 6.3 重点 review（读代码 + 定向测试得出）

1. **两层菜单 / Fast 独立性**：`ModelPicker.tsx` 是 Fast 版最终形态——聊天入口默认紧凑层（强度 / 当前模型名 / 闪电 / 滑块），点模型名才进目录；目录层不再重复摆滑块 / Fast；返回与 Esc 只退一层。`packages/server/src/pi-adapter/fast-mode.ts` 只操作 `service_tier`（`priority`），**全文没有碰 thinking**；关掉只「不附加」，不补 `auto/default`，已有别的 `service_tier` 不改写。
2. **滑块语义没被 Fast 覆盖**：`ThinkingSlider.tsx` 仍是「`pointerup` 才提交 / `pointercancel`·失焦·Esc 不写 / 拖动只改预览头部与 `aria-valuetext` / `role="slider"` + `aria-valuetext`」；`useMoStyle` 走主题订阅回读（A 项修复在），白色实心无字圆钮与主题 token 都在 `app.css` 的 `pa-think-*`。
3. **竞态修复都在**：`apps/web/src/latest-write.ts` 的 `LatestWrite` / `SerialWriteQueue`、`esc-layer.ts` 的分层关闭、`patchAgentFast` 按助理一份写入代次与「回滚取服务端真值」——`fast-mode-frontend.test.mjs` 的 3 条顺序断言 + `model-menu-two-level.test.mjs` 的 Esc 归属断言本树全过。
4. **显式候选范围只收窄接口、不放宽权限**：`parseCandidateScope` 只接受 `{role?, label}`（2..32、label 1..120、role 1..80、重复 / 空 / 非数组 / 越界一律 `invalid`），**没有新增任何权限字段或档位语义**；匹配只在**本次已收集的有界候选**里做，`role` 给了就精确相等、label 走 `trim` 后的**完整可见 label**；执行前（G2）按 `matched[i]` 的 **selector 索引**在新一次重读里重新匹配并逐个比 `sameSemanticTarget`（role / value / actions），**派发用这次重读的新 `element_token` / `ref`，不复用旧 token**；候选 ID / 描述 / 收集顺序原样透传。
5. **审批 / 权限语义零改动**：`2e87f51..3462f8e` 的 `fast-computer/**` 与 `ext-computer` 新增行里没有 `approval` / `permission` / `tier` / `hostFileAccess` / `scope:` 相关改动（grep 核对）；`host-control.test.ts` 的启动重试边界、系统授权三值、只读探测缓存仍全过。
6. **原生启动环境**：`host-control.ts` 的 `driverEnv()` 只读探测 + 只记一条 warn、不因此拒绝启动；`hostMcpCommand()` 走自有启动器全量替换（argv 只放键名 / HOME 与固定开关，不把整份 env 写进 argv）；`browser.ts` 两处本机 Chrome 传同一份 env。**生产服务自己的合成 HOME / 数据目录 / 工作区隔离没被改动**。
7. **研究脚本不进产品**：`scripts/laya-browser-input.ts` 只被自己的 `.test.ts` 引用，`packages/` 与 `apps/` 无任何 import（grep 核对）；未新增空卡片、未新增下载入口、未改 catalog / manifest / UI。
8. **第三方许可口径**：`THIRD_PARTY_NOTICES.md` 新增条目只记来源 + revision + Apache-2.0 义务，并明写「本表只是来源记录，不是版权声明或证明已有完整许可证」「本仓当前没有核对 / 附带该许可证全文」，**没有伪造完整许可证**。

### 6.4 本树实跑（纯检查；Node v24.19.0）

新树 `node_modules` 是**本地未跟踪**的软链：第三方依赖指回 `release-candidate-validation` 已装好的那份（Pi SDK 1.3.0），但 `@pi-assistant/*` 单独建链指向**本树** `packages/*`。已核对解析：`@pi-assistant/shared` / `ext-computer` 的 `realpath` 落在本树，不是旧树 src。

| 检查 | 结果 |
|---|---|
| `tsc --noEmit -p apps/web` | **exit 0** |
| `tsc --noEmit -p packages/server` | **exit 0** |
| `e2e/native-launch-env-fixture` + `fast-mode-frontend` + `model-menu-two-level` | **18/18** |
| `e2e/thinking-slider-frontend.test.mjs` | **33/33** |
| `test/fast-mode` + `native-launch-env` + `native-launch-env-stdio` | **28/28** |
| `test/fast-computer-tool` + `host-control` | **61/61** |
| `test/fast-computer-benchmark-window` + `fast-computer` + `fast-computer-benchmark` + `-host` | **90/90** |
| `scripts/laya-benchmark-handoff` + `laya-stepwise-fixture` + `laya-benchmark-supervisor` + `laya-benchmark-harness-env` + `laya-browser-input` | **40/40** |
| 改动过的 `.mjs` / `.js` 全部 `node --check` | 通过 |

合计 **270 项通过 / 0 失败**。均为纯逻辑或定向单测（临时数据目录 / 假 MCP ctx / 假驱动），**没有**起服务、浏览器、CuaDriver、模型，**没有**下载，**没有**连真实数据目录。

### 6.5 剩余验收清单（本轮未做，交给重测试槽）

> 2026-10-17 更新：第 1、2 项里的 `vite build`、`fast-mode-ui`、`thinking-slider-ui` 的 **A 组**已在本树一次性跑完（64/64、A 组 10/10 步），证据与 counts 见 [beta.30 有限 UI 验收](beta30-followup-ui-validation.md)（2026-10-17）。下面 2 项中其余脚本、B/C 组与 visual77 仍未跑。

1. `vite build`（`npm run build -w @pi-assistant/web`）。
2. 浏览器 e2e：`fast-mode-ui`、`model-menu-flow`、`thinking-slider-ui`、`thinking-slider-visual`、`model-ui`、`composer-compact`、`subagent-thinking-levels`、`subagent-thinking-loading`、`model-picker-favorites-ui`。
3. 真机看：两层弹层 / 闪电 / 白色圆钮在各主题与 390 的观感，拖动取消不写库。
4. 真实 CUA 任务与真实 Laya 质量（需单独授权）：**不重跑旧四题、不 stepwise 调词**；候选范围会让 k / 熵变化，旧成绩不可对照。
5. 全量 `npm test` / 全量 `e2e/run.mjs`；真机 App 与打包（另需授权）。

### 6.6 边界遵守

未 push、未动 `main`、未打 tag、未打包、未装 App；未 `npm ci` / 未装依赖 / 未改系统 Node；未改 Pi SDK 与 `node_modules` 内容（只有本地未跟踪软链）；未动 stash、用户设置、凭据文件、日常 Chrome、系统权限。
