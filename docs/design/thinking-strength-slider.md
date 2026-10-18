# 思考强度滑块 · 交互设计稿

> **状态：生产实现已落地（beta.29 已公开）；视觉已按用户 2026-10-17 最终参考图重做（beta.30 候选，未 push / 未 tag / 未打包）。** 本文件是交互设计稿（受控正式文档），配套单文件原型
> `docs/design/thinking-strength-slider-prototype.html`（浏览器直接打开，纯模拟数据，不调用模型、不写设置）。
> 实现见工作树 `thinking-slider-implementation`：`apps/web/src/thinking-slider.ts`（纯逻辑）+ `apps/web/src/components/ThinkingSlider.tsx`（公共组件）+
> `apps/web/src/components/ModelPicker.tsx`（`ThinkingButton` / 模型菜单接入）+ `apps/web/src/themes/app.css`（`pa-think-*` 样式与主题 token）+
> 测试 `e2e/thinking-slider-frontend.test.mjs`。落地遵循 [§7 实施方向](#7-实施方向复用不新造状态)，不新造状态、不改服务端 clamp。
> 主题 / DIY 动效 token 见 `docs/design/slider-token-contract.md`（与 AI DIY 的 `--mo-*` 契约对齐）。

> 交互设计稿，**不调用模型、不写入设置、不改生产控件**。配套文件：
> `design/thinking-strength-slider-prototype.html`（单文件自包含，浏览器直接打开）。
> 原型里的模型与档位样本都是**模拟数据**，只用于演示。

## 1. 设计目标

输入栏（composer）里现有 chip 打开一个约 340px 的弹层，把「思考强度」从下拉列表升级成**离散滑块**：

- 顶部：左「思考」标记 + 居中当前档中文名（accent 大字）+ 次行短模型名（长名截断），右上「跟随 / 重置」。
- 中间：36px 粗胶囊轨道（渐变填充）+ 40px 实心高对比圆钮（**钮内无字**，命中区仍是整条 44px 轨道），轨道里少量星点。
- 底部：一句非承诺的速度/用量提示 + 「?」帮助（档位子集等细节放帮助里，不占正文）。

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
| 触摸 | 轨道 44px 命中区、滑钮 40px；弹层 340px 宽（≤640 走底部弹窗），390px 视口内不溢出（JS 再做一次边界收敛） |
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

星点能量随档位在**密度 / 层次 / 幅度**上递进，**不表示「越快越聪明」**；星点铺在**轨道里**（不在手柄内），
静止很轻，只在切换 / 拖动时按档位播一次预览。滑钮里不再放中文短标（档位名在顶部 + 每个刻度的 aria / tooltip）：

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
- 不靠颜色唯一区分：每个刻度都有**中文 aria-label / tooltip**，当前档位另用顶部大字 + 高亮刻度点；
  不再挤一排 7 个小标签（`pa-think-labels` 已移除，`THINKING_SLIDER_SHORT` 一并删除）。

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

### 8.1 最终视觉（用户 2026-10-17 参考图；beta.30 候选）

用户给了一张「Codex 风格 Ultra」截图并说「做成这样的」，这是**生产视觉授权**，不再猜设计：

- **形态**：粗饱满渐变胶囊轨道（36px）+ 右侧实心高对比圆钮（40px，白/主题 fg，**钮内无字**），滑钮与轨道同高衔接、上下略露；最左 / 最右都完整落在轨道内，不越出弹层。
- **顶部**：左「思考」标记（四角星，不是品牌 logo）+ 居中当前档中文（accent，17px）+ 次行模型名（小灰、长名 `truncate`）+ 右上「跟随 / 重置」图标（只有调用方给了 `followLabel` 才出现；**重置 ≠ off**，主会话没有继承语义就不摆这个按钮）。模型名只在**有真实单一选中值**时显示：主模型菜单 / 默认模型按实际 `value.provider/id` 从目录取 `name`，每个子代理固定模型用它自己的模型 id；没有值（助理级「跟随主会话」/ 候选池多选）就不编一个模型名。主模型菜单原先用 `showHead={false}` 关掉了整个头部、外面只剩一行「思考强度」，已改回同一头部并删掉重复小标题。
- **拖动预览**：手柄下标 ≠ 已生效下标时算预览态，头部 / `aria-valuetext` 显示正在预览的档（拖到 max 就写「最大」），不沿用「跟随·X」或旧的降级前缀；松手才提交，取消 / 失焦 / Esc 回到静态值（跟随态回「跟随·当前生效」）。前后端值一律不变。
- **星点**：铺在轨道里（不是手柄内），`off` 无星点；切换 / 拖动才播一次 320–700ms 预览，静止无 RAF / 无循环。
- **底部**：一行「较高强度可能更慢，并可能增加用量」+ 现成 `<Help>`，不再堆工程说明。
- **主题**：全部走 token —— glass 通透渐变 / warm 暖色 / pixel 阶梯（滑钮切角、轨道方角）/ noir 高对比；DIY 的 `--acc` / `--acc2` / 圆角 / 字体 / `--mo-*` 真生效，**不在 JS 里写死紫色或 Ultra**。
- **不变**：七档语义、档位来源（模型支持子集，不伪全 7）、`pointerup` 才提交、键盘 / Home / End、跟随 / 降级、`--mo-style` 实时切换、reduce 静态可辨，一律未动。

改的文件：`apps/web/src/components/ThinkingSlider.tsx`（有限 markup：Head 重排 + 拖动预览头部 + 星点移进轨道 + 去掉手柄文字 / 标签行 + footer 用 `Help`；`showHead` 参数已删）、
`apps/web/src/components/ModelPicker.tsx`（`ModelMenu` 接回滑块头部 + 按实际选中值传 `modelName` + 删外层重复小标题）、
`apps/web/src/themes/app.css`（`pa-think-*` 一节与各主题覆盖）、`apps/web/src/thinking-slider.ts`（删 `THINKING_SLIDER_SHORT`）。
证据：`e2e/thinking-slider-visual.mjs`（真实服务端 + 真实构建 + Chromium，**77/77**，截图写 `docs/screenshots/thinking-slider-*.png`；含主模型菜单头部 / 拖动预览 / 取消回跟随 / 后端不写）、
`e2e/thinking-slider-ui.mjs` **18/18**（A1 加「模型菜单单个头部 + 当前档中文 + 实际模型名」、A1b 加拖动预览头部与未写库；A1 的「一排小标签」断言改为 aria / tooltip，行为断言不变）、
`e2e/thinking-slider-frontend.test.mjs` **29/29**；两端 `tsc --noEmit` 0、`vite build` 通过。
**未验**：真机 App（需用户自己装）、真实云模型、Windows / Linux / 手机真机。

### 9. 模型目录加载态（2026-10-17，beta.29 候选）

档位来自前端模型目录（`useConfiguredModels`）。以前目录还没回来时 `levels=[]`，弹层会显示「这个模型不支持调整思考强度」——把「还没加载」说成了「不支持」。现在分三态：

- `loading`：还没拿到目录（刷新时保留旧数据、不清空）。弹层只显示「正在加载模型档位…」，**不画滑块、不说「不支持」**；加载中 Esc / 点外部照常关闭，已选档位原样显示、不写库（不会被改成 `off`）。
- `error`：这次拉取失败（只有最新一次请求算数，迟到响应不覆盖）。弹层给一句「模型目录没加载出来」+「重试」（复用 `reload`），不冒充「不支持」。
- `ready` 且 `levels` 为空：才是**真不支持**，仍走原 `unsupported` 说明。

成功返回后**开着的弹层直接变成完整滑块**，不用退出再进。子代理会话与助理设置两处都传 `loading/error/onRetry`；模型菜单在目录未到时显示「正在加载模型…」，不误报「还没有配置模型服务」。定向 DOM：`e2e/subagent-thinking-loading.mjs`（真实服务端 + 真实构建 + Chromium，只拦截 `/api/models`）**18/18**。

