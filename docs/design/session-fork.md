# 从消息另开会话分支（session fork）

状态：已实现（已合入候选 `release-candidate-validation`，未打包；实现见 `packages/server/src/pi-adapter`、`src/fork.ts`、`http.ts`、`apps/web`）。

## 1. 目标与非目标

**目标**：单聊里每条**可分支的**消息旁提供「从此另开新对话」，用 Pi 公开 SDK 在服务端建一个**新的自有对话**（新 conversation id + 新 Pi 会话文件 + `parentSession` 父关系），历史显示为「从某条消息分支」，原对话完全不动，可随时切回。

**非目标**（本轮明确不做，避免范围爆炸）：
- 不做分支树可视化、不做跨分支导航 UI。
- 不做群聊分支（群成员会话是群内隐藏对话，把整段群上下文复制进单聊需要用户显式授权，另立需求）。
- 不自动调用模型、不重放已有工具、不复制父对话的排队任务 / 等待 / 后台任务 / 审批单。
- 不做「fork 后自动重发原 prompt」——`/fork` 语义只把被分支的用户消息正文放回新对话输入框，等用户自己改、自己发。

## 2. 官方 Pi 1.2.0 公开能力（已确认，不碰私有接口）

全部经 `packages/server/src/pi-adapter/` 调用，只使用 `@earendil-works/pi-coding-agent` 的公开导出。

| 能力 | 出处 | 语义 |
|---|---|---|
| `SessionManager.open(path, sessionDir?, cwd?)` | `docs/session-format.md`、`sdk.md#sessionmanager-api` | 打开会话文件，得到入口树与 leaf。 |
| `SessionManager.createBranchedSession(leafId)` | `session-manager.d.ts` | **只读**源文件，另写一个新会话文件，内容 = 根到 `leafId`（含）这一条路径；新文件头带 `parentSession: 源文件`。源文件不被追加 / 修改。这就是「fork」。 |
| `SessionManager.create(cwd, dir)` + `newSession({ parentSession })` | 同上 | 当分支点在第一条消息之前（`leafId` 为空）时，建一个只有父关系、没有历史的新会话。 |
| `AgentSession.getUserMessagesForForking()` | `agent-session.d.ts` | 返回 `{ entryId, text }[]`，只含 **user** 消息。官方交互式 `/fork` 的选择器数据源。 |
| `AgentSessionRuntime.fork(entryId)` / `fork(entryId, { position: "at" })` | `agent-session-runtime.js` | 默认（`position` 缺省）：**只接受 user 消息**，分支点到该消息的 `parentId`（即**不含**这条消息），并把它的正文作为 `selectedText` 返回给编辑器——「从这条消息另开并编辑」。`position: "at"`：接受任意 entry，含该 entry，编辑器清空（官方 `/clone`）。 |

**结论（决定可分支范围）**：官方 `/fork` 锚点 = **user 消息**；`position: "at"` 虽然任意 entry 都行，但把分支点停在 assistant 的 tool-call 之后、或停在 toolResult 上，会留下「悬空 tool call」这类不安全上下文。因此第一版**只开放 user 消息**作为锚点，前端只在这种消息上显示按钮，后端对其它类型 fail-closed。这与官方一致，不需要自造规则。

## 3. 冻结 API

```
POST /api/conversations/:cid/fork
body: { messageId: string, clientId?: string }
200:  { conversationId, draft: string | null, forkedFrom: { conversationId, messageId, entryId } , created: boolean }
4xx:  { error, code }
```

错误码（fail-closed，前端据此给明确提示，不静默从别的消息 fork）：

| code | HTTP | 含义 |
|---|---|---|
| `not_found` | 404 | 对话 / 消息不存在 |
| `fork_cross_scope` | 403 | 消息不属于该对话，或属于群 / 子代理 / 后台任务 |
| `fork_anchor_not_supported` | 409 | 该消息角色不是 user（引用 / 卡片 / 工具 / 系统消息不可分支） |
| `fork_anchor_unmapped` | 409 | 该消息还没落 `piEntryId`（例如 Pi 会话文件被清理），无法可信定位分支点 |
| `fork_no_session` | 409 | 源对话还没有 Pi 会话文件（一条消息都没发过） |
| `fork_busy` | 409 | 源对话正在流式输出。**不 abort 用户任务**，提示等这一轮结束再来 |
| `fork_failed` | 500 | 建会话失败（磁盘等） |

幂等：带 `clientId` 时，同一对话内同 `clientId` 只创建 1 个对话，重复请求返回同一个 `{ created: false }`。

## 4. app 消息 ↔ Pi entry 的可信映射

前端**不能**传 session 文件名 / 下标。锚点必须是服务端可信的 `messageId`，由服务端解析成 Pi entry id。

**落库**：服务端在 Pi 把消息写进会话文件后，把该消息的 entry id 写进 app 消息的 `meta.piEntryId`（Pi 的 `message_end` 事件里，公开监听器先于持久化触发，所以在同一个同步块之后用公开 `SessionManager.getEntries()` 按**消息对象身份**（`entry.message === message`）反查刚追加的 entry；实现放在 `pi-adapter` 的 `subscribeSession`，用 `queueMicrotask` 在持久化完成后取）。不用 `getLeafId()`（多条 `message_end` 落在同一个 tick 时会把它们都指到最后一条），也不靠文本 / 下标猜。

**user 消息配对**：`runtime.bindSession` 把每条 user 消息在 `send()` 时按**发送顺序**入队，收到 `entry_id`（role=user）时按同一顺序出队 —— Pi 把 user 消息按送达顺序持久化（普通发送立即、插话在工具边界），连发**同文本**也不会串；发送失败 / 未送达的从队列去掉。

**覆盖范围**：`user` / `assistant` / `toolResult` 三类消息都会拿到 `piEntryId`。user 是 fork 锚点；assistant / tool 用于把分支前缀投影成新对话的消息行。

**不是 1:1**：app 消息与 Pi entry 不保证一一对应（工具步骤合并展示、压缩系统消息、`context_edit` 等）。投影规则：遍历新会话分支里的 `message` entry → 用 `entryId` 反查源对话里 `meta.piEntryId` 相等的 app 消息 → 命中才复制；命中不了的 entry 只留在 Pi 侧，不产生 app 消息行。这样不靠文本猜、不靠下标，缺映射就是缺一行展示，不会错位。

## 5. 数据模型

新增表（`db.ts` 轻量迁移，只加表不改旧列）：

```sql
CREATE TABLE IF NOT EXISTS conversation_forks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,     -- 新对话
  agent_id TEXT NOT NULL,
  source_conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,   -- 锚点 app 消息
  source_entry_id TEXT NOT NULL,     -- 锚点 Pi entry
  client_id TEXT,                    -- 幂等键
  created_at INTEGER NOT NULL,
  UNIQUE(source_conversation_id, client_id)
);
```

新对话的行：`conversations(id, agent_id, title, session_file, ...)`，标题默认 `从「<锚点摘录>」分支`。

**不复制**：`tasks` / `requests`（审批单）/ `task_waits` / `proactive_followups` / `usage` 表行 / `files` blob。新对话从 0 开始计自己的用量。

**投影消息行**：复制的是 app 消息行（内容 + 附件引用 + 引用快照），并：
- 打 `meta.forked = { conversationId, messageId }`、`meta.readonly = true`（旧上下文只读，不能在新对话里重跑 / 编辑触发副作用）。
- 去掉 `meta.usage` / `meta.delivery` / `meta.error`，避免把旧对话的模型账单混进新对话的「本轮花费」。
- 引用快照保留原 `source.id`（仍指向原对话，跳转时按原对话权限校验）；不复制附件 blob。

**可删性**：新对话里的旧消息是**独立副本**；删除它只删这个副本，源对话不受影响（不共享 source）。

## 6. 安全边界

- **鉴权**：沿用 `/api/*` 全局鉴权；额外核对 `conversation.agent_id`、`message.conversation_id`、`message.agent_id`，跨对话 / 跨助理 fail-closed；群内隐藏对话与子代理消息拒绝。
- **不额外调用模型 / 不重放工具**：fork 只读写 JSONL 与 SQLite，不碰 `AgentSession`。
- **不动用户任务**：源对话流式时直接 409，不 abort、不排队。
- **不共享可变状态**：新对话走既有 `runtime(agentId, newConversationId)` 懒创建自己的 `AgentSession`，与源对话的 `AgentSession` 互相独立。
- **权限不扩大**：新对话属于同一 agent，继承其技能 / 权限 / 凭据；不跨助理、不跨记忆 bank。
- **Pi 会话文件清理**：源文件不存在 → `fork_no_session`；锚点 `piEntryId` 在文件里找不到 → `fork_failed`。

## 7. 前端交互

- 每条 **user** 消息的操作行（`MessageActions`）加一个次要按钮「另开新对话」，与「引用」同排；引用按钮不变、仍每条可见。桌面右键菜单在同一条目下多加一项。390 宽度下两个按钮不换行、不遮挡正文。
- 点击 → `POST .../fork`（带 `clientId` 幂等）→ 成功后切到新对话，把返回的 `draft` 放进输入框（**不自动发送**），顶部/系统行提示「已从 X 另开新对话，原文已放回输入框，改完自己发」。
- 草稿：输入框文字按「助理 + 对话」分桶保存，切对话保留各自草稿，不回串、不丢失（详见实现）。
- 失败：`fork_busy` / `fork_anchor_not_supported` 等显示对应中文提示，不切换、不动原对话。

## 8. 验证

见 `packages/server/test/session-fork.test.ts`（真实公开 SessionManager + Mock provider，临时数据目录、内存凭据）与前端截图/fixture 断言。要证的点：源文件不被修改、新文件头 `parentSession` 指向源、分支等于前缀、0 额外模型调用 / 0 工具调用、源对话 busy 时 409 不 abort、幂等只建 1 个对话、跨对话 messageId 拒绝。
