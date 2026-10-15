# 聊天附件应用内预览 file-preview（进度）

更新时间：2026-10-22（Asia/Shanghai）
树：`file-preview`（worktree，基 `unified-integration` 最新 clean `3bf2c01`）
状态：**本地提交，未 push / 未 tag / 未打包**（等主 review 合入 `unified-integration`，memory / model UI 之后统一发 beta.24，仅 mac-arm64）

## 需求（用户原话大意）

聊天里的文件卡片（截图 `uploads/粘贴的图片-1792069605963.png`：`voice-input-feasibility.md`，只有右侧下载图标）点卡片没有任何预览，只能下载。要求点卡片主体 / 文件名打开应用内预览，下载图标保持独立（不误触预览）。

## 已做

| 文件 | 改动 |
|---|---|
| `apps/web/src/preview.ts`（新增） | 纯逻辑：`previewKind`（扩展名 + MIME）、`looksBinary`（字节嗅探）、`parseCsv`（引号内换行 / `""` 转义 / 有界）、`stripBom`、上限常量 |
| `apps/web/src/components/FilePreview.tsx`（新增） | `openFilePreview` + `FilePreviewHost`；复用 `Modal`；工具栏 = 文件名 + 类型·大小 + 下载 + 关闭；加载 / 取消 / 错误重试 / 404 / 权限 / 超限 / 二进制 / 不支持 各态；Markdown / CSV / 代码 / 文本 / PDF / 图片 渲染 |
| `apps/web/src/api.ts` | `fetchBlob(path, signal)`；新增 `fetchBlobLimited(path, maxBytes, signal)`（先看 `content-length`，超限不读 body） |
| `apps/web/src/components/Markdown.tsx` | 加 `blockRemoteImages`（远端图占位、不自动加载）；链接只放行 `http/https/mailto/#`，`javascript:`/`data:`/`file:`/相对路径只显示文字 |
| `apps/web/src/components/Attachments.tsx` | 非图片卡片 = 主体 `<button>`（预览）+ 独立下载 `<button>`（`stopPropagation`）；无嵌套 button |
| `apps/web/src/components/InfoPane.tsx` | 「文件」列表同样预览 + 独立下载 |
| `apps/web/src/App.tsx` | 挂 `<FilePreviewHost />` |
| `e2e/file-preview.mjs`（新增） | 纯前端 fixture（静态托管 `apps/web/dist` + `page.route` 拦 `/api`），桌面 + 390 |

图片附件仍走 `ImageViewer`（未新建重复图片预览）。

## 安全边界（明确）

- 只走授权资源地址 `/api/files/:id` 带登录凭证拉取；不读本机任意路径 / URL、不绕权限、不读工作区路径。
- 类型不只看扩展名 / Content-Type，还嗅探实际字节；二进制不当文本解码。
- 文本上限 1MB、CSV 500×50、代码 5000 行；超限只提示 + 下载，不下载整份大文件。
- HTML / SVG / Office / 压缩包不 inline、不执行；PDF 只用本会话 blob，不外源、不服务端 exec、不上传云。

## 验证（实际跑过）

- 环境：Node 24.20.0（`/opt/homebrew/opt/node@24/bin`），`node_modules` 用软链接指向 `unified-integration`（同 commit 依赖；web `vite build` 正常）。
- `tsc --noEmit -p apps/web`：**exit 0**。
- `vite build apps/web`：**通过**（2498 modules）。
- `node e2e/file-preview.mjs`：桌面 + 390 **35 项全通过**（点主体预览 / 下载不误触 / 39KB Markdown 表格代码 / 外链图不自动加载 / 危险与相对链接不成链 / CSV 引号换行 / 代码行号复制 / 不支持类型 / 超限不下载 / 404 重试 / PDF object+fallback / 图片仍走 ImageViewer / Esc + 焦点返回 / 390 工具栏）。
- `node e2e/mobile-viewport-ui.mjs`：**回归全通过**。
- 截图：`evidence/file-preview/{desktop-chat,desktop-markdown-preview,desktop-csv-preview,mobile-390-markdown}.png`（已用识图核对内容）。

## 未做 / 未验证（诚实边界）

- xlsx / docx / pptx 等 Office 预览：仓库无安全库，**明确暂不支持**（只下载），未乱执行宏 / 外链。
- 真实 PDF 内嵌：headless 无 PDF 插件，只验证了 `<object>` + fallback + 下载；未在真机 / 真浏览器确认内嵌渲染。
- 真机 iOS 手势、全量 e2e、真实服务端 `/api/files` 端到端（本轮全部纯前端 fixture，未启动 `packages/server/src/main.ts`，未碰钥匙串）。
- 未 push / 未 tag / 未打包。
