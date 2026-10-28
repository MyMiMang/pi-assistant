状态：已批准（2026-10-28，用户要求「像 Claude 那样能直接看 HTML 这些文件」）

# HTML / SVG 文件应用内显示

## 问题
助理做出来的 HTML 报告、网页、SVG 图，在聊天附件 / 交付卡 / 信息面板里点开只显示「暂不支持这种文件预览」，只能下载。
原因是 [DESIGN.md §29](../DESIGN.md) 当时为了安全把 HTML / SVG 一律挡掉。用户要的是 Claude 那样：点开就看到渲染好的页面，也能切到源码。

## 做法（第一期：HTML + SVG）
复用现有 `FilePreview.tsx` / `preview.ts` / 签名链接，不另起一套预览。

### 判定（`preview.ts`）
- 新增 `html`（`.html/.htm/.xhtml`、`text/html`、`application/xhtml+xml`）和 `svg`（`.svg`、`image/svg+xml`）两种。
- `.hta`、Office、压缩包仍然 `unsupported`。

### SVG
- 「图片 / 源码」两档。图片档用 `<img src=blob:>` 显示（img 里的 SVG 不执行脚本、不加载外部资源）；blob 的类型强制成 `image/svg+xml`。
- 源码档复用 `CodeView`，大小上限沿用 `MAX_TEXT_BYTES`。

### HTML
- 「网页 / 源码」两档，默认网页。模式切换条和 Markdown 的那条合成一个共用组件（不复制）。
- 网页档：`<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads">`，**不给 `allow-same-origin`**（页面是不透明来源，读不到 App 的 localStorage / 登录令牌，也不能操作外层页面）。
- iframe 的地址是新接口 `GET /api/files/:id/view-link` 换来的短时签名链接（复用 `signedPath` / `verifySigned` 和 `/hooks/dl`，`?view=1`，有效期 10 分钟）。iframe 带不了 Authorization 头，所以和视频播放一样换签名链接。
- `/hooks/dl/...?view=1` 且文件判定为 HTML 时，服务端按页面返回，并带专用响应头：
  - `Content-Type: text/html; charset=utf-8`，不带 `Content-Disposition: attachment`；
  - `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; default-src https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src https: data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`
    - `sandbox` 写进 CSP：就算有人直接在新标签打开这个链接，也照样是隔离来源；
    - 只放行 `https:`：页面能用 CDN 上的脚本 / 字体 / 图片（和 Claude 一样），但**连不到 `http://127.0.0.1` 上的 App 接口**；
  - `Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`；不发 `X-Frame-Options: DENY`。
  - 全局安全头中间件目前在 `next()` 之后对非 `/api` 路径一律覆盖 CSP、加 `X-Frame-Options: DENY`，要改成：路由已经设了 CSP 就不覆盖，并且这条路由不加 DENY。其他页面的安全头一个字节都不变。
- 外层 App 的 CSP 不用改（`frame-src 'self'` 已允许同源 iframe）。
- 纵深防御：`/api/*` 收到 `Origin: null` 的请求一律 403（本机请求默认免登录，隔离页面发出的请求 Origin 就是 `null`，这里直接拒掉）。
- 源码档：和其他文本一样按 `MAX_TEXT_BYTES` 拉取后用 `CodeView`。网页档不受这个上限限制（浏览器自己加载）。
- 网页档顶部一行小字：「页面在隔离环境里运行，读不到 App 的数据」，更多说明放 `<Help>`。

### 已知限制（写进说明，不在第一期做）
- HTML 里用相对路径引用的旁边文件（`./style.css`、`./img.png`）加载不到；单文件 HTML 和用 CDN 的页面正常。
- Office（docx / xlsx / pptx）仍然只能下载，第二期再说。

## 测试
- 单测：`preview.ts` 新判定；服务端 view-link 接口、`?view=1` 响应头（CSP 含 sandbox、无 `X-Frame-Options: DENY`、非 HTML 文件不按页面返回）、`Origin: null` 被拒、普通页面安全头不变。
- e2e：扩充 `e2e/file-preview.mjs`：HTML 渲染出内容、页面里的脚本能跑、页面里 `fetch` App 接口失败、源码档有行号；SVG 图片档和源码档；390 窄屏。
