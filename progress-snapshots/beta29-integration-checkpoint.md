# beta.29 候选整合：合并 + 代码 review 检查点（15 分钟）

时间：2026-10-24（Asia/Shanghai）。worktree `release-candidate-validation`（本任务独占）。
> 合并检查点起点 HEAD `6babde5`（工作区干净、无 WIP 遗留）；同日后续轻量修复见 §六，HEAD 前移至 `997b3e4` + 本次文档提交。

> 本文件只记**已发生的事实**：两次合并的 commit、逐项 review 结论、**未跑**的验证，以及接手后的轻量修复（§六，已改 / 未跑）。
> **不声称可发布**；beta.28 tag 未移动，未 push / 未 tag / 未装用户 App。

## 起点
- 起点 HEAD `11ce8f2`（前一轮合并检查点；**tag `v0.1.0-beta.28` 就指向它，构建 run 38949928195 保留，未改旧 tag**）。
- 两棵待合分支的 merge-base 都是 `11ce8f2`，均**无遗漏提交**（并入后 `git rev-list --count HEAD..<branch>` = 0）。

## 一、合并（`--no-ff`）
| 顺序 | 分支 | 源 HEAD | 合并提交 | 冲突 |
|---|---|---|---|---|
| 1 | `thinking-slider-implementation` | `4e15158` | `b051a39` | 无（自动合并全部成功） |
| 2 | `theme-diy-motion-implementation` | `ffbfb7f`（快照，非 WIP） | `43e7afb` | 仅 `docs/HANDOFF.md`、`docs/ROADMAP.md` |

- 第 2 次合并前先核对该分支工作树：只有未跟踪的 `.npm-cache-pi13/`，**没有未提交代码**；`git status` 无 modified → 快照 `ffbfb7f` 就是可合状态，未把 WIP 当稳定。
- docs 冲突**逐段按当前实际状态合并**（现公开状态 + 两条候选事项都保留），未用 `-X ours/theirs` 整篇覆盖；合完无残留冲突标记。
- 代码文件**零冲突**（两条分支改的文件集不重叠：滑块改 `components/ModelPicker|Models|Subagents`、`themes/app.css`、新增 `thinking-slider.ts`/`ThinkingSlider.tsx`；动效改 `themes/manifest.ts|base.css`、`ThemeDesigner.tsx`、`shared/src/theme-manifest.ts`、`server/src/themes/tool.ts`）。
- 合并后候选 HEAD：`43e7afb`。本文件提交后 HEAD 会再前进一格（文档提交）。

## 二、重点代码 review（逐项，读代码得出，**未跑测试**）

### 结论：核对通过（按当前代码成立）
1. **`--mo-style` 枚举不当 CSS 缓动**：`ThinkingSlider.tsx` 读计算样式里的 `--mo-style`，映射成**真实属性** `data-pa-mo-style`；CSS 走 `[data-pa-mo-style=steps]` 分支（`app.css` 335–338：`transition:none` + `steps(3,end)` + 直角）。内置 pixel 也在 `.pa-think` 声明 `--mo-style: steps` 兜底（`app.css` 327）。**没有**把枚举字符串塞进 `transition`/`animation-timing-function`。
2. **token 有界、无任意 CSS/JS/url**：`packages/shared/src/theme-manifest.ts` 的 `validateMotion` 是**唯一**校验器（服务端 `themes/tool.ts` 复用同一函数，不两套）；时长走 `DURATION = /^([0-9]*\.?[0-9]+)(ms|s)$/i`（**必须带单位 → 不会把百分比当时长**）、范围 40..1200ms；`scale` 0.5..2 且必须有限数；`glow`/`style` 为 enum；缓动只允许枚举名或受限 `cubic-bezier`（x∈[0,1]、y∈[-0.5,1.5]）；未知字段 fail-closed；`FORBIDDEN_IN_VALUE` 拦 `url(` / `;{}<>@` / 注释。`--mo-scale` / `--mo-glow` 数值由 `motionTokens` 归一化后写进 `[data-skin=custom-*]`。
3. **可选 schema 不破旧存量**：`motion?` 可选，`motionTokens` 缺项补 `DEFAULT_THEME_MOTION`；旧 v1（无 `motion`）仍合法，服务端 `theme-manifest.test.ts` 加了旧主题兼容用例（**未跑**）。
4. **预览取消不串变量**：`themes/preview.ts` 预览只改 DOM + 独立临时 `<style>`，规则作用域是 `[data-skin=custom-<id>]`（不写全局）；`cancelPreview` 清临时样式、注销未保存草稿、按快照恢复 `appearance`（含 accent/mode）；`commitPreview` 先落库再切正式 skin 并清临时样式。不会串进其他内置主题或其他 custom。
5. **reduce 无循环、无 particles**：全仓 `apps/web/src`、`packages/shared/src` **没有** particle / 动画 rAF 循环代码；引擎在 `@media (prefers-reduced-motion: reduce)` 把 `--pa-dur-*` 置 0s、`--mo-scale` 置 0（`manifest.ts`），组件侧再用 `matchMedia` + 早退跳过计时器，CSS 另有强制兜底。
6. **七档 / 并集 / 降级 / 跟随三层语义**：`orderedThinkingLevels` 只用 `THINKING_LEVEL_ORDER` 过滤排序（不发明档位，非法/重复被规范化）；候选池档位来自 `thinkingLevelsFor` / `thinkingLevelsUnion`（并集，不取交集吞掉 xhigh/max）；`fitThinkingLevel` 复述服务端 `clampThinkingLevel` 语义（≤目标的最高支持档，否则最低支持档），**只用于显示「实际会运行哪档」，不代替服务端**；`off` 仍是**一档**（不是 0%）；`following = current===null && 有 followLabel`，跟随是滑块外的 reset 动作，不是第 8 档。
7. **不硬主题覆盖用户新样式**：内置 skin 的 `--mo-glow` / `--mo-style` 规则都限定在 `[data-skin=glass|warm|noir|pixel]`；DIY 主题的 `data-skin=custom-*` 不命中这些规则，用户自己的 `motion` 值生效。
8. **组件不写死颜色**：滑块颜色/圆角/字体/动效全走 token；静态渲染测试里有「markup 不含硬编码色值」断言（**19/19 是 owner 在自己树跑的，本树未重跑**）。

### 结论：**未过 / 待修**（本树未改，留给「测试槽 + 集成验证」那一步，避免无测试的静默行为改动）
- **[必修 A] `--mo-style` 只在挂载时读一次 → 主题实时切换时滑块动效分支滞后。**
  位置：`apps/web/src/components/ThinkingSlider.tsx` 的 `const [moStyle, setMoStyle] = useState<string | null>(null)` 后那个 `useLayoutEffect(..., [])`（依赖数组为空）。
  事实：`--mo-scale` / `--mo-glow` / `--mo-ease` / `--pa-dur-*` 走 CSS 变量，主题一变就**自动**生效；只有 `style` 枚举需要 JS 映射成 `data-pa-mo-style`，而它只在挂载时读 → 主题从 `smooth` 变 `steps`（或反向、或预览切换）时，**弹层不重挂载就仍是旧分支**，直到组件卸载重建。
  建议修法（小改，不动 CSS）：把这次读取放进对主题信号敏感的 effect（主题 store 的 skin/mode 版本号，或 `document.documentElement` 的 `data-skin`/`data-mode`），或用一次 `MutationObserver` 观察这两个属性；SSR 下 layout effect 不执行，保持现有 guard。
  **→ 已在本树修（§六 A）：`apps/web/src/themes/motion-signals.ts` 订阅回读 + `ThinkingSlider.tsx` 的 `useMoStyle`；断言已写、本树未跑。**
- **[必修 B] `--mo-style` 的 `steps` 分支与 pixel 内置有语义重叠，需在真机确认。** `[data-skin=pixel] .pa-think-handle{transition:none}`（`app.css` 328）与 `[data-pa-mo-style=steps] .pa-think-handle{transition:none}`（335）同时存在；两者一致所以不冲突，但**若将来 pixel 想恢复过渡**，两处都要改。属提示，非缺陷。
- **[必修 C] 回滚竞态：`Models.tsx` 的 `saveThinking` 无请求代次保护。**
  位置：`apps/web/src/components/Models.tsx` `DefaultModelPicker.saveThinking`（`const prev = thinking; ... catch { setThinking(prev) }`）。
  事实：两次快速切换 A→B，若 A 的失败响应晚于 B 成功返回，catch 会把界面回滚成 A 之前的旧值，**把用户第二次的新选择覆盖掉**（正是「失败回滚不把第二次新选择回滚旧请求」要防的）。建议加一个递增 seq（`useRef`），仅当「这次仍是最新请求」时才回滚。
  **→ 已在本树修（§六 C）：`apps/web/src/latest-write.ts` 的 `LatestWrite` + `Models.tsx` 代次 / 确认值 / 真值回读；断言已写、本树未跑。**
- **[待确认 D] 选到与当前相同档位时弹层不关闭。** `shouldCommitThinking` 对「值没变」返回 false → `commit` 早退、不调 `onPick`，而 `ThinkingButton` 的 `onPick` 包装里才 `setOpen(false)`。所以点当前档位（或跟随态点已跟随项）**弹层保持打开**。这是组件注释里写明的有意设计（避免无意义写入），但 `ModelPicker.tsx` 里那句注释「提交后按原行为关菜单」与之一致性需要 e2e 明确预期（原 chips 点同一档会关菜单）。**不要**直接改测试迎合；先在测试槽用真浏览器确认哪种更合理。
  **→ 本树结论（§六 D）：注释与设计稿一致，保持现行为、不改代码；「再点同一档收起」属交互变更，留待测试槽真浏览器确认。**
- **[测试脚本 bug E，已在本检查点顺手修] `e2e/subagent-thinking-levels.mjs` 第 5 步断言本身写错。**
  选择器 `[data-testid^="agent-subagent-thinking-"]` 会同时命中原有的 `-menu` 与 `-body`（只过滤了 `-follow`），实际数到 9 个，`tickCount === 7` 必失败——该脚本 owner 标注**未运行**，所以没暴露。已改为只在弹层内取 `.pa-think-step`（语义等价且更准，不弱化断言）。**本树未运行该脚本**，改动待测试槽验证。

### 明确不动的边界
- 未改 Pi SDK / `node_modules` / 私有接口；两条分支的 `node_modules` 为指向候选树的软链（未 `npm ci`），合并不触碰共享 link。
- 未改服务端 `clampThinkingLevel`、未新增状态（仍是助理 `thinking`、子代理覆盖 `thinking|null`、助理级 `follow|fixed`）。
- 未动 `.github/release-scope.json`（仍是 `all-intel`，tag 触发含 Intel）；未 push、未 tag、未装 App。

## 三、验证状态（如实：本轮**未跑任何测试/构建**）
- **本检查点只做 git 合并 + 读代码**：无 `build` / `npm ci` / `vite` / 服务端 / 浏览器 e2e（重测试槽 `sa_mvbc7ddxqfkd4s` 在用，未放行）。
- 已具事实（来自 owner 在自己树上的实跑，**本树未复现**）：滑块纯逻辑 + 静态 DOM 夹具 **19/19**、`tsc --noEmit -p apps/web` exit 0、web `vite build` 通过；动效侧 motion 边界/引擎 token/reduce 覆盖/旧主题兼容/AI payload 用例（数量见 `theme-motion-token-contract.md`）。
- **待测试槽（放行后按此顺序跑，不全量、不重跑 GB 级 smoke）**：
  1. 两端 `tsc --noEmit`。
  2. `e2e/thinking-slider-frontend.test.mjs` + 服务端 `theme-manifest` / `theme-ai` 定向用例。
  3. `vite build`（web）。
  4. 1 条浏览器集成串行：七档展示 / 子集 / 候选池并集 / 关闭 vs 跟随 / 单模型 1 档或 0 档 / 保存失败复原 / 拖动只在 `pointerup` 提交（`pointercancel` 不提交）/ 键盘 / Esc 后焦点回芯片 / 390 宽四主题 + DIY steps；用 fake AI + manifest 安装 → 改 motion → **滑块 computed animation/transition 真的变化**；preview 取消 / reload 持久化 / 导出导入。
  5. `e2e/subagent-thinking-levels.mjs`（含本检查点修的选择器）、`model-ui` / `model-capabilities` 等受影响的 legacy 夹具，**只更新断言不得弱化**。
  6. A / C 已在本树修完（§六，代码 + 断言，**未跑**）：放行后按 1–5 跑，并跑新增的 A / C 断言（同一 `e2e/thinking-slider-frontend.test.mjs`）。

## 四、还差什么才算可发（未达成，不称可发）
- **theme-DIY owner 的验证可能追加新 commit**：本树合的是快照 `ffbfb7f`；若该分支随后有新 commit，需**再走一次增量 merge**（同一 `--no-ff` 流程 + 本文件续记），否则不能当最终状态。
- 上面的 **A（实时主题切换后滑块分支）、C（回滚竞态）已修（§六），但尚未跑测试**；D 已有结论（§六）。放行后按 §三 跑过、重测试槽串行结果贴回来后，才能更新 `beta.29-final-validation` 并谈打包；tag 用**下一个未用编号**（现公开最新仍是 `v0.1.0-beta.27`，`v0.1.0-beta.28` 已建在 `11ce8f2` 上，**不得重发/移动旧 tag**）。
- 本轮**未 push**：候选树仍在本地；Push 与打包等主发放行。

## 五、环境与清理
- Node `v24.20.0`；本树 `node_modules` 为共享软链（未 `npm ci`、未改共享 link）。
- 本轮**没有**启动任何长期进程 / 服务器 / 浏览器，无孤儿进程需要清理（合并是纯 git 操作）。

## 六、本树轻量修复（A / C 必修项 + D 结论；**已改、未跑**）

2026-10-24 续作（同一 worktree `release-candidate-validation`，从 `6babde5` 起）。本轮**只做 `read` / `edit` / `git` / 静态 node check**：未 `build`、未起服务 / 浏览器 / 模型、未跑测试、未 `npm ci`（重测试槽 `sa_mvbc7ddxqfkd4s` 仍在用）；未 push / 未 tag / 未装 App。

### A `--mo-style` 主题实时切换（已修，代码 + 断言）
- 新增 `apps/web/src/themes/motion-signals.ts`：`readMoStyle(el, env?)` 读一次计算样式里的 `--mo-style`（去空白，空值→`null`）；`watchMoStyle(el, onChange, env?)` 先读一次，再用**一个有界 MutationObserver** 订阅 `<html>` 的 `data-skin` / `data-mode` / `class` / `style` 与 `<head>` 样式表的增删 / 文本变化，**值真的变了**才回读；返回 `disconnect`（弹层关闭 / 组件卸载时调用）。`env` 可注入 → 不依赖浏览器就能单测。
- `ThinkingSlider.tsx`：删掉 `useLayoutEffect(..., [])` 的挂载单次读，改 `useMoStyle(rootRef, reduced)`——订阅只在组件挂载（弹层可见）期间存在，关闭 / 卸载即断开；reduce 开关变化时**同一套订阅**重挂并回读（不另起监听）；值没变不 setState（不无谓重渲染）。
- 为什么不用主题 store / 事件：DIY 预览在**同一个 custom id** 下只改临时 `<style>` 文本，`data-skin` 与 store 都不变；仓库里也没有主题变更事件总线——**不为此新建 store / 状态**。
- 明确不做：全页 MutationObserver、轮询、每帧 `getComputedStyle`、重挂控件（拖动 / 焦点不受影响）；`--mo-scale` / `--mo-glow` / `--mo-ease` / `--pa-dur-*` 仍由 CSS 变量自动生效，其他 token 不动。

### C `Models.tsx` 保存思考强度的回滚代次（已修，代码 + 断言）
- 新增 `apps/web/src/latest-write.ts`：`LatestWrite`（`begin` / `isCurrent` / `confirm` / `fail` / `invalidate`），语义 = 「最后一次为准」+「回滚只落到服务端确认过的值」。
- `Models.tsx` `DefaultModelPicker.saveThinking`：发起前 `begin()`；失败时 `fail(id)`——不是最新一次 → 不回滚（**不覆盖用户后来的选择**）；是最新一次 → 先回落到 `confirm` 过的值（**不用未确认的乐观值当真相**），再 `readThinking()` 回读 `/api/models/defaults` 取**服务端真值**；组件卸载时 `invalidate()`（在飞响应不落地，不串到别的助理）。`onPick(level)` 口径与调用方不变，不关掉操作（乐观更新照旧）。
- 服务端顺序核实（读代码，未跑）：`PUT /api/models/default` 校验后同步 `setSetting` 后到覆盖先到，响应体只有 `{ok:true}`；客户端不再拿旧响应改界面，因此「旧的 success 盖掉新的 failure」没有路径。**未做**（按指示可选）：并发 PUT 的串行化——本轮**不声称 HTTP 层到达顺序有保证**，只保证界面始终是用户最后一次选择、失败时对齐服务端真值。
- 同页复核：`ModelPicker.tsx` 的 `patchAgent` 按 `agentId` 合并，不会串到别的助理；迟到的旧响应仍可能把**该助理**的显示回退到旧的服务端值——**未改**（不在必修项，且它没有乐观回滚路径），如实记为已知残余。

### D 同档点击时弹层不关：保持现行为，不改代码
- 事实核对：`thinking-slider.ts` 的 `shouldCommitThinking` 注释写明「值和已生效的一致：不写、**不关弹层**」；`ModelPicker.tsx` 那句「提交后按原行为关菜单」说的是**提交路径**（提交才关）——两者一致，不是设计冲突。
- 设计稿 `docs/design/thinking-strength-slider.md` 只规定提交时机（拖动 `pointerup` 才提交）与关闭方式（点外部 / `Esc`），**没有**「点同一档必须关」的条目。
- 因此不改：拖动不会每个 tick 关弹层；点同一档保持打开（避免无意义写入）；不做「再点同一档收起」的新交互（需要把「UI 关闭」与「onChange」分开，属交互变更，等测试槽真浏览器确认后再谈）。`§二 E` 的 `e2e/subagent-thinking-levels.mjs` 选择器修正保留。

### 测试断言（新增，**本树未跑**）
- `e2e/thinking-slider-frontend.test.mjs` 新增：A 组（`readMoStyle` 去空白 / 空值 / 无计算样式；`watchMoStyle` 只观察 `<html>` 属性 + `<head>` 样式文本、`smooth → steps → 取消还原` 都回读且不重挂组件、值没变不重复回调、断开后不再回读、无 MutationObserver 时降级为只读一次）；C 组（迟到失败不回滚新选择、最新失败回落到服务端确认值、乱序成功不改确认值也不盖新回滚、新成功更新落点、`invalidate` 后在飞响应不落地）。
- **本树本轮实际只跑了**：`node --check e2e/thinking-slider-frontend.test.mjs`（语法 OK）、`tsc --noEmit -p apps/web`（exit 0，118 个 src 文件）。**未跑** `node --import tsx --test e2e/thinking-slider-frontend.test.mjs`、未跑浏览器 e2e、未 `vite build`——A 的观感（切主题 / 预览时滑块 computed `transition` / `animation` 真的变）仍需测试槽的浏览器 e2e；C 的组件接线仍需真 server 定向验证。
- 涉及文件：`apps/web/src/themes/motion-signals.ts`（新）、`apps/web/src/latest-write.ts`（新）、`apps/web/src/components/ThinkingSlider.tsx`、`apps/web/src/components/Models.tsx`、`e2e/thinking-slider-frontend.test.mjs`；修复提交 `997b3e4`（文档为本提交）。未动 Pi SDK / `node_modules` / 生产配置 / 用户数据 / 凭据；未 push / 未 tag。
