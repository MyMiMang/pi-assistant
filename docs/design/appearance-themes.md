# 外观主题：默认暗夜、移除极简、可爱像素风与用户 DIY（设计）

状态：**P1 已实现**（默认暗夜 + 移除极简 + 迁移 + 首屏预置）；**P2 像素风已实现**；**P3 DIY 的 schema / 引擎 / 库存 / 预览事务 / 管理 UI 已实现**，**AI 后端已接通**（`POST /api/themes/draft` + 临时专用 Pi 会话，见 §5.7）。入口只有「设置 → 外观 → 用 AI 设计主题」；用户已明确**取消** `/主题设计` slash 命令，不注册任何 slash、不注入 prompt、不加命令列表。
用户原话（2026-10-22）：『默认的这个外观替换成暗夜这个外观变成默认；极简删掉；再设计一套可爱一点像素风；外观开放给用户 DIY 让他们 AI 创造，你看怎么弄』。
后续追加（同一轮）：DIY 保存后仍可编辑；图片素材作视觉参考（先定配色/风格/材质/布局），上传默认**不**嵌入主题、只有用户显式选「用作背景/装饰」才算素材；AI 后端复用当前 agent 模型（主会话另接）。
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

## 4. 可爱像素风（已实现：`pixel`）

方向（克制、不压业务）：

- **配色**：柔和奶油底（`#f7f3ea` 一类的暖白）+ 低饱和点缀：薄荷 `#8fd3c1`、桃粉 `#f2b8c6`、淡紫 `#c3b6f0`；深色版可选（同一套 token，不新增第二套 palette 体系）。
- **像素只做装饰，不做正文**：头像外框、角标（badge）、侧栏分组头的点阵、发送按钮的 8bit 阶梯边角、空态/加载的小插画。
- **可读性优先**：中文正文保留系统字体（**不全像素字体**，避免高 DPI 发虚）；像素字体只用于装饰性的英文/数字或按钮角标，且走内置资源或系统 fallback，不引入重资产。
- **交互**：触控目标 ≥ 44px；8bit 边角用 `clip-path`/`border-image` 实现但不能造成溢出/裁切；`focus-visible` 仍有清晰轮廓。
- **动效**：轻量、可被 `prefers-reduced-motion` 与设置里的「减少动态」关掉。
- 落地：新增 `apps/web/src/themes/pixel.css`（`[data-skin=pixel]`）+ `registry.ts` 一条元数据 + `index.css` 一条 `@import`，复用同一批 token；组件代码不改。

## 5. DIY：用户 / AI 造主题

> 下面第 5.1 是最初的草案；**实际冻结的实现**以 `packages/shared/src/theme-manifest.ts` 为准。两处差异：
> 1. **必需颜色 token 必须齐全**（fail-closed），不做 token 继承；`basedOn` 仅作来源标注（v1 不做 CSS 变量继承，避免内置 token 在 CSS 里、引擎读不到而静默白屏）。
> 2. 尺寸 / 字体 token 可选，缺省由引擎补内置中性默认；装饰（纹理/边角/阴影/背景）全部 enum。
>
> AI 生成 / 继续修改的后端契约见 §5.7；数据契约仍是冻结的 `ThemeDraftRequest` / `ThemeDraftResult`。

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

### 5.5 图片素材（用户新增要求，已落地接口）

- 面板里的图片上传复用**聊天附件的安全上传与预览**（`ThemeImagePicker`）；图片只存**附件 id + 元数据**（mime / 尺寸 / 字节数 / sha256），**绝不写 base64 / 本地绝对路径**。
- 默认「**仅作参考**」（`usage: "reference"`）：只参与用户显式发起的那一轮 AI 请求，**不写进主题、不随主题导出**。只有用户显式切换「用作背景 / 装饰」（`background` / `decor`）才作为主题素材。
- 历史每轮只带引用（`ThemeDraftRequest.images`），不带图片内容；图片原件不重复存进历史。
- 模型不支持视觉时后端返回 `visionUnsupported`，UI 提示换支持视觉的模型或仅用文字；**不偷偷换视觉服务 / 收费模型**，不猜模型能力。
- 安全：默认拒 SVG（避免任意矢量脚本）；MIME / 大小 / 像素总量有上限；EXIF 与远端上传提示沿用已有附件文案。
- 导出：默认剥掉参考图（`stripReferenceImages`）；用户显式作背景/装饰的素材以**引用**形式保留（首版**不打包图片 zip**，已如实说明）。
- 外部远程 URL 不为参考图放开：仍禁 CSS `url()` / `@import`。

### 5.6 创作规范 / 样例（给 AI 照着写）

必需颜色 token：`--bg --side --panel --card --fg --mut --mut2 --line --line-strong --hover --active --user-bg --user-fg --acc --acc-fg --acc-soft --ok --warn --z-light --z-dark`（每个 light/dark 都要有）。可选：`--acc2 --live`、`--r/--r-sm/--r-bubble/--r-tail/--r-comp/--r-btn/--r-chip/--r-logo/--r-av`（px/rem，限范围）、`--font/--display/--mono`（字体名列表）。装饰 enum：`texture: none|dots|grid`、`corner: round|step2|step4`、`shadow: soft|elevated|none`、`background: flat|glow`。

```jsonc
{
  "manifestVersion": 1,
  "id": "11111111-2222-3333-4444-555555555555",
  "name": "我的奶油紫",
  "author": "AI 生成",
  "basedOn": "noir",
  "modes": {
    "light": { "--bg": "#fffdf8", "--side": "#f6f1e6", "--panel": "#f6f1e6", "--card": "#ffffff", "--fg": "#2a251f", "--mut": "#5f564b", "--mut2": "#9a8f80", "--line": "#e4dccd", "--line-strong": "#cfc4b1", "--hover": "#ebe4d6", "--active": "#e6dccb", "--user-bg": "#ece4d4", "--user-fg": "#2a251f", "--acc": "#8fd3c1", "--acc-fg": "#123123", "--acc-soft": "rgba(143,211,193,.12)", "--ok": "#5f8a5a", "--warn": "#c08a2c", "--z-light": "#ffffff", "--z-dark": "#2a251f", "--r": "10px" },
    "dark":  { "--bg": "#141218", "--side": "#1e1a2b", "--panel": "#1e1a2b", "--card": "#241f33", "--fg": "#f3eee6", "--mut": "#c0b8d4", "--mut2": "#8b83a3", "--line": "#332c45", "--line-strong": "#463d5c", "--hover": "#2a2438", "--active": "#322b42", "--user-bg": "#2f2a44", "--user-fg": "#e9e3f5", "--acc": "#c3b6f0", "--acc-fg": "#221d33", "--acc-soft": "rgba(195,182,240,.16)", "--ok": "#8fd3c1", "--warn": "#f2b8c6", "--z-light": "#f0ecf7", "--z-dark": "#181524" }
  },
  "decor": { "texture": "dots", "corner": "step2", "background": "glow" },
  "images": [{ "attachmentId": "att_abc123", "usage": "background", "mime": "image/png", "width": 1200, "height": 800, "bytes": 204800 }],
  "createdAt": "2026-10-22T00:00:00.000Z",
  "updatedAt": "2026-10-22T00:00:00.000Z"
}
```

### 5.7 AI 后端（已实现：`POST /api/themes/draft`）

设计目标：让「用 AI 设计主题」真的走一次**当前助理的模型**，而不是聊天主线程里塞一句自然语言、让 agent 混着命令/代码产出 CSS。

- **入口**：`packages/server/src/themes/routes.ts` → `POST /api/themes/draft`（带 `/api/*` 鉴权中间件）。请求 / 响应就是冻结的 `ThemeDraftRequest` / `ThemeDraftResult`；客户端关面板 / 离开时 `fetch` abort，经 `c.req.raw.signal` 透传，后端**真 abort 模型请求**。
- **模型**：`runtime(agentId).modelFor(agent)`（当前助理已选的模型，否则用户默认模型）。**未知 agent / 没有模型一律拒绝**，不猜、不取第一个模型、不建新助理。
- **临时专用会话**（`packages/server/src/themes/index.ts` + `pi-adapter` 的 `CreateSessionOptions` 新选项）：
  - `inMemorySession: true` → 内存会话，**不落盘**、不动主聊天会话、不挪当前对话/场景、不写用户会话历史；
  - `minimalExtensions: true` → 不加载 MCP / codemode / tool-search；`extensions: []` → 不加载任何 `ext-*`（没有 bash / 主机 / 桌面 / 邮箱 / 审批 / 交付）；
  - `tools: ["theme_draft"]` → **只**启用 `theme_draft` 一个工具；这些是会话构造参数，**prompt 改不了**（测试里用「用 bash 读 ~/.ssh/id_rsa」的注入 prompt 验证工具面不变）。
  - 复用公开 `createPiSession` / 现有 `models` / `recordUsage`，不 fork SDK、不改 `node_modules`、不 monkeypatch 私有接口。
- **结构化产出**：`packages/server/src/themes/tool.ts` 的 `theme_draft` 用 shared 校验器 fail-closed 校验；校验不过就保留上一版（不 apply），把可读错误回给模型，**最多一次格式修复**（`MAX_THEME_DRAFT_CALLS = 2`），不无限重试。**不**用正则/字符串执行模型产出的 CSS，**不**兜底硬编码主题当模型产物。
  - `id` / `createdAt` / 图片引用由服务端强制：继续修改时保持 `previousManifest.id`（保存即更新同一套主题），首版服务端生成 uuid；模型不能自己塞图片。
- **参考图**（`packages/server/src/themes/images.ts`）：只认附件 opaque id。先按 id 查 `files` 行并校验 **canonical owner（`agent_id`）**，再读服务端登记过的 `stored_path`；**sniff 真实 magic bytes** 定 MIME / 尺寸（png / jpeg / gif / webp，拒 SVG 与非图片），限制张数 / 字节 / 像素总量。客户端给的任意 attachmentId、remote URL、绝对路径都读不到（跨助理附件直接拒）。图片以公开 Pi `imageBlocks` 参数发给模型（复用 `toImagePart` 缩放）；**当前模型不支持视觉时返回 `visionUnsupported` 且一次请求都不发**，不偷偷换视觉服务 / 收费模型。附件内容**不写进主题导出**（JSON 只留引用与元数据），也不额外记进 memory / system logs。
- **有界上下文**：每轮只带 `prompt` + `previousManifest`（+ 本轮显式参考图），不带整段对话历史，避免上下文无界增长。
- **预算 / 取消 / 去重**：用用户已选服务正常调用，用量沿现有 `recordUsage` 记账（生产点一次即计费）；同 `(agentId, turnId)` 并发**去重**，避免界面重发重复付费；超时（默认 180s）或用户取消时真 abort；迟到响应由前端 `DraftTurns` 丢弃、不覆盖当前预览。
- **前端接线**：`AppearanceTab` 注入 `onThemeDraft` → `POST /api/themes/draft`（带 `agentId` + `AbortSignal`）；`ThemeDesigner` 用纯逻辑 `apps/web/src/themes/design-session.ts`（`DraftTurns`）管理轮次：发新一轮 / 关面板 / 保存都会 abort 在飞请求，晚到的旧轮次响应不应用。

## 6. 文件计划（✅ = 已实现）

| 文件 | 变更 |
|---|---|
| `apps/web/src/themes/registry.ts` | ✅ 默认 noir、删 linear、迁移别名、`normalizeSkin`、`pixel` 元数据、`unregisterTheme`（取消未保存预览用） |
| `apps/web/src/appearance-migration.ts` `migrate.ts` | ✅ 纯函数迁移 + 启动调用；启动时 `installCustomThemes()`（必须在 store 读 `pia.skin` 之前） |
| `apps/web/src/themes/linear.css` / `index.css` / `app.css` | ✅ 删文件、去 import、清残留；`index.css` `@import pixel.css`、`app.css` 补 pixel 的 `--z-*` 锚点 |
| `apps/web/public/theme-boot.js` / `index.html` / `public/sw.js` | ✅ 首屏预置（含 `custom-` 皮肤保留）、默认 theme-color、SW 预缓存 |
| `apps/web/src/themes/pixel.css` | ✅ 像素风 token + 装饰（浅深双版） |
| `packages/shared/src/theme-manifest.ts` | ✅ Typed ThemeManifest v1 + 白名单 + fail-closed 校验 + 图片引用 + AI 草稿 DTO（前后端共用） |
| `apps/web/src/themes/manifest.ts` | ✅ manifest→CSS（`[data-skin=custom-*]` 作用域）/→ThemeDef；内置主题读真实 CSS 变量另存 |
| `apps/web/src/themes/custom-store.ts` | ✅ 本地库存（保存/导入/导出/删除、内置只读保护、导入撞 id 换新、样式注入） |
| `apps/web/src/themes/preview.ts` | ✅ 预览事务（继续改 / 上一版 / 应用并保存 / 取消恢复），DOM 走注入 effects 以便单测 |
| `packages/server/src/themes/` | ✅ AI 创作后端：`index.ts`（`draftTheme`：模型解析 / 专用会话 / 去重 / 超时 / 取消 / 用量）、`tool.ts`（`theme_draft` + 设计系统提示）、`images.ts`（附件解析 + magic bytes）、`routes.ts`（`POST /api/themes/draft`） |
| `packages/server/src/pi-adapter/index.ts` | ✅ `CreateSessionOptions` 新增 `tools` / `excludeTools` / `customTools` / `minimalExtensions` / `inMemorySession`（受限专用会话用，不改 SDK） |
| `apps/web/src/themes/design-session.ts` | ✅ `DraftTurns`：主题设计请求的轮次管理（取消真 abort / 迟到响应丢弃），组件与单测共用 |
| `packages/server/src/pi-adapter/mock-provider.ts` | ✅ Mock 模型支持 `theme_draft` 分支（e2e / 集成测试用） |
| `apps/web/src/components/ThemeDesigner.tsx` `ThemeImagePicker.tsx` | ✅ 设计面板 + 图片素材选择（复用附件上传；`onThemeDraft` 接真实后端，支持取消 / 迟到响应丢弃） |
| `apps/web/src/components/Settings.tsx` | ✅ 「用 AI 设计主题」主入口 + 内置/我的主题卡片（编辑/导出/删除/另存为） |
| `apps/web/vite.config.ts` | ✅ brand 插件产物改写 `closeBundle`→`writeBundle`（Vite 8 下构建修复） |
| `packages/server/test/theme-manifest.test.ts` `appearance-theme.test.ts` | ✅ 22/22 + 8/8（schema 注入拒绝、图片元数据、导出过滤、库存 CRUD、预览事务、像素 token、无 slash 残留） |
| `packages/server/test/theme-ai.test.ts` `theme-draft-mock.ts` | ✅ AI 创作后端 13/13（真实 Pi 会话 + 假模型：payload / 工具面 / image block / visionUnsupported 0 请求 / 坏 manifest / 一次修复 / 跨助理拒 / 取消 / 超时 / 去重 / magic bytes） |
| `e2e/theme-ai-frontend.test.mjs` `theme-ai-ui.mjs` | ✅ 前端纯逻辑 4/4（DraftTurns / 同 id 更新 / 另存新 id / 参考图不导出）+ 真实 server UI 5/5（AI 生成预览 / 取消恢复 / 保存 / 继续改同 id / 另存 / 390） |
| `e2e/run.mjs` | ✅ 「外观 DIY」步骤改为 AI 生成 / 继续改 / 保存 / 另存 + 恶意 JSON / 预览不落 localStorage / 取消 / 390 |

## 7. 分期

- **P1（已做）**：默认暗夜、移除极简、迁移、首屏不闪白、单测、fixture 截图、文档。
- **P2（已做）**：像素风浅深双版（奶油 + 薄荷/桃粉/淡紫，装饰纯 CSS，正文系统字体）。
- **P3（引擎/UI/AI 后端已做）**：manifest v1 + 校验 + 导入/导出/预览/持久化 + 管理 UI + 创作规范 + 真实 AI 创作（专用会话 + `theme_draft` + 参考图 + 取消/去重）。
- **不做**：fork/改 Pi SDK、node_modules；一次上 10 套主题；自造复杂多 palette；重资源像素图集；远程 CSS / `url()` / SVG 执行。

## 8. 已定 / 待定

已定（用户本轮确认）：

1. 入口：设置 → 外观 →「用 AI 设计主题」；已存 DIY 卡「编辑 / 用 AI 改」进同一面板。**取消 `/主题设计`**。
2. 像素风：浅深双版；奶油 + 薄荷/桃粉/淡紫；像素只做装饰、正文系统字体、无远程素材。
3. DIY：保存后仍可编辑；AI 继续修改；另存为新 UUID；导出/删除；预览未保存不可覆盖原主题；取消完整恢复。
4. 图片：默认「仅作参考」（只参与本轮 AI 请求、不写主题、不导出）；显式「用作背景/装饰」才进 manifest；只存附件引用与元数据。

仍待用户决定 / 待接：

1. AI 生成已接后端（复用当前 agent 模型，§5.7）；模型不支持视觉时明确提示换模型或仅文字，不偷偷换视觉服务。**未验**：真实云模型上的生成质量 / 参考图实际效果。
2. 「用作背景/装饰」的素材导出：首版只导出 manifest（不含图片文件），安全 zip（assets + manifest）**未实现**。
3. 自定义主题是否需要跨设备同步（若需要，复用现有 server 设置能力，不新建设置服务）。
4. 主题是否开放对外分享 / 上架（当前只支持本地导出 JSON 文件）。
