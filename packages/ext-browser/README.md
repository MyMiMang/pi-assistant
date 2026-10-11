# ext-browser

助理的浏览器（Pi 扩展）。工具：`browser_navigate` / `browser_snapshot`（可访问性大纲 + 编号 + 截图）/
`browser_click` / `browser_type` / `browser_select` / `browser_scroll` / `browser_press` / `browser_tabs` /
`browser_download` / `browser_upload` / `browser_handoff`。

- 浏览器由宿主提供（`BrowserHost.context()`）：助理电脑容器里有界面的 Chromium（经 CDP 连接，「电脑」实时画面里可见），
  或 Docker 不可用时本机无头 Chromium（每个助理独立的持久化用户目录）。
- 只用 Playwright 公开 API（`page.evaluate` 打编号、`locator`、`waitForEvent('download')`、`setInputFiles`）。
- 审批：提交表单 / 付款 / 下单 / 发送 / 上传文件前，经宿主 `request()` 等用户批准（可选“本任务内都允许”）。
- 一键暂停：`isPaused()` 为真时全部拒绝。
