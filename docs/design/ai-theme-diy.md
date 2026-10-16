# AI DIY 主题：当前能力与明确待接（设计 / 现状）

> 一句话：**AI 造主题的「颜色 + 圆角 + 阴影 + 纹理 + 角形 + 字体」已经接通并有真实入口；「交互状态的质感」只到颜色层；「动效参数（时长 / 缓动 / 光晕）」在 manifest schema 里还没有字段，属于明确待接，不许宣称已实现。**
>
> 入口（唯一，用户已取消 `/主题设计` slash）：**设置 → 外观 → 用 AI 设计主题**；已保存 DIY 主题的「编辑 / 继续用 AI 修改」。保存前不覆盖原主题，可另存为新主题。
> 详细能力盘点、数据流与安全边界见 [appearance-themes.md](appearance-themes.md)（本页只讲「组件 / 动效级 DIY」的范围与缺口，避免重复全文）。

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
| 生成 / 校验 / 预览 / 持久化 | AI 生成 JSON → `validateThemeManifest`（unknown_token / 格式 / 对比度 warning，坏值 fail-closed 不 reset 现用主题）→ 临时全 app 预览 → 取消恢复 / 应用持久化 | ✅ |

## 3. 明确**待接**的缺口（不要宣称已完成）

1. **动效参数不在 schema 里（最重要）**：`ThemeManifestV1` 只有 `modes.light/dark` 的 token 表 + `decor`；**没有时长 / 缓动 / 光晕字段**。`ui-consistency-motion` 这一轮引入的全局动效 token（`--pa-dur-fast` / `--pa-dur` / `--pa-dur-slow` / `--pa-ease-out` / `--pa-ease-expand` / `--pa-ease-spring`，定义在 `base.css` 的 `html{}`）**目前不受主题控制**——内置主题和各 DIY 主题都用同一组值（`reduced-motion` 另有覆盖）。
   - 要做的是：把动效 token 纳入 `ThemeManifestV1`（建议 `modes.*` 白名单或独立 `motion` 段，带范围校验），并让引擎在 `custom-<id>` 作用域输出。**在此之前，说「DIY 能改动效」是假的。**
2. **交互状态的形状 / 时长**：hover / pressed 的位移、缩放、过渡时长目前是组件里的固定值 + 全局 token，主题只能改**颜色**（`--hover` / `--active` / `--acc-soft`），改不了反馈幅度与节奏。
3. **7 档思考强度滑块与主题的联动**：滑块设计的 §6（主题只换 token：`--acc` / `--r` / `--mo-scale` / `--mo-ease` / `--mo-glow`，不从 JS 写死颜色）**目前只是设计稿**（[thinking-strength-slider.md](thinking-strength-slider.md)）。`--mo-*` 这三个旋钮在代码里**尚不存在**；滑块本身也未进生产。所以「7 档滑块样式与动效随主题变化」= **待接**，不是已完成。
4. **组件质感级 DIY 的边界**：非颜色 token 仍限于白名单 enum / 尺寸与字体；「任意组件质感」不会做（禁止任意 CSS / JS / 远程资源），只能通过新增受控 token 逐项开放。

## 4. 落地顺序建议（供接手）

1. 先在 `packages/shared/src/theme-manifest.ts` 加动效 token 白名单（时长带上下限、缓动限枚举或受限 `cubic-bezier`），补校验与单测（缺省回落内置默认值，老 manifest 不破）。
2. `manifest.ts` 的 `completeTokens` 输出这些 token；`base.css` 的 `html{}` 默认值与之一致（内置主题可各写各的）。
3. 再决定 7 档滑块是否进生产；进的话按 `thinking-strength-slider.md` §7 复用 `ThinkingButton` 与既有档位来源，**只换编辑方式、不新造状态**，并把样式全部走 token。
4. 动效开关必须统一尊重 `prefers-reduced-motion`（见 `app.css` 末尾的减弱动效段），无论主题怎么写。

## 5. 边界声明

- 不改 Pi SDK / `node_modules` / 私有 API；web 主题与 Pi 的 TUI theme schema 无关。
- 不新增后端 API；跨设备同步只在既有 server 设置能力上复用。
- 本页是现状与缺口说明；**未接通的项不许写成已实现**，发布说明与 HANDOFF 同一口径。
