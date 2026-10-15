# 进度快照：message-replies-ui（消息引用前端）

> 独立树 `message-replies-ui`，基 `unified-integration` `ad3526f`；本地 3 个中文 commit（`f225a85` / `859809a` / `0885369`），**未 push / 未 tag / 未打包**。后端契约由 `message-replies-backend`（`8d9af27`/`5a9a65f`/`341f0fa`）冻结，本树按 exact fields 对接。

## 做了什么（用户明确）

- 每条可引用用户 / 助理消息旁**直接可见**「引用」按钮（`Quote` 图标 + 短文字 + `aria-label`/`title`），桌面与手机都可见；右键 / 长按只是**辅助**入口。工具步骤 / 卡片 / 系统消息不挂按钮。
- 输入框上方**引用条**：作者 / 目标 + 1–2 行摘录 + 附件文件名 + 取消；`Esc` 只取消引用、不清已输入文字；`X` 同效。
- 发送带 `replyToId` + 幂等 `clientId`；成功清引用，网络失败保留引用与草稿、还原文字 / @ / 附件；发送中按钮 disabled。
- 点引用条 / 已发送消息里的引用块 → 跳回原消息并高亮；已加载直接定位，未加载走 `GET /api/messages/:mid/context?limit=50`（有界，不拉全历史）；404/403 显示「原消息不在当前会话或已删除」+ 重试；不白屏 / 不死 loading。
- draft 按「助理 + 对话 / 群」独立（独立小 store `replyDrafts.ts`），切换目标不串引用。
- 群目标标签（展示；最终后端裁定）：显式 @ 优先（`@B 将回复`）、无 @ 引用活跃助理只「回复给 A」、引用用户消息不显示误导标签、引用的助理已删除 / 离群提示需 @。
- 390：`ResizeObserver` 同步 `.pa-scroll` 底部留白，引用条多一行不遮最后一条；未贴底不抢滚动。

## 对齐后端（exact fields，不重复 schema）

- `apps/web/src/types.ts` 镜像 `ReplySnapshot` + `Message.replyToId?` / `Message.reply?`。
- `quotedBlock(m)` 读 `m.reply`，展示 `edited` / `truncated` / `unavailable`（删除后只看「原消息已删除」）。
- 客户端只传 `replyToId` / `clientId`；作者 / 摘录 / 接收人服务端可信解析，后端 return 覆盖本地 optimistic 展示。
- locate 用 `/api/messages/:mid/context`；发送错误码 `reply_not_found` / `reply_cross_scope` / `reply_not_quotable` 照常显示。

## 验证（Node 24.20.0；纯前端 fixture，未启动 server / 未碰钥匙串 / 未碰真实数据）

- web `tsc --noEmit -p apps/web` exit 0；`vite build` 通过。
- `e2e/replies-frontend.test.mjs` 纯逻辑 **11/11**。
- `e2e/message-replies-ui.mjs` 纯前端 e2e **全通过**（可见入口 / 右键不拦链接 / 引用条 Esc / 发送 payload+clientId / 失败保留 / 跳转已加载+未加载+删除重试 / draft 隔离 agent+conv+room / 长按移动取消 / 390 无溢出 + 底部留白）。
- 回归：`e2e/file-preview.mjs`、`e2e/mobile-viewport-ui.mjs` 全通过。
- **未跑**：`composer-compact` / `task-ui`（会启动 `packages/server/src/main.ts`，避免系统钥匙串，按任务限制不默认 main）。

## 本树改动的文件（防交叉，语音输入任务请只加 mic 局部 hunk）

- 新增：`apps/web/src/replies.ts`、`replies-api.ts`、`replyDrafts.ts`、`components/MessageReply.tsx`、`docs/design/message-replies-ui.md`、`e2e/message-replies-ui.mjs`、`e2e/replies-frontend.test.mjs`。
- 修改：`apps/web/src/types.ts`（加 `ReplySnapshot` / `Message.replyToId|reply`）、`components/ChatMessages.tsx`（`UserMsg` / `BotPart` 加 `data-mid` + 引用按钮 + 引用块）、`components/Chat.tsx`（Composer：ReplyBar + Escape + replyToId/clientId + 失败还原）、`components/RoomChat.tsx`（RoomComposer 同上 + 群目标标签）、`themes/app.css`（追加引用样式）。
- 语音输入若在 `Chat/RoomChat/Subagents` composer 加麦克风：我的 hunk 集中在 `send()`、`textarea onKeyDown` 的 Escape 分支、`.pa-send` 前插入的 `ReplyBar`；麦克风放在 `.pa-send` 旁即可，**别覆盖 `quote` / `replyKey` / `clientRef`**。`Subagents.tsx` 本树未改引用（共享组件已支持，不传 `onQuote` 即无按钮）。

## 未做

- `Subagents.tsx` 引用 composer 接入（避免争语音任务的 composer hunks；组件本身已支持）。
- 真机 iOS 手势；真实后端联调（仅按冻结契约 mock）。
