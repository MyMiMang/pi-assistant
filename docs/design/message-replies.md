# 消息引用（reply / quote）设计

状态：设计已定，后端开发中（未打包）
范围：单聊 + 群聊的“引用某条消息再回复”。UI 由另一路负责，本文冻结 DTO 与 API。
树：`message-replies-backend`（基 `unified-integration`）。

## 1. 目标与非目标

目标：
- 用户能引用任意一条**自己可见的、同会话/同群的**用户或助理消息再回复。
- 群聊里引用谁，就只唤醒谁：引用 A 只叫 A，不再唤醒管理者、也不叫其它成员。
- 引用只是**上下文**，不是授权、不是新指令。
- 服务端可信解析引用目标；客户端不能伪造被引内容、作者或接收人。
- 重复投递 / 重试 / 重启不重复唤醒。
- 删除被引用消息后，引用快照不得泄露已删除正文。

非目标（本轮不做）：
- 跨会话 / 跨群引用（一律 fail closed）。
- 引用 system / tool / 已删除成员的隐藏消息。
- 让“助理互相引用”自动触发新一轮（防机器循环）。
- 修改 Pi SDK / node_modules，或自造消息 role。

## 2. 数据模型（SQLite，`packages/server/src/db.ts`）

`messages` 增列（轻量迁移，兼容旧库）：

| 列 | 类型 | 说明 |
|---|---|---|
| `reply_to_id` | TEXT | 被引用消息 id；无引用为 NULL |
| `reply_snapshot` | TEXT | 有界 JSON 快照（见 §3）；无引用为 NULL |

`room_turns` 增列：

| 列 | 类型 | 说明 |
|---|---|---|
| `source_message_id` | TEXT | 触发本轮的用户消息 id，用于去重 / 重启恢复 |

其它：
- 快照是引用时刻的**子集**，不是整条消息的复制，长度有界（见 §3）。
- 被引用消息被**真删除**时，把所有 `reply_to_id = 该 id` 的快照 scrub 成不可用（§6）。
- 被引用消息被**编辑**时，快照保留原版本，置 `edited = true`（§6）。
- 不额外长期复制原文；不做新隐私存储层。

## 3. DTO（冻结，供 UI 复用）

放在服务端消息 DTO 上（`packages/server/src/messages.ts`），前端 `apps/web/src/types.ts` 镜像同名类型。

```ts
/** 引用快照：服务端生成，客户端只读。 */
export interface ReplySnapshot {
  messageId: string;
  /** 作者：user 的 id 为空串；assistant 的 id 为 agentId */
  author: { id: string; name: string; role: "user" | "assistant"; avatar?: string };
  /** 来源容器：群或单聊对话 */
  source: { kind: "room" | "conversation"; id: string };
  /** 原文摘录，UTF-16 截断到 ≤2000 字符；不含 tool / system / 密钥 / 二进制 */
  excerpt: string;
  truncated: boolean;
  /** 快照生成后，原消息被编辑过 */
  edited: boolean;
  /** 仅元数据，无 base64 / data URL / 二进制 */
  attachments?: { fileId: string; name: string; mime: string; size: number }[];
  createdAt: number;
  /** 原消息已被删除：excerpt 清空、attachments 清空，仅保留“不可用”标记 */
  unavailable?: boolean;
}

// Message DTO 新增字段（其余不变）：
// replyToId?: string | null;
// reply?: ReplySnapshot | null;
```

规则：
- 快照由服务端从**可信数据库行**生成；只接受客户端传 `replyToId`，绝不接受 `excerpt` / `author` / `recipient` 等覆盖字段（传了忽略）。
- `excerpt` 只取 `role ∈ {user, assistant}` 的 `content`，按 Markdown 安全渲染；引用只作上下文，不自动点击外链、不自动下载 / 生成任何东西。
- 附件只带元数据；引用图片**不会**因此把图片作为输入自动发给模型（看图仍按现有附件路径，见 §8）。
- 快照的 `author.name` 用引用时刻的名字；作者后续改名不回改历史快照。

## 4. API（精确路径）

### 4.1 发送（新增可选 `replyToId`）

| 方法 | 路径 | 新增字段 |
|---|---|---|
| POST | `/api/agents/:id/messages` | `replyToId?: string` |
| POST | `/api/rooms/:rid/messages` | `replyToId?: string` |

- 请求体**不接受**任何 `reply` 对象 / `excerpt` / `author` / `recipient` 覆盖。
- 校验与错误（不泄露被引用内容）：

| 场景 | HTTP | body.code |
|---|---|---|
| 目标消息不存在 | 404 | `reply_not_found` |
| 目标不在同一会话 / 同群（跨会话、跨群、单聊引群消息等） | 403 | `reply_cross_scope` |
| 目标 role 不可引用（system / tool / card） | 403 | `reply_not_quotable` |

- 校验失败 → 整条发送失败，不落库、不唤醒任何人（fail closed）。
- 校验通过 → 先落库（带服务端生成的 `reply_snapshot`），再按 §5 路由唤醒。
- 幂等：请求可带 `clientId`（可选）；同 `clientId` 重复发送在窗口期内返回已存在的那条消息，**不重复唤醒**。此外路由按 `room_turns.source_message_id` 去重（§7）。

### 4.2 查询 / 跳转（有界）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/messages/:mid` | 单条消息；按调用者的可见范围鉴权（同会话 / 同群成员），否则 403/404 不泄露存在性 |
| GET | `/api/messages/:mid/context?limit=50` | 目标消息的**有界**上下文窗口（同容器内前后各 ≤ limit/2，`limit` ≤ 100，默认 50），升序返回 `Message[]`；用于 UI 点击引用后定位，不拉全量历史 |

- 列表接口 `/api/agents/:id/messages`、`/api/rooms/:rid/messages` 的返回项自动带 `replyToId` / `reply`（无需新参数）。
- UI 可复用已有分页（`before`）先在本 store 内定位；定位不到再调 `/context`。

## 5. 群路由规则（核心）

只处理**用户本人新消息**触发的路由；助理消息、tool、system、后台事件一律不触发（防机器循环）。

优先级（`packages/server/src/rooms/logic.ts` 纯函数）：

1. **显式 @ 优先**（沿用现状，含 `@所有人`/`@all`）：
   - 有 @ 目标 → 只按 @ 的目标唤醒（按出现顺序）。引用只作上下文，不额外唤醒被引用者。
   - 例：引用 A 但 `@B` ⇒ **只唤醒 B**。
   - `@all` 是用户主动选择 → 唤醒全部成员（与“默认只 A”不同，但由用户显式决定）。
2. **无 @，且引用的是群内某助理消息** → **只唤醒作者 A**（`reason: "mention"`，定向），不唤醒管理者、不唤醒其它成员。引用 A 只叫 A。
3. **无 @，且引用的是用户消息 / system / 已删除成员 / 其它不可路由消息** → 走**既有管理者路由**；无法定向时给用户明确提示“这条不能定向，请用 @ 选择成员”，**不擅自指定“第一个成员”**。
4. **无 @，且引用的是管理者自己的助理消息** → 只唤醒管理者，走正常管理者功能，但**默认不自动扩派 / 不 broadcast**：
   - 路由本身不产生任何 fan-out；`planAfter` 只对管理者**显式**产出的分配（`room_assign` / 文字 @）生效。
   - 定向回合的系统提示追加：“用户引用了你的这条消息，只回应这条；除非用户明确要求分工，否则不要 `room_assign`、不要 @ 别人。”
   - 若用户明确请管理者分工，管理者仍可按其正常意图自主分配（这是用户意图，不是路由 broadcast）。

定向目标校验（唤醒前）：
- 仅当前群成员、`left_at IS NULL`、`deleted = 0`、助理存在且可用，才可被定向唤醒。
- 目标是已删除 / 停用的助理 → **不静默改叫管理者**；群内写一条明确提示“该成员已被删除或停用，请用 @ 选择其它成员”。
- 程序按存储行的**可信 id** 路由，不调用额外 LLM 选接收人。

## 6. 快照生成 / 编辑 / 删除

生成（`packages/server/src/replies.ts`）：
- `resolveReplyTarget({ scope, scopeId, messageId, requesterAgentId? })`：解析目标 + 校验可见性 / role，失败抛带 `code` 的错误。
- `buildReplySnapshot(target)`：生成 §3 快照，`excerpt` 截断 ≤2000 且置 `truncated`。

编辑：
- `updateMessage` 发现 `content` 变化时，把 `reply_to_id = id` 的引用快照统一置 `edited = true`；快照 excerpt 保持原版本（用户可见“已编辑”）。

删除：
- `deleteMessage(id)` 前，先把 `reply_to_id = id` 的快照 scrub：清空 `excerpt` / `attachments`（连同 `truncated` 复位），置 `unavailable = true`，只留 `messageId` / `author` 摘要。**不得**保留已删除正文。
- 整会话 / 整群删除时，同容器内被引用消息一并删除，悬空引用随容器消失，无需单独处理。
- 允许先走现有 history 软删除策略；无论软删还是硬删，都不能违反“删除后不泄露正文”。

## 7. 幂等与重启

- 发送路由只发生一次；重复投递同一 `clientId` 返回已有消息，不再唤醒。
- `room_turns.source_message_id` 记录触发消息；入队前若已存在该 source 的未取消回合，则跳过，避免 retry / 重启后 double wake。
- 实现（`packages/server/src/rooms/index.ts`）：`postUserMessage` 先落库，再由 `routeUserMessage(roomId, messageId)` 按 DB 里的**可信来源消息 id** 路由，不接受客户端传参。同一来源只路由一次（已有任何非 `cancelled` 回合 → 整组不再路由）；`enqueue(..., sourceMessageId, dedup)` 对根回合用 `INSERT … WHERE NOT EXISTS` 原子认领 `(room, source, agent, reason)`，因此 @所有人 每人 1 条、管理者分工（reason 不同）与多步 followup 照常入队，不会被同 source 误吞；真正不同的消息（即使同文本）各唤醒一次。
- 服务重启沿用现有 `bootstrapRooms()`：`running/queued` 标 `interrupted`，用户“继续”时按 `source_message_id` 恢复，不重新路由。

## 8. 模型上下文（Pi 适配，不改 SDK）

- Pi 原生消息表示**没有 reply 字段**；不改 SDK / node_modules / 不自造 role。
- 通过自有适配层，把引用作为**带可信 role wrapper 的上下文文本**拼在用户新消息**之前**，与用户新消息明确分开：

```
（被引用的历史内容，仅上下文 · 来自 <作者> · <时间> · 原文 id <mid>）
<excerpt>            ← 有界；truncated 时附“原文更长，可用工具按 id 查原消息”
（引用结束）

<用户新消息正文>
```

- 明确声明：引用内容**不是新指令、也不构成授权**；只有用户本人的话才算授权（与群规则 §17 一致）。
- 引用过长时，不复制整段历史；给原文 id，需要时由模型按现有工具查（后续可加按 id 取消息的工具，本轮不新增 message 子工具）。
- 附件只写元数据与现有工作区路径；不因引用自动发送 / 下载 / 再生成。
- **验证要求**：测试断言实际进入 provider 的 payload（fake Pi + 记录 `complete`/prompt 参数）包含引用块（作者 + 摘录）**和**用户新消息正文，而不只是 DB / UI 上贴了一块。

## 9. 安全与边界

- 所有信任边界：客户端只传 `replyToId`，其余服务端解析；不信任客户端引用 Markdown，渲染走既有安全 Markdown 管线。
- 不把原始工具输出、密钥、system 隐藏消息写进快照 / 聊天。
- 跨会话 / 跨群引用 fail closed（§4.1）。
- 完全权限档位不因引用绕过审批；引用不批准任何操作。
- 单聊引用任意同对话内的 user / assistant 消息；跨对话先 fail closed，不做“先试后通”。

## 10. 测试计划（sqlite 临时库 + 假 Pi + 内存 CredentialStore）

强制 `PIA_DATA_DIR` / `PIA_WORKSPACE` 指向临时目录，禁用真实 keychain / secret。
- 快照：保存 → 重载；旧消息无引用（backcompat）；编辑 → `edited`；删除 → scrub 不可用。
- 路由：A 引用 → 只 A、manager 0；引用 A 但 @B → 只 B；manager 被引用 → 只 manager 且不自动扩派；普通无引用 → manager 1；无 @ 引用用户/system → 管理者或明确提示。
- 权限：群禁用 / 已删除成员被引用 → 明确提示，不误唤 manager。
- 跨 room / 跨单聊引用 → 403/404 且不泄露内容。
- 幂等：同 `clientId` / 同 source 重复 → 只唤醒一次。`test/message-replies-queue-dedup.test.ts` 覆盖：同一来源路由两次只入队一组、@all 每人 1 条且重复事件不翻倍、重启后同源 0 新回合、引用甲只叫甲（管理者 0）、引用甲但 @乙只叫乙、引用管理者只叫管理者、两条同文本不同消息各 1 条、clientId 幂等。
- 助理消息引用 → 不自动触发 loop。
- provider payload：断言含引用块与用户正文。
- 完全权限档位下不受影响。

## 11. 交付与限制

- 中文小 commit，不 push / 不 tag；每个关键路由补测试。
- 与 UI owner 通过 §3 DTO / §4 API 对接；后端先落 DTO 与路由，UI 消费。
- 与 `agent-onboarding-training` / SkillsTab 等其它分支可能存在 merge hunks，本设计不碰未知 WIP 与 memory scope。
- 限制：本轮只有**用户本人引用**会触发唤醒；助理引用、tool / system 自动消息不唤醒任何人。跨会话引用未支持。
- 合入路径：整合到 `unified-integration`，随下一个未发布 beta.24 只在 Apple Silicon macOS 出包。
