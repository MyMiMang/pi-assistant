# 手机聊天历史性能 — 恢复点（context 窗口导航，未 push / 未 tag）

> 2026-10-17。用户机器曾严重卡顿（16GB 内存用 15GB、swap 13.7GB、load 233）按主指示暂停新 build / browser / perf 重测；
> 恢复后本轮仍**只做轻量 read/edit/git**（不 run build / browser / test / service），重测试槽由 voice 子代理占用，等主放行。
> 我自建的测试进程 / 端口已全部回收（无残留监听）。

## 0. 当前状态

- HEAD（本 worktree `mobile-chat-history-performance`）：
  - `f40956a` **checkpoint 1（已提交）**：静态预压缩 + 缓存头、API JSON gzip、WS 首次连接去重、上滑自动加载保护、
    引用跳转去掉孤立窗口 merge（改成连续向更早分页，后由本轮的 context 窗口导航取代）。
  - 本轮 **context 窗口导航**（未提交，见下）→ 待提交为 checkpoint 2 + 文档。
- 基线：`release-candidate-validation` `6d6c1ee`；beta.28 候选，**未 push / 未 tag / 未打包**。

## 1. 本轮（context 窗口导航）改了什么

用户/主决定：**不能把 ~1000 条距离上限作为产品行为**，任意远目标都应能一跳；但**不能为了跳一条把沿途上千条加载进 DOM**；
也**不能**再把 `/context` 的孤立窗口 merge 进当前列表（会在中间留永久空洞）。A（有界连续分页 + far 拒绝）与 B（加大页大小）都被主拒绝。

实现：把当前列表**替换**成围绕目标的连续有界上下文窗口，窗口外按需前后分页。

- 服务端 `packages/server/src/messages.ts`
  - `listMessages` 新增前向分页 `after` / `afterSeq`（`(created_at, rowid)` 复合游标，升序、不含游标本身）。
  - `listRoomMessages` 新增 `after=seq`（rowid 升序）。
  - 旧 `before` / `beforeSeq` 语义不变。
- 服务端 `packages/server/src/http.ts`
  - `/api/agents/:id/messages`、`/api/rooms/:rid/messages` 透传 `after` / `afterSeq`。
  - `/api/messages/:mid/context` 新增 `?bounds=1` → `{ messages, hasOlder, hasNewer }`（默认仍是旧数组契约）。
    边界查询与窗口用同一过滤条件（`task_id IS NULL AND subagent_id IS NULL`），避免子代理/任务消息把 `hasNewer` 顶成永远 true。
- 前端 `apps/web/src/replies-api.ts`：`locateMessage` 用 `bounds=1`，返回 `hasOlder` / `hasNewer`（旧服务端数组 → null）。
- 前端 `apps/web/src/store.ts`
  - `HistoryWindow { hasNewer, newCount }`；`MsgState.window`；新增 `roomWindow`。
  - `openHistoryWindow` / `openRoomHistoryWindow`：用窗口替换列表（`hasMore = hasOlder`）。
  - `loadNewerMessages` / `loadNewerRoomMessages`：向前分页到实时末尾（`newer.length >= PAGE` 才 hasNewer=true）。
  - `returnToLatest` / `returnRoomToLatest`：重新拉最近一页并清空窗口；`loadMessages(..., replace=true)` 不跨 gap 合并。
  - `handle` `message.created`：窗口还不到实时末尾（`hasNewer`）时只 `newCount++` 提示，**不 append**（防中段不可达）；
    窗口内已载消息的 updated / deleted / delta 仍按 id 正常更新。
  - 删除旧的 `loadUntilMessage`（20 页上限 + far 拒绝）。
- 前端 `apps/web/src/components/MessageReply.tsx`：`useMessageJump(scroller, locate, onWindow)`；去掉 `far` 状态；
  目标已在列表 → 直接 `flash`；不在 → 用返回的窗口替换列表再定位。
- 前端 `apps/web/src/components/Chat.tsx` / `RoomChat.tsx`：接入窗口；底部提示条 `data-testid="history-window"`
  （「正在查看历史消息 / 有 N 条新消息」+「加载较新消息」+「回到最新」）；跳进窗口后 `stick=false`，回到最新时 `stick=true`。
- 前端 `apps/web/src/themes/base.css`：`.pa-history-window` 样式。

## 2. 测试（已写，**尚未运行**）

- 服务端 `packages/server/test/messages-pagination.test.ts`：新增「单聊 afterSeq 前向分页同毫秒不跳不重」「群聊 after 前向分页」。
- 服务端 `packages/server/test/message-replies-http.test.ts`：新增「context?bounds=1 回 hasOlder/hasNewer，默认仍数组契约」。
- 纯前端 `e2e/mobile-chat-pagination-ui.mjs`（重写，8 步）：
  首屏有界 / 上滑保锚点（既有 5/5 语义保留）/ 往上翻不拉底 / 引用跳只发一次 context 窗口 + 加载较新 + 回到最新 /
  **10k 历史跳最早只发一次 context、DOM ≤60 条** / **窗口里 WS 新消息不跨 gap 只计数、回到最新后可见** /
  群聊上滑 / 群聊引用跳窗口。
- 运行方式（等重测试槽放行）：`node --import tsx --test packages/server/test/messages-pagination.test.ts`、
  `.../message-replies-http.test.ts`；`npm run build -w @pi-assistant/web` 后
  `CHROME=… node e2e/mobile-chat-pagination-ui.mjs`；两端 `tsc --noEmit`。

## 3. 仍未验 / 未做（如实）

- context 窗口新增定向测试**尚未运行**；真机、隧道压缩、PWA 缓存命中未验。
- 全量 `npm test`（757）/ 全量 `e2e/run.mjs` 未跑。
- 未加「简洁模式」、未删/截断历史；引用快照 schema 未动。

## 4. 环境（重要，避免重踩）

- Homebrew `/opt/homebrew/bin/node` 25.8.2 缺 `libsimdjson.31.dylib`，不可用。
- `~/.local/node-v24.19.0/bin/node` v24：vite build / Playwright OK，但 `node --import tsx test/launch-memory.ts` **静默挂起**（服务端测试起不来）。
- 服务端测试 / 启服统一用 App 内置 `/Applications/Pi Assistant.app/Contents/MacOS/node` v22.23.3。
- `node_modules/@pi-assistant/*` 指向本 worktree `packages/*`；无共享基树污染。

## 5. 下一步（按优先级）

1. 等重测试槽放行：跑 §2 的定向单测 + 纯前端 fixture + 两端 `tsc`。
2. 过了再跑受影响回归（rooms / message-replies / conversation-restore / web-selection）。
3. 提交 checkpoint 2（context 窗口 + 测试 + 文档）；更新 HANDOFF；不 push / 不 tag（除非主放行）。
