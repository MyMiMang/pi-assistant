# 思考强度滑块 · 主题 token 契约（给主题 / DIY worker）

> 状态：**beta.29 候选，未打包 / 未 push / 未 tag**。工作树 `thinking-slider-implementation`
> （基 `release-candidate-validation` `11ce8f2`）。实现见 `apps/web/src/components/ThinkingSlider.tsx` +
> `apps/web/src/themes/app.css` 的「思考强度离散滑块」一节；纯逻辑与测试见
> `apps/web/src/thinking-slider.ts` / `e2e/thinking-slider-frontend.test.mjs`。
>
> 这份文件是**组件已经使用的 token 名单**，供 theme-DIY worker 的 token contract / manifest
> allowlist 对齐。组件对每个新增 token 都有 fallback，**现在不配也能正常显示**；主题 / DIY
> 配置这些 token 即可改质感、密度与动效，**不需要、也不允许**通过非法 custom CSS 绕过 allowlist。

## 1. 语义 / 结构 token（颜色、圆角、字体）

| token | 类型 | 组件里的 fallback | 用途 |
| --- | --- | --- | --- |
| `--pa-think-rail` | color | `var(--line)` | 轨道底色 |
| `--pa-think-fill` | color / gradient | `linear-gradient(90deg, var(--acc-soft), var(--acc))` | 已选区填充 |
| `--pa-think-tick` | color | `var(--line-strong, var(--mut2))` | 未选刻度点 |
| `--pa-think-tick-on` | color | `var(--acc)` | 当前档刻度点 |
| `--pa-think-handle-ring` | color | `var(--acc)` | 手柄描边 |
| `--pa-think-handle-bg` | color | `var(--card)` | 手柄底色 |
| `--pa-think-star` | color | `var(--acc)` | 星点主色 |
| `--pa-think-star-2` | color | `var(--acc2, var(--acc))` | 星点次色（间隔着色） |
| `--pa-think-glow` | number | `1` | 手柄 / 星点光晕强度倍率（0 = 无光晕） |

其余一律复用现有 token：`--fg / --mut / --mut2 / --line / --hover / --card / --acc / --acc-soft / --acc-fg / --r / --r-sm / --font / --mono`。
**组件不写死任何颜色**（颜色只在主题 CSS；`e2e/thinking-slider-frontend.test.mjs` 有一条断言守护这件事）。

## 2. 动效 token

| token | 类型 | fallback | 用途 |
| --- | --- | --- | --- |
| `--pa-motion-scale` | number | `1` | 预览动效时长倍率（档位基础时长 = 320–700ms，见下） |
| `--pa-think-move` | time | `var(--pa-dur)` | 手柄位移过渡时长；pixel 主题设 `none` 走离散瞬移 |
| `--pa-think-ease` | easing | `var(--pa-ease-out)` | 预览动效缓动；pixel 主题可覆盖为 `steps(3, end)` |
| `--pa-think-dur` | number（内联，非主题） | 每档 0/320/400/480/560/620/700 | 组件按档位内联写入，主题用 `--pa-motion-scale` 整体缩放 |

已有共用动效 token（`apps/web/src/themes/base.css`）：`--pa-dur-fast`(.12s) / `--pa-dur`(.18s) / `--pa-dur-slow`(.26s) /
`--pa-ease-out` / `--pa-ease-expand` / `--pa-ease-spring`。

硬性约束（主题也必须遵守）：
- 预览只在切换 / 拖动时**播一次**，播完即停；弹层收起后没有后台 RAF / timer / 无限粒子。
- 只改密度 / 层次 / 时长 / 质感，**档位语义、键盘、snap、跟随**在任何主题下完全一致。
- `prefers-reduced-motion: reduce` 时**不播预览动效**、去掉位移与光晕，只保留静态的星点密度差异（组件同时按 `matchMedia` 跳过计时器）。

## 3. 内置主题的现状（组件侧，app.css 里 `[data-skin=…]` 覆盖）

| 主题 | 表现差异（仅表现层，不写死颜色） |
| --- | --- |
| glass | 手柄光晕更柔（`--pa-think-glow: 1.6`）、弹层毛玻璃 |
| warm | 光晕克制（`--pa-think-glow: .6`） |
| pixel | 手柄 / 刻度 / 星点为像素方角、手柄瞬时到位（`transition: none`）、预览用 `steps(3, end)`、刻度与档位名用等宽字体 |
| noir | 高对比描边、光晕集中（`--pa-think-glow: 1.4`）、弹层线条阴影 |
| custom-*（DIY） | 组件只用上面的 fallback + 现有 accent / 边框 / 圆角 / 字体；DIY manifest 配 `--pa-think-*` / `--pa-motion-scale` 即可，无需另配多套 |

## 4. 给 theme-DIY worker 的对齐要求

1. manifest / token allowlist 里请把上表两项（语义 + 动效）纳入**可配置 token 名单**；
2. 只允许**值**层面的覆盖（颜色、时间、倍数），不引入任意 CSS 规则；
3. 新组件样式（含本滑块）都不要写死颜色 / 时长，统一走 token，避免绕过 DIY；
4. 若需要新增 token，先在本文补一行（名称 + 类型 + fallback），再在组件里以 `var(--pa-think-…, fallback)` 使用。
