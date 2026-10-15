# 外观主题：默认暗夜、移除极简、可爱像素风与用户 DIY（设计）

状态：**第一段已实现**（默认暗夜 + 移除极简 + 迁移 + 首屏预置，见第 3 节）；**像素风 / DIY 是方案，待用户确认后再实现**（第 4、5 节）。
用户原话（2026-10-22）：『默认的这个外观替换成暗夜这个外观变成默认；极简删掉；再设计一套可爱一点像素风；外观开放给用户 DIY 让他们 AI 创造，你看怎么弄』。
主会话确认：**用户主动选择过的其他主题保留、不 reset**。

## 1. 边界（先说清楚这是什么）

- 这是 **Pi Assistant 应用（`apps/web`）的外观**，不是 Pi SDK 的 TUI themes。**不改 Pi SDK / `node_modules` / 私有 API**；Pi 的 theme JSON schema 与本系统无关，不能当 web 主题用。
- 主题 = 一份 CSS 变量集合 + 一条元数据；组件只读 CSS 变量（`pa-*` 类），核心交互不 hardcode 颜色。
- **概念区分（关键）**：**主题（skin，样式 id）** ≠ **明暗（mode：`light` / `dark` / `system`）**。用户说的「暗夜」是主题 `noir`，**不是** dark mode；两者独立持久化（`pia.skin` / `pia.theme` / `pia.accent`，按设备存 localStorage）。默认暗夜只是把**没显式选过**的设备落到 `noir`（它 `defaultMode: dark`），**不强改**任何 OS 设置或已存的明暗选择。

## 2. 现状盘点（只读审计结论）

单一事实来源与数据流：

| 位置 | 职责 |
|---|---|
| `apps/web/src/themes/registry.ts` | 主题元数据（id/名称/简介/强调色/地址栏色/默认明暗）、`DEFAULT_THEME`、已移除 id → 默认主题的迁移别名、`registerTheme()`（预留） |
| `apps/web/src/themes/<id>.css` | 每个主题的 token（颜色/圆角/阴影/字体/动效）+ 少量组件微调，限定在 `[data-skin=<id>]` / `[data-skin=<id>][data-mode=…]` |
| `apps/web/src/themes/index.css` | `@import` 汇总所有主题 CSS |
| `apps/web/src/themes/base.css` | 组件样式（`pa-*`），只读 CSS 变量 |
| `apps/web/src/themes/app.css` | 布局胶水；Tailwind 语义色（`bg-card`/`text-mut`/`border-line`）与 `zinc-50…950` 按 `--z-light`/`--z-dark` 混合；`rounded-*` 跟随 `--r` |
| `apps/web/src/styles.css` `@theme inline` | 把 token 接到 Tailwind（`--color-*`、`--radius-*`、`--font-*`） |
| `apps/web/src/store.ts` `applyTheme` / `setAppearance` | 写 `<html data-skin data-mode class="dark">`、`--user-acc`、`meta[theme-color]`；持久化三个 localStorage 键 |
| `apps/web/index.html` + `apps/web/public/theme-boot.js` | 首屏同步预置 `data-skin`/`data-mode`/`theme-color`（CSP `script-src 'self'`，只能外部文件不能内联） |
| `apps/web/src/appearance-migration.ts` + `migrate.ts` | 启动最前面的存储值迁移（旧默认强调色、已移除主题） |
| `apps/web/src/components/Settings.tsx`（`AppearanceTab`）+ `ThemePreview.tsx` | 主题卡片（用真实主题 CSS 渲染的缩小界面）、明暗三态、强调色、语言 |

覆盖率要求（换任何命名主题都必须正确，不能靠核心组件里 hardcode 颜色）：app shell/桌面背景、侧边栏、聊天头、消息/气泡、活动行/步骤、审批卡片、**引用条**、composer、**voice / memory `Select`**、**ModelPicker 与所有 portal / 弹出菜单**、**keyboard focus / hover / placeholder / disabled（disabled 不能因主题整体压暗而难读）**。

## 3. 第一段：默认暗夜 + 移除极简（已实现）

- `registry.ts`：`DEFAULT_THEME = "noir"`；删除 `linear` 元数据；新增 `REMOVED_SKINS = { linear: "noir" }`；`getTheme()` 先查注册表（用户 `registerTheme()` 注册的同名 id 不会被误并），查不到再按迁移别名，最后落默认；新增 `normalizeSkin()`。主题数 3：`glass` / `warm` / `noir`。
- 删除 `themes/linear.css`，`index.css` 不再 `@import`，`app.css` 清掉 `[data-skin=linear]` 的 `--z-*` 锚点与主按钮残留规则（避免死 CSS）。
- `appearance-migration.ts`（纯函数）+ `migrate.ts`：`pia.skin=linear` → `noir`，**其他显式选择一律不动**；旧默认强调色 `#6366f1` 清掉。
- 首屏不闪白：`theme-boot.js` 同步预置 `data-skin`/`data-mode`/`class="dark"`/`meta[theme-color]`；常量与 `registry.ts` 由单测钉住；`index.html` 默认 `theme-color` 改为暗夜深色 `#09090b`；SW 预缓存 `theme-boot.js`（`pia-shell-v3`）。
- e2e：默认断言 `linear` → `noir`；主题枚举与「4 套」文案改 3 套。
- 验证：`packages/server/test/appearance-theme.test.ts` 7/7（含**直接执行 `theme-boot.js`** 的默认/迁移/保留三态）、两端 `tsc --noEmit` exit 0、真实主题 CSS fixture 截图（`evidence/appearance-theme-design/`）。
- 未做：全量 `e2e/run.mjs`、真机、打包。环境限制：本树借用其他树 `node_modules`，`vite build` 在 basе 提交同样失败（brand 插件 closeBundle 读不到 dist，环境问题，非本次改动）。

## 4. 可爱像素风（第二段，用户已明确要设计一套 → 可开始；配色等细节待用户定）

方向（克制、不压业务）：

- **配色**：柔和奶油底（`#f7f3ea` 一类的暖白）+ 低饱和点缀：薄荷 `#8fd3c1`、桃粉 `#f2b8c6`、淡紫 `#c3b6f0`；深色版可选（同一套 token，不新增第二套 palette 体系）。
- **像素只做装饰，不做正文**：头像外框、角标（badge）、侧栏分组头的点阵、发送按钮的 8bit 阶梯边角、空态/加载的小插画。
- **可读性优先**：中文正文保留系统字体（**不全像素字体**，避免高 DPI 发虚）；像素字体只用于装饰性的英文/数字或按钮角标，且走内置资源或系统 fallback，不引入重资产。
- **交互**：触控目标 ≥ 44px；8bit 边角用 `clip-path`/`border-image` 实现但不能造成溢出/裁切；`focus-visible` 仍有清晰轮廓。
- **动效**：轻量、可被 `prefers-reduced-motion` 与设置里的「减少动态」关掉。
- 落地：新增 `apps/web/src/themes/pixel.css`（`[data-skin=pixel]`）+ `registry.ts` 一条元数据 + `index.css` 一条 `@import`，复用同一批 token；组件代码不改。

## 5. DIY：用户 / AI 造主题

### 5.1 数据模型（Pi Assistant 自有 Typed ThemeManifest，v1）

```jsonc
{
  "manifestVersion": 1,
  "id": "本地生成的 uuid",          // 仅作 key，绝不作文件路径
  "name": "我的奶油紫",              // 用户文本，限长、转义
  "author": "AI 生成",              // 可选
  "basedOn": "noir",                // 可选：缺省项继承某内置主题
  "modes": {
    "light": { "--bg": "#fffdf8", "--fg": "#2a251f", "/* …白名单变量… */": "" },
    "dark":  { "--bg": "#141218", "/* … */": "" }
  },
  "radius": { "--r": "14px", "--r-sm": "10px" },
  "decor":  { "texture": "none|dots|grid", "corner": "round|step2|step4" }
}
```

- **CSS 变量白名单**：颜色（`--bg/--side/--panel/--card/--fg/--mut/--mut2/--line/--line-strong/--hover/--active/--user-bg/--user-fg/--acc/--acc-fg/--acc-soft/--ok/--warn`）；圆角（`--r` 系列，px 范围）；字号（范围）；间距（范围）；阴影（受限格式或内置 enum）；纹理（enum）。
- **禁止**：任意 JS、远程 CSS、`@import`、`url()` 追踪、读取本地任意文件、HTML 注入。装饰纹理由 `decor` enum 映射到内置 CSS，不接受自由字符串。

### 5.2 校验与 fail-closed

- 值类型/范围校验（颜色只能是受限颜色表示，圆角/字号/间距限范围）。
- 对比度**警告**（提示但不强制禁止——保留创作自由）。
- 坏值 **fail-closed**：拒绝该 manifest，**先不 reset 当前主题**，弹出可读错误列表。

### 5.3 交互流程

- 生成：AI 用**现有文件工具**生成 JSON → 用户在 UI 里导入（粘贴 JSON 或 file import）→ **临时全 app 预览**（无需先保存就能看整套界面）→ 明确「取消恢复 / 应用并持久化 / 恢复默认」。
- 存储：统一主题库存（复用现有 style manager 的持久化：localStorage / profile）；每设备本地。**跨设备同步只在已有 server 设置能力时复用，不新增配置服务 API**（先提示用户选择）。
- 删除：内置主题不可删；自定义主题删除时若正在使用，先切回默认（暗夜），避免悬空 skin。
- 导出 / 分享：导出完整 manifest（**不含任何凭据**）。
- 安全：**不允许网页 prompt 任意偷偷换样式**；`theme_create` 之类的 LLM 工具若当前没有，先不加进 toolspace。
- 附带可复制粘贴的**创作规范 / schema 文档 + 样例 JSON**，让 AI 能直接照着写并导入；不必 fork SDK。

### 5.4 预览交互细节

- 预览态全 app 实时切换，顶部显示「预览中 · 未保存」；切换预览不影响已保存值。
- 导入失败：列出每条错误（字段、期望、实际）。
- 对比度低：黄色 warning 列表，允许继续。

## 6. 文件计划

| 文件 | 变更 |
|---|---|
| `apps/web/src/themes/registry.ts` | ✅ 默认 noir、删 linear、迁移别名、`normalizeSkin`；后续加 `pixel` 元数据 |
| `apps/web/src/themes/appearance-migration.ts` `migrate.ts` | ✅ 纯函数迁移 + 启动调用 |
| `apps/web/src/themes/linear.css` / `index.css` / `app.css` | ✅ 删文件、去 import、清残留 |
| `apps/web/public/theme-boot.js` / `index.html` / `public/sw.js` | ✅ 首屏预置、默认 theme-color、SW 预缓存 |
| `apps/web/src/themes/pixel.css` | ⏳ 像素风 token + 装饰（P2） |
| `apps/web/src/themes/manifest.ts` | ⏳ typed manifest 解析 + 校验 + 变量白名单（P3） |
| `apps/web/src/themes/custom-store.ts` | ⏳ 自定义主题库存（导入/导出/删除，本地持久化）（P3） |
| `apps/web/src/components/Settings.tsx` + `ThemePreview.tsx` | ⏳ 自定义主题卡片、导入/预览/应用 UI（P3） |
| `docs/design/appearance-themes.md` + 样例 JSON | ⏳ 创作规范（P3） |
| `packages/server/test/appearance-theme.test.ts` | ✅ 现有 7 项；后续加 manifest 校验、迁移、像素 token 覆盖的 fixture 测试 |

## 7. 分期

- **P1（本次，已做）**：默认暗夜、移除极简、迁移、首屏不闪白、单测、fixture 截图、文档。
- **P2**：可爱像素风一套（用户已明确要，先定配色/深浅版/是否像素字体标题）。
- **P3**：DIY manifest v1 + 校验 + 导入/预览/持久化 + 创作规范文档。
- **不做**：fork/改 Pi SDK、node_modules；一次上 10 套主题；自造复杂多 palette；重资源像素图集。

## 8. 待用户决定

1. 像素风的深浅版（只做浅色奶油底，还是同时给深色版）？像素字体是否只用于装饰性文字（推荐）？
2. DIY 首版导入方式：只支持粘贴 JSON，还是同时支持 file import？
3. 是否需要「导出/分享」主题（仅 manifest、无凭据）？
4. 自定义主题是否需要跨设备同步（若需要，复用现有 server 设置能力，不新建设置服务）。
