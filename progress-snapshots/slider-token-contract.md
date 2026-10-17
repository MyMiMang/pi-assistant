# 思考强度滑块 · 组件消费 token 清单（已对齐 theme-DIY 契约）

> 状态：**beta.29 已公开；视觉重做为 beta.30 候选（未 push / 未 tag / 未打包）**，见 §6。原始实现工作树 `thinking-slider-implementation`
> （基 `release-candidate-validation` `11ce8f2`）。实现：`apps/web/src/components/ThinkingSlider.tsx`
> + `apps/web/src/themes/app.css` 的「思考强度离散滑块」；纯逻辑 / 测试：
> `apps/web/src/thinking-slider.ts` / `e2e/thinking-slider-frontend.test.mjs`。
>
> **已对齐** [theme-motion-token-contract.md](../../theme-diy-motion-implementation/progress-snapshots/theme-motion-token-contract.md)
> （另一工作树 `theme-diy-motion-implementation` 的接口契约，待主合并后在本树可见）。
> 本文件只列**滑块实际 consume 的 token**，以及 `--mo-style` 的落地方式；不再另立一套。
>
> 候选树 `release-candidate-validation` 的后续轻量修复（A：`--mo-style` 跟随主题实时回读；C：默认思考强度保存的代次守卫）见 `beta29-integration-checkpoint.md` §六（已改 / **未跑**）。

## 1. 组件实际消费的 token（不是只输出）

| token | 来源 | 组件里的 fallback | 用途 |
| --- | --- | --- | --- |
| `--pa-dur-fast` / `--pa-dur` / `--pa-dur-slow` | 主题 / DIY motion | base.css 默认 | 手柄位移、跟随按钮、填充过渡等常规切换 |
| `--pa-ease-out` | 主题 / DIY motion | `cubic-bezier(.2,.8,.2,1)` | 通用缓出 |
| `--mo-ease` | DIY motion（= easeOut 别名） | `var(--pa-ease-out)` | 预览动效缓动 |
| `--mo-scale` | DIY motion（`0.5..2`，数字） | `1` | 时长倍率：预览时长 = 档位基础时长 × `--mo-scale`；手柄位移时长 = `--pa-dur` × `--mo-scale` |
| `--mo-glow` | DIY motion（`none/subtle/normal/strong` → `0/.5/1/1.6`） | `1` | 手柄 / 星点光晕强度 |
| `--mo-style` | DIY motion（`smooth` / `steps`） | `smooth` | 见 §3：组件读成真实 data 属性，不直接当缓动字符串 |
| `--acc` / `--acc2` / `--acc-soft` / `--card` / `--line` / `--line-strong` / `--fg` / `--mut2` / `--r` / `--r-sm` / `--font` / `--mono` | 主题 / DIY | — | 配色 / 形状 / 字体 |

滑块专用**颜色**可选覆盖（都有 fallback，不配也正常）：`--pa-think-rail`、`--pa-think-fill`、`--pa-think-tick`、`--pa-think-tick-on`、`--pa-think-handle-ring`、`--pa-think-handle-bg`、`--pa-think-star`、`--pa-think-star-2`。**组件不写死任何颜色**（有测试断言守护）。

`--pa-think-dur` 是组件按档位**内联**写入的基础时长（0/320/400/480/560/620/700），不是主题 token；主题只通过 `--mo-scale` 缩放它。

## 2. 内置主题的表现差异（仅表现层，`app.css` 里 `[data-skin=…]`）

| 主题 | 覆盖 |
| --- | --- |
| glass | `--mo-glow: 1.6`、弹层毛玻璃、轨道 / 填充走半透明渐变 |
| warm | `--mo-glow: .6`、滑钮阴影更软 |
| noir | `--mo-glow: 1.4`、轨道内描边更亮、弹层线条阴影 |
| pixel | `--mo-glow: .4`、`--mo-style: steps`、轨道 / 填充 / 星点方角 + 滑钮阶梯切角、滑钮瞬时到位、预览 `steps(3,end)` |
| custom-*（DIY） | 不覆盖；直接用 DIY 引擎输出的 `--mo-*` + 颜色 token |

## 3. `--mo-style: steps` 的落地（关键）

CSS 里 `--mo-style` 是字符串（`smooth` / `steps`），**不能**直接放进 `animation-timing-function`（会失效）。组件做法：

1. `getComputedStyle(root).getPropertyValue("--mo-style")` 读**主题声明值**（不是读硬编码调色板）；挂载先读一次，之后由 `apps/web/src/themes/motion-signals.ts` 的 `watchMoStyle` 用一个有界 MutationObserver 盯 `<html>` 的 `data-skin` / `data-mode` / `class` / `style` 与 `<head>` 样式表文本，**值真的变了才回读**——所以切主题 / DIY 预览（同一 custom id 只改临时 `<style>` 文本、`data-skin` 不变）不重挂组件也会更新；订阅只在弹层挂载期间存在，关闭 / 卸载断开；
2. 映射成真实属性 `data-pa-mo-style="steps"`（smooth 时不加或为 `smooth`，CSS 只针对 steps 分支）；
3. CSS `[data-pa-mo-style=steps]`：手柄 / 填充 `transition: none`（离散瞬移）、星点 / 刻度方角、预览 `steps(3, end)`；
4. 内置 pixel 也在 `[data-skin=pixel] .pa-think` 声明 `--mo-style: steps`，走同一条 data 属性分支（另有 `[data-skin=pixel]` 直接覆盖兜底，即使 JS 未跑到也成立）。

即：DIY 主题 `motion.style = steps` 时，读数 → data 属性 → 真实 steps 生效，**不依赖 `@container style()` 的浏览器支持，也不注入任意 CSS**。

## 4. reduced-motion 双保险

- 引擎 / base.css 在 reduce 时把 `--pa-dur-*` 置 `0s`、`--mo-scale` 置 `0`（安全网）；
- 组件同时 `matchMedia("(prefers-reduced-motion: reduce)")` 自查：reduce 时**不播预览动效、不启动计时器**（`--mo-style` 的订阅随 reduce 开关重挂并回读，共用同一套监听）；
- CSS `@media (prefers-reduced-motion: reduce)` 再强制 `animation: none` / `transition: none`、去光晕；
- `off` 档基础时长 0、星点 0，任何情况下都不播。

## 5. 边界（不变）

- 固定语义（七档、键盘、snap、跟随 / 继承、reduce）**不可被主题覆盖**；主题只改表现层。
- 不为 7 档各写一套 token；密度差异由组件按档位 + `--mo-scale` 推导，不进 schema。
- 不通过非法 custom CSS / JS 绕过 allowlist；组件只读主题声明 token。

## 6. 最终视觉（2026-10-17 用户参考图；beta.30 候选）

形态改成「粗胶囊轨道 + 实心高对比圆钮（钮内无字）」，**token 契约不变**，只是默认 fallback 换成更贴参考图的值：

| token | 现在的默认 fallback | 说明 |
| --- | --- | --- |
| `--pa-think-rail` | `color-mix(in srgb, var(--fg) 8%, transparent)` | 36px 胶囊底轨，内描边 `var(--line)` |
| `--pa-think-fill` | `linear-gradient(90deg, color-mix(--acc 55%), var(--acc2))` | 宽度 = 档位比例；glass 用半透明版 |
| `--pa-think-tick` / `-tick-on` | `color-mix(--fg 80%)` / `var(--fg)` | 3px 小点，静止 .35 透明度、hover / 拖动态更亮 |
| `--pa-think-handle-bg` | `var(--fg)`（原来是 `var(--card)`） | 实心高对比圆钮 40px；**不再画 ring**（`--pa-think-handle-ring` 仍可覆盖描边） |
| `--pa-think-star` / `-star-2` | `color-mix(--fg 88%)` / `var(--acc2)` | 星点铺在**轨道里**（不再在手柄内），`off` 仍为 0 |

弹层宽度：`.pa-think-pop { --pop-w: 340px; width: 340px }`（`.pa-pop` 的 `max-width: 20rem` 会压回 320，所以两个都要给）。
手柄位移：`left: calc(20px + pos * (100% - 40px))` —— 两端都完整落在轨道内，不再溢出到 padding。

不变：`--mo-*` 的读取与映射（§3）、reduce 双保险（§4）、语义边界（§5）。

生产入口一致：输入栏 / 设置的主模型菜单（`ModelMenu`）与独立「思考强度」弹层用同一个 `ThinkingSlider` **完整头部**，不再在外层重复一行「思考强度」；模型名按实际选中的 `value.provider/id` 从目录取（无值不编名）。拖动预览态头部跟着预览档走，静态态才写「跟随·当前生效」，后端值不受预览影响。

## 7. Fast 闪电（请求级 service_tier，候选未发布）

滑块头部的左侧改成**独立 Fast 按钮**（`Zap`，44px 命中区、图标 21px），不再是四角星；用户已批准的粗渐变轨 / 实心无字白圆 / 居中 strength / 模型名次行**不变**。Fast 与思考强度是两个独立请求语义：点闪电不改档位、换模型或改 `--mo-*`；关闭不附加 `service_tier`。颜色 / 背景只用 `--mut2 / --fg / --acc / --acc-soft / --hover`，glass 加光晕、pixel 去圆角，全部走主题 token；不可用用 `aria-disabled`（仍可聚焦看原因），等待保存 `aria-busy`。实现与口径见 [docs/design/fast-mode-contract.md](../docs/design/fast-mode-contract.md)、进度 [fast-mode-implementation.md](fast-mode-implementation.md)。
