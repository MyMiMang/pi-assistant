# 思考强度滑块 · 交互设计稿

> **状态：生产实现已落地（beta.29 候选，未打包 / 未 push / 未 tag），浏览器 e2e / build / 真机待测试槽。** 本文件是交互设计稿（受控正式文档），配套单文件原型
> `docs/design/thinking-strength-slider-prototype.html`（浏览器直接打开，纯模拟数据，不调用模型、不写设置）。
> 实现见工作树 `thinking-slider-implementation`：`apps/web/src/thinking-slider.ts`（纯逻辑）+ `apps/web/src/components/ThinkingSlider.tsx`（公共组件）+
> `apps/web/src/components/ModelPicker.tsx`（`ThinkingButton` / 模型菜单接入）+ `apps/web/src/themes/app.css`（`pa-think-*` 样式与主题 token）+
> 测试 `e2e/thinking-slider-frontend.test.mjs`。落地遵循 [§7 实施方向](#7-实施方向复用不新造状态)，不新造状态、不改服务端 clamp。
> 主题 / DIY 动效 token 见 `progress-snapshots/slider-token-contract.md`（与 AI DIY 的 `--mo-*` 契约对齐）。

> 交互设计稿，**不调用模型、不写入设置、不改生产控件**。配套文件：
> `design/thinking-strength-slider-prototype.html`（单文件自包含，浏览器直接打开）。
> 原型里的模型与档位样本都是**模拟数据**，只用于演示。

## 1. 设计目标

输入栏（composer）里现有 chip 打开一个约 320px 的弹层，把「思考强度」从下拉列表升级成**离散滑块**：

- 顶部一行：中文当前强度 + 短模型名。
- 中间：44px 手柄，带 snap 刻度与「星点能量」渐变。
- 底部：一句非承诺的速度/用量提示。

不照搬 Codex 的 logo 或固定「Ultra」等级美化——档位、文案、颜色都来自本项目已有定义。

## 2. 为什么是离散滑块，而不是自由滑杆

Pi 的思考档位是**枚举**（`ModelThinkingLevel = off | minimal | low | medium | high | xhigh | max`），不是连续百分比；而且**每个模型只支持其中一个子集**（`getSupportedThinkingLevels`）。因此：

- 滑块格子数 = 当前模型支持的档位数，`snap` 到具体档位，**没有「63%」这种模型不存在的值**。
- 7 档全量只在「全部 7 档展示」区做设计展示，**不代表当前模型全支持**。
- 换模型后档位会真的变少/变多；候选池场景按 `thinkingLevelsUnion` 取**并集**（至少一个候选支持就保留），不做交集、不提前裁掉 `xhigh`/`max`。
- 用户保存过的档位若当前模型不支持：**不静默假装保留**。原型会显示「待规范化：旧→新」并给两个动作（按收敛后的档运行 / 改选支持的模型），收敛规则示意用 `clampThinkingLevel`（取不超过目标的最高支持档）。

## 3. 交互与可访问性

| 项 | 设计 |
| --- | --- |
| 打开 | `chip` 点击；键盘 Enter/Space 打开后焦点落到手柄（鼠标打开不抢焦点，不打断编辑） |
| 选择 | 点击刻度 / 拖动 / 方向键 / Home / End / PageUp / PageDown |
| 提交时机 | **拖动中只预览，`pointerup` 才写原型 state**；键盘按一次即提交（keyboard commit）。均无真实持久化 / API |
| 语义 | `role="slider"`，`aria-valuemin/max/now`，`aria-valuetext="思考强度：高"`（中文） |
| 关闭 | 点击外部 / `Esc`；关闭后焦点回到 chip；`Esc` 不改变已提交值 |
| 触摸 | 手柄 44px 命中区；弹层 320px 宽，390px 视口内不溢出（JS 再做一次边界收敛） |
| 少档/无档 | 只有 1 档 → 说明「只有一档，不需要调整」；0 档 → 「这个模型不支持调整思考强度」，都不显示滑块 |
| 位置 | 单聊 / 群聊成员 / 子代理**统一用 composer 里的同一入口** |

## 4. 继承与 off（两者不是一回事）

- **「关闭」是模型的一档**，永远在最左，`off` 就是「不做推理」。
- **「跟随助理默认 / 跟随主会话」是继承别的设置**，不是第 8 档，所以放在**滑块外的 reset action**（虚线按钮 + 「当前实际：中」badge），不占最左格。
- 语义沿用现有代码：
  - 主会话 / 群聊成员：助理有自己的 `thinking`，没有「跟随」（与 `ModelPicker` 一致）。
  - 子代理（单个覆盖）：`thinking = null` 即跟随，chip 显示「跟随·中」，`resolvedThinking` 是实际生效档位（与 `Subagents.tsx` 一致）。
  - 助理级子代理默认：`mode: follow | fixed`，标签「跟随主会话」（与 `SubagentModels` 一致）。
- 运行中的子代理改档：按现有实现立即用于该子代理、不动主会话；排队/未开始的下一轮生效。**本轮只做语义标注，不新增行为。**

## 5. 不同档位的动效区别（表现层，不改语义）

星点能量随档位在**密度 / 层次 / 幅度**上递进，**不表示「越快越聪明」**：

| 档位 | 星点 | 切换预览动效 |
| --- | --- | --- |
| 关闭 off | 0 | **完全无动画**（静态） |
| 极简 minimal | 1 | 一次短闪 ≈320ms |
| 低 low | 3 | 稀疏缓移 ≈400ms |
| 中 medium | 5 | 柔和两层 ≈480ms |
| 高 high | 8 | 多一层景深 ≈560ms |
| 超高 xhigh | 12 | 细密微闪 ≈620ms |
| 最大 max | 16 | 最丰富、幅度克制 ≈700ms |

硬性约束：

- 动效**只在拖动 / 切换时播放一次**（300–700ms），**播完即停**；弹层收起后**没有后台 RAF / timer / 无限粒子**。
- 静止状态很轻或完全静态；不做「思考正在运行」的假象。
- `prefers-reduced-motion`（或演示开关）：去掉位移与粒子，只保留静态对比差（手柄描边高亮），键盘 7 档仍全部可达。
- 不靠颜色唯一区分：每格都有**中文刻度名**，当前档位另用高亮 + 手柄内中文短标。

## 6. 主题差异：只换 token，不换组件

不同主题下**样式与动画不同**，但实现方式是**同一套组件 + 每个主题覆盖 token**，不是五套独立组件、也**不从 JS 写死颜色**（否则会覆盖用户的 DIY 主题）：

- 只用主题 token：`--acc` / `--acc2` / `--acc-soft` / `--line` / `--line-strong` / `--r` / `--font`，以及动效旋钮 `--mo-scale`（时长倍率）、`--mo-ease`（缓动）、`--mo-glow`（光晕）。
- DIY / 自定义主题：直接沿用用户已有的 accent / 边框 / 字体 / 圆角 token；原型额外提供 `--user-acc` / `--user-r` 作为 fallback 演示，**不要求用户另配 5 套**。
- 七档的 semantic / mapping / keyboard / snap / inherit **在任何主题下完全一致**，主题只改 density / duration / texture。

原型内置的 5 个样本主题表现差异：

| 主题 | 表现差异（仅表现层） |
| --- | --- |
| linear 极简专业 | 干脆、无光晕、更快更直线 |
| glass 毛玻璃 | 柔和通透、大圆角、轻光晕、时长 ×1.18 |
| warm 暖色人文 | 暖色、轻微呼吸 / 短泛光、幅度更小 |
| pixel 像素风 | 阶梯像素边角、等宽数字、**离散成步（steps）不丝滑弹簧**、手柄瞬移 |
| noir 暗夜 | 高对比、克制线条、辉光集中 |
| custom DIY | 无内置配色，走 token fallback |

## 7. 实施方向（复用，不新造状态）

- 复用现有 **`ThinkingButton`** 的位置与共用组件/入口（单聊、群聊成员、子代理同一处），只把弹层内容从列表换成滑块；保留 `testid` 与 `onPick(level | null)` 口径。
- 档位来源不变：主模型用 `getSupportedThinkingLevels`，多候选用 `thinkingLevelsUnion` / `thinkingLevelsFor`；收敛用 `clampThinkingLevel`。
- **不新增一套状态**：仍然是「助理的 `thinking`」「子代理覆盖 `thinking | null`」「助理级 `follow | fixed`」三处，滑块只是换一种编辑方式。
- 文案复用 `THINKING_LABEL`；`THINKING_DESC` 里「最快 / 默认 / 更贵」这类绝对说法**不搬进设计**，统一成「较高强度通常更慢，并可能增加用量；具体取决于模型」。

## 8. 落地状态与边界

- **已实现（beta.29 候选，未打包）**：`ThinkingButton` 弹层与模型菜单里的思考强度都换成离散滑块；主会话 / 群聊 / 子代理 / 设置复用同一组件；档位来自 `getSupportedThinkingLevels` / `thinkingLevelsUnion`，收敛仍由服务端 `clampThinkingLevel`。
- 交互：拖动只预览、`pointerup` 提交；`pointercancel` / 窗口失焦 / Esc 关闭**不提交**半途预览；键盘 Arrow / Home / End / PageUp / PageDown 逐档提交；`role="slider"` + `aria-valuetext`；44px 命中；`--mo-scale` 缩放时长。
- 主题：颜色 / 圆角 / 字体 / 动效只走 token（`--pa-*` / `--mo-*`），组件不写死颜色；`--mo-style=steps` 由组件读主题声明值映射成真实 data 属性，并订阅 `<html>` 属性 / `<head>` 样式表变化（`apps/web/src/themes/motion-signals.ts`）在主题 / DIY 预览改变时回读，切主题不重挂组件也生效（订阅只在弹层挂载期间存在）。
- **未验**：浏览器 e2e（`e2e/subagent-thinking-levels.mjs`、`model-ui.mjs`、`run.mjs` 相关步骤）、`vite build`、真机与真模型。**未做**：真实持久化 / 后端改动（沿用现有写入），未改 SDK / 服务端 clamp。
- **候选树后续修复（2026-10-17）**：A 主题实时切换的 `--mo-style` 订阅回读、C 默认思考强度保存的回滚代次 —— 代码 + 断言已写、**未跑**，见 `progress-snapshots/beta29-integration-checkpoint.md` §六。

### 9. 模型目录加载态（2026-10-17，beta.29 候选）

档位来自前端模型目录（`useConfiguredModels`）。以前目录还没回来时 `levels=[]`，弹层会显示「这个模型不支持调整思考强度」——把「还没加载」说成了「不支持」。现在分三态：

- `loading`：还没拿到目录（刷新时保留旧数据、不清空）。弹层只显示「正在加载模型档位…」，**不画滑块、不说「不支持」**；加载中 Esc / 点外部照常关闭，已选档位原样显示、不写库（不会被改成 `off`）。
- `error`：这次拉取失败（只有最新一次请求算数，迟到响应不覆盖）。弹层给一句「模型目录没加载出来」+「重试」（复用 `reload`），不冒充「不支持」。
- `ready` 且 `levels` 为空：才是**真不支持**，仍走原 `unsupported` 说明。

成功返回后**开着的弹层直接变成完整滑块**，不用退出再进。子代理会话与助理设置两处都传 `loading/error/onRetry`；模型菜单在目录未到时显示「正在加载模型…」，不误报「还没有配置模型服务」。定向 DOM：`e2e/subagent-thinking-loading.mjs`（真实服务端 + 真实构建 + Chromium，只拦截 `/api/models`）**18/18**。

