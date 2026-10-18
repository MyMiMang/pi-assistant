# AI DIY 主题：当前能力与明确待接（设计 / 现状）

状态：已实现

> 一句话：**AI 造主题的「颜色 + 圆角 + 字体 + 阴影 + 纹理 + 角形 + 装饰」已经接通并有真实入口；「动效参数（时长 / 缓动 / 倍率 / 光晕 / 风格）」已在 next 候选（预计 beta.29）接通：`ThemeManifestV1` 新增可选 `motion` 段，由同一套 fail-closed 校验器与引擎编译成 `--pa-dur-*` / `--pa-ease-*` / `--mo-*`；七档滑块消费 `--mo-*`，不再由 JS 写死。**（已发布版本仍是旧能力，勿把候选写成已发布。）
>
> 入口（唯一，用户已取消 `/主题设计` slash）：**设置 → 外观 → 用 AI 设计主题**；已保存 DIY 主题的「编辑 / 继续用 AI 修改」。保存前不覆盖原主题，可另存为新主题；面板内提供「动效微调（可选）」按需入口。
> 详细能力盘点、数据流与安全边界见 [appearance-themes.md](appearance-themes.md)（本页只讲「组件 / 动效级 DIY」的范围与缺口，避免重复全文）；动效 token 协作契约见 `docs/design/theme-motion-token-contract.md`。

## 1. 底座：CSS 变量，不是 JS 写死

- 组件样式统一在 `apps/web/src/themes/base.css`（`pa-*` 类），只读 CSS 变量；每个主题是 `[data-skin=<id>]` 作用域下的一组 token。
- 自定义主题 = 一份 **`ThemeManifestV1`**（`packages/shared/src/theme-manifest.ts`，v1 冻结）+ 白名单 token；引擎 `apps/web/src/themes/manifest.ts` 把它编译成 `[data-skin="custom-<id>"]` 的变量与少量装饰规则。
- **硬约束**：新组件样式必须走 token / 变量，**不能写死在 JS 或内联 style 里绕过 DIY**（否则 DIY 主题覆盖不到，等于该组件不可主题化）。这条对后续新控件（含 7 档思考强度滑块）同样成立。

## 2. 现在 DIY 能改什么（已接通）

| 维度 | 对应 | 状态 |
| --- | --- | --- |
| 颜色（背景 / 卡片 / 正文 / 次要文字 / 分隔线 / 强调色 / 语义色…） | `REQUIRED_COLOR_TOKENS` 20 项 + `OPTIONAL_COLOR_TOKENS`（`--acc2` / `--live`） | ✅ 必需项缺一个就 fail-closed |
| **交互状态的颜色**（悬停 / 按下） | `--hover`、`--active`、`--acc-soft` | ✅ 颜色层已可主题化（但**形状 / 时长 / 缓动**见 §3） |
| **圆角排版** | `OPTIONAL_SIZE_TOKENS`：`--r` / `--r-sm` / `--r-bubble` / `--r-tail` / `--r-comp` / `--r-btn` / `--r-chip` / `--r-logo` / `--r-av` | ✅ |
| 字体 | `OPTIONAL_FONT_TOKENS`：`--font` / `--display` / `--mono`（严格字符集，不收 `url()` / 函数） | ✅ |
| 阴影 / 质感 | `decor.shadow` = `soft` / `elevated` / `none` → 引擎出 `--shadow` / `--comp-shadow` / `--btn-shadow` | ✅（enum，不出自由字符串） |
| 纹理 / 背景 | `decor.texture` = `none` / `dots` / `grid`、`decor.background` = `flat` / `glow` → 纯 CSS 渐变，无 `url()` / SVG / 远程资源 | ✅ |
| 角形 | `decor.corner` = `round` / `step2` / `step4`（8bit 阶梯，只裁装饰元素） | ✅ |
| 图片素材 | `images[]` + `THEME_IMAGE_USAGES = reference / background / decor`；默认 `reference` 不嵌入主题，只有用户显式选「用作背景 / 装饰」才成为素材 | ✅ |
| **动效（时长 / 缓动 / 倍率 / 光晕 / 风格）** | `motion` 段（模式无关）：`durationFast/duration/durationSlow`（40..1200ms）、`easeOut/easeExpand/easeSpring`（枚举名或受限 `cubic-bezier()`）、`scale`（0.5..2）、`glow`（enum）、`style`（`smooth`/`steps`）→ 引擎编译 `--pa-dur-*` / `--pa-ease-*` / `--mo-scale` / `--mo-ease` / `--mo-glow` / `--mo-style` | ✅（next 候选，预计 beta.29） |
| 生成 / 校验 / 预览 / 持久化 | AI 生成 JSON → `validateThemeManifest`（unknown_token / 格式 / 对比度 warning，坏值 fail-closed 不 reset 现用主题）→ 临时全 app 预览 → 取消恢复 / 应用持久化 | ✅ |

## 3. 边界与已收敛的缺口

1. **动效参数已进 schema（next 候选）**：`ThemeManifestV1` 新增**可选**顶层 `motion` 段（模式无关），引擎在 `[data-skin=custom-<id>]` 作用域输出 `--pa-dur-fast/.--pa-dur/.--pa-dur-slow`、`--pa-ease-out/expand/spring` 与 `--mo-scale/--mo-ease/--mo-glow/--mo-style`。仍是**有界 typed token**：时长限范围、缓动只允许枚举名或受限 `cubic-bezier()`（x∈[0,1]、y∈[-0.5,1.5]），其余 enum；**不升 manifest 版本**，旧 v1 主题缺 `motion` 仍合法，引擎补内置默认（不丢 / 不覆盖）。
2. **交互状态的形状 / 时长**：hover / pressed 的位移、缩放现在可由主题的 `motion` 影响（时长 / 缓动走 token）；**幅度本身**仍是组件固定值，不由主题任意放大（避免主题做出夸张位移）。
3. **七档思考强度滑块与主题的联动**：滑块设计 §6 的 `--mo-scale` / `--mo-ease` / `--mo-glow` 旋钮**已在 schema / 引擎中存在**（`--mo-ease` 由 `--pa-ease-out` 承担）；滑块组件本身由在修树负责，**只消费 token，不写死颜色 / 时长**。**不为 7 档各写一套 token**：语义 / 键位 / snap / 继承在任何主题下一致，主题只改表现层。
4. **组件质感级 DIY 的边界**：非颜色 token 仍限于白名单 enum / 尺寸 / 字体 / 动效；「任意组件质感」不会做（禁止任意 CSS / JS / 远程资源），只能通过新增受控 token 逐项开放。
5. **reduced-motion 硬边界**：引擎在自定义主题 CSS 末尾自带 `@media (prefers-reduced-motion: reduce)` 覆盖块（把时长置零、`--mo-scale` 置 0），`base.css` 也给内置主题同一段；**用户无法用 motion token 打开 reduce 禁止的位移 / 循环**，组件侧仍需自查 `matchMedia`。

## 4. 落地顺序（已按此实现，next 候选）

1. `packages/shared/src/theme-manifest.ts`：新增可选 `motion` 段白名单（时长范围、缓动枚举 / 受限 bezier、倍率、光晕 / 风格 enum），补校验与单测；**不升版本**，旧 manifest 不破。
2. `apps/web/src/themes/manifest.ts`：`motionTokens()` 输出 `--pa-*` / `--mo-*`；`base.css` 的 `html{}` 默认值与之对齐（内置主题另给 `--mo-*` 默认 + reduce 安全网）。
3. 七档滑块按 [thinking-strength-slider.md](thinking-strength-slider.md) §7 复用 `ThinkingButton`，**只换编辑方式、不新造状态**，样式全走 token。
4. 动效开关统一尊重 `prefers-reduced-motion`（见 `app.css` 末尾 + 引擎自带覆盖块），主题无法绕过。

## 5. 边界声明

- 不改 Pi SDK / `node_modules` / 私有 API；web 主题与 Pi 的 TUI theme schema 无关。
- 不新增后端 API；跨设备同步只在既有 server 设置能力上复用。
- 本页是现状与缺口说明；**未接通的项不许写成已实现**，发布说明与 HANDOFF 同一口径。
