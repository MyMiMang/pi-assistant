# conversation-loading-restore-fix 进度快照

树：`conversation-loading-restore-fix`（基 `hotfix-integration` `b7d33d3`，含 `48c50b0` 向导修复，未 push / 未 tag）。
本树只改**前端选择恢复 + 聊天记录加载**；`App.tsx` 未动，向导（onboarding）逻辑未动，统一模型设置 UI 未动。

## 根因（实际代码）

1. **每次打开默认第一个助理**：`store.ts` 的 `current` 只在内存；`loadAgents()` 用
   `agents.find(a => a.scope !== "room")?.id ?? agents[0]?.id` 兜底，且没有任何持久化 /
   恢复。刷新、重开（尤其手机）就丢，于是永远显示列表第一个。地址栏 `?agent=` 只在
   这一条初始化分支里生效，之后的 `loadAgents`（重连 / `agents.changed`）不会用。
2. **点会话白屏很久**：`switchConversation` / `selectAgent` 先把 `messages[agentId]` 清空或
   直接覆盖，但没有任何 loading / 错误 / 空态渲染；`Chat.tsx` 只按 `messages` 渲染，
   历史没回来就是空白。也没有并发保护：晚返回的旧对话 history 会覆盖刚切到的目标；
   请求失败也没有错误态和重试，界面一直空白 → 用户以为坏了。

## 改动

- 新增 `apps/web/src/selection.ts`（纯函数）：`selectionKey` / `loadSelection` / `saveSelection` /
  `resolveInitialAgent` / `storedConversation` / `mergeMessages`。只持久化公开 id（助理 id +
  每个助理最近打开的对话 id），不存消息 / token / 凭据。
- `store.ts`：
  - 新增 `selKey`（= `pia.sel.<serverId>.<deviceId>`，按账号隔离，换账号读不到对方 id）与
    `msgState`（loading / error / loaded / conv / hasMore）。
  - `loadAgents` 恢复优先级：内存有效 current > 地址栏 `?agent=` > 上次明确打开 > 第一个（**仅一次**）；
    已删除 id 回退并回写，有效选择不覆盖。
  - `selectAgent` / `switchConversation` / `loadMessages`：每次请求带代号 + `AbortController`，
    晚返回的旧请求不覆盖新目标；`switchConversation` 立即切目标并显示 loading（不闪旧聊天）；
    失败写入错误态；`retryMessages` 可重试；`loadMoreMessages` 向上翻页（`before` 分页，不截断服务端模型会话）。
  - `mergeMessages`：同一对话内把「已显示但后端 history 还没带上」的乐观 / 流式消息并进来，
    迟到 history 不覆盖、后台刷新不清空。
- `Chat.tsx`：加载骨架 `thread-loading`、错误 + 重试 `thread-error` / `thread-retry`、
  空对话 `thread-empty`、更早消息 `load-more`；已有消息时后台刷新不显示骨架。

## 实际跑的

- 两端 `tsc --noEmit`（`apps/web`、`packages/server`）exit 0。
- 纯逻辑单测 `packages/server/test/web-selection.test.ts`：**10/10**（fresh / stored 有效 /
  已删除 id / deeplink 优先 / 当前优先 / 群助理不误判 / 账号隔离 / 只存公开 id / 乐观合并 / 刷新不清空）。
- 纯前端 fixture `e2e/conversation-restore.mjs`：**10/10**（手机 390 + 桌面：恢复上次助理与对话、
  已删除 id 回退回写、deeplink 优先、慢 agents 不提前覆盖、切对话晚返回不覆盖且不闪旧聊天、
  失败 + 重试、空对话、重新拉取不清空）。静态托管 `apps/web/dist` + `page.route` 拦 `/api`，
  **不启动 `main.ts`、不碰钥匙串、不读写用户数据、不调付费模型**。
- 性能证据（fixture 计数）：切到目标对话只发 **1 次** `messages` 请求（`messages:c2 === 1`），
  晚返回的旧请求被中止 / 丢弃；未承诺真实秒数。

## 未做 / 边界（诚实）

- **未真机**：没有在真实手机 / 安装包上验证（用户只用安装包测；本树未打包）。
- 未跑全量 e2e / 服务端全量单测（只跑受影响的纯前端 fixture 与纯逻辑单测）。
- 未做真实「很大历史」的耗时实测，只给请求次数与竞态行为证据。
- 未改 `App.tsx`、向导（onboarding）、统一模型设置 UI；`hotfix-integration` 的
  `48c50b0` 向导修复保留未动。

## 提交

- `d8d38fe` 选择持久化恢复 + 消息加载 loading/错误/重试/空态与竞态保护
- `a940cfe` 纯逻辑单测 + 手机 390/桌面纯前端 fixture
