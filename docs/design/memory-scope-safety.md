# 记忆作用域安全（memory-scope-safety）

状态：已实现

> 基：`unified-integration` HEAD `66ae16b`（2026-10-15）。依据：`docs/research/hindsight-integration-audit.md`。
> 目标：**完整可用 + 分层权限**——不砍子代理记忆能力，但堵住「未验证结论污染共享 user 库 / 子代理删共享事实 / 无 provenance」。

## 1. 问题（来自审计 §4）

- `memory/index.ts:91`：fact 默认 `scope=user`；子代理/后台与主会话共用同一批工具，直接写进**所有助理共享**的 `user` 库。
- `ext-memory`：4 个工具全标 `readOnlyHint:true` → 任何档位免审批；`forget` 可删共享 user 条目。
- `meta` 只有 `{kind,source,...}`，没有 provenance/status，分不清「主/用户确认」与「子代理推测」。
- 没有 `task` 短期作用域，临时假设只能混进 agent/user 库。

## 2. 设计

### 2.1 Provenance（`MemoryOrigin`，存 `meta.origin`）

服务端按会话上下文**注入**，工具参数无法伪造 actor：

```
MemoryActor = "main" | "subagent" | "background" | "user" | "group"
MemoryStatus = "draft" | "verified" | "promoted" | "legacy"
MemoryOrigin = { actor, assistantId, conversationId?, taskId?, subagentId?,
                 source?, evidenceRef?, createdAt, status }
```

- `actor`：主会话 `main`；子代理 `subagent`；后台任务/定时/心跳/群成员 `background|group`；界面 HTTP 写入 `user`。
- `status`：主/用户写入 = `verified`；子代理/后台写入 = `draft`；晋升后草稿 = `promoted`；旧条目（无 origin）读取时视为 `legacy`（不改盘）。
- `evidenceRef` 只放**安全 ID**（如晋升来源记忆 id / taskId），绝不写任务 prompt/正文/敏感内容。

### 2.2 作用域分层

| 来源 actor | 请求 scope=user | scope=agent/conversation | 默认 |
|---|---|---|---|
| main / user | `user` 库，`verified` | 直接写，`verified` | 原行为 |
| subagent | **降级**为 `task` 草稿（不落 user） | `draft`，可带 conversationId | fact/log/note 全 draft |
| background / group | 同上 | 同上 | 同上 |

- 新增 `scope=task`：仍落 `agent_<id>` 库，带 `meta.taskId`，`status=draft`，`expiresAt = now + 任务草稿 TTL`（默认 7 天，设置 `memoryTaskDraftTtlDays`）。
- **读**：所有会话可读 `user`（verified）+ 本助理 `agent_<id>`（verified）+ 本对话 conversation；子代理额外可读**自己 taskId 的草稿**；主会话（parent）可读本助理下的**全部草稿+来源**用于核验；其它子代理默认读不到兄弟草稿。
- `conversation`/`task` 的可见性同时按 `conversationId`/`taskId` 过滤；越权 deny **不能靠换 scope 绕过**（校验在实际 bank/item 上）。

### 2.3 晋升（promotion）

- 草稿不直接进共享库；由主会话/用户核验后 `memory.promote(agentId, draftId, {scope})`：
  - 只允许 actor=main/user；子代理/后台拒绝。
  - **幂等**：草稿已 `promoted` 直接返回既有晋升 id。
  - **去重/冲突**：只与目标库里**已确认**（verified/legacy）的同规范化文本条目去重；**绝不与别的草稿互相合并**（否则同文本不同事实会互相吞掉）。命时不新增、不覆盖正文，把草稿 id 累积进 `evidenceRefs`（保留旧证据）并把草稿标 `promoted`，返回既有 id。
  - **agent 级原地转正**：目标库与草稿同库时（scope=agent）原地把 `status` 改为 `verified`、清掉 `taskId`，不新建也不隐藏——否则账本按 bank+同文本去重会把草稿行当成「新条目」又标成 promoted 而消失。
  - 否则在目标库写 `status=verified` 新条目，`origin.source="promotion"`，`evidenceRef=draftId`。
  - 晋升要求草稿带可信 provenance（`origin`，非 legacy）且 `origin.assistantId` 确为本助理。
- **同文本不同 task 草稿不互吞**：`RememberInput.dedupe`（默认 true）；`memory.remember` 对未确认草稿传 `dedupe:false`，账本（`basicMemory.remember`）不再按 `bank+text` 把不同任务/子代理的同文本草稿并成一行（修跨任务串位）；已确认写入仍去重。
- 新增最小工具 `memory_review`（仅主会话注入）：列出待核验草稿 / 晋升 / 驳回。晋升是显式用户授权动作，不写成「每轮自动 retain」。
- 技能仍走 `ext-skills` 现有用户同意，记忆晋升**不绕过** `skill_save` 审批。

### 2.3.1 reflect 源端隔离（补强，堵「只在下游过滤」缺口）

主 review 发现：同助理多任务的 `reflect` 原先都落在同一个 `agent_<id>` 库、只在下游按 recall id 过滤已生成的 text，等于先把整库（含兄弟 task 草稿）送给模型再删输出——会泄露，也会影响答案。

- retain 时给每条打 provenance tag：`scope:<user|agent|conversation|task>`、`status:<draft|verified|…>`、`actor:<…>`、`task:<taskId>`、`conv:<conversationId>`。
- `MemoryProvider.reflect(bank, query, scope)` **必须**带显式作用域，没给直接拒绝（fail closed）；`memory.reflect` 按 actor/taskId/conversationId 算每库允许集合。**非核验视角对每个库都显式列范围**，并加一条官方 untagged/global 范围（`{tags:[],match:'exact'}`，经安装包 0.10.3 `engine/search/tags.py` 实物核实：`any`/`all` 含无 tag、`_strict`/`exact` 不含）来保留无 provenance tag 的旧忆：
  - 共享 `user` 库：主会话/用户核验视角 `{all:true}`；子代理/后台 = `OR( AND(scope:user,status:verified), untagged/global )`（不再整库 `all`；万一库里出现异常 tag 的草稿也不会被非核验视角读到）。
  - `agent_<id>` 库：主会话/用户核验视角 `{all:true}`；子代理/后台 = `OR( AND(scope:agent,status:verified), AND(scope:conversation,conv:本对话), AND(task:本任务,status:draft), untagged/global )`，叶子用 `all_strict`。本任务只取 `status=draft`（已驳回/已晋升草稿重打 tag 后不再进证据）；兄弟 task 草稿带自己的 task tag 又非本任务，在**请求端**就被服务端过滤掉；无 tag 旧忆保留可见。
- 若后端根本不支持 tags/tag_groups 过滤（无法证明正确 filter），回退方案是 task 草稿物理分 bank/namespace 隔离 + 分调用安全聚合；本轮 Hindsight 公开 API 支持 `tags`/`tags_match`/`tag_groups`，未触发回退。
- 验证：假 Hindsight 按官方语义实现 tag 过滤，测试断言 reflect **请求**带精确 provenance 过滤、且服务端实际喂给模型的命中里没有兄弟草稿（不是断言最后 text 不含）；另用**本机安装的真实 0.10.3 服务代码**（`ReflectRequest` 校验器 + `build_tag_groups_where_clause`/`tags_satisfy_groups`）对实际请求体生成 SQL 并逐条命中判定为证。

### 2.4 删除/更新归属

- 只能对自己的 task 草稿 / 自己写入的条目直接 `forget`/`update`。
- 共享 `user` 库、`verified`、他人/legacy 写入的条目：子代理/后台**拒绝**（即使完全权限档位，服务端语义拒绝，不是审批）；主会话/用户可操作。

### 2.5 审批与 permissions

- `memory_recall` / `memory_reflect`：`readOnlyHint:true`（反思是推理，不写事实），不误拦。
- `memory_remember`：`readOnlyHint:false`（真实写入），`destructiveHint:false, openWorldHint:false` → 非完全权限档位也不弹（不「一刀每记忆都弹审批」），完全权限档位照旧应用层免审批。
- `memory_forget`：`readOnlyHint:false, destructiveHint:true` → 非完全权限档位按原有档位走审批，完全权限免审批。
- scope/ownership 的 deny 是服务端逻辑，不等于审批。

### 2.6 兼容 / 迁移

- 旧条目无 origin/status → 读取标 `legacy`，**保持原作用域可见、不自动降级/删除**；不做批量 rewrite，只渐进写新 metadata。
- `meta` 增量字段，旧后端忽略也无碍；迁移逻辑用 mock 旧 rows 测幂等。
- retain 队列：去重条件去掉 `attempts=0`（失败重试后不再重复入队）；写失败仍经 `pending/lastError` 对用户可见；TTL 草稿到期由展示层隐藏。

## 3. 测试（fake Hindsight + 临时 PIA_DATA_DIR/WORKSPACE + 内存 CredentialStore）

1. 主子同 parent：recall 得到 verified；子写 fact 落 task 草稿，**不是** shared user。
2. 父晋升：保存 provenance、幂等；去重命中不新增不覆盖。
3. 子 `forget` 共享 user/他人条目被拒（含完全权限档位上下文）。
4. legacy 条目保留、可读；task 草稿 TTL；伪 actor 字段被忽略。
5. agent/user 隔离；background 来源不入 user。
6. 队列 retain 去重：失败 attempts>0 后不重复入队；runtime resume 任务 origin 不变。
7. permissions：readOnlyHint 修正后普通档位不误拦 recall/reflect、完全权限仍 bypass。
8. **reflect 源端隔离**：子代理 reflect 请求带 provenance `tag_groups`，兄弟 task 草稿不出现在服务端命中（fake 记录**真正送给模型的依据**，断言请求正文与命中都不含兄弟草稿）；本任务只取 `status=draft`（已驳回不进证据）；无 tag 旧忆保留可见；主会话核验视角不做 tag 限制；user 库非核验视角也显式限定；`provider.reflect` 无 scope 直接拒绝；跨助理草稿不进入本助理 reflect；同文本不同 task 草稿隔离；并发晋升不重复。

## 4. 不做 / 边界

- 不改 Hindsight backend、不读 `secrets.ts`、不碰真实 Hindsight/钥匙串/真实数据目录。
- reflect 源端隔离靠 Hindsight 公开 API `tags`/`tags_match`/`tag_groups`；字段/枚举/SQL 语义已用**本机安装的真实 0.10.3 服务代码**实物验证，但**端到端 HTTP retain/reflect 未验**（需 LLM 凭据，按约定不读用户 key；独立实例需 Docker 或另起嵌入式 Postgres，本轮未做）；未拆物理 bank。
- 不做「每轮自动总结/自动 retain」；不整段移除上下文注入（缓存未实测）。
- 新发布仅 mac-arm64，下一个未用 beta（24），需主协调合入后统一发布。
