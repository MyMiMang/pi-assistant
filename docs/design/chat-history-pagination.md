# 聊天历史分页（手机首屏加载性能）

> 状态：**beta.28 候选，未发布 / 未 push / 未 tag**。改动只涉及首屏拉取条数与游标稳定性，不改数据、不截断历史、不加「简洁模式」。
> 量化证据：`evidence/mobile-chat-history-perf/`。合成历史 + 模拟手机网络（CDP 200ms 延迟 / 1.5Mbps 下行 / 4x CPU 降速 / 390×844），**不是真实用户网络实测**。

## 1. 结论：不是「一次全量加载」，而是首批过大 + 元数据重

静态 trace（手机启动 → 选聊 → 消息）：

1. `App.tsx`：`loadSystem` → `loadAgents` → `loadRooms`（串行）→ `current` 变化触发 `selectAgent`。
2. `store.ts selectAgent`：`loadConversations` → `loadMessages`。
3. `store.ts loadMessages`：`GET /api/agents/:id/messages?limit=<PAGE>&conversation=<cid>`。
4. 服务端 `http.ts` → `messages.ts listMessages`：`WHERE agent_id=? AND conversation_id=? AND task_id IS NULL AND subagent_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`（索引 `messages_conv(conversation_id, created_at)`，无 OFFSET 大扫描）。
5. 客户端把整批放进 `messages[agentId]` → `group()` → 全部消息一次性挂到 DOM；`Markdown` 已 `memo`，但首次挂载仍按条数线性增长。
6. 群聊：`selectRoom` 拉 `limit=200`；`RoomChat` 另有「更早的消息」（`before=seq`，limit=100）。
7. WS 连接只发 `hello`（`bus.seq`），**不回放历史**；重连时 `App.tsx` 会重新 `selectAgent`/`selectRoom` 再拉一次首批。

所以：**首屏是有界的（随 limit，不随历史总量增长）**，并非全量。真正的成本是：

- **首批太大**：单聊 `PAGE=300`、群聊 200。合成数据里单聊 300 条 = **2.75 MB** JSON；群聊 200 条 = **1.85 MB**；`limit=50` 时 = **0.47 MB**。`meta` 里 `thinking` 上限 20k 字符、工具 `result` 上限 4k 字符（`runtime.ts`），工具密集的历史尤其重。
- **服务端不压缩**：`serveStatic` + JSON 都无 `content-encoding`（实测 JS bundle 1,292,406 字节原样发出，vite 的 gzip 393 KB 未被利用）。隧道是否压缩取决于部署，本地/直连不压缩。
- 渲染：300 条时 DOM 约 13k 节点；50 条约 2.3k。

## 2. 改动（最小、复用现有分页）

### 服务端 `packages/server/src/messages.ts` / `http.ts`
- 每条消息带 `seq`（`rowid`）。
- 单聊新增**稳定游标** `beforeSeq`：`(created_at < before) OR (created_at = before AND rowid < beforeSeq)`，与排序 `created_at DESC, rowid DESC` 严格对应 → 同一毫秒的多条消息不再在分页边界被跳过 / 重复。
- 只传 `before`（旧客户端 / 旧契约）= 原样 `created_at < before`，**行为不变**。
- 群聊沿用 `before=seq`（本就稳定）。
- 索引 `messages_conv` / `messages_room` 已足够，无需迁移。

### 前端 `apps/web/src/store.ts`
- `PAGE = 50`（单聊首屏 / 每次向上加载）、`ROOM_PAGE = 50`（群聊）。
- `loadMoreMessages` 用 `olderParams()`：带上 `before=created_at` + `beforeSeq=seq`；旧服务端无 `seq` 时退回 `before`。
- `selectRoom` 首批 200 → 50。

### 前端 `Chat.tsx` / `RoomChat.tsx`
- 滚动接近顶部自动加载更早；插入上方后按 `scrollHeight` 高度差回填 `scrollTop`，**保视觉锚点不跳**；正在往上翻 `stick=false`，新消息不把视图拉到底。
- 加载失败显示错误 + 重试；`hasMore=false`（收到空页）后不再发请求。
- **引用 / 搜索 jump** 到未加载的旧消息：继续用有界 `GET /api/messages/:mid/context`（前后各 ≤ limit/2），插入后把 `hasMore` 置真、群聊把 `older` 复位，保证从窗口继续向上加载**不出现分页断档**；不为跳一条拉全量。

## 3. 实测（合成 1000 条历史，模拟手机网络）

| 指标 | 改前（300/200） | 改后（50/50） | 变化 |
|---|---|---|---|
| 首屏第一行可见 | 23,566 ms | 10,644 ms | −55% |
| 稳定渲染 | 23,997 ms | 10,768 ms | −55% |
| 消息响应字节 | 2,746,171 B | 471,445 B | −83% |
| DOM 节点 | 13,072 | 2,343 | −82% |

HTTP 层（本机回环，仅服务端查询 + 序列化）：单聊 `limit=300` 2.75MB / 37ms，`limit=50` 0.47MB / 6ms；10000 条历史首批字节与 1000 条一致（有界）；逐页翻完 10000 条无重复无缺项。详见 `evidence/mobile-chat-history-perf/*.json`。

## 4. 未做 / 未验（如实）
- 模拟网络是 CDP 限速，**不是真实手机 / 隧道实测**；真机、隧道压缩、PWA 缓存命中未验。
- 服务端未加 gzip/br 压缩——这是下一个更大的杠杆（bundle 393KB gzip / 消息 JSON 同理），本轮未做，避免扩大改动面。
- 全量 `npm test`（757）/ 全量 e2e 未跑。
- 群聊「向上加载」在 jump 后与单聊共用同一套语义，但未做逐条 DOM 断言。
