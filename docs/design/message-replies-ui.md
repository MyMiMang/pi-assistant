# 消息「引用回复」前端设计（message-replies-ui）

> 状态：前端 UI 完成、后端接口由独立任务 `message-replies-backend` 提供（**本树不编造后端可用**，全部经 `replies-api.ts` typed adapter）。未 push / 未 tag / 未打包。
> 范围：**纯前端 UI + 纯逻辑 + 夹具测试**；不动 `sharedcomposer` 大重构、不动后端 runtime / store、不做语音 / 双向通话。

## 1. 目标（用户明确）

- 每条**可引用**（用户 / 助理普通文本）消息旁边有**直接可见**的「引用」小按钮（引用图标 + 短文字 / 明确 `aria-label`），桌面与手机都可发现；右键 / 长按只是**辅助**入口，不是唯一入口。
- 输入框上方出现「引用条」：作者 + 1–2 行短摘录 + 附件文件名；`X` 或键盘 `Esc` 取消引用（**只取消引用，不清空已输入文字**）。
- 点引用条 / 已发送消息里的引用块 → 跳回原消息并高亮几秒；**不自动发消息、不触发模型**。
- 引用是 **draft 状态**，按「助理 + 对话 / 群 / 子代理」独立保存，切换目标不串引用。发送成功清引用；网络失败保留引用与草稿文字。
- 重复点发送时按钮 disabled（不重复提交 / 不重复唤醒）。

## 2. 数据模型（对齐后端冻结契约）

- draft 引用（`apps/web/src/replies.ts` 的 `ReplyRef`）只存展示所需，不存 HTML / URL / 附件本体：

```ts
interface ReplyRef {
  messageId: string;
  authorId: string;
  authorName: string;
  authorRole: "user" | "assistant";
  excerpt: string;              // 已 sanitize 的纯文本，最多 240 字
  hasText: boolean;
  attachments: { name: string; mime: string; size: number }[]; // 仅摘要，不上传 / 不带 fileId
}
```

- 已发送消息的引用块直接读后端 `Message.reply`（`ReplySnapshot`，见 `docs/design/message-replies.md` §3）；`apps/web/src/types.ts` 镜像同名类型（`ReplySnapshot` + `Message.replyToId?` / `Message.reply?`），**不另造一套 schema**。`quotedBlock(m)` 读 `m.reply`，支持 `edited` / `truncated` / `unavailable`（删除后只看“原消息已删除”）。
- `isQuotable(m)`：仅 `role=user|assistant`，排除 `role=tool`、`role=card`、`role=system`（含隐藏系统消息）、`meta.hidden/visible=false`。工具结果里的密钥 / 隐藏 system 不会成为引用候选。
- `sanitizeExcerpt`：去 `<think>` 块、所有标签、压缩空白；只以纯文本渲染 → 危险内容不执行。
- `buildReplyRef(m, author)` 只用于**本地 optimistic 展示**；发送只传 `replyToId`（+ 幂等 `clientId`），作者 / 摘录 / 接收人由服务端可信解析，后端 return 覆盖本地展示。

## 3. 目标标签与群规则

- 单聊：`回复给 {助理名}`。
- 群聊（展示预测；**最终由后端权限校验决定**）：
  - 有显式 `@B` → 只有 B 回复：`@B 将回复`；若同时引用了 A，再显示 `回复给 A`（两个标签并存，`@` 优先）。
  - 无 `@`、引用活跃助理 A → `回复给 A`（只 A，不叫管理者 / 其他人）。
  - 引用管理者 → 只管理者。
  - 引用用户消息 / 其它 → **不显示「只有用户」这类误导标签**，沿用现有「不 @ 人时由管理者回答」提示。
  - 引用的助理已被删除 / 已离群 / 不在成员里 → 目标不可用，前端提示「该助理已不在群里，请用 @ 指定回复对象」，仍发 `replyToId`，由后端裁定。

## 4. 入口交互

- **可见按钮**：`MessageActions` 行（消息底部元数据行）里的「复制」「引用」。「复制」复制整条消息原文（去掉思考过程，Markdown 原样），点完短暂显示「已复制」。助理消息挂在对应 `pa-bubble` 下；用户消息挂在气泡下方。**工具步骤（steps）不挂按钮**，卡片 / 系统消息不挂。
- **桌面右键**（2026-10-23 用户要求改成程序自己的菜单）：消息上右键弹出「复制 / 引用 / 另开新对话」；选了字时「复制」只复制选中的部分（按右键按下之前的选区，避开 macOS 右键自动选词）。消息以外的地方由 `ContextMenu.tsx` 的全局接管：选了字给「复制」，链接给「复制链接」，其余不弹菜单（不再出现浏览器的后退 / 重新载入 / 检查元素）。`input / textarea / select / [contenteditable]` 和 `img / video / audio` 保留系统菜单（粘贴、存图）。
- **手机长按**：`useLongPress` 阈值触发（~500ms），移动超过 ~10px（等于滚动 / 文字选择）即取消，多指 / 长按中的非折叠选区不触发；不 `preventDefault` touchstart，**不阻正常文字选择 / 复制粘贴**。按钮仍是主入口。
- 键盘：按钮可 Tab 聚焦，`aria-label="引用这条消息"`，`title` 提示。

## 5. 跳回原消息

- 已加载：`scroller.querySelector` 按 `data-mid` 找到元素 → `scrollIntoView({block:"center"})` + 高亮 class（~2.4s）。
- 未加载：经 `replies-api.locateMessage()` 调 `GET /api/messages/:mid/context?limit=50&roomId=|conversationId=`（**有界上下文窗口，不拉全历史**），拿到后合并进当前列表再定位；定位中 loading，404 / 403（`reply_not_found` / `reply_cross_scope`）显示「原消息不在当前会话或已删除」，网络错误可重试，**不白屏 / 不死 loading**。
- 适配层集中在 `replies-api.ts`；后端路由若调整只改这一处。

## 6. 发送 payload（adapter，对齐后端 §4）

- 单聊：`{ text, attachments, conversationId, replyToId?, clientId? }`
- 群聊：`{ text, mentions, attachments, replyToId?, clientId? }`
- 子代理：`{ text, replyToId?, clientId? }`
- `replyToId` / `clientId` 可选；服务端可信解析引用目标、按 `clientId` 幂等去重（同草稿重试复用同一 `clientId`，草稿一变就换新的）；前端**不自填** author / recipient / excerpt，只做 optimistic 展示。错误码 `reply_not_found` / `reply_cross_scope` / `reply_not_quotable` 由后端返回，UI 显示后端消息（Chinese），失败保留引用与草稿。

## 7. 布局 / 390

- 引用条在 `textarea` 上方（composer 内部），比原状态多一行。用 `ResizeObserver` 观察 composer 高度，同步 `.pa-scroll` 的 `padding-bottom = composerH + 24`，**最后一条消息不被遮**。
- 仅在用户**本来就贴底**时（`stick`）跟随滚动；未贴底不抢滚动。`visualViewport` 的 `stickChatScrolls` 逻辑不变。
- 发送键与换行键由用户偏好决定（2026-10-16 起默认 `Enter` 发送 / `Shift+Enter` 换行，见 [chat-send-shortcut.md](chat-send-shortcut.md)；`composer.ts` 的 `useComposerKeys`，本页只保证引用条 `Esc` 只取消引用，若菜单 / 弹窗开着由它们自己处理顶层 Esc）。
- 390 宽：引用条 `min-width:0` + 单/双行截断，不横向溢出、不挤正文与工具结果。

## 8. 夹具测试（纯前端，不启动 server）

- 纯逻辑：`e2e/replies-frontend.test.mjs`（`node --import tsx --test`）覆盖 `replies.ts`：候选过滤（tool/system 不可引用）、摘录 sanitize（script / svg / think 不执行）、群目标规则（quoteA onlyA、quoteA@B onlyB、quoteManager、user 引用不误导、已删除 → 需 @）、draft key 隔离、payload `replyToId`。
- UI：`e2e/message-replies-ui.mjs`（静态托管 `apps/web/dist` + `page.route` 拦 `/api`）：可见按钮在每条 target、右键不拦链接 / 图片、长按移动取消、引用条 + Esc 只清引用、发送 payload 带 `replyToId`、跳转已加载 / 未加载（loading → 定位 / notfound 提示 + 重试）、切对话 / 切群 draft 不串、390 无横向溢出。
- 回归：`e2e/composer-compact.mjs` / `task-ui.mjs` / `file-preview.mjs` / `mobile-viewport-ui.mjs`。
- 构建：`tsc --noEmit -p apps/web` + `vite build`。

## 9. 明确不做 / 未验证

- 后端 `replyToId` 解析、群权限裁定、`/api/messages/:mid(/context)` 实现属 `message-replies-backend`（已完成 `8d9af27` / `5a9a65f` / `341f0fa`）；本树用 adapter + fixture mock 验证 UI 分支，未跑真实 server（避免系统钥匙串）。
- 子代理 composer 暂未接引用（共享组件已支持，`BotTurn`/`UserMsg` 不传 `onQuote` 就不显示按钮；避免和语音输入任务争 `Subagents.tsx` composer hunks）。
- 语音 / 双向通话（未开发，已取消；另一任务负责麦克风，不改本引用条）。
- 真机 iOS 手势（仅 Playwright 近似）；真实聊天读写 / 删除 / 模型调用一律未碰。
