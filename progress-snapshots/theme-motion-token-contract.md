# 主题动效 token 契约（AI DIY 表现能力 · v1 增量）

> 状态：**next 候选（预计 beta.29）实现中，未发布**。本文件是给主会话 / 七档滑块 worker 的**接口契约**，
> 由「AI DIY 主题表现与动效」这条线负责（独占 `packages/shared/src/theme-manifest.ts` +
> `apps/web/src/themes/manifest.ts` + themeAI 后端 contract / prompt / schema）。
> 实现落地后，正式说明写进 `docs/design/ai-theme-diy.md` / `appearance-themes.md`；本页只做协作接口，不重复全文。

## 0. 一句话

`ThemeManifestV1` **不升版本**，新增一个**可选**的顶层 `motion` 段（模式无关：light / dark 共用一套）。
旧 v1 主题（没有 `motion`）继续合法，引擎补内置默认，**不丢、不覆盖**。动效仍是**有界 typed token**，
不是任意 CSS / JS：时长限范围、缓动限枚举或受限 `cubic-bezier()`，其余 enum。

## 1. manifest → CSS 变量映射（引擎产出）

引擎把 `motion` 段编译进 `[data-skin="custom-<id>"]` 作用域（与颜色 / 圆角 / 字体同一处），
**不写全局 `html{}`**，所以只影响该 DIY 主题。

| manifest 字段 | 产出 CSS 变量 | 默认值（缺省 / 旧主题） | 允许值 |
| --- | --- | --- | --- |
| `motion.durationFast` | `--pa-dur-fast` | `.12s` | 时长串 `40ms..1200ms`（`ms` / `s`） |
| `motion.duration` | `--pa-dur` | `.18s` | 同上 |
| `motion.durationSlow` | `--pa-dur-slow` | `.26s` | 同上 |
| `motion.easeOut` | `--pa-ease-out` | `cubic-bezier(.2,.8,.2,1)` | 枚举名 / 受限 `cubic-bezier()` |
| `motion.easeExpand` | `--pa-ease-expand` | `cubic-bezier(.22,1,.36,1)` | 同上 |
| `motion.easeSpring` | `--pa-ease-spring` | `cubic-bezier(.2,.9,.3,1.35)` | 同上 |
| `motion.scale` | `--mo-scale` | `1` | 数字 `0.5..2`（时长倍率） |
| `motion.glow` | `--mo-glow` | `normal` → `1` | 枚举 `none`/`subtle`/`normal`/`strong` → `0/.5/1/1.6` |
| `motion.style` | `--mo-style` | `smooth` | 枚举 `smooth` / `steps` |

- 缓动枚举名（引擎映射到内置 bezier，不引入外部资源）：`linear` `ease` `ease-in` `ease-out` `ease-in-out` `standard` `emphasized` `spring-soft`。
- 受限 `cubic-bezier(a,b,c,d)`：`x1,x2 ∈ [0,1]`，`y1,y2 ∈ [-0.5,1.5]`；其余（含 `steps()`、`url()`、`;`、`{}`）一律 fail-closed。
- 未知 `motion` 字段 → 报错（不静默丢弃）；坏值 → 拒绝整份 manifest，**不 reset 当前主题**。

## 2. 七档滑块（`--mo-*`）消费约定 —— 给滑块 worker

滑块组件**只读这些 token + 既有颜色 / 圆角 token**，颜色 / 动效**不得从 JS 写死**（否则覆盖不了用户 DIY 主题）：

- 通用时长 / 缓动：`--pa-dur-fast` / `--pa-dur` / `--pa-dur-slow`、`--pa-ease-out` / `--pa-ease-expand` / `--pa-ease-spring`。
- 滑块专用旋钮（**新增**）：`--mo-scale`（时长倍率，乘到档位切换时长上）、`--mo-glow`（光晕强度数字）、`--mo-style`（`smooth` 连续 / `steps` 离散，像素风用）。
- 配色 / 形状 / 字体：`--acc` / `--acc2` / `--acc-soft` / `--line` / `--line-strong` / `--r` / `--font`（已在 DIY 白名单内，引擎已真正输出到 `[data-skin=custom-*]`，**不是"样式继承"糊弄**）。

**明确不做**：不为 7 档各写一套 token（`--pa-thinking-off/…/max` 之类）。档位的**语义 / 键位 / snap / 继承**在任何主题下一致；
主题只改**表现层**（时长 / 缓动 / 光晕 / 风格 / 密度），密度差异由组件按档位 + `--mo-scale` 推导，不进 schema。
即：**不需要新增 `--pa-thinking-*` 粒子 / 纹理字段**。

## 3. reduced-motion 安全边界（硬约束）

- 引擎在自定义主题 CSS 末尾**自带**一段 `@media (prefers-reduced-motion: reduce){ [data-skin="custom-<id>"]{--pa-dur-fast:0s;--pa-dur:0s;--pa-dur-slow:0s;--mo-scale:0} }`，
  写在同一 `<style>` 的后面 → 同特异性下后写覆盖，**用户无法用 motion token 打开 reduce 禁止的位移 / 循环**。
- 组件侧仍应自查 `matchMedia("(prefers-reduced-motion: reduce)")` 决定是否播放粒子 / 位移（参考 `PetSprite.tsx`）；
  token 置零只是安全网，**不替代**组件判断。
- 交互动效**播完即停**：无后台 RAF / timer / 无限粒子（滑块设计 §5 的硬约束不变）。

## 4. 其它边界（不变）

- 不改 Pi SDK / `node_modules` / 私有 API；主题与 Pi TUI theme 无关。
- 不允许任意 CSS / JS / 远程 `url()` / `@import` / SVG；不开放"任意表现能力"。
- 覆盖范围**只限白名单 token**：颜色 / 圆角 / 字体 / 装饰 enum / 动效 token。
- 固定语义（七档、键盘、跟随 / 继承、reduced-motion）**不可被主题覆盖**；主题不能隐藏关键错误、不能改 `position:fixed` 布局、不能注入 URL / 脚本。

## 5. 影响面 / 交接清单

| 文件 | 变更 | 负责 |
| --- | --- | --- |
| `packages/shared/src/theme-manifest.ts` | `ThemeMotion` + 枚举 / 默认 + 校验（v1 兼容） | 本线 |
| `apps/web/src/themes/manifest.ts` | `motionTokens()` 输出 `--pa-*` / `--mo-*` + reduce 覆盖块 | 本线 |
| `apps/web/src/themes/base.css` | 确认 `html{}` 默认值与本表一致（不改行为） | 本线 |
| `packages/server/src/themes/tool.ts` | `theme_draft` 参数 + 系统提示加 `motion`（模型按同一 schema 产） | 本线 |
| `apps/web/src/components/ThemeDesigner.tsx` | 同页「动效微调」按需入口（编辑 `motion` 立即预览） | 本线 |
| 七档滑块组件 / CSS | 消费 `--mo-*` + `--pa-*`，不写死颜色 | 滑块 worker |
