# 0024 HTML / SVG 文件在应用内隔离显示
- 日期：2026-10-28
- 状态：有效
- 决定：聊天附件、交付卡、信息面板里的 HTML 文件像 Claude 一样直接渲染（页面脚本可运行），SVG 按图片显示；两者都能切到源码。修订 DESIGN.md §29「HTML / SVG 一律不 inline」。
- 原因：用户要求助理做出的网页、报告、图能直接看，不用先下载。
- 怎么保证安全：HTML 放进不给 allow-same-origin 的 sandbox iframe，用 10 分钟签名链接加载，响应头 CSP 自带 sandbox，只放行 https:（连不到本机 App 接口）；/api 拒绝 Origin: null；SVG 用 img 显示，不执行脚本。
- 不做什么：不在 App 同源下直接渲染 HTML；不把 HTML 转成纯文本凑合；Office 暂不做（第二期）。
- 影响：`preview.ts`、`FilePreview.tsx`、`http.ts`；[设计](../design/html-file-preview.md)
