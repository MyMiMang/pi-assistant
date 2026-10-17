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

## 6. 进展（合并中补）
